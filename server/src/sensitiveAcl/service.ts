import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { CapabilityPolicy } from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  authorizeSensitiveResource,
  candidateDescriptor,
  noteDescriptor,
  sourceArtifactDescriptor,
  transcriptDescriptor,
  type SensitiveResourceDescriptor,
  type SensitiveResourceKind,
  type SensitiveResourceVisibility,
} from '../sensitiveAccess.js';
import type { VisibilityRole } from '../visibility.js';
import {
  ensureSourceArtifactForNote,
  ensureSourceArtifactForTranscript,
} from '../sourceArtifacts/service.js';

export class SensitiveAclError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SensitiveAclError';
  }
}

interface ActorInput {
  tenantId: string;
  actorId: string;
  actorRole: VisibilityRole;
  requestId?: string;
}

type Tx = Prisma.TransactionClient;

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === 'function';
}

async function inSerializableTransaction<T>(db: DbClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isRootClient(db)) return work(db as Tx);
  return db.$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 15_000,
  });
}

async function loadDescriptor(
  tx: Tx,
  tenantId: string,
  kind: SensitiveResourceKind,
  id: string,
): Promise<SensitiveResourceDescriptor | null> {
  switch (kind) {
    case 'note': {
      const row = await tx.note.findFirst({ where: { id, tenantId }, select: {
        id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
        createdByUserId: true, visibility: true, aclVersion: true,
      } });
      return row ? noteDescriptor(row) : null;
    }
    case 'transcript': {
      const row = await tx.transcript.findFirst({ where: { id, tenantId }, select: {
        id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
        createdByUserId: true, visibility: true, aclVersion: true,
      } });
      return row ? transcriptDescriptor(row) : null;
    }
    case 'candidate': {
      const row = await tx.candidate.findFirst({ where: { id, tenantId }, select: {
        id: true, tenantId: true, accountId: true, matterId: true,
        createdByUserId: true, visibility: true, aclVersion: true,
      } });
      return row ? candidateDescriptor(row) : null;
    }
    case 'source_artifact': {
      const row = await tx.sourceArtifact.findFirst({ where: { id, tenantId }, select: {
        id: true, tenantId: true, accountId: true, matterId: true, personId: true,
        createdByUserId: true, visibility: true, aclVersion: true,
      } });
      return row ? sourceArtifactDescriptor(row) : null;
    }
    default:
      throw new SensitiveAclError('invalid_resource_kind');
  }
}

async function updateAclVersion(
  tx: Tx,
  descriptor: SensitiveResourceDescriptor,
  expectedAclVersion: number,
  data: { visibility?: SensitiveResourceVisibility; aclVersion: number },
): Promise<void> {
  const where = { id: descriptor.id, tenantId: descriptor.tenantId, aclVersion: expectedAclVersion };
  let changed: { count: number };
  switch (descriptor.kind) {
    case 'note':
      changed = await tx.note.updateMany({ where, data });
      break;
    case 'transcript':
      changed = await tx.transcript.updateMany({ where, data });
      break;
    case 'candidate':
      changed = await tx.candidate.updateMany({ where, data });
      break;
    case 'source_artifact':
      changed = await tx.sourceArtifact.updateMany({ where, data });
      break;
    default:
      throw new SensitiveAclError('invalid_resource_kind');
  }
  if (changed.count !== 1) throw new SensitiveAclError('acl_version_conflict');
}

async function audit(
  tx: Tx,
  actor: ActorInput,
  action: string,
  descriptor: SensitiveResourceDescriptor,
  changedFields: readonly string[],
  metadata: Record<string, string | number | null>,
): Promise<void> {
  await tx.auditEvent.create({ data: {
    id: `audit_${randomUUID().replaceAll('-', '')}`,
    tenantId: actor.tenantId,
    actorId: actor.actorId,
    channel: 'system',
    action,
    entityKind: descriptor.kind,
    entityId: descriptor.id,
    requestId: actor.requestId,
    changedFields: JSON.stringify(changedFields),
    metadata: JSON.stringify(metadata),
  } });
}

async function requireManage(
  tx: Tx,
  actor: ActorInput,
  policy: CapabilityPolicy,
  kind: SensitiveResourceKind,
  resourceId: string,
  expectedAclVersion: number,
): Promise<SensitiveResourceDescriptor> {
  const descriptor = await loadDescriptor(tx, actor.tenantId, kind, resourceId);
  if (!descriptor) throw new SensitiveAclError('sensitive_resource_not_found');
  if (descriptor.aclVersion !== expectedAclVersion) throw new SensitiveAclError('acl_version_conflict');
  const decision = await authorizeSensitiveResource(tx, {
    tenantId: actor.tenantId,
    userId: actor.actorId,
    role: actor.actorRole,
  }, policy, descriptor, 'manage');
  if (!decision.allowed) throw new SensitiveAclError('sensitive_resource_not_found');
  return descriptor;
}

export async function setSensitiveResourceVisibility(
  db: DbClient,
  input: ActorInput & {
    kind: SensitiveResourceKind;
    resourceId: string;
    visibility: Exclude<SensitiveResourceVisibility, 'owner_admin_only'>;
    expectedAclVersion: number;
  },
  policy: CapabilityPolicy,
): Promise<{ aclVersion: number }> {
  return inSerializableTransaction(db, async (tx) => {
    const descriptor = await requireManage(
      tx, input, policy, input.kind, input.resourceId, input.expectedAclVersion,
    );
    if (!descriptor.createdByUserId) {
      throw new SensitiveAclError('quarantine_not_shareable');
    }
    if (input.visibility === 'matter_shared' && !descriptor.matterId) {
      throw new SensitiveAclError('matter_parent_required');
    }
    const aclVersion = descriptor.aclVersion + 1;
    await updateAclVersion(tx, descriptor, input.expectedAclVersion, {
      visibility: input.visibility,
      aclVersion,
    });
    if (descriptor.kind === 'note') {
      await ensureSourceArtifactForNote(tx, input.tenantId, descriptor.id);
    } else if (descriptor.kind === 'transcript') {
      await ensureSourceArtifactForTranscript(tx, input.tenantId, descriptor.id);
    }
    if (descriptor.kind === 'candidate') {
      if (input.visibility === 'private') {
        await tx.sensitiveResourceGrant.updateMany({
          where: {
            tenantId: input.tenantId, resourceKind: 'candidate', resourceId: input.resourceId,
            revokedAt: null,
          },
          data: { revokedAt: new Date(), revokedByUserId: input.actorId },
        });
      } else {
        await tx.sensitiveResourceGrant.updateMany({
          where: {
            tenantId: input.tenantId, resourceKind: 'candidate', resourceId: input.resourceId,
            revokedAt: null,
          },
          data: { resourceAclVersion: aclVersion },
        });
      }
    }
    await audit(tx, input, 'SENSITIVE_VISIBILITY_SET', descriptor, ['visibility', 'aclVersion'], {
      fromVisibility: descriptor.visibility,
      toVisibility: input.visibility,
      fromAclVersion: descriptor.aclVersion,
      toAclVersion: aclVersion,
    });
    return { aclVersion };
  });
}

export async function grantCandidateReviewer(
  db: DbClient,
  input: ActorInput & {
    candidateId: string;
    granteeUserId: string;
    expectedAclVersion: number;
  },
  policy: CapabilityPolicy,
): Promise<{ aclVersion: number; grantId: string }> {
  return inSerializableTransaction(db, async (tx) => {
    const descriptor = await requireManage(
      tx, input, policy, 'candidate', input.candidateId, input.expectedAclVersion,
    );
    if (descriptor.visibility !== 'matter_shared') throw new SensitiveAclError('candidate_not_shared');
    const grantee = await tx.user.findFirst({
      where: { id: input.granteeUserId, tenantId: input.tenantId },
      select: { id: true, role: true },
    });
    if (!grantee || grantee.role === 'viewer' || !['owner', 'admin', 'member'].includes(grantee.role)) {
      throw new SensitiveAclError('invalid_reviewer');
    }
    const aclVersion = descriptor.aclVersion + 1;
    await updateAclVersion(tx, descriptor, input.expectedAclVersion, { aclVersion });
    await tx.sensitiveResourceGrant.updateMany({
      where: {
        tenantId: input.tenantId, resourceKind: 'candidate', resourceId: input.candidateId,
        revokedAt: null,
      },
      data: { resourceAclVersion: aclVersion },
    });
    const grantId = `srg_${randomUUID().replaceAll('-', '')}`;
    const grant = await tx.sensitiveResourceGrant.upsert({
      where: { tenantId_resourceKind_resourceId_granteeUserId_grantKind: {
        tenantId: input.tenantId,
        resourceKind: 'candidate',
        resourceId: input.candidateId,
        granteeUserId: grantee.id,
        grantKind: 'reviewer',
      } },
      update: {
        grantedByUserId: input.actorId,
        resourceAclVersion: aclVersion,
        grantedAt: new Date(),
        revokedAt: null,
        revokedByUserId: null,
      },
      create: {
        id: grantId,
        tenantId: input.tenantId,
        resourceKind: 'candidate',
        resourceId: input.candidateId,
        granteeUserId: grantee.id,
        grantedByUserId: input.actorId,
        grantKind: 'reviewer',
        resourceAclVersion: aclVersion,
      },
      select: { id: true },
    });
    await audit(tx, input, 'SENSITIVE_REVIEWER_GRANTED', descriptor, ['aclVersion', 'reviewerGrant'], {
      granteeUserId: grantee.id,
      fromAclVersion: descriptor.aclVersion,
      toAclVersion: aclVersion,
      grantKind: 'reviewer',
    });
    return { aclVersion, grantId: grant.id };
  });
}

export async function revokeCandidateReviewer(
  db: DbClient,
  input: ActorInput & {
    candidateId: string;
    granteeUserId: string;
    expectedAclVersion: number;
  },
  policy: CapabilityPolicy,
): Promise<{ aclVersion: number }> {
  return inSerializableTransaction(db, async (tx) => {
    const descriptor = await requireManage(
      tx, input, policy, 'candidate', input.candidateId, input.expectedAclVersion,
    );
    const existing = await tx.sensitiveResourceGrant.findFirst({ where: {
      tenantId: input.tenantId,
      resourceKind: 'candidate',
      resourceId: input.candidateId,
      granteeUserId: input.granteeUserId,
      grantKind: 'reviewer',
      resourceAclVersion: descriptor.aclVersion,
      revokedAt: null,
    }, select: { id: true } });
    if (!existing) throw new SensitiveAclError('reviewer_grant_not_found');
    const aclVersion = descriptor.aclVersion + 1;
    await updateAclVersion(tx, descriptor, input.expectedAclVersion, { aclVersion });
    await tx.sensitiveResourceGrant.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedByUserId: input.actorId },
    });
    await tx.sensitiveResourceGrant.updateMany({
      where: {
        tenantId: input.tenantId, resourceKind: 'candidate', resourceId: input.candidateId,
        revokedAt: null,
      },
      data: { resourceAclVersion: aclVersion },
    });
    await audit(tx, input, 'SENSITIVE_REVIEWER_REVOKED', descriptor, ['aclVersion', 'reviewerGrant'], {
      granteeUserId: input.granteeUserId,
      fromAclVersion: descriptor.aclVersion,
      toAclVersion: aclVersion,
      grantKind: 'reviewer',
    });
    return { aclVersion };
  });
}
