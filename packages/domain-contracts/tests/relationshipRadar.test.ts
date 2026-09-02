import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const observedAtUtc = '2026-09-01T08:30:00.000Z';
const expiresAtUtc = '2026-09-02T08:30:00.000Z';
const ruleVersion = 'saas-212.relationship-radar.v1';
const matterRef = {
  entityKind: 'matter', entityId: 'matter-1', version: 7, scheduleVersion: null,
};

const signal = (
  dimension: string,
  status: 'healthy' | 'attention' | 'gap' | 'unknown' = 'healthy',
  severity: 'info' | 'low' | 'medium' | 'high' = 'info',
) => ({
  id: `rrsig_${dimension}`,
  dimension,
  status,
  severity,
  reasonCode: `${dimension}.${status}`,
  explanation: '仅基于当前可见的正式 CRM 元数据生成。',
  sourceRefs: [matterRef],
  observedAtUtc,
  ruleVersion,
  expiresAtUtc,
  suggestedAction: {
    kind: 'view_relationship_source', label: '查看依据', commandType: null,
  },
});

const dimensions = [
  'interaction_freshness',
  'single_threaded_contact',
  'role_coverage',
  'visible_warm_paths',
  'evidence_freshness',
  'next_step_completeness',
] as const;

const payload = {
  customerId: 'customer-1',
  matterId: 'matter-1',
  generatedAtUtc: observedAtUtc,
  expiresAtUtc,
  ruleVersion,
  signals: dimensions.map((dimension) => (
    dimension === 'interaction_freshness'
      ? signal(dimension, 'attention', 'low')
      : dimension === 'next_step_completeness'
        ? signal(dimension, 'gap', 'medium')
        : signal(dimension)
  )),
  interventions: [{
    id: 'rrint_interaction_freshness',
    section: 'follow_up',
    providerKey: 'relationship_radar',
    title: '关系互动需要关注',
    context: { customerName: '当前客户', matterName: '当前事项' },
    reasonCode: 'interaction_freshness.attention',
    explanation: '当前可见互动已进入关注窗口。',
    sourceRefs: [matterRef],
    observedAtUtc,
    ruleVersion,
    time: { kind: 'observed', atUtc: observedAtUtc, relation: 'missing', label: '需要关注' },
    suggestedAction: { kind: 'view_relationship_source', label: '查看依据', commandType: null },
    target: {
      entityKind: 'matter', entityId: 'matter-1', customerId: 'customer-1',
      matterId: 'matter-1', commitmentId: null, version: 7, scheduleVersion: null,
    },
  }],
  drafts: [{
    id: 'rrdraft_next_step',
    state: 'uncommitted',
    actionType: 'CREATE_COMMITMENT',
    customerId: 'customer-1',
    matterId: 'matter-1',
    target: {
      entityKind: 'matter', entityId: 'matter-1', customerId: 'customer-1',
      matterId: 'matter-1', commitmentId: null, version: 7, scheduleVersion: null,
    },
    sourceRefs: [matterRef],
    prefill: { title: '补充下一步' },
    reasonCode: 'next_step_completeness.gap',
    explanation: '当前事项没有计划中的下一步。',
    observedAtUtc,
    ruleVersion,
    expiresAtUtc,
  }],
};

describe('SAAS-212 relationship radar contracts', () => {
  it('exports the exact six independent dimensions in their canonical order', () => {
    expect(Reflect.get(contracts, 'RELATIONSHIP_RADAR_DIMENSIONS')).toEqual(dimensions);
    expect(Reflect.get(contracts, 'RELATIONSHIP_RADAR_RULE_VERSION')).toBe(ruleVersion);
  });

  it('accepts only strict body-free signals and the V1 status/severity matrix', () => {
    const relationshipSignal = schema('RelationshipSignalSchema');
    expect(relationshipSignal, 'RelationshipSignalSchema must be exported').toBeDefined();
    expect(relationshipSignal!.safeParse(signal('interaction_freshness')).success).toBe(true);
    expect(relationshipSignal!.safeParse(signal('single_threaded_contact', 'attention', 'medium')).success).toBe(true);
    expect(relationshipSignal!.safeParse(signal('evidence_freshness', 'unknown', 'low')).success).toBe(true);
    expect(relationshipSignal!.safeParse(signal('role_coverage', 'healthy', 'medium')).success).toBe(false);
    expect(relationshipSignal!.safeParse(signal('role_coverage', 'gap', 'high')).success).toBe(false);
    expect(relationshipSignal!.safeParse({
      ...signal('visible_warm_paths', 'gap', 'medium'), sourceRefs: [],
    }).success).toBe(false);
    expect(relationshipSignal!.safeParse({
      ...signal('interaction_freshness'), sourceBody: '私有客户内容',
    }).success).toBe(false);
  });

  it('locks one canonical 24-hour payload with no aggregate score or duplicate dimensions', () => {
    const radarPayload = schema('RelationshipRadarSnapshotPayloadSchema');
    expect(radarPayload, 'RelationshipRadarSnapshotPayloadSchema must be exported').toBeDefined();
    expect(radarPayload!.safeParse(payload).success).toBe(true);
    expect(radarPayload!.safeParse({ ...payload, totalScore: 88 }).success).toBe(false);
    expect(radarPayload!.safeParse({
      ...payload,
      signals: [payload.signals[1], payload.signals[0], ...payload.signals.slice(2)],
    }).success).toBe(false);
    expect(radarPayload!.safeParse({
      ...payload,
      signals: payload.signals.map((item, index) => index === 5
        ? { ...item, dimension: 'evidence_freshness' }
        : item),
    }).success).toBe(false);
    expect(radarPayload!.safeParse({ ...payload, expiresAtUtc: '2026-09-02T08:29:59.999Z' }).success).toBe(false);
    expect(radarPayload!.safeParse({
      ...payload,
      signals: payload.signals.map((item) => ({ ...item, severity: 'high' })),
    }).success).toBe(false);
  });

  it('requires exact drillable intervention targets and explicitly uncommitted drafts', () => {
    const actionDraft = schema('RelationshipRadarActionDraftSchema');
    const radarPayload = schema('RelationshipRadarSnapshotPayloadSchema');
    expect(actionDraft, 'RelationshipRadarActionDraftSchema must be exported').toBeDefined();
    expect(actionDraft!.safeParse(payload.drafts[0]).success).toBe(true);
    expect(actionDraft!.safeParse({ ...payload.drafts[0], state: 'committed' }).success).toBe(false);
    expect(actionDraft!.safeParse({ ...payload.drafts[0], commitmentId: 'formal-write' }).success).toBe(false);
    expect(radarPayload!.safeParse({
      ...payload,
      interventions: payload.interventions.map((item) => ({ ...item, sourceRefs: [] })),
    }).success).toBe(false);
    expect(radarPayload!.safeParse({
      ...payload,
      drafts: payload.drafts.map((item) => ({ ...item, sourceRefs: [{ ...matterRef, version: 6 }] })),
    }).success).toBe(false);
  });
});
