import { randomUUID } from 'node:crypto';
import {
  ActorRoleSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { Prisma } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  authorizeSensitiveResource,
  candidateDescriptor,
  createSensitiveAccessEvaluator,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import { sourceArtifactMetadataIsValid } from '../sourceArtifacts/service.js';
import { REVIEW_CANDIDATE_KINDS, validateReviewBatchMetadata } from './model.js';

export class ReviewBatchError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly scopedNotFound: boolean;

  constructor(code: string, statusCode = 409, scopedNotFound = false) {
    super(code);
    this.name = 'ReviewBatchError';
    this.code = code;
    this.statusCode = statusCode;
    this.scopedNotFound = scopedNotFound;
  }
}

export interface ReviewBatchContext extends CommandContext {
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface CandidateAttachmentInput {
  id: string;
  expectedVersion: number;
  expectedAclVersion: number;
}

export interface CreateReviewBatchInput {
  id?: string;
  sourceArtifactId: string;
  expectedSourceAclVersion: number;
  candidates: CandidateAttachmentInput[];
}

export interface CreateReviewBatchAuthorization {
  /** Public/manual creation requires manage; the trusted Agent port may use current read ACL. */
  sourceIntent: 'manage' | 'read';
  grantActorReviewer: boolean;
}

const sourceSelect = {
  id: true,
  tenantId: true,
  accountId: true,
  matterId: true,
  personId: true,
  backingKind: true,
  backingId: true,
  artifactKind: true,
  source: true,
  externalRef: true,
  idempotencyDomain: true,
  title: true,
  occurredAt: true,
  fingerprintKind: true,
  sourceFingerprint: true,
  retentionState: true,
  retentionUpdatedAt: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;
type SourceRow = Prisma.SourceArtifactGetPayload<{ select: typeof sourceSelect }>;

const candidateMetadataSelect = {
  id: true,
  tenantId: true,
  kind: true,
  status: true,
  accountId: true,
  matterId: true,
  targetKind: true,
  targetId: true,
  fieldKey: true,
  sourceArtifactId: true,
  reviewBatchId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  legacySourceKind: true,
  legacySourceId: true,
  version: true,
} as const;
export type ReviewCandidateMetadata = Prisma.CandidateGetPayload<{ select: typeof candidateMetadataSelect }>;

const batchMetadataSelect = {
  id: true,
  tenantId: true,
  sourceArtifactId: true,
  accountId: true,
  matterId: true,
  status: true,
  activityKind: true,
  occurredAt: true,
  interactionId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  acceptanceVersion: true,
  version: true,
  lastAcceptanceVersion: true,
  lastAcceptanceHash: true,
  lastAcceptanceResult: true,
  reviewedByUserId: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
export type ReviewBatchMetadata = Prisma.ReviewBatchGetPayload<{ select: typeof batchMetadataSelect }>;

const allowedBatchKinds = new Set<string>(REVIEW_CANDIDATE_KINDS);

function notFound(): never {
  throw new ReviewBatchError('review_batch_not_found', 404, true);
}

function candidateConflict(code: string): never {
  throw new ReviewBatchError(code, 409);
}

async function currentActorRole(db: DbClient, ctx: ReviewBatchContext) {
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId }, select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success) notFound();
  return role.data;
}

async function loadSource(db: DbClient, tenantId: string, id: string): Promise<SourceRow> {
  const row = await db.sourceArtifact.findFirst({ where: { id, tenantId }, select: sourceSelect });
  if (!row || !sourceArtifactMetadataIsValid(row)) notFound();
  return row;
}

async function authorizeSource(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  source: SourceRow,
  intent: 'read' | 'manage',
): Promise<'owner' | 'admin' | 'member' | 'viewer'> {
  const role = await currentActorRole(db, ctx);
  if (intent === 'manage' && role === 'viewer') {
    throw new ReviewBatchError('viewer_write_denied', 403);
  }
  const access = await authorizeSensitiveResource(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role,
  }, policy, sourceArtifactDescriptor(source), intent);
  if (!access.allowed) notFound();
  return role;
}

function assertAttachmentInput(input: CreateReviewBatchInput): void {
  if (!input.sourceArtifactId.trim()
    || !Number.isSafeInteger(input.expectedSourceAclVersion)
    || input.expectedSourceAclVersion < 1
    || input.candidates.length < 1
    || input.candidates.length > 100) {
    candidateConflict('review_batch_input_invalid');
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate.id.trim()
      || !Number.isSafeInteger(candidate.expectedVersion) || candidate.expectedVersion < 0
      || !Number.isSafeInteger(candidate.expectedAclVersion) || candidate.expectedAclVersion < 1
      || ids.has(candidate.id)) {
      candidateConflict('review_batch_input_invalid');
    }
    ids.add(candidate.id);
  }
}

function batchView(batch: ReviewBatchMetadata, candidates: readonly ReviewCandidateMetadata[]) {
  return {
    id: batch.id,
    sourceArtifactId: batch.sourceArtifactId,
    accountId: batch.accountId,
    matterId: batch.matterId,
    status: batch.status,
    activityKind: batch.activityKind,
    occurredAt: batch.occurredAt?.toISOString() ?? null,
    interactionId: batch.interactionId,
    visibility: batch.visibility,
    aclVersion: batch.aclVersion,
    acceptanceVersion: batch.acceptanceVersion,
    version: batch.version,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      status: candidate.status,
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      fieldKey: candidate.fieldKey,
      version: candidate.version,
      aclVersion: candidate.aclVersion,
    })),
  };
}

function sourceMatchesBatch(
  batch: ReviewBatchMetadata,
  source: SourceRow,
  intent: 'read' | 'review',
): boolean {
  const valid = validateReviewBatchMetadata(batch);
  return valid.ok
    && sourceArtifactMetadataIsValid(source)
    && source.id === batch.sourceArtifactId
    && source.accountId === batch.accountId
    && source.matterId === batch.matterId
    && source.createdByUserId === batch.createdByUserId
    && source.visibility === batch.visibility
    && source.aclVersion === batch.aclVersion
    && !(intent === 'review' && source.retentionState === 'deleted');
}

function candidatesMatchBatch(
  batch: ReviewBatchMetadata,
  source: SourceRow,
  candidates: readonly ReviewCandidateMetadata[],
): boolean {
  if (candidates.length === 0) return false;
  let pending = 0;
  let accepted = 0;
  for (const candidate of candidates) {
    if (!allowedBatchKinds.has(candidate.kind)
      || !['pending', 'accepted', 'rejected'].includes(candidate.status)
      || candidate.sourceArtifactId !== source.id
      || candidate.reviewBatchId !== batch.id
      || candidate.accountId !== batch.accountId
      || candidate.matterId !== batch.matterId
      || candidate.createdByUserId !== batch.createdByUserId
      || candidate.visibility !== batch.visibility
      || !Number.isSafeInteger(candidate.aclVersion) || candidate.aclVersion < 1
      || !Number.isSafeInteger(candidate.version) || candidate.version < 0) return false;
    if (candidate.status === 'pending') pending += 1;
    if (candidate.status === 'accepted') accepted += 1;
  }
  if (batch.status === 'pending') return pending > 0;
  if (batch.status === 'accepted') return pending === 0 && accepted > 0;
  return pending === 0 && accepted === 0;
}

async function candidateRows(db: DbClient, tenantId: string, ids: readonly string[]) {
  return db.candidate.findMany({
    where: { tenantId, id: { in: [...ids] } },
    orderBy: { id: 'asc' },
    select: candidateMetadataSelect,
  });
}

export async function createReviewBatch(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  input: CreateReviewBatchInput,
  authorization: CreateReviewBatchAuthorization = {
    sourceIntent: 'manage',
    grantActorReviewer: false,
  },
) {
  assertAttachmentInput(input);
  const source = await loadSource(db, ctx.tenantId, input.sourceArtifactId);
  const actorRole = await authorizeSource(db, ctx, policy, source, authorization.sourceIntent);
  if (actorRole === 'viewer') throw new ReviewBatchError('viewer_write_denied', 403);
  if (source.aclVersion !== input.expectedSourceAclVersion
    || source.retentionState === 'deleted'
    || !source.accountId) {
    candidateConflict('review_batch_source_conflict');
  }
  const expectedById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const rows = await candidateRows(db, ctx.tenantId, [...expectedById.keys()]);
  if (rows.length !== expectedById.size) notFound();
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: await currentActorRole(db, ctx),
  }, policy);
  const decisions = await evaluator.authorizeMany(
    rows.map(candidateDescriptor),
    authorization.sourceIntent === 'manage' ? 'manage' : 'read',
  );
  if (decisions.some((decision) => !decision.allowed)) notFound();
  for (const row of rows) {
    const expected = expectedById.get(row.id)!;
    if (!allowedBatchKinds.has(row.kind)
      || row.status !== 'pending'
      || row.sourceArtifactId !== source.id
      || row.reviewBatchId !== null
      || row.accountId !== source.accountId
      || row.matterId !== source.matterId
      || row.createdByUserId !== source.createdByUserId
      || row.visibility !== source.visibility
      || row.aclVersion !== source.aclVersion
      || row.version !== expected.expectedVersion
      || row.aclVersion !== expected.expectedAclVersion) {
      candidateConflict(`review_batch_candidate_conflict:${row.id}`);
    }
  }
  const id = input.id ?? `review_batch_${randomUUID().replaceAll('-', '')}`;
  const existing = await db.reviewBatch.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: { id: true },
  });
  if (existing) candidateConflict('review_batch_id_conflict');
  await db.reviewBatch.create({ data: {
    id,
    tenantId: ctx.tenantId,
    sourceArtifactId: source.id,
    accountId: source.accountId,
    matterId: source.matterId,
    createdByUserId: source.createdByUserId,
    visibility: source.visibility,
    aclVersion: source.aclVersion,
  } });
  for (const row of rows) {
    const expected = expectedById.get(row.id)!;
    const changed = await db.candidate.updateMany({
      where: {
        id: row.id,
        tenantId: ctx.tenantId,
        status: 'pending',
        sourceArtifactId: source.id,
        reviewBatchId: null,
        version: expected.expectedVersion,
        aclVersion: expected.expectedAclVersion,
      },
      data: {
        reviewBatchId: id,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) candidateConflict(`review_batch_candidate_conflict:${row.id}`);
  }
  const needsReviewerGrant = authorization.grantActorReviewer
    && source.visibility === 'matter_shared'
    && source.createdByUserId !== ctx.actorId;
  if (needsReviewerGrant) {
    if (!capabilityPolicyAllows(policy, { permission: 'candidate.review_shared' })) {
      throw new ReviewBatchError('review_batch_reviewer_permission_required', 403);
    }
    for (const row of rows) {
      await db.sensitiveResourceGrant.upsert({
        where: { tenantId_resourceKind_resourceId_granteeUserId_grantKind: {
          tenantId: ctx.tenantId,
          resourceKind: 'candidate',
          resourceId: row.id,
          granteeUserId: ctx.actorId,
          grantKind: 'reviewer',
        } },
        update: {
          grantedByUserId: ctx.actorId,
          resourceAclVersion: source.aclVersion,
          grantedAt: new Date(),
          revokedAt: null,
          revokedByUserId: null,
        },
        create: {
          id: `srg_${randomUUID().replaceAll('-', '')}`,
          tenantId: ctx.tenantId,
          resourceKind: 'candidate',
          resourceId: row.id,
          granteeUserId: ctx.actorId,
          grantedByUserId: ctx.actorId,
          grantKind: 'reviewer',
          resourceAclVersion: source.aclVersion,
        },
      });
    }
  }
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'review_batch_created',
    entityKind: 'review_batch',
    entityId: id,
    requestId: ctx.requestId ?? null,
    sourceRef: source.id,
    changedFields: JSON.stringify(['sourceArtifactId', 'candidateCount', 'aclVersion']),
    metadata: JSON.stringify({
      candidateCount: rows.length,
      aclVersion: source.aclVersion,
      reviewerGrantCount: needsReviewerGrant ? rows.length : 0,
    }),
  } });
  const [batch, attached] = await Promise.all([
    db.reviewBatch.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: batchMetadataSelect }),
    candidateRows(db, ctx.tenantId, rows.map((row) => row.id)),
  ]);
  return batchView(batch, attached);
}

export async function assertReviewBatchCreateReplayAccess(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  input: CreateReviewBatchInput,
): Promise<void> {
  assertAttachmentInput(input);
  const source = await loadSource(db, ctx.tenantId, input.sourceArtifactId);
  const role = await authorizeSource(db, ctx, policy, source, 'manage');
  const rows = await candidateRows(db, ctx.tenantId, input.candidates.map((candidate) => candidate.id));
  if (rows.length !== input.candidates.length) notFound();
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role,
  }, policy);
  const decisions = await evaluator.authorizeMany(rows.map(candidateDescriptor), 'manage');
  if (decisions.some((decision) => !decision.allowed)) notFound();
  const batchIds = new Set(rows.map((candidate) => candidate.reviewBatchId));
  if (batchIds.size !== 1 || batchIds.has(null)) notFound();
  if (rows.some((candidate) => (
    candidate.sourceArtifactId !== source.id
    || candidate.accountId !== source.accountId
    || candidate.matterId !== source.matterId
    || candidate.createdByUserId !== source.createdByUserId
    || candidate.visibility !== source.visibility
  ))) notFound();
  const batchId = [...batchIds][0];
  if (!batchId || !source.accountId) notFound();
  const batch = await db.reviewBatch.findFirst({
    where: {
      id: batchId,
      tenantId: ctx.tenantId,
      sourceArtifactId: source.id,
      accountId: source.accountId,
      matterId: source.matterId,
      createdByUserId: source.createdByUserId,
      visibility: source.visibility,
      aclVersion: source.aclVersion,
    },
    select: { id: true },
  });
  if (!batch) notFound();
}

async function readableBatch(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  batch: ReviewBatchMetadata,
  intent: 'read' | 'review',
): Promise<{ batch: ReviewBatchMetadata; candidates: ReviewCandidateMetadata[] } | null> {
  const source = await db.sourceArtifact.findFirst({
    where: { id: batch.sourceArtifactId, tenantId: ctx.tenantId }, select: sourceSelect,
  });
  if (!source || !sourceMatchesBatch(batch, source, intent)) return null;
  const role = await currentActorRole(db, ctx);
  if (intent === 'review' && role === 'viewer') return null;
  const sourceAccess = await authorizeSensitiveResource(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role,
  }, policy, sourceArtifactDescriptor(source), 'read');
  if (!sourceAccess.allowed) return null;
  const candidates = await db.candidate.findMany({
    where: { tenantId: ctx.tenantId, reviewBatchId: batch.id },
    orderBy: { id: 'asc' }, select: candidateMetadataSelect,
  });
  if (!candidatesMatchBatch(batch, source, candidates)) return null;
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role,
  }, policy);
  const access = await evaluator.authorizeMany(
    candidates.map(candidateDescriptor), intent === 'review' ? 'review' : 'read',
  );
  return access.some((decision) => !decision.allowed) ? null : { batch, candidates };
}

export async function readableReviewBatchById(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  id: string,
  intent: 'read' | 'review' = 'read',
) {
  const batch = await db.reviewBatch.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: batchMetadataSelect,
  });
  if (!batch) return null;
  const readable = await readableBatch(db, ctx, policy, batch, intent);
  return readable ? { ...readable, view: batchView(readable.batch, readable.candidates) } : null;
}

export async function assertReviewBatchReplayAccess(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  id: string,
): Promise<void> {
  const role = await currentActorRole(db, ctx);
  if (role === 'viewer') throw new ReviewBatchError('viewer_write_denied', 403);
  const readable = await readableReviewBatchById(db, { ...ctx, actorRole: role }, policy, id, 'review');
  if (!readable) notFound();
}

export async function readableReviewBatches(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  input: { cursor?: string; limit: number },
) {
  const scanLimit = Math.min(500, input.limit * 5 + 1);
  const rows = await db.reviewBatch.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: scanLimit,
    select: batchMetadataSelect,
  });
  if (rows.length === 0) return { items: [], nextCursor: null };
  const role = await currentActorRole(db, ctx);
  const [sources, candidates] = await Promise.all([
    db.sourceArtifact.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: [...new Set(rows.map((row) => row.sourceArtifactId))] },
      },
      select: sourceSelect,
    }),
    db.candidate.findMany({
      where: { tenantId: ctx.tenantId, reviewBatchId: { in: rows.map((row) => row.id) } },
      orderBy: [{ reviewBatchId: 'asc' }, { id: 'asc' }],
      select: candidateMetadataSelect,
    }),
  ]);
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role,
  }, policy);
  const [sourceAccess, candidateAccess] = await Promise.all([
    evaluator.authorizeMany(sources.map(sourceArtifactDescriptor), 'read'),
    evaluator.authorizeMany(candidates.map(candidateDescriptor), 'read'),
  ]);
  const sourceById = new Map(sources.map((source, index) => [source.id, {
    source,
    allowed: sourceAccess[index]?.allowed === true,
  }]));
  const candidatesByBatch = new Map<string, ReviewCandidateMetadata[]>();
  const candidateAllowed = new Map(candidates.map((candidate, index) => [
    candidate.id, candidateAccess[index]?.allowed === true,
  ]));
  for (const candidate of candidates) {
    if (!candidate.reviewBatchId) continue;
    const grouped = candidatesByBatch.get(candidate.reviewBatchId) ?? [];
    grouped.push(candidate);
    candidatesByBatch.set(candidate.reviewBatchId, grouped);
  }
  const items: ReturnType<typeof batchView>[] = [];
  let lastScanned: string | null = null;
  for (const row of rows) {
    lastScanned = row.id;
    const sourceState = sourceById.get(row.sourceArtifactId);
    const grouped = candidatesByBatch.get(row.id) ?? [];
    if (sourceState?.allowed
      && sourceMatchesBatch(row, sourceState.source, 'read')
      && candidatesMatchBatch(row, sourceState.source, grouped)
      && grouped.every((candidate) => candidateAllowed.get(candidate.id) === true)) {
      items.push(batchView(row, grouped));
    }
    if (items.length === input.limit) break;
  }
  const hasMore = rows.length === scanLimit || (items.length === input.limit && lastScanned !== rows.at(-1)?.id);
  return { items, nextCursor: hasMore ? lastScanned : null };
}
