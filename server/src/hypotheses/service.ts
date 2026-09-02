import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  CommandContextSchema,
  SalesHypothesisCommandSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
  type HypothesisEvidenceLinkView,
  type SalesHypothesisCommand,
  type SalesHypothesisCommandReceipt,
  type SalesHypothesisDetailQuery,
  type SalesHypothesisDetailResponse,
  type SalesHypothesisListQuery,
  type SalesHypothesisListResponse,
  type SalesHypothesisRevisionView,
  type SalesHypothesisStatusSuggestion,
  type SalesHypothesisView,
} from '@jianghu/domain-contracts';
import { activePersonWhere } from '../activePerson.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope, type EffectiveResourceScope } from '../resourceScope.js';
import {
  canonicalHypothesisStrings,
  hypothesisStatusSuggestion as projectStatusSuggestion,
  projectHypothesisEvidenceLink,
  projectSalesHypothesis,
  projectSalesHypothesisRevision,
  SalesHypothesisStorageError,
} from './model.js';

export class SalesHypothesisError extends Error {
  readonly scopedNotFound: boolean;
  constructor(readonly code: string, readonly statusCode = 409, scopedNotFound = false) {
    super(code);
    this.name = 'SalesHypothesisError';
    this.scopedNotFound = scopedNotFound;
  }
}

type ReceiptWithoutReplay = Omit<SalesHypothesisCommandReceipt, 'replayed'>;

const hypothesisSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  personId: true,
  status: true,
  ownerUserId: true,
  nextReviewAt: true,
  currentRevisionId: true,
  legacyStrategyRiskId: true,
  createdByUserId: true,
  statusConfirmedByUserId: true,
  statusConfirmedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const revisionSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  revisionNumber: true,
  claim: true,
  reason: true,
  expectedSignals: true,
  falsificationConditions: true,
  origin: true,
  createdByUserId: true,
  createdAt: true,
} as const;

const linkSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  hypothesisRevisionId: true,
  evidenceId: true,
  evidenceVersion: true,
  direction: true,
  verificationCommitmentId: true,
  linkedByUserId: true,
  linkedAt: true,
} as const;

type HypothesisRow = Prisma.SalesHypothesisGetPayload<{ select: typeof hypothesisSelect }>;
type RevisionRow = Prisma.SalesHypothesisRevisionGetPayload<{ select: typeof revisionSelect }>;
type LinkRow = Prisma.HypothesisEvidenceLinkGetPayload<{ select: typeof linkSelect }>;

function notFound(): never {
  throw new SalesHypothesisError('sales_hypothesis_not_found', 404, true);
}

function conflict(code: string): never {
  throw new SalesHypothesisError(code, 409);
}

function storageInvalid(): never {
  throw new SalesHypothesisError('sales_hypothesis_storage_invalid', 409);
}

function requireSalesCapability(policy: CapabilityPolicy): void {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new SalesHypothesisError('capability_denied', 403);
  }
}

function requireHumanConfirmation(ctx: CommandContext): void {
  if (ctx.assertionMode !== 'user_asserted') {
    throw new SalesHypothesisError('human_confirmation_required', 403);
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
      throw new SalesHypothesisError('viewer_write_denied', 403);
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

async function requireTenantUser(db: DbClient, tenantId: string, userId: string | null): Promise<void> {
  if (userId === null) return;
  const row = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!row) notFound();
}

async function validateStoredTenantUser(
  db: DbClient,
  tenantId: string,
  userId: string | null,
): Promise<void> {
  if (userId === null) return;
  const row = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!row) storageInvalid();
}

async function requirePersonParticipant(
  db: DbClient,
  tenantId: string,
  customerId: string,
  matterId: string,
  personId: string | null,
): Promise<void> {
  if (personId === null) return;
  const row = await db.matterParticipant.findFirst({
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
  if (!row) notFound();
}

function requireFutureReview(reviewAt: string, now: Date): Date {
  const parsed = new Date(reviewAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    conflict('sales_hypothesis_review_time_conflict');
  }
  return parsed;
}

function prismaCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function receipt(
  type: SalesHypothesisCommand['type'],
  row: Pick<HypothesisRow, 'id' | 'customerId' | 'matterId' | 'currentRevisionId' | 'status' | 'version'>,
  currentRevisionNumber: number,
  evidenceLinkId: string | null = null,
  verificationCommitmentId: string | null = null,
): ReceiptWithoutReplay {
  return {
    type,
    salesHypothesisId: row.id,
    customerId: row.customerId,
    matterId: row.matterId,
    currentRevisionId: row.currentRevisionId,
    currentRevisionNumber,
    evidenceLinkId,
    verificationCommitmentId,
    status: row.status as ReceiptWithoutReplay['status'],
    version: row.version,
    undoable: false,
  };
}

async function writeAudit(
  db: DbClient,
  ctx: CommandContext,
  input: {
    action: string;
    hypothesisId: string;
    customerId: string;
    matterId: string;
    currentRevisionId: string;
    revisionNumber: number;
    status: string;
    version: number;
    changedFields: readonly string[];
    ownerUserId?: string | null;
    nextReviewAt?: Date | null;
    evidenceLinkId?: string;
    evidenceId?: string;
    evidenceVersion?: number;
    direction?: string;
    verificationCommitmentId?: string | null;
  },
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: input.action,
    entityKind: 'sales_hypothesis',
    entityId: input.hypothesisId,
    requestId: ctx.requestId,
    sourceRef: input.evidenceId ?? input.currentRevisionId,
    changedFields: JSON.stringify([...input.changedFields].sort()),
    metadata: JSON.stringify({
      customerId: input.customerId,
      matterId: input.matterId,
      currentRevisionId: input.currentRevisionId,
      revisionNumber: input.revisionNumber,
      status: input.status,
      version: input.version,
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.nextReviewAt !== undefined
        ? { nextReviewAt: input.nextReviewAt?.toISOString() ?? null }
        : {}),
      ...(input.evidenceLinkId ? {
        evidenceLinkId: input.evidenceLinkId,
        evidenceId: input.evidenceId,
        evidenceVersion: input.evidenceVersion,
        direction: input.direction,
        verificationCommitmentId: input.verificationCommitmentId ?? null,
      } : {}),
    }),
  } });
}

async function findHypothesis(db: DbClient, tenantId: string, id: string): Promise<HypothesisRow> {
  const row = await db.salesHypothesis.findFirst({
    where: { id, tenantId }, select: hypothesisSelect,
  });
  if (!row) notFound();
  return row;
}

async function requireApprovedEvidence(
  db: DbClient,
  tenantId: string,
  customerId: string,
  matterId: string,
  evidenceId: string,
  evidenceVersion: number,
): Promise<void> {
  if (evidenceVersion !== 0) conflict('hypothesis_evidence_version_conflict');
  const row = await db.evidenceEvent.findFirst({
    where: {
      id: evidenceId,
      tenantId,
      accountId: customerId,
      opportunityId: matterId,
      status: 'approved',
    },
    select: { id: true },
  });
  if (!row) notFound();
}

async function requireVerificationCommitment(
  db: DbClient,
  ctx: CommandContext,
  row: Pick<HypothesisRow, 'id' | 'customerId' | 'matterId' | 'currentRevisionId'>,
  commitmentId: string | null,
  lock: boolean,
): Promise<void> {
  if (commitmentId === null) return;
  const commitment = await db.planAction.findFirst({
    where: {
      id: commitmentId,
      tenantId: ctx.tenantId,
      accountId: row.customerId,
      opportunityId: row.matterId,
      hypothesisId: row.id,
      hypothesisRevisionId: row.currentRevisionId,
      archivedAt: null,
    },
    select: {
      version: true,
      kind: true,
      executionStatus: true,
      completionResult: true,
      completionResultRecordedAtUtc: true,
      completionResultRecordedByUserId: true,
      verificationReviewDisposition: true,
      verificationReviewedAtUtc: true,
      verificationReviewedByUserId: true,
    },
  });
  if (!commitment) notFound();
  if (commitment.kind !== 'verification'
    || commitment.executionStatus !== 'completed'
    || commitment.completionResult.length === 0
    || !commitment.completionResultRecordedAtUtc
    || !commitment.completionResultRecordedByUserId) {
    conflict('hypothesis_verification_commitment_not_ready');
  }
  if (commitment.verificationReviewDisposition.length > 0
    || commitment.verificationReviewedAtUtc
    || commitment.verificationReviewedByUserId) {
    conflict('hypothesis_verification_commitment_already_reviewed');
  }
  await requireTenantUser(db, ctx.tenantId, commitment.completionResultRecordedByUserId);
  if (!lock) return;
  const locked = await db.planAction.updateMany({
    where: {
      id: commitmentId,
      tenantId: ctx.tenantId,
      accountId: row.customerId,
      opportunityId: row.matterId,
      hypothesisId: row.id,
      hypothesisRevisionId: row.currentRevisionId,
      archivedAt: null,
      version: commitment.version,
      kind: 'verification',
      executionStatus: 'completed',
      completionResult: commitment.completionResult,
      completionResultRecordedAtUtc: commitment.completionResultRecordedAtUtc,
      completionResultRecordedByUserId: commitment.completionResultRecordedByUserId,
      verificationReviewDisposition: '',
      verificationReviewedAtUtc: null,
      verificationReviewedByUserId: null,
    },
    data: { version: { increment: 0 } },
  });
  if (locked.count !== 1) conflict('hypothesis_verification_commitment_state_conflict');
}

async function requireCreateAccess(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  command: Extract<SalesHypothesisCommand, { type: 'CREATE_SALES_HYPOTHESIS' }>,
  now: Date,
): Promise<void> {
  const item = command.hypothesis;
  await requireParentScope(db, ctx, policy, item.customerId, item.matterId, 'write');
  await requirePersonParticipant(db, ctx.tenantId, item.customerId, item.matterId, item.personId);
  await requireTenantUser(db, ctx.tenantId, item.ownerUserId);
  requireFutureReview(item.nextReviewAt, now);
}

async function requireExistingAccess(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  intent: 'read' | 'write',
): Promise<HypothesisRow> {
  const row = await findHypothesis(db, ctx.tenantId, id);
  await requireParentScope(db, ctx, policy, row.customerId, row.matterId, intent);
  return row;
}

export async function assertSalesHypothesisCommandAccess(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  rawCommand: SalesHypothesisCommand,
  now = new Date(),
): Promise<void> {
  const command = SalesHypothesisCommandSchema.parse(rawCommand);
  if (command.type === 'CREATE_SALES_HYPOTHESIS') {
    await requireCreateAccess(db, ctx, policy, command, now);
    return;
  }
  const hypothesisId = command.type === 'LINK_HYPOTHESIS_EVIDENCE'
    ? command.link.salesHypothesisId
    : command.salesHypothesisId;
  const row = await requireExistingAccess(db, ctx, policy, hypothesisId, 'write');
  if (command.type === 'UPDATE_SALES_HYPOTHESIS_REVIEW') {
    await requireTenantUser(db, ctx.tenantId, command.ownerUserId);
    requireFutureReview(command.nextReviewAt, now);
  } else if (command.type === 'REVISE_SALES_HYPOTHESIS') {
    requireFutureReview(command.nextReviewAt, now);
  } else if (command.type === 'LINK_HYPOTHESIS_EVIDENCE') {
    await requireApprovedEvidence(
      db, ctx.tenantId, row.customerId, row.matterId,
      command.link.evidenceId, command.link.evidenceVersion,
    );
    if (row.currentRevisionId !== command.link.expectedCurrentRevisionId) {
      conflict('sales_hypothesis_current_revision_conflict');
    }
    await requireVerificationCommitment(
      db,
      ctx,
      row,
      command.link.verificationCommitmentId,
      false,
    );
  }
}

async function historyFor(
  db: DbClient,
  row: HypothesisRow,
): Promise<{ revisions: RevisionRow[]; views: SalesHypothesisRevisionView[]; current: SalesHypothesisRevisionView }> {
  const revisions = await db.salesHypothesisRevision.findMany({
    where: { tenantId: row.tenantId, hypothesisId: row.id },
    orderBy: { revisionNumber: 'asc' },
    select: revisionSelect,
  });
  if (revisions.length === 0) storageInvalid();
  const views: SalesHypothesisRevisionView[] = [];
  for (const [index, revision] of revisions.entries()) {
    if (revision.revisionNumber !== index + 1) storageInvalid();
    try {
      views.push(projectSalesHypothesisRevision(revision));
    } catch (error) {
      if (error instanceof SalesHypothesisStorageError) storageInvalid();
      throw error;
    }
    await validateStoredTenantUser(db, row.tenantId, revision.createdByUserId);
  }
  const current = views.at(-1);
  if (!current || current.id !== row.currentRevisionId) storageInvalid();
  return { revisions, views, current };
}

async function validateHypothesis(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  row: HypothesisRow,
  intent: 'read' | 'write',
): Promise<{
  scope: EffectiveResourceScope;
  view: SalesHypothesisView;
  revisions: RevisionRow[];
  revisionViews: SalesHypothesisRevisionView[];
}> {
  const scope = await requireParentScope(db, ctx, policy, row.customerId, row.matterId, intent);
  try {
    await requirePersonParticipant(db, row.tenantId, row.customerId, row.matterId, row.personId);
  } catch (error) {
    if (error instanceof SalesHypothesisError && error.scopedNotFound) storageInvalid();
    throw error;
  }
  await validateStoredTenantUser(db, row.tenantId, row.ownerUserId);
  await validateStoredTenantUser(db, row.tenantId, row.createdByUserId);
  await validateStoredTenantUser(db, row.tenantId, row.statusConfirmedByUserId);
  const history = await historyFor(db, row);
  let view: SalesHypothesisView;
  try {
    view = projectSalesHypothesis(row, history.current);
  } catch (error) {
    if (error instanceof SalesHypothesisStorageError) storageInvalid();
    throw error;
  }
  return {
    scope,
    view,
    revisions: history.revisions,
    revisionViews: history.views,
  };
}

async function linksForRevisions(
  db: DbClient,
  row: HypothesisRow,
  revisions: readonly RevisionRow[],
): Promise<Map<string, HypothesisEvidenceLinkView[]>> {
  const revisionIds = revisions.map((revision) => revision.id);
  const rows = revisionIds.length === 0
    ? []
    : await db.hypothesisEvidenceLink.findMany({
        where: { tenantId: row.tenantId, hypothesisRevisionId: { in: revisionIds } },
        orderBy: [{ linkedAt: 'asc' }, { id: 'asc' }],
        select: linkSelect,
      });
  const revisionSet = new Set(revisionIds);
  const grouped = new Map<string, HypothesisEvidenceLinkView[]>();
  for (const link of rows) {
    if (link.hypothesisId !== row.id || !revisionSet.has(link.hypothesisRevisionId)) storageInvalid();
    const [evidence, user, verificationCommitment] = await Promise.all([
      db.evidenceEvent.findFirst({
        where: {
          id: link.evidenceId,
          tenantId: row.tenantId,
          accountId: row.customerId,
          opportunityId: row.matterId,
          status: 'approved',
        },
        select: { id: true },
      }),
      db.user.findFirst({
        where: { id: link.linkedByUserId, tenantId: row.tenantId }, select: { id: true },
      }),
      link.verificationCommitmentId === null
        ? Promise.resolve({ id: null })
        : db.planAction.findFirst({
            where: {
              id: link.verificationCommitmentId,
              tenantId: row.tenantId,
              accountId: row.customerId,
              opportunityId: row.matterId,
              hypothesisId: row.id,
              hypothesisRevisionId: link.hypothesisRevisionId,
              archivedAt: null,
            },
            select: { id: true },
          }),
    ]);
    if (!evidence || !user || !verificationCommitment) storageInvalid();
    let view: HypothesisEvidenceLinkView;
    try {
      view = projectHypothesisEvidenceLink(link);
    } catch (error) {
      if (error instanceof SalesHypothesisStorageError) storageInvalid();
      throw error;
    }
    const current = grouped.get(link.hypothesisRevisionId) ?? [];
    current.push(view);
    if (current.length > 50) storageInvalid();
    grouped.set(link.hypothesisRevisionId, current);
  }
  return grouped;
}

export async function executeSalesHypothesisCommand(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  rawCommand: SalesHypothesisCommand,
  now = new Date(),
): Promise<ReceiptWithoutReplay> {
  const command = SalesHypothesisCommandSchema.parse(rawCommand);
  await assertSalesHypothesisCommandAccess(db, ctx, policy, command, now);

  if (command.type === 'CREATE_SALES_HYPOTHESIS') {
    const item = command.hypothesis;
    const reviewAt = requireFutureReview(item.nextReviewAt, now);
    try {
      await db.salesHypothesis.create({ data: {
        id: item.id,
        tenantId: ctx.tenantId,
        customerId: item.customerId,
        matterId: item.matterId,
        personId: item.personId,
        status: 'untested',
        ownerUserId: item.ownerUserId,
        nextReviewAt: reviewAt,
        currentRevisionId: item.revision.id,
        createdByUserId: ctx.actorId,
        createdAt: now,
      } });
      await db.salesHypothesisRevision.create({ data: {
        id: item.revision.id,
        tenantId: ctx.tenantId,
        hypothesisId: item.id,
        revisionNumber: 1,
        claim: item.revision.claim,
        reason: item.revision.reason,
        expectedSignals: canonicalHypothesisStrings(item.revision.expectedSignals),
        falsificationConditions: canonicalHypothesisStrings(item.revision.falsificationConditions),
        origin: 'user',
        createdByUserId: ctx.actorId,
        createdAt: now,
      } });
    } catch (error) {
      if (prismaCode(error) === 'P2002') conflict('sales_hypothesis_id_conflict');
      throw error;
    }
    const result = {
      id: item.id,
      customerId: item.customerId,
      matterId: item.matterId,
      currentRevisionId: item.revision.id,
      status: 'untested',
      version: 0,
    } as const;
    await writeAudit(db, ctx, {
      action: 'sales_hypothesis_create',
      hypothesisId: item.id,
      customerId: item.customerId,
      matterId: item.matterId,
      currentRevisionId: item.revision.id,
      revisionNumber: 1,
      status: 'untested',
      version: 0,
      ownerUserId: item.ownerUserId,
      nextReviewAt: reviewAt,
      changedFields: ['currentRevisionId', 'ownerUserId', 'nextReviewAt', 'status'],
    });
    return receipt(command.type, result, 1);
  }

  const hypothesisId = command.type === 'LINK_HYPOTHESIS_EVIDENCE'
    ? command.link.salesHypothesisId
    : command.salesHypothesisId;
  const expectedVersion = command.type === 'LINK_HYPOTHESIS_EVIDENCE'
    ? command.link.expectedVersion
    : command.expectedVersion;
  const row = await findHypothesis(db, ctx.tenantId, hypothesisId);
  const validated = await validateHypothesis(db, ctx, policy, row, 'write');
  if (row.version !== expectedVersion) conflict('sales_hypothesis_version_conflict');
  const currentRevision = validated.revisionViews.at(-1)!;

  if (command.type === 'REVISE_SALES_HYPOTHESIS') {
    if (row.currentRevisionId !== command.expectedCurrentRevisionId) {
      conflict('sales_hypothesis_current_revision_conflict');
    }
    const reviewAt = requireFutureReview(command.nextReviewAt, now);
    const revisionNumber = currentRevision.revisionNumber + 1;
    try {
      await db.salesHypothesisRevision.create({ data: {
        id: command.revision.id,
        tenantId: ctx.tenantId,
        hypothesisId: row.id,
        revisionNumber,
        claim: command.revision.claim,
        reason: command.revision.reason,
        expectedSignals: canonicalHypothesisStrings(command.revision.expectedSignals),
        falsificationConditions: canonicalHypothesisStrings(command.revision.falsificationConditions),
        origin: 'user',
        createdByUserId: ctx.actorId,
        createdAt: now,
      } });
    } catch (error) {
      if (prismaCode(error) === 'P2002') conflict('sales_hypothesis_revision_conflict');
      throw error;
    }
    const changed = await db.salesHypothesis.updateMany({
      where: {
        id: row.id,
        tenantId: ctx.tenantId,
        version: command.expectedVersion,
        currentRevisionId: command.expectedCurrentRevisionId,
      },
      data: {
        currentRevisionId: command.revision.id,
        nextReviewAt: reviewAt,
        status: 'untested',
        statusConfirmedByUserId: null,
        statusConfirmedAt: null,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) conflict('sales_hypothesis_version_conflict');
    const result = { ...row, currentRevisionId: command.revision.id, status: 'untested', version: row.version + 1 };
    await writeAudit(db, ctx, {
      action: 'sales_hypothesis_revise', hypothesisId: row.id,
      customerId: row.customerId, matterId: row.matterId,
      currentRevisionId: command.revision.id, revisionNumber, status: 'untested',
      version: result.version, nextReviewAt: reviewAt,
      changedFields: ['currentRevisionId', 'nextReviewAt', 'status', 'statusConfirmedAt', 'statusConfirmedByUserId'],
    });
    return receipt(command.type, result, revisionNumber);
  }

  if (command.type === 'UPDATE_SALES_HYPOTHESIS_REVIEW') {
    const reviewAt = requireFutureReview(command.nextReviewAt, now);
    const changed = await db.salesHypothesis.updateMany({
      where: { id: row.id, tenantId: ctx.tenantId, version: command.expectedVersion },
      data: {
        ownerUserId: command.ownerUserId,
        nextReviewAt: reviewAt,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) conflict('sales_hypothesis_version_conflict');
    const result = { ...row, ownerUserId: command.ownerUserId, nextReviewAt: reviewAt, version: row.version + 1 };
    await writeAudit(db, ctx, {
      action: 'sales_hypothesis_review_update', hypothesisId: row.id,
      customerId: row.customerId, matterId: row.matterId,
      currentRevisionId: row.currentRevisionId, revisionNumber: currentRevision.revisionNumber,
      status: row.status, version: result.version, ownerUserId: command.ownerUserId,
      nextReviewAt: reviewAt, changedFields: ['ownerUserId', 'nextReviewAt'],
    });
    return receipt(command.type, result, currentRevision.revisionNumber);
  }

  if (command.type === 'SET_SALES_HYPOTHESIS_STATUS') {
    const changed = await db.salesHypothesis.updateMany({
      where: { id: row.id, tenantId: ctx.tenantId, version: command.expectedVersion },
      data: {
        status: command.status,
        statusConfirmedByUserId: ctx.actorId,
        statusConfirmedAt: now,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) conflict('sales_hypothesis_version_conflict');
    const result = { ...row, status: command.status, version: row.version + 1 };
    await writeAudit(db, ctx, {
      action: 'sales_hypothesis_status_set', hypothesisId: row.id,
      customerId: row.customerId, matterId: row.matterId,
      currentRevisionId: row.currentRevisionId, revisionNumber: currentRevision.revisionNumber,
      status: command.status, version: result.version,
      changedFields: ['status', 'statusConfirmedByUserId', 'statusConfirmedAt'],
    });
    return receipt(command.type, result, currentRevision.revisionNumber);
  }

  if (row.currentRevisionId !== command.link.expectedCurrentRevisionId) {
    conflict('sales_hypothesis_current_revision_conflict');
  }
  await requireVerificationCommitment(
    db,
    ctx,
    row,
    command.link.verificationCommitmentId,
    true,
  );
  const linkCount = await db.hypothesisEvidenceLink.count({
    where: { tenantId: ctx.tenantId, hypothesisRevisionId: row.currentRevisionId },
  });
  if (linkCount >= 50) conflict('hypothesis_evidence_limit_exceeded');
  try {
    await db.hypothesisEvidenceLink.create({ data: {
      id: command.link.id,
      tenantId: ctx.tenantId,
      hypothesisId: row.id,
      hypothesisRevisionId: row.currentRevisionId,
      evidenceId: command.link.evidenceId,
      evidenceVersion: command.link.evidenceVersion,
      direction: command.link.direction,
      verificationCommitmentId: command.link.verificationCommitmentId,
      linkedByUserId: ctx.actorId,
      linkedAt: now,
    } });
  } catch (error) {
    if (prismaCode(error) === 'P2002') conflict('hypothesis_evidence_conflict');
    throw error;
  }
  const changed = await db.salesHypothesis.updateMany({
    where: {
      id: row.id,
      tenantId: ctx.tenantId,
      version: command.link.expectedVersion,
      currentRevisionId: command.link.expectedCurrentRevisionId,
    },
    data: { version: { increment: 1 } },
  });
  if (changed.count !== 1) conflict('sales_hypothesis_version_conflict');
  const result = { ...row, version: row.version + 1 };
  await writeAudit(db, ctx, {
    action: 'sales_hypothesis_evidence_link', hypothesisId: row.id,
    customerId: row.customerId, matterId: row.matterId,
    currentRevisionId: row.currentRevisionId, revisionNumber: currentRevision.revisionNumber,
    status: row.status, version: result.version,
    evidenceLinkId: command.link.id, evidenceId: command.link.evidenceId,
    evidenceVersion: command.link.evidenceVersion, direction: command.link.direction,
    verificationCommitmentId: command.link.verificationCommitmentId,
    changedFields: ['evidenceLinks'],
  });
  return receipt(
    command.type,
    result,
    currentRevision.revisionNumber,
    command.link.id,
    command.link.verificationCommitmentId,
  );
}

function decodeCursor(value: string): { updatedAt: Date; id: string } {
  try {
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(raw) || raw.length !== 2
      || typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
      conflict('sales_hypothesis_cursor_invalid');
    }
    const updatedAt = new Date(raw[0]);
    if (!Number.isFinite(updatedAt.getTime()) || raw[1].length === 0) {
      conflict('sales_hypothesis_cursor_invalid');
    }
    return { updatedAt, id: raw[1] };
  } catch (error) {
    if (error instanceof SalesHypothesisError) throw error;
    return conflict('sales_hypothesis_cursor_invalid');
  }
}

function encodeCursor(row: Pick<HypothesisRow, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.updatedAt.toISOString(), row.id])).toString('base64url');
}

export async function listSalesHypotheses(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  query: SalesHypothesisListQuery,
): Promise<SalesHypothesisListResponse> {
  await requireParentScope(db, ctx, policy, query.customerId, query.matterId, 'read');
  const decodedCursor = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await db.salesHypothesis.findMany({
    where: {
      tenantId: ctx.tenantId,
      customerId: query.customerId,
      matterId: query.matterId,
      ...(query.personId ? { personId: query.personId } : {}),
      ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
      ...(query.status
        ? { status: query.status }
        : query.includeRetired ? {} : { status: { not: 'retired' } }),
      ...(decodedCursor ? {
        OR: [
          { updatedAt: { lt: decodedCursor.updatedAt } },
          { updatedAt: decodedCursor.updatedAt, id: { lt: decodedCursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: hypothesisSelect,
  });
  const selected = rows.slice(0, query.limit);
  const items: SalesHypothesisView[] = [];
  for (const row of selected) {
    items.push((await validateHypothesis(db, ctx, policy, row, 'read')).view);
  }
  return {
    items,
    nextCursor: rows.length > query.limit && selected.length > 0
      ? encodeCursor(selected.at(-1)!)
      : null,
  };
}

export async function salesHypothesisDetail(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  query: SalesHypothesisDetailQuery,
): Promise<SalesHypothesisDetailResponse | null> {
  const row = await db.salesHypothesis.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: hypothesisSelect,
  });
  if (!row) return null;
  let validated;
  try {
    validated = await validateHypothesis(db, ctx, policy, row, 'read');
  } catch (error) {
    if (error instanceof SalesHypothesisError && error.scopedNotFound) return null;
    throw error;
  }
  const descending = [...validated.revisions].reverse()
    .filter((revision) => query.beforeRevisionNumber === null
      || revision.revisionNumber < query.beforeRevisionNumber);
  const selected = descending.slice(0, query.limit);
  const links = await linksForRevisions(db, row, selected);
  const viewById = new Map(validated.revisionViews.map((view) => [view.id, view]));
  return {
    item: validated.view,
    revisions: selected.map((revision) => ({
      revision: viewById.get(revision.id)!,
      evidenceLinks: links.get(revision.id) ?? [],
    })),
    nextRevisionBefore: descending.length > query.limit && selected.length > 0
      ? selected.at(-1)!.revisionNumber
      : null,
  };
}

export async function salesHypothesisStatusSuggestion(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
): Promise<SalesHypothesisStatusSuggestion | null> {
  const row = await db.salesHypothesis.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: hypothesisSelect,
  });
  if (!row) return null;
  let validated;
  try {
    validated = await validateHypothesis(db, ctx, policy, row, 'read');
  } catch (error) {
    if (error instanceof SalesHypothesisError && error.scopedNotFound) return null;
    throw error;
  }
  const current = validated.revisions.at(-1)!;
  const links = await linksForRevisions(db, row, [current]);
  return projectStatusSuggestion(
    row.id,
    row.currentRevisionId,
    validated.view.status,
    links.get(row.currentRevisionId) ?? [],
  );
}
