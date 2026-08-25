import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { CapabilityPolicy, CommandContext } from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  authorizeSensitiveResource,
  createSensitiveAccessEvaluator,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import type { ReadPrincipal } from '../visibility.js';
import {
  artifactIdForExternalReference,
  referenceFingerprint,
  sourceArtifactCreateData,
  sourceArtifactIdempotencyDomain,
  sourceArtifactProjectionForNote,
  sourceArtifactProjectionForTranscript,
  validateSourceArtifactProjection,
  type SourceArtifactProjection,
  type SourceArtifactVisibility,
} from './model.js';

export class SourceArtifactError extends Error {
  readonly scopedNotFound: boolean;
  constructor(readonly code: string, readonly statusCode = 400, scopedNotFound = false) {
    super(code);
    this.name = 'SourceArtifactError';
    this.scopedNotFound = scopedNotFound;
  }
}

export const SOURCE_ARTIFACT_METADATA_SELECT = {
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

export type SourceArtifactMetadata = Prisma.SourceArtifactGetPayload<{
  select: typeof SOURCE_ARTIFACT_METADATA_SELECT;
}>;

export interface SourceArtifactView {
  id: string;
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
  backingKind: string;
  artifactKind: string;
  source: string;
  externalRef: string | null;
  title: string;
  occurredAt: Date | null;
  fingerprintKind: string;
  sourceFingerprint: string;
  retentionState: string;
  retentionUpdatedAt: Date;
  createdByUserId: string | null;
  visibility: string;
  aclVersion: number;
  createdAt: Date;
  updatedAt: Date;
  backingPresent: boolean;
  contentAvailable: boolean;
  canDegrade: boolean;
  canDelete: boolean;
  explanation: string;
}

interface MountInput {
  accountId?: string | null;
  matterId?: string | null;
  personId?: string | null;
}

interface NormalizedMount {
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
}

function projectionFromStored(row: SourceArtifactMetadata): SourceArtifactProjection {
  return row as SourceArtifactProjection;
}

export function sourceArtifactMetadataIsValid(row: SourceArtifactMetadata): boolean {
  return validateSourceArtifactProjection(projectionFromStored(row)).ok;
}

function assertProjection(row: SourceArtifactMetadata): void {
  const result = validateSourceArtifactProjection(projectionFromStored(row));
  if (!result.ok) throw new SourceArtifactError(`source_artifact_invalid:${result.code}`, 409);
}

function sameParents(left: NormalizedMount, right: NormalizedMount): boolean {
  return left.accountId === right.accountId
    && left.matterId === right.matterId
    && left.personId === right.personId;
}

async function requireUnanchoredSourceArtifact(db: DbClient, tenantId: string, id: string): Promise<void> {
  const anchored = await db.reviewBatch.findFirst({
    where: { tenantId, sourceArtifactId: id },
    select: { id: true },
  });
  if (anchored) throw new SourceArtifactError('source_artifact_review_batch_locked', 409);
}

async function normalizeMount(db: DbClient, tenantId: string, input: MountInput): Promise<NormalizedMount> {
  let accountId = input.accountId ?? null;
  const matterId = input.matterId ?? null;
  const personId = input.personId ?? null;
  if (matterId) {
    const matter = await db.opportunity.findFirst({
      where: {
        id: matterId,
        tenantId,
        archivedAt: null,
        account: { tenantId, archivedAt: null },
      },
      select: { accountId: true },
    });
    if (!matter || (accountId && matter.accountId !== accountId)) {
      throw new SourceArtifactError('source_artifact_not_found', 404, true);
    }
    accountId = matter.accountId;
  }
  if (personId) {
    const person = await db.person.findFirst({
      where: {
        id: personId, tenantId, archivedAt: null, mergedIntoPersonId: null,
      },
      select: { accountId: true },
    });
    if (!person || (accountId && person.accountId !== accountId)) {
      throw new SourceArtifactError('source_artifact_not_found', 404, true);
    }
    accountId = person.accountId;
  }
  if (accountId && !matterId && !personId) {
    const account = await db.account.findFirst({
      where: { id: accountId, tenantId, archivedAt: null }, select: { id: true },
    });
    if (!account) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  }
  if (!accountId && (matterId || personId)) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  return { accountId, matterId, personId };
}

function projectionUpdateData(projection: SourceArtifactProjection, current: SourceArtifactMetadata) {
  const preserveContentFingerprint = projection.retentionState === 'degraded'
    && current.fingerprintKind === 'content_sha256_v1';
  return {
    accountId: projection.accountId,
    matterId: projection.matterId,
    personId: projection.personId,
    backingKind: projection.backingKind,
    backingId: projection.backingId,
    artifactKind: projection.artifactKind,
    source: projection.source,
    externalRef: projection.externalRef,
    idempotencyDomain: projection.idempotencyDomain,
    title: projection.title,
    occurredAt: projection.occurredAt,
    fingerprintKind: preserveContentFingerprint ? current.fingerprintKind : projection.fingerprintKind,
    sourceFingerprint: preserveContentFingerprint ? current.sourceFingerprint : projection.sourceFingerprint,
    retentionState: projection.retentionState,
    retentionUpdatedAt: current.retentionState === projection.retentionState
      ? current.retentionUpdatedAt
      : new Date(),
    createdByUserId: projection.createdByUserId,
    visibility: projection.visibility,
    aclVersion: projection.aclVersion,
  };
}

async function upsertProjection(db: DbClient, projection: SourceArtifactProjection): Promise<SourceArtifactMetadata> {
  const validation = validateSourceArtifactProjection(projection);
  if (!validation.ok) {
    throw new SourceArtifactError(`source_artifact_invalid:${validation.code}`, 409);
  }
  const byBacking = await db.sourceArtifact.findFirst({
    where: {
      tenantId: projection.tenantId,
      backingKind: projection.backingKind,
      backingId: projection.backingId,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  const adoptable = !byBacking && projection.backingKind === 'transcript' && projection.externalRef
    ? await db.sourceArtifact.findFirst({
        where: {
          tenantId: projection.tenantId,
          idempotencyDomain: projection.idempotencyDomain,
          source: projection.source,
          externalRef: projection.externalRef,
        },
        select: SOURCE_ARTIFACT_METADATA_SELECT,
      })
    : null;
  const current = byBacking ?? adoptable;
  if (!current) {
    try {
      return await db.sourceArtifact.create({
        data: sourceArtifactCreateData(projection),
        select: SOURCE_ARTIFACT_METADATA_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await db.sourceArtifact.findFirst({
          where: {
            tenantId: projection.tenantId,
            OR: [
              { backingKind: projection.backingKind, backingId: projection.backingId },
              ...(projection.externalRef ? [{
                idempotencyDomain: projection.idempotencyDomain,
                source: projection.source,
                externalRef: projection.externalRef,
              }] : []),
            ],
          },
          select: SOURCE_ARTIFACT_METADATA_SELECT,
        });
        if (raced) return upsertProjection(db, projection);
      }
      throw error;
    }
  }
  assertProjection(current);
  if (current.retentionState === 'deleted') throw new SourceArtifactError('source_artifact_deleted', 409);
  if (current.retentionState === 'degraded' && projection.retentionState === 'available') {
    throw new SourceArtifactError('source_artifact_restore_not_supported', 409);
  }
  if (current.tenantId !== projection.tenantId
    || current.createdByUserId !== projection.createdByUserId
    || current.idempotencyDomain !== projection.idempotencyDomain
    || (current.backingKind !== 'external_reference'
      && (current.backingKind !== projection.backingKind || current.backingId !== projection.backingId))
    || current.aclVersion > projection.aclVersion
    || current.aclVersion + 1 < projection.aclVersion) {
    throw new SourceArtifactError('source_artifact_projection_conflict', 409);
  }
  if (current.backingKind === 'external_reference') {
    const currentMount = { accountId: current.accountId, matterId: current.matterId, personId: current.personId };
    const nextMount = { accountId: projection.accountId, matterId: projection.matterId, personId: projection.personId };
    if (!sameParents(currentMount, nextMount) || current.visibility !== projection.visibility) {
      throw new SourceArtifactError('source_artifact_adoption_conflict', 409);
    }
  }
  const changed = await db.sourceArtifact.updateMany({
    where: { id: current.id, tenantId: projection.tenantId, aclVersion: current.aclVersion },
    data: projectionUpdateData(projection, current),
  });
  if (changed.count !== 1) throw new SourceArtifactError('source_artifact_acl_conflict', 409);
  return db.sourceArtifact.findFirstOrThrow({
    where: { id: current.id, tenantId: projection.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
}

export async function ensureSourceArtifactForNote(db: DbClient, tenantId: string, noteId: string) {
  const note = await db.note.findFirst({
    where: { id: noteId, tenantId },
    select: {
      id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
      content: true, source: true, createdByUserId: true, visibility: true, aclVersion: true,
      createdAt: true,
    },
  });
  if (!note) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  return upsertProjection(db, sourceArtifactProjectionForNote(note));
}

export async function ensureSourceArtifactForTranscript(db: DbClient, tenantId: string, transcriptId: string) {
  const transcript = await db.transcript.findFirst({
    where: { id: transcriptId, tenantId },
    select: {
      id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
      source: true, externalRef: true, idempotencyDomain: true, title: true, contentEnc: true,
      recordedAt: true, status: true, createdByUserId: true, visibility: true, aclVersion: true,
      createdAt: true,
    },
  });
  if (!transcript) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  return upsertProjection(db, sourceArtifactProjectionForTranscript(transcript));
}

export async function markSourceArtifactRetentionForBacking(
  db: DbClient,
  input: {
    tenantId: string;
    backingKind: 'note' | 'transcript';
    backingId: string;
    retentionState: 'degraded' | 'deleted';
  },
): Promise<void> {
  const current = await db.sourceArtifact.findFirst({
    where: {
      tenantId: input.tenantId,
      backingKind: input.backingKind,
      backingId: input.backingId,
    },
    select: { id: true, retentionState: true },
  });
  if (!current) throw new SourceArtifactError('source_artifact_projection_missing', 409);
  if (current.retentionState === input.retentionState) return;
  if (current.retentionState === 'deleted') throw new SourceArtifactError('source_artifact_deleted', 409);
  const changed = await db.sourceArtifact.updateMany({
    where: { id: current.id, tenantId: input.tenantId, retentionState: current.retentionState },
    data: { retentionState: input.retentionState, retentionUpdatedAt: new Date() },
  });
  if (changed.count !== 1) throw new SourceArtifactError('source_artifact_projection_conflict', 409);
}

async function requireManage(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  expectedAclVersion: number,
): Promise<SourceArtifactMetadata> {
  const row = await db.sourceArtifact.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!row) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  const decision = await authorizeSensitiveResource(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role: ctx.actorRole,
  }, policy, sourceArtifactDescriptor(row), 'manage');
  if (!decision.allowed) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  assertProjection(row);
  if (row.aclVersion !== expectedAclVersion) throw new SourceArtifactError('source_artifact_acl_conflict', 409);
  return row;
}

async function audit(
  db: DbClient,
  ctx: CommandContext,
  action: string,
  artifactId: string,
  changedFields: readonly string[],
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID().replaceAll('-', '')}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action,
    entityKind: 'source_artifact',
    entityId: artifactId,
    requestId: ctx.requestId,
    changedFields: JSON.stringify(changedFields),
    metadata: JSON.stringify(metadata),
  } });
}

export interface SourceArtifactMutationReceipt {
  id: string;
  aclVersion: number;
  visibility: string;
  retentionState: string;
  contentAvailable: boolean;
  backingPresent: boolean;
}

function receipt(
  row: SourceArtifactMetadata,
  backingPresent: boolean,
  contentAvailable = backingPresent && row.retentionState === 'available',
): SourceArtifactMutationReceipt {
  return {
    id: row.id,
    aclVersion: row.aclVersion,
    visibility: row.visibility,
    retentionState: row.retentionState,
    contentAvailable,
    backingPresent,
  };
}

async function verifiedReceipt(
  db: DbClient,
  row: SourceArtifactMetadata,
): Promise<SourceArtifactMutationReceipt> {
  assertProjection(row);
  if (row.backingKind === 'external_reference') return receipt(row, false, false);
  if (row.backingKind === 'note') {
    const backing = await db.note.findFirst({
      where: { id: row.backingId, tenantId: row.tenantId }, select: { id: true },
    });
    const backingPresent = Boolean(backing);
    if ((row.retentionState === 'available') !== backingPresent) {
      throw new SourceArtifactError('source_artifact_backing_conflict', 409);
    }
    return receipt(row, backingPresent, backingPresent && row.retentionState === 'available');
  }
  const [backing, available] = await Promise.all([
    db.transcript.findFirst({
      where: { id: row.backingId, tenantId: row.tenantId }, select: { id: true },
    }),
    db.transcript.findFirst({
      where: {
        id: row.backingId, tenantId: row.tenantId,
        status: { not: 'redacted' }, contentEnc: { not: '' },
      },
      select: { id: true },
    }),
  ]);
  const backingPresent = Boolean(backing);
  const contentAvailable = Boolean(available);
  const consistent = row.retentionState === 'available'
    ? contentAvailable
    : row.retentionState === 'degraded'
      ? backingPresent && !contentAvailable
      : row.retentionState === 'deleted'
        ? !backingPresent
        : false;
  if (!consistent) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  return receipt(row, backingPresent, contentAvailable);
}

export async function registerExternalSourceArtifact(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: MountInput & {
    source: string;
    externalRef: string;
    title?: string;
    occurredAt?: Date | null;
  },
): Promise<SourceArtifactMutationReceipt> {
  const mount = await normalizeMount(db, ctx.tenantId, input);
  const idempotencyDomain = sourceArtifactIdempotencyDomain(ctx.actorId);
  const id = artifactIdForExternalReference(
    ctx.tenantId, idempotencyDomain, input.source, input.externalRef,
  );
  const prospective = {
    kind: 'source_artifact' as const,
    id,
    tenantId: ctx.tenantId,
    ...mount,
    createdByUserId: ctx.actorId,
    visibility: 'private' as const,
    aclVersion: 1,
  };
  const access = await authorizeSensitiveResource(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role: ctx.actorRole,
  }, policy, prospective, 'manage');
  if (!access.allowed) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  const current = await db.sourceArtifact.findFirst({
    where: {
      tenantId: ctx.tenantId, idempotencyDomain, source: input.source, externalRef: input.externalRef,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (current) {
    assertProjection(current);
    if (current.retentionState === 'deleted') throw new SourceArtifactError('source_artifact_deleted', 409);
    if (current.createdByUserId !== ctx.actorId || !sameParents(current, mount)) {
      throw new SourceArtifactError('source_artifact_identity_conflict', 409);
    }
    return verifiedReceipt(db, current);
  }
  const now = new Date();
  const row = await db.sourceArtifact.create({
    data: {
      id,
      tenantId: ctx.tenantId,
      ...mount,
      backingKind: 'external_reference',
      backingId: id,
      artifactKind: 'external_reference',
      source: input.source,
      externalRef: input.externalRef,
      idempotencyDomain,
      title: (input.title ?? '').slice(0, 200),
      occurredAt: input.occurredAt ?? null,
      fingerprintKind: 'reference_sha256_v1',
      sourceFingerprint: referenceFingerprint({ idempotencyDomain, source: input.source, externalRef: input.externalRef }),
      retentionState: 'reference_only',
      retentionUpdatedAt: now,
      createdByUserId: ctx.actorId,
      visibility: 'private',
      aclVersion: 1,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  await audit(db, ctx, 'source_artifact.register_external', row.id, ['create'], {
    artifactKind: 'external_reference', retentionState: 'reference_only', aclVersion: 1,
  });
  return verifiedReceipt(db, row);
}

export async function canRegisterExternalSourceArtifact(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: MountInput & { source: string; externalRef: string },
): Promise<boolean> {
  let mount: NormalizedMount;
  try {
    mount = await normalizeMount(db, ctx.tenantId, input);
  } catch (error) {
    if (error instanceof SourceArtifactError && error.statusCode === 404) return false;
    throw error;
  }
  const idempotencyDomain = sourceArtifactIdempotencyDomain(ctx.actorId);
  const id = artifactIdForExternalReference(
    ctx.tenantId, idempotencyDomain, input.source, input.externalRef,
  );
  const principal = {
    tenantId: ctx.tenantId, userId: ctx.actorId, role: ctx.actorRole,
  };
  const prospective = await authorizeSensitiveResource(db, principal, policy, {
    kind: 'source_artifact', id, tenantId: ctx.tenantId, ...mount,
    createdByUserId: ctx.actorId, visibility: 'private', aclVersion: 1,
  }, 'manage');
  if (!prospective.allowed) return false;
  const current = await db.sourceArtifact.findFirst({
    where: {
      tenantId: ctx.tenantId, idempotencyDomain, source: input.source, externalRef: input.externalRef,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!current) return true;
  if (!sourceArtifactMetadataIsValid(current)) return false;
  const access = await authorizeSensitiveResource(
    db, principal, policy, sourceArtifactDescriptor(current), 'manage',
  );
  return access.allowed;
}

export async function externalSourceArtifactAdoptionMetadata(
  db: DbClient,
  input: {
    tenantId: string;
    actorId: string;
    actorRole: ReadPrincipal['role'];
    source: string;
    externalRef: string;
  },
): Promise<{
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
  visibility: SourceArtifactVisibility;
  aclVersion: number;
} | null> {
  const idempotencyDomain = sourceArtifactIdempotencyDomain(input.actorId);
  const current = await db.sourceArtifact.findFirst({
    where: {
      tenantId: input.tenantId,
      idempotencyDomain,
      source: input.source,
      externalRef: input.externalRef,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!current) return null;
  assertProjection(current);
  if (current.retentionState === 'deleted') {
    throw new SourceArtifactError('source_artifact_deleted', 409);
  }
  if (current.backingKind !== 'external_reference'
    || current.retentionState !== 'reference_only'
    || current.createdByUserId !== input.actorId) {
    throw new SourceArtifactError('source_artifact_adoption_conflict', 409);
  }
  const access = await authorizeSensitiveResource(db, {
    tenantId: input.tenantId, userId: input.actorId, role: input.actorRole,
  }, { entitlements: [], permissions: [] }, sourceArtifactDescriptor(current), 'manage');
  if (!access.allowed) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  return {
    accountId: current.accountId,
    matterId: current.matterId,
    personId: current.personId,
    visibility: current.visibility as SourceArtifactVisibility,
    aclVersion: current.aclVersion,
  };
}

async function updateBackingMount(
  db: DbClient,
  row: SourceArtifactMetadata,
  mount: NormalizedMount,
): Promise<void> {
  if (row.backingKind === 'note') {
    const changed = await db.note.updateMany({
      where: { id: row.backingId, tenantId: row.tenantId, aclVersion: row.aclVersion },
      data: {
        accountId: mount.accountId, opportunityId: mount.matterId, personId: mount.personId,
        aclVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  } else if (row.backingKind === 'transcript') {
    const changed = await db.transcript.updateMany({
      where: { id: row.backingId, tenantId: row.tenantId, aclVersion: row.aclVersion },
      data: {
        accountId: mount.accountId, opportunityId: mount.matterId, personId: mount.personId,
        aclVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  }
}

export async function mountSourceArtifact(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  input: MountInput & { expectedAclVersion: number },
): Promise<SourceArtifactMutationReceipt> {
  const current = await requireManage(db, ctx, policy, id, input.expectedAclVersion);
  const mount = await normalizeMount(db, ctx.tenantId, input);
  if (current.visibility === 'matter_shared' && !mount.matterId) {
    throw new SourceArtifactError('shared_artifact_matter_required', 409);
  }
  const prospective = sourceArtifactDescriptor({ ...current, ...mount });
  const access = await authorizeSensitiveResource(db, {
    tenantId: ctx.tenantId, userId: ctx.actorId, role: ctx.actorRole,
  }, policy, prospective, 'manage');
  if (!access.allowed) throw new SourceArtifactError('source_artifact_not_found', 404, true);
  if (sameParents(current, mount)) return verifiedReceipt(db, current);
  await requireUnanchoredSourceArtifact(db, ctx.tenantId, current.id);
  await updateBackingMount(db, current, mount);
  const changed = await db.sourceArtifact.updateMany({
    where: { id: current.id, tenantId: ctx.tenantId, aclVersion: current.aclVersion },
    data: { ...mount, aclVersion: { increment: 1 } },
  });
  if (changed.count !== 1) throw new SourceArtifactError('source_artifact_acl_conflict', 409);
  const row = await db.sourceArtifact.findFirstOrThrow({
    where: { id: current.id, tenantId: ctx.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  await audit(db, ctx, 'source_artifact.mount', row.id, ['accountId', 'matterId', 'personId', 'aclVersion'], {
    mounted: Boolean(row.accountId), aclVersion: row.aclVersion,
  });
  return verifiedReceipt(db, row);
}

async function updateBackingVisibility(
  db: DbClient,
  row: SourceArtifactMetadata,
  visibility: SourceArtifactVisibility,
): Promise<void> {
  const where = { id: row.backingId, tenantId: row.tenantId, aclVersion: row.aclVersion };
  if (row.backingKind === 'note') {
    const changed = await db.note.updateMany({ where, data: { visibility, aclVersion: { increment: 1 } } });
    if (changed.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  } else if (row.backingKind === 'transcript') {
    const changed = await db.transcript.updateMany({ where, data: { visibility, aclVersion: { increment: 1 } } });
    if (changed.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  }
}

export async function setSourceArtifactVisibility(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  input: { visibility: Exclude<SourceArtifactVisibility, 'owner_admin_only'>; expectedAclVersion: number },
): Promise<SourceArtifactMutationReceipt> {
  const current = await requireManage(db, ctx, policy, id, input.expectedAclVersion);
  if (input.visibility === 'matter_shared' && !current.matterId) {
    throw new SourceArtifactError('shared_artifact_matter_required', 409);
  }
  if (current.visibility === input.visibility) return verifiedReceipt(db, current);
  await requireUnanchoredSourceArtifact(db, ctx.tenantId, current.id);
  await updateBackingVisibility(db, current, input.visibility);
  const changed = await db.sourceArtifact.updateMany({
    where: { id: current.id, tenantId: ctx.tenantId, aclVersion: current.aclVersion },
    data: { visibility: input.visibility, aclVersion: { increment: 1 } },
  });
  if (changed.count !== 1) throw new SourceArtifactError('source_artifact_acl_conflict', 409);
  const row = await db.sourceArtifact.findFirstOrThrow({
    where: { id: current.id, tenantId: ctx.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  await audit(db, ctx, 'source_artifact.visibility', row.id, ['visibility', 'aclVersion'], {
    visibility: row.visibility, aclVersion: row.aclVersion,
  });
  return verifiedReceipt(db, row);
}

export async function degradeSourceArtifact(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  expectedAclVersion: number,
): Promise<SourceArtifactMutationReceipt> {
  const current = await requireManage(db, ctx, policy, id, expectedAclVersion);
  if (current.backingKind !== 'transcript') throw new SourceArtifactError('degrade_not_supported', 409);
  if (current.retentionState === 'degraded') return verifiedReceipt(db, current);
  if (current.retentionState !== 'available') throw new SourceArtifactError('degrade_not_supported', 409);
  const changedBacking = await db.transcript.updateMany({
    where: {
      id: current.backingId, tenantId: ctx.tenantId, aclVersion: current.aclVersion,
      status: { not: 'redacted' }, contentEnc: { not: '' },
    },
    data: { contentEnc: '', status: 'redacted' },
  });
  if (changedBacking.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  const changed = await db.sourceArtifact.updateMany({
    where: { id: current.id, tenantId: ctx.tenantId, aclVersion: current.aclVersion, retentionState: 'available' },
    data: { retentionState: 'degraded', retentionUpdatedAt: new Date() },
  });
  if (changed.count !== 1) throw new SourceArtifactError('source_artifact_acl_conflict', 409);
  const row = await db.sourceArtifact.findFirstOrThrow({
    where: { id: current.id, tenantId: ctx.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  await audit(db, ctx, 'source_artifact.degrade', row.id, ['retentionState'], {
    retentionState: 'degraded', aclVersion: row.aclVersion,
  });
  return verifiedReceipt(db, row);
}

export async function deleteSourceArtifact(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  id: string,
  expectedAclVersion: number,
): Promise<SourceArtifactMutationReceipt> {
  const current = await requireManage(db, ctx, policy, id, expectedAclVersion);
  if (current.retentionState === 'deleted') return verifiedReceipt(db, current);
  if (current.backingKind === 'note') {
    const changed = await db.note.deleteMany({
      where: { id: current.backingId, tenantId: ctx.tenantId, aclVersion: current.aclVersion },
    });
    if (changed.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  } else if (current.backingKind === 'transcript') {
    const changed = await db.transcript.deleteMany({
      where: { id: current.backingId, tenantId: ctx.tenantId, aclVersion: current.aclVersion },
    });
    if (changed.count !== 1) throw new SourceArtifactError('source_artifact_backing_conflict', 409);
  }
  const changed = await db.sourceArtifact.updateMany({
    where: { id: current.id, tenantId: ctx.tenantId, aclVersion: current.aclVersion },
    data: { retentionState: 'deleted', retentionUpdatedAt: new Date() },
  });
  if (changed.count !== 1) throw new SourceArtifactError('source_artifact_acl_conflict', 409);
  const row = await db.sourceArtifact.findFirstOrThrow({
    where: { id: current.id, tenantId: ctx.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  await audit(db, ctx, 'source_artifact.delete', row.id, ['retentionState'], {
    retentionState: 'deleted', backingKind: row.backingKind, aclVersion: row.aclVersion,
  });
  return verifiedReceipt(db, row);
}

function lifecycleExplanation(row: SourceArtifactMetadata, backingPresent: boolean, contentAvailable: boolean): string {
  if (row.retentionState === 'deleted') return 'original_deleted_tombstone_retained';
  if (!backingPresent && row.backingKind !== 'external_reference') return 'backing_missing_fail_closed';
  if (row.retentionState === 'reference_only') return 'reference_only_no_local_body';
  if (row.retentionState === 'degraded') return 'original_body_degraded';
  return contentAvailable ? 'local_body_available' : 'projection_backing_mismatch_fail_closed';
}

export async function buildSourceArtifactViews(
  db: DbClient,
  rows: readonly SourceArtifactMetadata[],
  principal: ReadPrincipal,
  policy: CapabilityPolicy,
): Promise<SourceArtifactView[]> {
  if (rows.length === 0) return [];
  const evaluator = await createSensitiveAccessEvaluator(db, principal, policy);
  const manage = await evaluator.authorizeMany(rows.map(sourceArtifactDescriptor), 'manage');
  const transcriptIds = rows.filter((row) => row.backingKind === 'transcript').map((row) => row.backingId);
  const noteIds = rows.filter((row) => row.backingKind === 'note').map((row) => row.backingId);
  const [transcripts, availableTranscripts, notes] = await Promise.all([
    transcriptIds.length ? db.transcript.findMany({
      where: { tenantId: principal.tenantId, id: { in: transcriptIds } }, select: { id: true },
    }) : [],
    transcriptIds.length ? db.transcript.findMany({
      where: {
        tenantId: principal.tenantId, id: { in: transcriptIds },
        status: { not: 'redacted' }, contentEnc: { not: '' },
      },
      select: { id: true },
    }) : [],
    noteIds.length ? db.note.findMany({
      where: { tenantId: principal.tenantId, id: { in: noteIds } }, select: { id: true },
    }) : [],
  ]);
  const present = new Set([
    ...transcripts.map((row) => `transcript\u0000${row.id}`),
    ...notes.map((row) => `note\u0000${row.id}`),
  ]);
  const available = new Set(availableTranscripts.map((row) => row.id));
  return rows.map((row, index) => {
    const backingPresent = row.backingKind === 'external_reference'
      ? false
      : present.has(`${row.backingKind}\u0000${row.backingId}`);
    const contentAvailable = row.retentionState === 'available'
      && backingPresent
      && (row.backingKind === 'note' || available.has(row.backingId));
    return {
      id: row.id,
      accountId: row.accountId,
      matterId: row.matterId,
      personId: row.personId,
      backingKind: row.backingKind,
      artifactKind: row.artifactKind,
      source: row.source,
      externalRef: row.externalRef,
      title: row.title,
      occurredAt: row.occurredAt,
      fingerprintKind: row.fingerprintKind,
      sourceFingerprint: row.sourceFingerprint,
      retentionState: row.retentionState,
      retentionUpdatedAt: row.retentionUpdatedAt,
      createdByUserId: row.createdByUserId,
      visibility: row.visibility,
      aclVersion: row.aclVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      backingPresent,
      contentAvailable,
      canDegrade: Boolean(manage[index]?.allowed)
        && row.backingKind === 'transcript' && contentAvailable,
      canDelete: Boolean(manage[index]?.allowed)
        && row.retentionState !== 'deleted'
        && (row.backingKind === 'external_reference' || backingPresent),
      explanation: lifecycleExplanation(row, backingPresent, contentAvailable),
    };
  });
}

export async function readableSourceArtifactMetadata(
  db: DbClient,
  principal: ReadPrincipal,
  policy: CapabilityPolicy,
  options: {
    accountId?: string;
    matterId?: string;
    unclassified?: boolean;
    cursor?: string;
    limit: number;
  },
): Promise<{ rows: SourceArtifactMetadata[]; nextCursor: string | null }> {
  const evaluator = await createSensitiveAccessEvaluator(db, principal, policy);
  const metadataWhere = await evaluator.metadataWhere('source_artifact', 'read');
  const visible: SourceArtifactMetadata[] = [];
  let cursor = options.cursor;
  while (visible.length < options.limit) {
    const take = Math.max(100, options.limit * 2);
    const batch = await db.sourceArtifact.findMany({
      where: {
        tenantId: principal.tenantId,
        AND: [
          metadataWhere,
          ...(options.accountId ? [{ accountId: options.accountId }] : []),
          ...(options.matterId ? [{ matterId: options.matterId }] : []),
          ...(options.unclassified ? [{ accountId: null, matterId: null, personId: null }] : []),
          ...(cursor ? [{ id: { gt: cursor } }] : []),
        ],
      },
      orderBy: { id: 'asc' },
      take,
      select: SOURCE_ARTIFACT_METADATA_SELECT,
    });
    if (batch.length === 0) break;
    const decisions = await evaluator.authorizeMany(batch.map(sourceArtifactDescriptor), 'read');
    for (let index = 0; index < batch.length; index += 1) {
      cursor = batch[index]!.id;
      if (decisions[index]?.allowed && sourceArtifactMetadataIsValid(batch[index]!)) {
        visible.push(batch[index]!);
      }
      if (visible.length === options.limit) {
        const morePossible = index < batch.length - 1 || batch.length === take;
        return { rows: visible, nextCursor: morePossible ? cursor : null };
      }
    }
    if (batch.length < take) break;
  }
  return { rows: visible, nextCursor: null };
}

export async function readableSourceArtifactById(
  db: DbClient,
  principal: ReadPrincipal,
  policy: CapabilityPolicy,
  id: string,
): Promise<SourceArtifactMetadata | null> {
  const row = await db.sourceArtifact.findFirst({
    where: { id, tenantId: principal.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!row || !sourceArtifactMetadataIsValid(row)) return null;
  const access = await authorizeSensitiveResource(db, principal, policy, sourceArtifactDescriptor(row), 'read');
  return access.allowed ? row : null;
}

export async function canManageSourceArtifactById(
  db: DbClient,
  principal: ReadPrincipal,
  policy: CapabilityPolicy,
  id: string,
): Promise<boolean> {
  const row = await db.sourceArtifact.findFirst({
    where: { id, tenantId: principal.tenantId }, select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!row || !sourceArtifactMetadataIsValid(row)) return false;
  const access = await authorizeSensitiveResource(
    db, principal, policy, sourceArtifactDescriptor(row), 'manage',
  );
  return access.allowed;
}
