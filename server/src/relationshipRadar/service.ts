import { createHash } from 'node:crypto';
import {
  AgentOutputRefSchema,
  RelationshipRadarResponseSchema,
  RelationshipRadarSnapshotPayloadSchema,
  TodaySourceViewSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
  type InterventionItem,
  type InterventionSourceRef,
  type RelationshipRadarResponse,
  type RelationshipRadarSnapshotPayload,
  type TodaySourceView,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import { loadRelationshipRadarFacts } from './handler.js';
import { canonicalRelationshipRadarPayload } from './migration.js';
import { buildRelationshipRadarSnapshot } from './rules.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export class RelationshipRadarReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly scopedNotFound = false,
  ) {
    super(code);
    this.name = 'RelationshipRadarReadError';
  }
}

function notFound(): never {
  throw new RelationshipRadarReadError('relationship_radar_not_found', 404, true);
}

function storageInvalid(): never {
  throw new RelationshipRadarReadError('relationship_radar_storage_invalid', 409);
}

function sourceChanged(): never {
  throw new RelationshipRadarReadError('relationship_radar_source_changed', 409);
}

async function requireAuthority(
  db: DbClient,
  ctx: Pick<CommandContext, 'tenantId' | 'actorId' | 'actorRole'>,
  policy: CapabilityPolicy,
  customerId: string,
  matterId: string,
) {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new RelationshipRadarReadError('capability_denied', 403);
  }
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.valid || !scope.canReadMatter(matterId)) notFound();
  const [customer, matter] = await Promise.all([
    db.account.findFirst({
      where: { id: customerId, tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true, version: true },
    }),
    db.opportunity.findFirst({
      where: {
        id: matterId,
        tenantId: ctx.tenantId,
        accountId: customerId,
        archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: { id: true, version: true },
    }),
  ]);
  if (!customer || !matter || !scope.canReadAccountContainer(customer.id)) notFound();
  return { scope, customer, matter };
}

function expectedOutputRefs(payload: RelationshipRadarSnapshotPayload) {
  return [
    ...payload.signals.map((item) => ({
      kind: 'relationship_signal' as const, id: item.id, version: 1,
    })),
    ...payload.interventions.map((item) => ({
      kind: 'intervention_item' as const, id: item.id, version: 1,
    })),
    ...payload.drafts.map((item) => ({
      kind: 'draft_action' as const, id: item.id, version: 1,
    })),
  ];
}

function parseStoredPayload(snapshot: {
  customerId: string;
  matterId: string;
  payloadJson: string;
  payloadFingerprint: string;
  signalCount: number;
  interventionCount: number;
  draftCount: number;
  ruleVersion: string;
  generatedAt: Date;
  expiresAt: Date;
  version: number;
}): RelationshipRadarSnapshotPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(snapshot.payloadJson);
  } catch {
    storageInvalid();
  }
  const payload = RelationshipRadarSnapshotPayloadSchema.safeParse(raw);
  if (!payload.success
    || canonicalRelationshipRadarPayload(payload.data) !== snapshot.payloadJson
    || sha256(snapshot.payloadJson) !== snapshot.payloadFingerprint
    || payload.data.customerId !== snapshot.customerId
    || payload.data.matterId !== snapshot.matterId
    || payload.data.generatedAtUtc !== snapshot.generatedAt.toISOString()
    || payload.data.expiresAtUtc !== snapshot.expiresAt.toISOString()
    || payload.data.ruleVersion !== snapshot.ruleVersion
    || payload.data.signals.length !== snapshot.signalCount
    || payload.data.interventions.length !== snapshot.interventionCount
    || payload.data.drafts.length !== snapshot.draftCount
    || snapshot.version !== 1) {
    storageInvalid();
  }
  return payload.data;
}

function parseRunRefs(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) storageInvalid();
    const refs = value.map((item) => AgentOutputRefSchema.safeParse(item));
    if (refs.some((item) => !item.success)) storageInvalid();
    return refs.map((item) => item.data!);
  } catch (error) {
    if (error instanceof RelationshipRadarReadError) throw error;
    storageInvalid();
  }
}

function changedProjection(
  payload: RelationshipRadarSnapshotPayload,
  matterVersion: number,
): RelationshipRadarSnapshotPayload {
  const sourceRefs = [{
    entityKind: 'matter', entityId: payload.matterId, version: matterVersion, scheduleVersion: null,
  }];
  return RelationshipRadarSnapshotPayloadSchema.parse({
    ...payload,
    signals: payload.signals.map((item) => ({
      ...item,
      status: 'unknown',
      severity: 'low',
      reasonCode: `${item.dimension}.source_changed`,
      explanation: '当前权限或正式 CRM 来源版本已变化，请重新生成关系雷达。',
      sourceRefs,
      suggestedAction: {
        kind: 'refresh_relationship_radar', label: '重新生成关系雷达', commandType: null,
      },
    })),
    interventions: [],
    drafts: [],
  });
}

export async function readableRelationshipRadar(
  db: DbClient,
  ctx: Pick<CommandContext, 'tenantId' | 'actorId' | 'actorRole'>,
  policy: CapabilityPolicy,
  query: { customerId: string; matterId: string },
  now = new Date(),
): Promise<RelationshipRadarResponse> {
  const authority = await requireAuthority(
    db, ctx, policy, query.customerId, query.matterId,
  );
  const snapshot = await db.relationshipRadarSnapshot.findFirst({
    where: {
      tenantId: ctx.tenantId,
      customerId: query.customerId,
      matterId: query.matterId,
    },
    orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
  });
  if (!snapshot) {
    return RelationshipRadarResponseSchema.parse({
      status: 'missing', customerId: query.customerId, matterId: query.matterId,
    });
  }
  const payload = parseStoredPayload(snapshot);
  const run = await db.agentRun.findFirst({
    where: {
      id: snapshot.agentRunId,
      tenantId: ctx.tenantId,
      jobKey: 'relationship_radar',
      jobVersion: 'saas-212.v1',
      status: 'succeeded',
      customerId: query.customerId,
      matterId: query.matterId,
      actorId: snapshot.createdByUserId,
    },
    select: { outputRefs: true },
  });
  if (!run || JSON.stringify(parseRunRefs(run.outputRefs)) !== JSON.stringify(expectedOutputRefs(payload))) {
    storageInvalid();
  }
  const base = {
    id: snapshot.id,
    generatedAtUtc: snapshot.generatedAt.toISOString(),
    expiresAtUtc: snapshot.expiresAt.toISOString(),
    ruleVersion: snapshot.ruleVersion,
    version: snapshot.version,
  };
  if (snapshot.expiresAt.getTime() <= now.getTime()) {
    return RelationshipRadarResponseSchema.parse({
      status: 'expired',
      customerId: query.customerId,
      matterId: query.matterId,
      snapshot: { ...base, sourceState: 'changed' },
    });
  }

  const currentFacts = await loadRelationshipRadarFacts(db, {
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    actorRole: authority.scope.actorRole,
  }, policy, query.customerId, query.matterId, now);
  const comparableFacts = {
    ...currentFacts,
    generatedAtUtc: snapshot.generatedAt.toISOString(),
  };
  const current = buildRelationshipRadarSnapshot(comparableFacts);
  const currentSources = current.sourceSetHash === snapshot.sourceSetHash;
  return RelationshipRadarResponseSchema.parse({
    status: 'ready',
    customerId: query.customerId,
    matterId: query.matterId,
    snapshot: { ...base, sourceState: currentSources ? 'current' : 'changed' },
    projection: currentSources ? payload : changedProjection(payload, authority.matter.version),
  });
}

function sourceKey(source: InterventionSourceRef): string {
  return `${source.entityKind}\0${source.entityId}\0${source.version}\0${source.scheduleVersion ?? ''}`;
}

export async function relationshipRadarSourceView(
  db: DbClient,
  ctx: Pick<CommandContext, 'tenantId' | 'actorId' | 'actorRole'>,
  policy: CapabilityPolicy,
  input: { customerId: string; matterId: string; sourceRef: InterventionSourceRef },
  now = new Date(),
): Promise<TodaySourceView> {
  const radar = await readableRelationshipRadar(db, ctx, policy, input, now);
  if (radar.status !== 'ready' || radar.snapshot.sourceState !== 'current') sourceChanged();
  const allowed = new Set([
    ...radar.projection.signals.flatMap((item) => item.sourceRefs),
    ...radar.projection.interventions.flatMap((item) => item.sourceRefs),
    ...radar.projection.drafts.flatMap((item) => item.sourceRefs),
  ].map(sourceKey));
  if (!allowed.has(sourceKey(input.sourceRef))) notFound();

  const facts = await loadRelationshipRadarFacts(db, ctx, policy, input.customerId, input.matterId, now);
  const ref = input.sourceRef;
  let label = '';
  let detail = '';
  if (ref.entityKind === 'matter'
    && ref.entityId === facts.matterId
    && ref.version === facts.matterVersion
    && ref.scheduleVersion === null) {
    label = '当前事项';
    detail = `正式事项版本 ${ref.version}`;
  } else if (ref.entityKind === 'interaction') {
    const item = facts.interactions.find((value) => value.id === ref.entityId && value.version === ref.version);
    if (!item || ref.scheduleVersion !== null) notFound();
    label = '已确认互动';
    detail = `发生于 ${item.occurredAtUtc}`;
  } else if (ref.entityKind === 'matter_participant') {
    const item = facts.participants.find((value) => value.id === ref.entityId);
    if (!item || ref.version !== 0 || ref.scheduleVersion !== null) notFound();
    label = '正式参与人';
    detail = '当前事项的正式参与关系';
  } else if (ref.entityKind === 'relation') {
    const item = facts.relations.find((value) => (
      value.id === ref.entityId && value.version === ref.version
    ));
    if (!item || ref.scheduleVersion !== null) notFound();
    label = '正式关系';
    detail = '当前关系图中的已确认关系';
  } else if (ref.entityKind === 'evidence') {
    const item = facts.evidence.find((value) => value.id === ref.entityId);
    if (!item || ref.version !== 0 || ref.scheduleVersion !== null) notFound();
    label = '已审核 Evidence';
    detail = `发生于 ${item.occurredAtUtc}`;
  } else if (ref.entityKind === 'intelligence') {
    const item = facts.intelligence.find((value) => value.id === ref.entityId && value.version === ref.version);
    if (!item || ref.scheduleVersion !== null) notFound();
    label = '人工确认信息';
    detail = `得知于 ${item.learnedAtUtc}`;
  } else if (ref.entityKind === 'stakeholder_focus') {
    const item = facts.focus;
    if (!item || item.id !== ref.entityId || item.version !== ref.version || ref.scheduleVersion !== null) notFound();
    label = '人工确认 Focus';
    detail = `确认于 ${item.confirmedAtUtc}`;
  } else if (ref.entityKind === 'commitment') {
    const item = facts.commitments.find((value) => (
      value.id === ref.entityId
      && value.version === ref.version
      && value.scheduleVersion === ref.scheduleVersion
    ));
    if (!item) notFound();
    label = '正式下一步';
    detail = `${item.executionStatus === 'planned' ? '计划中' : '已完成'} · ${item.indicatorAtUtc}`;
  } else {
    notFound();
  }
  return TodaySourceViewSchema.parse({
    sourceRef: ref,
    customerId: input.customerId,
    matterId: input.matterId,
    label,
    detail,
  });
}

/** Current, revalidated radar interventions for the internal Today composition transaction. */
export async function relationshipRadarTodayItems(
  db: DbClient,
  ctx: Pick<CommandContext, 'tenantId' | 'actorId' | 'actorRole'>,
  policy: CapabilityPolicy,
  now = new Date(),
  target?: { customerId: string; matterId: string },
): Promise<InterventionItem[]> {
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.valid || scope.matterIds.size === 0
    || (target && !scope.canReadMatter(target.matterId))) return [];
  const readableMatterIds = target ? [target.matterId] : [...scope.matterIds];
  const candidates = await db.relationshipRadarSnapshot.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(target ? { customerId: target.customerId } : {}),
      matterId: { in: readableMatterIds },
      expiresAt: { gt: now },
    },
    orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
    select: { customerId: true, matterId: true },
  });
  const pairs: Array<{ customerId: string; matterId: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.customerId}\0${candidate.matterId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(candidate);
  }
  const items: InterventionItem[] = [];
  for (const pair of pairs) {
    const radar = await readableRelationshipRadar(db, ctx, policy, pair, now);
    if (radar.status !== 'ready' || radar.snapshot.sourceState !== 'current') continue;
    for (const item of radar.projection.interventions) {
      // Core Today already owns the canonical "Matter has no next Commitment" card.
      if (item.reasonCode === 'next_step_completeness.gap') continue;
      items.push(item);
    }
  }
  const severityRank = (item: InterventionItem): number => {
    const signal = item.reasonCode.endsWith('.gap') ? 0 : 1;
    return signal;
  };
  return items.sort((left, right) => severityRank(left) - severityRank(right)
    || left.observedAtUtc.localeCompare(right.observedAtUtc)
    || left.id.localeCompare(right.id));
}
