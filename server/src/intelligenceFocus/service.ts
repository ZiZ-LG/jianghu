import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  CommandContextSchema,
  IntelligenceItemCreateInputSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
  type IntelligenceItemCommand,
  type IntelligenceItemCommandReceipt,
  type IntelligenceItemListQuery,
  type IntelligenceItemListResponse,
  type IntelligenceItemDetailResponse,
  type IntelligenceItemView,
  type IntelligenceSource,
  type IntelligenceTargetRef,
  type StakeholderFocusBasisRef,
  type StakeholderFocusCommand,
  type StakeholderFocusCommandReceipt,
  type StakeholderFocusDetailResponse,
  type StakeholderFocusListQuery,
  type StakeholderFocusListResponse,
} from '@jianghu/domain-contracts';
import { activePersonWhere } from '../activePerson.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope, type EffectiveResourceScope } from '../resourceScope.js';
import { authorizeSensitiveResource, sourceArtifactDescriptor } from '../sensitiveAccess.js';
import {
  SOURCE_ARTIFACT_METADATA_SELECT,
  sourceArtifactMetadataIsValid,
} from '../sourceArtifacts/service.js';
import {
  canonicalFocusBasisRefs,
  canonicalIntelligenceTargets,
  parseStoredFocusBasisRefs,
  parseStoredIntelligenceTargets,
  projectIntelligenceItem,
  projectStakeholderFocus,
  type IntelligenceItemProjectionRow,
  type StakeholderFocusProjectionRow,
} from './model.js';

export class IntelligenceFocusError extends Error {
  readonly scopedNotFound: boolean;
  constructor(readonly code: string, readonly statusCode = 409, scopedNotFound = false) {
    super(code);
    this.name = 'IntelligenceFocusError';
    this.scopedNotFound = scopedNotFound;
  }
}

type ReceiptWithoutReplay<T extends { replayed: boolean }> = Omit<T, 'replayed'>;

const intelligenceSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  assertionType: true,
  statement: true,
  sourceKind: true,
  sourceDescription: true,
  sourceRefId: true,
  sourceRefVersion: true,
  occurredAt: true,
  learnedAt: true,
  confidence: true,
  targetRefs: true,
  createdByUserId: true,
  version: true,
  archivedAt: true,
  archivedByUserId: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

const focusSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  personId: true,
  desiredChange: true,
  rationale: true,
  evidenceGap: true,
  basisRefs: true,
  validUntil: true,
  activeMatterKey: true,
  confirmedByUserId: true,
  confirmedAt: true,
  retiredByUserId: true,
  retiredAt: true,
  retireReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type IntelligenceRow = Prisma.IntelligenceItemGetPayload<{ select: typeof intelligenceSelect }>;
type FocusRow = Prisma.StakeholderFocusGetPayload<{ select: typeof focusSelect }>;

function notFound(): never {
  throw new IntelligenceFocusError('intelligence_focus_not_found', 404, true);
}

function conflict(code: string): never {
  throw new IntelligenceFocusError(code, 409);
}

function requireSalesCapability(policy: CapabilityPolicy): void {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new IntelligenceFocusError('capability_denied', 403);
  }
}

function requireHumanConfirmation(ctx: CommandContext): void {
  if (ctx.assertionMode !== 'user_asserted') {
    throw new IntelligenceFocusError('human_confirmation_required', 403);
  }
}

async function requireParentScope(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  customerId: string,
  matterId: string,
  intent: 'read' | 'write',
): Promise<EffectiveResourceScope> {
  CommandContextSchema.parse(ctx);
  requireSalesCapability(policy);
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.valid) notFound();
  if (intent === 'write') {
    requireHumanConfirmation(ctx);
    if (scope.actorRole === 'viewer') {
      throw new IntelligenceFocusError('viewer_write_denied', 403);
    }
    const actorLock = await db.user.updateMany({
      where: { id: ctx.actorId, tenantId: ctx.tenantId, role: scope.actorRole },
      data: { role: scope.actorRole },
    });
    if (actorLock.count !== 1) notFound();
  }
  const [customer, matter] = await Promise.all([
    db.account.findFirst({
      where: { id: customerId, tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true },
    }),
    db.opportunity.findFirst({
      where: {
        id: matterId,
        tenantId: ctx.tenantId,
        accountId: customerId,
        archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: { id: true },
    }),
  ]);
  if (!customer || !matter || !scope.canReadMatter(matterId)) notFound();
  return scope;
}

async function requireUserClosure(db: DbClient, tenantId: string, userId: string | null): Promise<void> {
  if (userId === null) return;
  const user = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!user) conflict('intelligence_focus_storage_invalid');
}

async function requirePersonParticipant(
  db: DbClient,
  tenantId: string,
  customerId: string,
  matterId: string,
  personId: string,
): Promise<void> {
  const participant = await db.matterParticipant.findFirst({
    where: {
      tenantId,
      accountId: customerId,
      opportunityId: matterId,
      personId,
      person: { tenantId, accountId: customerId, ...activePersonWhere },
      opportunity: { tenantId, accountId: customerId, archivedAt: null },
      account: { tenantId, archivedAt: null },
    },
    select: { id: true },
  });
  if (!participant) notFound();
}

async function requireReadableInteraction(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  scope: EffectiveResourceScope,
  customerId: string,
  matterId: string,
  refId: string,
  expectedVersion: number,
): Promise<void> {
  const interaction = await db.interaction.findFirst({
    where: { id: refId, tenantId: ctx.tenantId, accountId: customerId, matterId },
    select: { id: true, version: true, sourceArtifactId: true },
  });
  if (!interaction) notFound();
  if (interaction.version !== expectedVersion) conflict('intelligence_source_version_conflict');
  const source = await db.sourceArtifact.findFirst({
    where: { id: interaction.sourceArtifactId, tenantId: ctx.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!source || !sourceArtifactMetadataIsValid(source)
    || source.accountId !== customerId || source.matterId !== matterId
    || source.retentionState === 'deleted' || source.retentionState === 'degraded') {
    notFound();
  }
  const access = await authorizeSensitiveResource(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: scope.actorRole,
  }, policy, sourceArtifactDescriptor(source), 'read');
  if (!access.allowed) notFound();
}

async function requireReadableEvidence(
  db: DbClient,
  tenantId: string,
  customerId: string,
  matterId: string,
  refId: string,
  expectedVersion: number,
  versionConflictCode = 'intelligence_source_version_conflict',
): Promise<void> {
  if (expectedVersion !== 0) conflict(versionConflictCode);
  const evidence = await db.evidenceEvent.findFirst({
    where: {
      id: refId,
      tenantId,
      accountId: customerId,
      opportunityId: matterId,
      status: 'approved',
    },
    select: { id: true },
  });
  if (!evidence) notFound();
}

async function requireIntelligenceSource(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  scope: EffectiveResourceScope,
  customerId: string,
  matterId: string,
  source: IntelligenceSource,
): Promise<void> {
  if (source.kind === 'manual') {
    if (source.refId !== null || source.refVersion !== null) conflict('intelligence_source_invalid');
    return;
  }
  if (source.refId === null || source.refVersion === null) conflict('intelligence_source_invalid');
  if (source.kind === 'interaction') {
    await requireReadableInteraction(
      db, ctx, policy, scope, customerId, matterId, source.refId, source.refVersion,
    );
    return;
  }
  await requireReadableEvidence(
    db, ctx.tenantId, customerId, matterId, source.refId, source.refVersion,
  );
}

async function requireIntelligenceTargets(
  db: DbClient,
  tenantId: string,
  customerId: string,
  matterId: string,
  targets: readonly IntelligenceTargetRef[],
): Promise<void> {
  for (const target of targets) {
    if (target.kind === 'customer') {
      if (target.id !== customerId) notFound();
    } else if (target.kind === 'matter') {
      if (target.id !== matterId) notFound();
    } else if (target.kind === 'person') {
      await requirePersonParticipant(db, tenantId, customerId, matterId, target.id);
    } else {
      const relation = await db.edge.findFirst({
        where: {
          id: target.id,
          tenantId,
          accountId: customerId,
          opportunityId: matterId,
        },
        select: { id: true },
      });
      if (!relation) notFound();
    }
  }
}

function sourceFromRow(row: IntelligenceRow): IntelligenceSource {
  return {
    kind: row.sourceKind as IntelligenceSource['kind'],
    description: row.sourceDescription,
    refId: row.sourceRefId,
    refVersion: row.sourceRefVersion,
  };
}

async function validateIntelligenceRow(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  scope: EffectiveResourceScope,
  row: IntelligenceRow,
): Promise<IntelligenceItemView> {
  let view: IntelligenceItemView;
  try {
    view = projectIntelligenceItem(row as IntelligenceItemProjectionRow);
  } catch {
    conflict('intelligence_item_storage_invalid');
  }
  await requireUserClosure(db, ctx.tenantId, row.createdByUserId);
  await requireUserClosure(db, ctx.tenantId, row.archivedByUserId);
  await requireIntelligenceSource(db, ctx, policy, scope, row.customerId, row.matterId, view.source);
  await requireIntelligenceTargets(db, ctx.tenantId, row.customerId, row.matterId, view.targets);
  return view;
}

function intelligenceReceipt(
  type: IntelligenceItemCommand['type'],
  row: Pick<IntelligenceItemView, 'id' | 'customerId' | 'matterId' | 'assertionType' | 'status' | 'version'>
    & { source: Pick<IntelligenceSource, 'kind'> },
): ReceiptWithoutReplay<IntelligenceItemCommandReceipt> {
  return {
    type,
    intelligenceItemId: row.id,
    customerId: row.customerId,
    matterId: row.matterId,
    assertionType: row.assertionType,
    sourceKind: row.source.kind,
    status: row.status,
    version: row.version,
    undoable: false,
  };
}

async function writeIntelligenceAudit(
  db: DbClient,
  ctx: CommandContext,
  input: {
    action: string;
    id: string;
    customerId: string;
    matterId: string;
    assertionType: string;
    sourceKind: string;
    sourceRefId: string | null;
    sourceRefVersion: number | null;
    confidence: number;
    occurredAt: string | null;
    learnedAt: string;
    targets: readonly IntelligenceTargetRef[];
    version: number;
    changedFields: readonly string[];
  },
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: input.action,
    entityKind: 'intelligence_item',
    entityId: input.id,
    requestId: ctx.requestId,
    sourceRef: input.sourceRefId,
    changedFields: JSON.stringify([...input.changedFields].sort()),
    metadata: JSON.stringify({
      customerId: input.customerId,
      matterId: input.matterId,
      assertionType: input.assertionType,
      sourceKind: input.sourceKind,
      sourceRefId: input.sourceRefId,
      sourceRefVersion: input.sourceRefVersion,
      confidence: input.confidence,
      occurredAt: input.occurredAt,
      learnedAt: input.learnedAt,
      targets: input.targets,
      version: input.version,
    }),
  } });
}

function prismaCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export async function executeIntelligenceItemCommand(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: IntelligenceItemCommand,
): Promise<ReceiptWithoutReplay<IntelligenceItemCommandReceipt>> {
  if (input.type === 'CREATE_INTELLIGENCE_ITEM') {
    const item = IntelligenceItemCreateInputSchema.parse(input.item);
    const scope = await requireParentScope(db, ctx, policy, item.customerId, item.matterId, 'write');
    await requireIntelligenceSource(db, ctx, policy, scope, item.customerId, item.matterId, item.source);
    await requireIntelligenceTargets(db, ctx.tenantId, item.customerId, item.matterId, item.targets);
    const targets = canonicalIntelligenceTargets(item.targets);
    try {
      await db.intelligenceItem.create({ data: {
        id: item.id,
        tenantId: ctx.tenantId,
        customerId: item.customerId,
        matterId: item.matterId,
        assertionType: item.assertionType,
        statement: item.statement,
        sourceKind: item.source.kind,
        sourceDescription: item.source.description,
        sourceRefId: item.source.refId,
        sourceRefVersion: item.source.refVersion,
        occurredAt: item.occurredAt ? new Date(item.occurredAt) : null,
        learnedAt: new Date(item.learnedAt),
        confidence: item.confidence,
        targetRefs: targets,
        createdByUserId: ctx.actorId,
      } });
    } catch (error) {
      if (prismaCode(error) === 'P2002') conflict('intelligence_item_id_conflict');
      throw error;
    }
    await writeIntelligenceAudit(db, ctx, {
      action: 'intelligence_item_create', id: item.id, customerId: item.customerId, matterId: item.matterId,
      assertionType: item.assertionType, sourceKind: item.source.kind,
      sourceRefId: item.source.refId, sourceRefVersion: item.source.refVersion,
      confidence: item.confidence, occurredAt: item.occurredAt, learnedAt: item.learnedAt,
      targets: item.targets, version: 0,
      changedFields: ['assertionType', 'statement', 'source', 'occurredAt', 'learnedAt', 'confidence', 'targets'],
    });
    return intelligenceReceipt(input.type, {
      id: item.id, customerId: item.customerId, matterId: item.matterId,
      assertionType: item.assertionType, source: item.source, status: 'active', version: 0,
    });
  }

  const row = await db.intelligenceItem.findFirst({
    where: { id: input.intelligenceItemId, tenantId: ctx.tenantId },
    select: intelligenceSelect,
  });
  if (!row) notFound();
  const scope = await requireParentScope(db, ctx, policy, row.customerId, row.matterId, 'write');
  const current = await validateIntelligenceRow(db, ctx, policy, scope, row);
  if (row.version !== input.expectedVersion) conflict('intelligence_item_version_conflict');

  if (input.type === 'UPDATE_INTELLIGENCE_ITEM') {
    if (row.archivedAt) conflict('intelligence_item_archived');
    const merged = IntelligenceItemCreateInputSchema.parse({
      id: row.id,
      customerId: row.customerId,
      matterId: row.matterId,
      assertionType: input.changes.assertionType ?? current.assertionType,
      statement: input.changes.statement ?? current.statement,
      source: input.changes.source ?? current.source,
      occurredAt: input.changes.occurredAt === undefined ? current.occurredAt : input.changes.occurredAt,
      learnedAt: input.changes.learnedAt ?? current.learnedAt,
      confidence: input.changes.confidence ?? current.confidence,
      targets: input.changes.targets ?? current.targets,
    });
    await requireIntelligenceSource(db, ctx, policy, scope, row.customerId, row.matterId, merged.source);
    await requireIntelligenceTargets(db, ctx.tenantId, row.customerId, row.matterId, merged.targets);
    const changed = await db.intelligenceItem.updateMany({
      where: {
        id: row.id, tenantId: ctx.tenantId, customerId: row.customerId, matterId: row.matterId,
        version: input.expectedVersion, archivedAt: null,
      },
      data: {
        assertionType: merged.assertionType,
        statement: merged.statement,
        sourceKind: merged.source.kind,
        sourceDescription: merged.source.description,
        sourceRefId: merged.source.refId,
        sourceRefVersion: merged.source.refVersion,
        occurredAt: merged.occurredAt ? new Date(merged.occurredAt) : null,
        learnedAt: new Date(merged.learnedAt),
        confidence: merged.confidence,
        targetRefs: canonicalIntelligenceTargets(merged.targets),
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) conflict('intelligence_item_version_conflict');
    const version = input.expectedVersion + 1;
    await writeIntelligenceAudit(db, ctx, {
      action: 'intelligence_item_update', id: row.id, customerId: row.customerId, matterId: row.matterId,
      assertionType: merged.assertionType, sourceKind: merged.source.kind,
      sourceRefId: merged.source.refId, sourceRefVersion: merged.source.refVersion,
      confidence: merged.confidence, occurredAt: merged.occurredAt, learnedAt: merged.learnedAt,
      targets: merged.targets, version, changedFields: Object.keys(input.changes),
    });
    return intelligenceReceipt(input.type, {
      id: row.id, customerId: row.customerId, matterId: row.matterId,
      assertionType: merged.assertionType, source: merged.source, status: 'active', version,
    });
  }

  if (input.type === 'ARCHIVE_INTELLIGENCE_ITEM') {
    if (row.archivedAt) conflict('intelligence_item_version_conflict');
    const archivedAt = new Date();
    const changed = await db.intelligenceItem.updateMany({
      where: { id: row.id, tenantId: ctx.tenantId, version: input.expectedVersion, archivedAt: null },
      data: {
        archivedAt, archivedByUserId: ctx.actorId, archiveReason: input.reason,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) conflict('intelligence_item_version_conflict');
    const version = input.expectedVersion + 1;
    await writeIntelligenceAudit(db, ctx, {
      action: 'intelligence_item_archive', id: row.id, customerId: row.customerId, matterId: row.matterId,
      assertionType: current.assertionType, sourceKind: current.source.kind,
      sourceRefId: current.source.refId, sourceRefVersion: current.source.refVersion,
      confidence: current.confidence, occurredAt: current.occurredAt, learnedAt: current.learnedAt,
      targets: current.targets, version, changedFields: ['archivedAt', 'archivedByUserId', 'archiveReason'],
    });
    return intelligenceReceipt(input.type, { ...current, status: 'archived', version });
  }

  if (!row.archivedAt) conflict('intelligence_item_version_conflict');
  const changed = await db.intelligenceItem.updateMany({
    where: { id: row.id, tenantId: ctx.tenantId, version: input.expectedVersion, archivedAt: row.archivedAt },
    data: {
      archivedAt: null, archivedByUserId: null, archiveReason: '', version: { increment: 1 },
    },
  });
  if (changed.count !== 1) conflict('intelligence_item_version_conflict');
  const version = input.expectedVersion + 1;
  await writeIntelligenceAudit(db, ctx, {
    action: 'intelligence_item_restore', id: row.id, customerId: row.customerId, matterId: row.matterId,
    assertionType: current.assertionType, sourceKind: current.source.kind,
    sourceRefId: current.source.refId, sourceRefVersion: current.source.refVersion,
    confidence: current.confidence, occurredAt: current.occurredAt, learnedAt: current.learnedAt,
    targets: current.targets, version, changedFields: ['archivedAt', 'archivedByUserId', 'archiveReason'],
  });
  return intelligenceReceipt(input.type, { ...current, status: 'active', version });
}

async function readableIntelligenceRow(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  row: IntelligenceRow,
): Promise<IntelligenceItemView | null> {
  try {
    const scope = await requireParentScope(db, ctx, policy, row.customerId, row.matterId, 'read');
    return await validateIntelligenceRow(db, ctx, policy, scope, row);
  } catch (error) {
    if (error instanceof IntelligenceFocusError && error.scopedNotFound) return null;
    throw error;
  }
}

export async function listIntelligenceItems(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  query: IntelligenceItemListQuery,
): Promise<IntelligenceItemListResponse> {
  await requireParentScope(db, ctx, policy, query.customerId, query.matterId, 'read');
  const rows = await db.intelligenceItem.findMany({
    where: {
      tenantId: ctx.tenantId,
      customerId: query.customerId,
      matterId: query.matterId,
      ...(query.assertionType ? { assertionType: query.assertionType } : {}),
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.cursor ? { id: { gt: query.cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: query.limit + 1,
    select: intelligenceSelect,
  });
  const visible: IntelligenceItemView[] = [];
  for (const row of rows) {
    const item = await readableIntelligenceRow(db, ctx, policy, row);
    if (item) visible.push(item);
  }
  const hasMore = visible.length > query.limit;
  const items = visible.slice(0, query.limit);
  return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
}

export async function intelligenceItemDetail(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
): Promise<IntelligenceItemDetailResponse | null> {
  const row = await db.intelligenceItem.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: intelligenceSelect,
  });
  if (!row) return null;
  const item = await readableIntelligenceRow(db, ctx, policy, row);
  return item ? { item } : null;
}

async function requireFocusBasis(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  scope: EffectiveResourceScope,
  customerId: string,
  matterId: string,
  refs: readonly StakeholderFocusBasisRef[],
): Promise<void> {
  for (const ref of refs) {
    if (ref.kind === 'intelligence_item') {
      const item = await db.intelligenceItem.findFirst({
        where: { id: ref.id, tenantId: ctx.tenantId, customerId, matterId },
        select: intelligenceSelect,
      });
      if (!item) notFound();
      if (item.version !== ref.version) conflict('stakeholder_focus_basis_version_conflict');
      await validateIntelligenceRow(db, ctx, policy, scope, item);
    } else if (ref.kind === 'interaction') {
      try {
        await requireReadableInteraction(db, ctx, policy, scope, customerId, matterId, ref.id, ref.version);
      } catch (error) {
        if (error instanceof IntelligenceFocusError && error.code === 'intelligence_source_version_conflict') {
          conflict('stakeholder_focus_basis_version_conflict');
        }
        throw error;
      }
    } else {
      await requireReadableEvidence(
        db, ctx.tenantId, customerId, matterId, ref.id, ref.version,
        'stakeholder_focus_basis_version_conflict',
      );
    }
  }
}

async function validateFocusRow(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  scope: EffectiveResourceScope,
  row: FocusRow,
  now: Date,
) {
  let view;
  try {
    view = projectStakeholderFocus(row as StakeholderFocusProjectionRow, now);
  } catch {
    conflict('stakeholder_focus_storage_invalid');
  }
  await requireUserClosure(db, ctx.tenantId, row.confirmedByUserId);
  await requireUserClosure(db, ctx.tenantId, row.retiredByUserId);
  await requirePersonParticipant(db, ctx.tenantId, row.customerId, row.matterId, row.personId);
  await requireFocusBasis(db, ctx, policy, scope, row.customerId, row.matterId, view.basisRefs);
  return view;
}

async function writeFocusAudit(
  db: DbClient,
  ctx: CommandContext,
  input: {
    action: string;
    id: string;
    customerId: string;
    matterId: string;
    personId: string;
    basisRefs: readonly StakeholderFocusBasisRef[];
    validUntil: string;
    confirmedAt: string;
    version: number;
    replacedFocusId?: string;
    replacedFocusVersion?: number;
    changedFields: readonly string[];
  },
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: input.action,
    entityKind: 'stakeholder_focus',
    entityId: input.id,
    requestId: ctx.requestId,
    sourceRef: input.personId,
    changedFields: JSON.stringify([...input.changedFields].sort()),
    metadata: JSON.stringify({
      customerId: input.customerId,
      matterId: input.matterId,
      personId: input.personId,
      basisRefs: input.basisRefs,
      validUntil: input.validUntil,
      confirmedAt: input.confirmedAt,
      version: input.version,
      ...(input.replacedFocusId ? {
        replacedFocusId: input.replacedFocusId,
        replacedFocusVersion: input.replacedFocusVersion,
      } : {}),
    }),
  } });
}

function focusReceipt(
  type: StakeholderFocusCommand['type'],
  input: {
    id: string;
    customerId: string;
    matterId: string;
    personId: string;
    status: 'active' | 'expired' | 'retired';
    version: number;
  },
): ReceiptWithoutReplay<StakeholderFocusCommandReceipt> {
  return {
    type,
    stakeholderFocusId: input.id,
    customerId: input.customerId,
    matterId: input.matterId,
    personId: input.personId,
    status: input.status,
    version: input.version,
    undoable: false,
  };
}

export async function executeStakeholderFocusCommand(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: StakeholderFocusCommand,
  now = new Date(),
): Promise<ReceiptWithoutReplay<StakeholderFocusCommandReceipt>> {
  if (input.type === 'SET_STAKEHOLDER_FOCUS') {
    const focus = input.focus;
    const scope = await requireParentScope(db, ctx, policy, focus.customerId, focus.matterId, 'write');
    await requirePersonParticipant(db, ctx.tenantId, focus.customerId, focus.matterId, focus.personId);
    if (new Date(focus.validUntil).getTime() <= now.getTime()) {
      conflict('stakeholder_focus_validity_conflict');
    }
    await requireFocusBasis(db, ctx, policy, scope, focus.customerId, focus.matterId, focus.basisRefs);
    const current = await db.stakeholderFocus.findFirst({
      where: { tenantId: ctx.tenantId, activeMatterKey: focus.matterId },
      select: focusSelect,
    });
    const expectedNone = input.expectedCurrentFocusId === null;
    if (expectedNone) {
      if (current || input.expectedCurrentFocusVersion !== null) conflict('stakeholder_focus_current_conflict');
    } else if (!current
      || current.id !== input.expectedCurrentFocusId
      || current.version !== input.expectedCurrentFocusVersion) {
      conflict('stakeholder_focus_current_conflict');
    }
    if (current) {
      if (current.customerId !== focus.customerId || current.matterId !== focus.matterId) {
        conflict('stakeholder_focus_storage_invalid');
      }
      await validateFocusRow(db, ctx, policy, scope, current, now);
      const retired = await db.stakeholderFocus.updateMany({
        where: {
          id: current.id,
          tenantId: ctx.tenantId,
          activeMatterKey: focus.matterId,
          version: current.version,
          retiredAt: null,
        },
        data: {
          activeMatterKey: null,
          retiredByUserId: ctx.actorId,
          retiredAt: now,
          retireReason: 'replaced',
          version: { increment: 1 },
        },
      });
      if (retired.count !== 1) conflict('stakeholder_focus_current_conflict');
    }
    try {
      await db.stakeholderFocus.create({ data: {
        id: focus.id,
        tenantId: ctx.tenantId,
        customerId: focus.customerId,
        matterId: focus.matterId,
        personId: focus.personId,
        desiredChange: focus.desiredChange,
        rationale: focus.rationale,
        evidenceGap: focus.evidenceGap,
        basisRefs: canonicalFocusBasisRefs(focus.basisRefs),
        validUntil: new Date(focus.validUntil),
        activeMatterKey: focus.matterId,
        confirmedByUserId: ctx.actorId,
        confirmedAt: now,
      } });
    } catch (error) {
      if (prismaCode(error) === 'P2002') conflict('stakeholder_focus_current_conflict');
      throw error;
    }
    await writeFocusAudit(db, ctx, {
      action: 'stakeholder_focus_set', id: focus.id, customerId: focus.customerId,
      matterId: focus.matterId, personId: focus.personId, basisRefs: focus.basisRefs,
      validUntil: focus.validUntil, confirmedAt: now.toISOString(), version: 0,
      ...(current ? { replacedFocusId: current.id, replacedFocusVersion: current.version } : {}),
      changedFields: [
        'personId', 'desiredChange', 'rationale', 'evidenceGap', 'basisRefs', 'validUntil',
        'activeMatterKey', 'confirmedByUserId', 'confirmedAt',
      ],
    });
    return focusReceipt(input.type, {
      id: focus.id, customerId: focus.customerId, matterId: focus.matterId,
      personId: focus.personId, status: 'active', version: 0,
    });
  }

  const row = await db.stakeholderFocus.findFirst({
    where: { id: input.stakeholderFocusId, tenantId: ctx.tenantId }, select: focusSelect,
  });
  if (!row) notFound();
  const scope = await requireParentScope(db, ctx, policy, row.customerId, row.matterId, 'write');
  const current = await validateFocusRow(db, ctx, policy, scope, row, now);
  if (row.version !== input.expectedVersion || row.retiredAt || row.activeMatterKey !== row.matterId) {
    conflict('stakeholder_focus_version_conflict');
  }
  const retired = await db.stakeholderFocus.updateMany({
    where: {
      id: row.id,
      tenantId: ctx.tenantId,
      matterId: row.matterId,
      activeMatterKey: row.matterId,
      version: input.expectedVersion,
      retiredAt: null,
    },
    data: {
      activeMatterKey: null,
      retiredByUserId: ctx.actorId,
      retiredAt: now,
      retireReason: input.reason,
      version: { increment: 1 },
    },
  });
  if (retired.count !== 1) conflict('stakeholder_focus_version_conflict');
  const version = input.expectedVersion + 1;
  await writeFocusAudit(db, ctx, {
    action: 'stakeholder_focus_retire', id: row.id, customerId: row.customerId,
    matterId: row.matterId, personId: row.personId, basisRefs: current.basisRefs,
    validUntil: current.validUntil, confirmedAt: current.confirmedAt, version,
    changedFields: ['activeMatterKey', 'retiredByUserId', 'retiredAt', 'retireReason'],
  });
  return focusReceipt(input.type, {
    id: row.id, customerId: row.customerId, matterId: row.matterId,
    personId: row.personId, status: 'retired', version,
  });
}

async function readableFocusRow(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  row: FocusRow,
  now: Date,
) {
  try {
    const scope = await requireParentScope(db, ctx, policy, row.customerId, row.matterId, 'read');
    return await validateFocusRow(db, ctx, policy, scope, row, now);
  } catch (error) {
    if (error instanceof IntelligenceFocusError && error.scopedNotFound) return null;
    throw error;
  }
}

export async function listStakeholderFocuses(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  query: StakeholderFocusListQuery,
  now = new Date(),
): Promise<StakeholderFocusListResponse> {
  await requireParentScope(db, ctx, policy, query.customerId, query.matterId, 'read');
  const rows = await db.stakeholderFocus.findMany({
    where: {
      tenantId: ctx.tenantId,
      customerId: query.customerId,
      matterId: query.matterId,
      ...(query.includeRetired ? {} : { retiredAt: null }),
      ...(query.cursor ? { id: { gt: query.cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: query.limit + 1,
    select: focusSelect,
  });
  const visible = [];
  for (const row of rows) {
    const item = await readableFocusRow(db, ctx, policy, row, now);
    if (item) visible.push(item);
  }
  const hasMore = visible.length > query.limit;
  const items = visible.slice(0, query.limit);
  return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
}

export async function stakeholderFocusDetail(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  now = new Date(),
): Promise<StakeholderFocusDetailResponse | null> {
  const row = await db.stakeholderFocus.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: focusSelect,
  });
  if (!row) return null;
  const item = await readableFocusRow(db, ctx, policy, row, now);
  return item ? { item } : null;
}

/** Current-snapshot authorization used before a CommandRun is created and again for completed replays. */
export async function assertIntelligenceItemCommandAccess(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: IntelligenceItemCommand,
): Promise<void> {
  if (input.type === 'CREATE_INTELLIGENCE_ITEM') {
    await requireParentScope(db, ctx, policy, input.item.customerId, input.item.matterId, 'write');
    return;
  }
  const row = await db.intelligenceItem.findFirst({
    where: { id: input.intelligenceItemId, tenantId: ctx.tenantId },
    select: { customerId: true, matterId: true },
  });
  if (!row) notFound();
  await requireParentScope(db, ctx, policy, row.customerId, row.matterId, 'write');
}

export async function assertStakeholderFocusCommandAccess(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: StakeholderFocusCommand,
): Promise<void> {
  if (input.type === 'SET_STAKEHOLDER_FOCUS') {
    await requireParentScope(db, ctx, policy, input.focus.customerId, input.focus.matterId, 'write');
    return;
  }
  const row = await db.stakeholderFocus.findFirst({
    where: { id: input.stakeholderFocusId, tenantId: ctx.tenantId },
    select: { customerId: true, matterId: true },
  });
  if (!row) notFound();
  await requireParentScope(db, ctx, policy, row.customerId, row.matterId, 'write');
}
