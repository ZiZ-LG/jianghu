import { createHash } from 'node:crypto';
import {
  RELATIONSHIP_RADAR_DIMENSIONS,
  RELATIONSHIP_RADAR_PROVIDER_KEY,
  RELATIONSHIP_RADAR_RULE_VERSION,
  RELATIONSHIP_RADAR_TTL_MS,
  RelationshipRadarSnapshotPayloadSchema,
  type AgentOutputRef,
  type InterventionSourceRef,
  type InterventionTarget,
  type RelationshipRadarSnapshotPayload,
  type RelationshipSignal,
} from '@jianghu/domain-contracts';
import type {
  RadarCommitmentFact,
  RadarRelationFact,
  RelationshipRadarFacts,
} from './model.js';

const DAY_MS = 86_400_000;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

const sourceKey = (source: InterventionSourceRef): string => (
  `${source.entityKind}\0${source.entityId}\0${source.version}\0${source.scheduleVersion ?? ''}`
);

function sources(...groups: readonly (InterventionSourceRef | readonly InterventionSourceRef[])[]): InterventionSourceRef[] {
  const result: InterventionSourceRef[] = [];
  const seen = new Set<string>();
  for (const value of groups.flatMap((group) => Array.isArray(group) ? group : [group])) {
    const key = sourceKey(value as InterventionSourceRef);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value as InterventionSourceRef);
    if (result.length === 8) break;
  }
  return result;
}

function ageMs(generatedAtUtc: string, occurredAtUtc: string): number | null {
  const generatedAt = Date.parse(generatedAtUtc);
  const occurredAt = Date.parse(occurredAtUtc);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(occurredAt) || occurredAt > generatedAt) return null;
  return generatedAt - occurredAt;
}

function latest<T>(items: readonly T[], timestamp: (item: T) => string): T | null {
  return [...items].filter((item) => Number.isFinite(Date.parse(timestamp(item))))
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))[0] ?? null;
}

const ref = {
  matter: (facts: RelationshipRadarFacts): InterventionSourceRef => ({
    entityKind: 'matter', entityId: facts.matterId, version: facts.matterVersion, scheduleVersion: null,
  }),
  interaction: (id: string, version: number): InterventionSourceRef => ({
    entityKind: 'interaction', entityId: id, version, scheduleVersion: null,
  }),
  participant: (id: string): InterventionSourceRef => ({
    entityKind: 'matter_participant', entityId: id, version: 0, scheduleVersion: null,
  }),
  relation: (item: RadarRelationFact): InterventionSourceRef => ({
    entityKind: 'relation', entityId: item.id, version: item.version, scheduleVersion: null,
  }),
  evidence: (id: string): InterventionSourceRef => ({
    entityKind: 'evidence', entityId: id, version: 0, scheduleVersion: null,
  }),
  intelligence: (id: string, version: number): InterventionSourceRef => ({
    entityKind: 'intelligence', entityId: id, version, scheduleVersion: null,
  }),
  focus: (id: string, version: number): InterventionSourceRef => ({
    entityKind: 'stakeholder_focus', entityId: id, version, scheduleVersion: null,
  }),
  commitment: (item: RadarCommitmentFact): InterventionSourceRef => ({
    entityKind: 'commitment', entityId: item.id, version: item.version,
    scheduleVersion: item.scheduleVersion,
  }),
};

type SignalSeed = Omit<RelationshipSignal, 'id' | 'observedAtUtc' | 'ruleVersion' | 'expiresAtUtc'>;

function interactionSignal(facts: RelationshipRadarFacts): SignalSeed {
  const item = latest(facts.interactions, (value) => value.occurredAtUtc);
  const age = item ? ageMs(facts.generatedAtUtc, item.occurredAtUtc) : null;
  const base = item ? sources(ref.matter(facts), ref.interaction(item.id, item.version)) : [ref.matter(facts)];
  if (age === null) return {
    dimension: 'interaction_freshness', status: 'unknown', severity: 'low',
    reasonCode: 'interaction_freshness.unknown', explanation: '当前没有可用的已确认互动时间。', sourceRefs: base,
    suggestedAction: { kind: 'record_interaction', label: '补充已确认互动', commandType: null },
  };
  if (age <= 14 * DAY_MS) return {
    dimension: 'interaction_freshness', status: 'healthy', severity: 'info',
    reasonCode: 'interaction_freshness.healthy', explanation: '最近一次已确认互动在 14 天窗口内。', sourceRefs: base,
    suggestedAction: { kind: 'view_relationship_source', label: '查看互动依据', commandType: null },
  };
  if (age <= 30 * DAY_MS) return {
    dimension: 'interaction_freshness', status: 'attention', severity: 'low',
    reasonCode: 'interaction_freshness.attention', explanation: '最近一次已确认互动已进入 15–30 天关注窗口。', sourceRefs: base,
    suggestedAction: { kind: 'plan_relationship_touch', label: '安排一次互动', commandType: null },
  };
  return {
    dimension: 'interaction_freshness', status: 'gap', severity: 'medium',
    reasonCode: 'interaction_freshness.gap', explanation: '最近一次已确认互动已超过 30 天。', sourceRefs: base,
    suggestedAction: { kind: 'plan_relationship_touch', label: '尽快安排互动', commandType: null },
  };
}

function recentPersonSources(facts: RelationshipRadarFacts): Map<string, InterventionSourceRef> {
  const result = new Map<string, InterventionSourceRef>();
  const recent = (at: string) => {
    const age = ageMs(facts.generatedAtUtc, at);
    return age !== null && age <= 60 * DAY_MS;
  };
  for (const item of [...facts.commitments].sort((left, right) => left.id.localeCompare(right.id))) {
    if (item.personId && recent(item.indicatorAtUtc)) result.set(item.personId, ref.commitment(item));
  }
  for (const item of [...facts.evidence].sort((left, right) => left.id.localeCompare(right.id))) {
    if (item.personId && recent(item.occurredAtUtc)) result.set(item.personId, ref.evidence(item.id));
  }
  for (const item of [...facts.intelligence].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!recent(item.learnedAtUtc)) continue;
    for (const personId of [...new Set(item.targetPersonIds)].sort()) {
      result.set(personId, ref.intelligence(item.id, item.version));
    }
  }
  return result;
}

function contactSignal(facts: RelationshipRadarFacts, indicators: ReadonlyMap<string, InterventionSourceRef>): SignalSeed {
  const visiblePeople = new Set(facts.participants.map((item) => item.personId));
  const entries = [...indicators.entries()].filter(([personId]) => visiblePeople.has(personId))
    .sort(([left], [right]) => left.localeCompare(right));
  const signalSources = sources(ref.matter(facts), entries.map(([, source]) => source));
  if (entries.length === 0) return {
    dimension: 'single_threaded_contact', status: 'unknown', severity: 'low',
    reasonCode: 'single_threaded_contact.unknown', explanation: '近 60 天没有足够的可见正式指标来判断联系线数。',
    sourceRefs: signalSources, suggestedAction: { kind: 'review_participants', label: '核对参与人与互动记录', commandType: null },
  };
  if (entries.length === 1) return {
    dimension: 'single_threaded_contact', status: 'attention', severity: 'medium',
    reasonCode: 'single_threaded_contact.attention', explanation: '近 60 天只有一位当前参与人出现在可见正式指标中。',
    sourceRefs: signalSources, suggestedAction: { kind: 'broaden_formal_contacts', label: '补充第二条正式联系线', commandType: null },
  };
  return {
    dimension: 'single_threaded_contact', status: 'healthy', severity: 'info',
    reasonCode: 'single_threaded_contact.healthy', explanation: '近 60 天至少两位当前参与人出现在可见正式指标中。',
    sourceRefs: signalSources, suggestedAction: { kind: 'view_relationship_source', label: '查看联系依据', commandType: null },
  };
}

function coverageSignal(facts: RelationshipRadarFacts): SignalSeed {
  const participantRefs = [...facts.participants].sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ref.participant(item.id));
  const focusRef = facts.focus ? ref.focus(facts.focus.id, facts.focus.version) : [];
  const signalSources = sources(ref.matter(facts), participantRefs, focusRef);
  if (facts.participants.length < 2) return {
    dimension: 'role_coverage', status: 'gap', severity: 'medium',
    reasonCode: 'role_coverage.gap', explanation: '当前事项少于两位正式参与人，通用角色覆盖不完整。',
    sourceRefs: signalSources, suggestedAction: { kind: 'review_participants', label: '补充正式参与人', commandType: null },
  };
  if (!facts.focus) return {
    dimension: 'role_coverage', status: 'attention', severity: 'low',
    reasonCode: 'role_coverage.attention', explanation: '已有多位正式参与人，但当前没有有效干系人聚焦。',
    sourceRefs: signalSources, suggestedAction: { kind: 'confirm_stakeholder_focus', label: '人工确认当前聚焦', commandType: null },
  };
  return {
    dimension: 'role_coverage', status: 'healthy', severity: 'info',
    reasonCode: 'role_coverage.healthy', explanation: '当前至少有两位正式参与人，且有有效干系人聚焦。',
    sourceRefs: signalSources, suggestedAction: { kind: 'view_relationship_source', label: '查看参与人与聚焦', commandType: null },
  };
}

function pathToFocus(
  facts: RelationshipRadarFacts,
  anchors: ReadonlySet<string>,
): { anchor: string; relationIds: string[] } | null {
  if (!facts.focus) return null;
  const outgoing = new Map<string, Array<{ personId: string; relation: RadarRelationFact }>>();
  const append = (from: string, to: string, relation: RadarRelationFact) => {
    const values = outgoing.get(from) ?? [];
    values.push({ personId: to, relation });
    outgoing.set(from, values);
  };
  for (const relation of [...facts.relations].sort((left, right) => left.id.localeCompare(right.id))) {
    append(relation.sourcePersonId, relation.targetPersonId, relation);
    if (!relation.directed) append(relation.targetPersonId, relation.sourcePersonId, relation);
  }
  for (const anchor of [...anchors].sort()) {
    if (anchor === facts.focus.personId) return { anchor, relationIds: [] };
    const first = outgoing.get(anchor) ?? [];
    for (const edge of first) {
      if (edge.personId === facts.focus.personId) return { anchor, relationIds: [edge.relation.id] };
    }
    for (const edge of first) {
      for (const second of outgoing.get(edge.personId) ?? []) {
        if (second.personId === facts.focus.personId) {
          return { anchor, relationIds: [edge.relation.id, second.relation.id] };
        }
      }
    }
  }
  return null;
}

function warmPathSignal(
  facts: RelationshipRadarFacts,
  indicators: ReadonlyMap<string, InterventionSourceRef>,
): SignalSeed {
  const participantIds = new Set(facts.participants.map((item) => item.personId));
  const anchors = new Set([...indicators.keys()].filter((personId) => participantIds.has(personId)));
  const base = sources(
    ref.matter(facts),
    facts.focus ? ref.focus(facts.focus.id, facts.focus.version) : [],
    [...anchors].sort().map((personId) => indicators.get(personId)!),
  );
  if (!facts.focus || anchors.size === 0) return {
    dimension: 'visible_warm_paths', status: 'unknown', severity: 'low',
    reasonCode: 'visible_warm_paths.unknown', explanation: '当前缺少有效聚焦或近期正式活动锚点，无法判断可见暖路径。',
    sourceRefs: base, suggestedAction: { kind: 'review_relationship_map', label: '核对聚焦与正式关系', commandType: null },
  };
  const path = pathToFocus(facts, anchors);
  if (!path) return {
    dimension: 'visible_warm_paths', status: 'gap', severity: 'medium',
    reasonCode: 'visible_warm_paths.gap', explanation: '当前正式关系中，没有从近期活动锚点到聚焦人的两跳内可见路径。',
    sourceRefs: base, suggestedAction: { kind: 'review_relationship_map', label: '核对引荐路径', commandType: null },
  };
  return {
    dimension: 'visible_warm_paths', status: 'healthy', severity: 'info',
    reasonCode: 'visible_warm_paths.healthy', explanation: '当前正式关系中存在从近期活动锚点到聚焦人的两跳内可见路径。',
    sourceRefs: sources(base, path.relationIds.map((id) => ref.relation(
      facts.relations.find((relation) => relation.id === id)!,
    ))),
    suggestedAction: { kind: 'view_relationship_source', label: '查看暖路径', commandType: null },
  };
}

function evidenceSignal(facts: RelationshipRadarFacts): SignalSeed {
  const item = latest(facts.evidence, (value) => value.occurredAtUtc);
  const age = item ? ageMs(facts.generatedAtUtc, item.occurredAtUtc) : null;
  const base = item ? sources(ref.matter(facts), ref.evidence(item.id)) : [ref.matter(facts)];
  if (age === null) return {
    dimension: 'evidence_freshness', status: 'unknown', severity: 'low',
    reasonCode: 'evidence_freshness.unknown', explanation: '当前没有可用的已审核 Evidence 时间。', sourceRefs: base,
    suggestedAction: { kind: 'review_evidence', label: '补充并审核 Evidence', commandType: null },
  };
  if (age <= 30 * DAY_MS) return {
    dimension: 'evidence_freshness', status: 'healthy', severity: 'info',
    reasonCode: 'evidence_freshness.healthy', explanation: '最近已审核 Evidence 在 30 天窗口内。', sourceRefs: base,
    suggestedAction: { kind: 'view_relationship_source', label: '查看 Evidence', commandType: null },
  };
  if (age <= 60 * DAY_MS) return {
    dimension: 'evidence_freshness', status: 'attention', severity: 'low',
    reasonCode: 'evidence_freshness.attention', explanation: '最近已审核 Evidence 已进入 31–60 天关注窗口。', sourceRefs: base,
    suggestedAction: { kind: 'review_evidence', label: '补充新 Evidence', commandType: null },
  };
  return {
    dimension: 'evidence_freshness', status: 'gap', severity: 'medium',
    reasonCode: 'evidence_freshness.gap', explanation: '最近已审核 Evidence 已超过 60 天。', sourceRefs: base,
    suggestedAction: { kind: 'review_evidence', label: '尽快补充新 Evidence', commandType: null },
  };
}

function nextStepSignal(facts: RelationshipRadarFacts): SignalSeed {
  const planned = [...facts.commitments].filter((item) => item.executionStatus === 'planned')
    .sort((left, right) => left.id.localeCompare(right.id));
  if (planned.length > 0) return {
    dimension: 'next_step_completeness', status: 'healthy', severity: 'info',
    reasonCode: 'next_step_completeness.healthy', explanation: '当前事项已有计划中的正式下一步。',
    sourceRefs: sources(ref.matter(facts), planned.map(ref.commitment)),
    suggestedAction: { kind: 'view_relationship_source', label: '查看下一步', commandType: null },
  };
  return {
    dimension: 'next_step_completeness', status: 'gap', severity: 'medium',
    reasonCode: 'next_step_completeness.gap', explanation: '当前事项没有计划中的正式下一步。',
    sourceRefs: [ref.matter(facts)],
    suggestedAction: { kind: 'create_commitment', label: '补充下一步', commandType: 'CREATE_COMMITMENT' },
  };
}

function targetFor(facts: RelationshipRadarFacts, signal: RelationshipSignal): InterventionTarget {
  const source = [...signal.sourceRefs].reverse().find((item) => item.entityKind !== 'matter')
    ?? ref.matter(facts);
  return {
    entityKind: source.entityKind,
    entityId: source.entityId,
    customerId: facts.customerId,
    matterId: facts.matterId,
    commitmentId: source.entityKind === 'commitment' ? source.entityId : null,
    version: source.version,
    scheduleVersion: source.scheduleVersion,
  };
}

const titles: Record<typeof RELATIONSHIP_RADAR_DIMENSIONS[number], string> = {
  interaction_freshness: '关系互动需要关注',
  single_threaded_contact: '联系线覆盖需要关注',
  role_coverage: '通用角色覆盖需要关注',
  visible_warm_paths: '可见暖路径需要关注',
  evidence_freshness: 'Evidence 新鲜度需要关注',
  next_step_completeness: '当前事项缺少下一步',
};

export interface RelationshipRadarBuildResult {
  payload: RelationshipRadarSnapshotPayload;
  sourceSetHash: string;
  outputRefs: AgentOutputRef[];
}

export function buildRelationshipRadarSnapshot(facts: RelationshipRadarFacts): RelationshipRadarBuildResult {
  const generatedAt = new Date(facts.generatedAtUtc);
  if (!Number.isFinite(generatedAt.getTime()) || generatedAt.toISOString() !== facts.generatedAtUtc) {
    throw new RangeError('Relationship radar requires a canonical UTC generation time');
  }
  const sourceSetHash = sha256(JSON.stringify(canonicalize(facts)));
  const token = sha256(`${facts.tenantId}\0${facts.customerId}\0${facts.matterId}\0${facts.generatedAtUtc}\0${sourceSetHash}`).slice(0, 12);
  const expiresAtUtc = new Date(generatedAt.getTime() + RELATIONSHIP_RADAR_TTL_MS).toISOString();
  const indicators = recentPersonSources(facts);
  const seeds = [
    interactionSignal(facts),
    contactSignal(facts, indicators),
    coverageSignal(facts),
    warmPathSignal(facts, indicators),
    evidenceSignal(facts),
    nextStepSignal(facts),
  ] as const;
  const signals = seeds.map((item) => ({
    ...item,
    id: `rrsig_${token}_${item.dimension}`,
    observedAtUtc: facts.generatedAtUtc,
    ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
    expiresAtUtc,
  })) as RelationshipRadarSnapshotPayload['signals'];
  const interventions = signals
    .filter((item) => item.status === 'attention' || item.status === 'gap')
    .map((item) => ({
      id: `rrint_${token}_${item.dimension}`,
      section: 'follow_up' as const,
      providerKey: RELATIONSHIP_RADAR_PROVIDER_KEY,
      title: titles[item.dimension],
      context: { customerName: '当前客户', matterName: '当前事项' },
      reasonCode: item.reasonCode,
      explanation: item.explanation,
      sourceRefs: item.sourceRefs,
      observedAtUtc: facts.generatedAtUtc,
      ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
      time: { kind: 'observed' as const, atUtc: facts.generatedAtUtc, relation: 'missing' as const, label: '需要关注' },
      suggestedAction: item.suggestedAction,
      target: targetFor(facts, item),
    }));
  const nextStep = signals[5];
  const drafts = nextStep.status === 'gap' ? [{
    id: `rrdraft_${token}_next_step`,
    state: 'uncommitted' as const,
    actionType: 'CREATE_COMMITMENT' as const,
    customerId: facts.customerId,
    matterId: facts.matterId,
    target: {
      entityKind: 'matter', entityId: facts.matterId, customerId: facts.customerId,
      matterId: facts.matterId, commitmentId: null, version: facts.matterVersion, scheduleVersion: null,
    },
    sourceRefs: [ref.matter(facts)],
    prefill: { title: '补充下一步' },
    reasonCode: nextStep.reasonCode,
    explanation: nextStep.explanation,
    observedAtUtc: facts.generatedAtUtc,
    ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
    expiresAtUtc,
  }] : [];
  const payload = RelationshipRadarSnapshotPayloadSchema.parse({
    customerId: facts.customerId,
    matterId: facts.matterId,
    generatedAtUtc: facts.generatedAtUtc,
    expiresAtUtc,
    ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
    signals,
    interventions,
    drafts,
  });
  const outputRefs: AgentOutputRef[] = [
    ...payload.signals.map((item) => ({ kind: 'relationship_signal' as const, id: item.id, version: 1 })),
    ...payload.interventions.map((item) => ({ kind: 'intervention_item' as const, id: item.id, version: 1 })),
    ...payload.drafts.map((item) => ({ kind: 'draft_action' as const, id: item.id, version: 1 })),
  ];
  return { payload, sourceSetHash, outputRefs };
}
