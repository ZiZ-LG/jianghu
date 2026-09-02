import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
  CapabilityPolicy,
  CommandContext,
  PostMeetingSourceOption,
} from '@jianghu/domain-contracts';
import {
  ActorRoleSchema,
  PostMeetingSourceOptionSchema,
  capabilityPolicyAllows,
} from '@jianghu/domain-contracts';
import { dec, enc } from '../ai.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import {
  SOURCE_ARTIFACT_METADATA_SELECT,
  ensureSourceArtifactForTranscript,
  sourceArtifactMetadataIsValid,
  sourceArtifactProjectionMatchesMetadata,
} from '../sourceArtifacts/service.js';
import { sourceArtifactProjectionForTranscript } from '../sourceArtifacts/model.js';
import { transcriptIdempotencyDomainForCreator } from '../transcriptDedupe.js';
import type { PreparedPostMeetingSource } from './importModel.js';

const SHA256 = /^[a-f0-9]{64}$/;
const FEISHU_TOKEN = /^[A-Za-z0-9_-]{8,200}$/;
const MAX_SOURCE_CHARACTERS = 500_000;

export class PostMeetingImportError extends Error {
  readonly scopedNotFound: boolean;

  constructor(readonly code: string, readonly statusCode = 400, scopedNotFound = false) {
    super(code);
    this.name = 'PostMeetingImportError';
    this.scopedNotFound = scopedNotFound;
  }
}

function failScoped(): never {
  throw new PostMeetingImportError('post_meeting_import_not_found', 404, true);
}

function validatePrepared(prepared: PreparedPostMeetingSource): PreparedPostMeetingSource {
  if (prepared.source !== 'upload' && prepared.source !== 'feishu') {
    throw new PostMeetingImportError('post_meeting_import_source_invalid');
  }
  const expectedExternalRef = prepared.source === 'upload'
    ? /^upload:[a-f0-9]{64}$/
    : new RegExp(`^feishu:${FEISHU_TOKEN.source.slice(1, -1)}$`);
  if (!expectedExternalRef.test(prepared.externalRef)) {
    throw new PostMeetingImportError('post_meeting_import_identity_invalid');
  }
  const title = prepared.title.trim().slice(0, 200);
  if (!title) throw new PostMeetingImportError('post_meeting_import_title_invalid');
  if (!prepared.text.trim() || prepared.text.length > MAX_SOURCE_CHARACTERS) {
    throw new PostMeetingImportError('post_meeting_import_body_invalid');
  }
  const digest = createHash('sha256').update(prepared.text).digest('hex');
  if (!SHA256.test(prepared.contentFingerprint) || digest !== prepared.contentFingerprint) {
    throw new PostMeetingImportError('post_meeting_import_fingerprint_invalid');
  }
  if (!Number.isSafeInteger(prepared.durationSec) || prepared.durationSec < 0) {
    throw new PostMeetingImportError('post_meeting_import_duration_invalid');
  }
  if (prepared.recordedAt !== null && Number.isNaN(prepared.recordedAt.getTime())) {
    throw new PostMeetingImportError('post_meeting_import_occurred_at_invalid');
  }
  return { ...prepared, title };
}

async function authorizeMount(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  mount: { customerId: string; matterId: string },
): Promise<{ actorRole: 'owner' | 'admin' | 'member' }> {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new PostMeetingImportError('capability_denied', 403);
  }
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.valid) throw new PostMeetingImportError('post_meeting_import_actor_invalid', 401);
  const currentRole = ActorRoleSchema.parse(scope.actorRole);
  if (currentRole === 'viewer') throw new PostMeetingImportError('viewer_write_denied', 403);
  if (!scope.canReadAccountData(mount.customerId) || !scope.canReadMatter(mount.matterId)) failScoped();
  const matter = await db.opportunity.findFirst({
    where: {
      id: mount.matterId,
      tenantId: ctx.tenantId,
      accountId: mount.customerId,
      archivedAt: null,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { id: true },
  });
  if (!matter) failScoped();
  return { actorRole: currentRole };
}

export async function authorizePostMeetingImportMount(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  mount: { customerId: string; matterId: string },
): Promise<void> {
  await authorizeMount(db, ctx, policy, mount);
}

function sourceOption(row: Awaited<ReturnType<typeof ensureSourceArtifactForTranscript>>): PostMeetingSourceOption {
  if (!sourceArtifactMetadataIsValid(row)
    || !row.accountId
    || (row.artifactKind !== 'uploaded_file' && row.artifactKind !== 'transcript')
    || row.retentionState !== 'available') {
    throw new PostMeetingImportError('post_meeting_import_projection_invalid', 409);
  }
  return PostMeetingSourceOptionSchema.parse({
    id: row.id,
    customerId: row.accountId,
    matterId: row.matterId,
    title: row.title,
    kind: row.artifactKind,
    fingerprint: row.sourceFingerprint,
    aclVersion: row.aclVersion,
    version: row.aclVersion,
    occurredAt: row.occurredAt?.toISOString() ?? null,
  });
}

const TRANSCRIPT_PROJECTION_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  opportunityId: true,
  personId: true,
  source: true,
  externalRef: true,
  idempotencyDomain: true,
  title: true,
  contentEnc: true,
  durationSec: true,
  recordedAt: true,
  status: true,
  createdBy: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  createdAt: true,
} as const;

type TranscriptProjectionRow = Prisma.TranscriptGetPayload<{
  select: typeof TRANSCRIPT_PROJECTION_SELECT;
}>;

export interface EncryptedTranscriptCreateInput {
  tenantId: string;
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
  source: string;
  externalRef: string | null;
  idempotencyDomain: string;
  title: string;
  text: string;
  durationSec: number;
  recordedAt: Date | null;
  createdBy: string;
  createdByUserId: string | null;
  visibility: 'private' | 'owner_admin_only' | 'matter_shared';
  aclVersion: number;
}

export async function findEncryptedTranscriptByIdentity(
  db: DbClient,
  identity: { tenantId: string; idempotencyDomain: string; source: string; externalRef: string | null },
): Promise<TranscriptProjectionRow | null> {
  if (!identity.externalRef) return null;
  return db.transcript.findUnique({
    where: {
      tenantId_idempotencyDomain_source_externalRef: {
        tenantId: identity.tenantId,
        idempotencyDomain: identity.idempotencyDomain,
        source: identity.source,
        externalRef: identity.externalRef,
      },
    },
    select: TRANSCRIPT_PROJECTION_SELECT,
  });
}

export async function createEncryptedTranscriptWithProjection(
  db: DbClient,
  input: EncryptedTranscriptCreateInput,
): Promise<{
  transcript: TranscriptProjectionRow;
  artifact: Awaited<ReturnType<typeof ensureSourceArtifactForTranscript>>;
}> {
  const transcriptId = `tr_${randomUUID().replaceAll('-', '')}`;
  const transcript = await db.transcript.create({
    data: {
      id: transcriptId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      opportunityId: input.matterId,
      personId: input.personId,
      source: input.source,
      externalRef: input.externalRef,
      idempotencyDomain: input.idempotencyDomain,
      title: input.title.slice(0, 200),
      contentEnc: enc(input.text),
      durationSec: Math.max(0, Math.round(input.durationSec)),
      recordedAt: input.recordedAt,
      status: 'active',
      createdBy: input.createdBy,
      createdByUserId: input.createdByUserId,
      visibility: input.visibility,
      aclVersion: input.aclVersion,
    },
    select: TRANSCRIPT_PROJECTION_SELECT,
  });
  const artifact = await ensureSourceArtifactForTranscript(db, input.tenantId, transcriptId);
  return { transcript, artifact };
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

async function replayExisting(
  db: DbClient,
  ctx: CommandContext,
  mount: { customerId: string; matterId: string },
  prepared: PreparedPostMeetingSource,
  transcript: TranscriptProjectionRow,
): Promise<{ source: PostMeetingSourceOption; businessReplayed: true }> {
  const decrypted = dec(transcript.contentEnc);
  const storedBodyFingerprint = decrypted
    ? createHash('sha256').update(decrypted).digest('hex')
    : '';
  if (transcript.tenantId !== ctx.tenantId
    || transcript.accountId !== mount.customerId
    || transcript.opportunityId !== mount.matterId
    || transcript.personId !== null
    || transcript.source !== prepared.source
    || transcript.externalRef !== prepared.externalRef
    || transcript.idempotencyDomain !== transcriptIdempotencyDomainForCreator(ctx.actorId)
    || transcript.title !== prepared.title
    || storedBodyFingerprint !== prepared.contentFingerprint
    || transcript.durationSec !== prepared.durationSec
    || !sameInstant(transcript.recordedAt, prepared.recordedAt)
    || transcript.status !== 'active'
    || transcript.createdBy !== ctx.actorId
    || transcript.createdByUserId !== ctx.actorId
    || transcript.visibility !== 'private'
    || transcript.aclVersion !== 1) {
    throw new PostMeetingImportError('post_meeting_import_conflict', 409);
  }
  const artifact = await db.sourceArtifact.findFirst({
    where: {
      tenantId: ctx.tenantId,
      backingKind: 'transcript',
      backingId: transcript.id,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  const derived = sourceArtifactProjectionForTranscript(transcript);
  if (!artifact
    || artifact.retentionState !== 'available'
    || !sourceArtifactMetadataIsValid(artifact)
    || !sourceArtifactProjectionMatchesMetadata(derived, artifact)) {
    throw new PostMeetingImportError('post_meeting_import_conflict', 409);
  }
  return { source: sourceOption(artifact), businessReplayed: true };
}

export async function readImportedPostMeetingSource(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  mount: { customerId: string; matterId: string },
  identity: { source: 'upload' | 'feishu'; externalRef: string },
): Promise<PostMeetingSourceOption> {
  await authorizeMount(db, ctx, policy, mount);
  const transcript = await findEncryptedTranscriptByIdentity(db, {
    tenantId: ctx.tenantId,
    idempotencyDomain: transcriptIdempotencyDomainForCreator(ctx.actorId),
    source: identity.source,
    externalRef: identity.externalRef,
  });
  if (!transcript
    || transcript.accountId !== mount.customerId
    || transcript.opportunityId !== mount.matterId
    || transcript.personId !== null
    || transcript.status !== 'active'
    || !transcript.contentEnc
    || transcript.createdBy !== ctx.actorId
    || transcript.createdByUserId !== ctx.actorId
    || transcript.visibility !== 'private'
    || transcript.aclVersion !== 1) {
    failScoped();
  }
  const artifact = await db.sourceArtifact.findFirst({
    where: {
      tenantId: ctx.tenantId,
      backingKind: 'transcript',
      backingId: transcript.id,
    },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!artifact
    || artifact.retentionState !== 'available'
    || !sourceArtifactMetadataIsValid(artifact)
    || !sourceArtifactProjectionMatchesMetadata(sourceArtifactProjectionForTranscript(transcript), artifact)) {
    throw new PostMeetingImportError('post_meeting_import_conflict', 409);
  }
  return sourceOption(artifact);
}

export async function commitPostMeetingSource(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  mount: { customerId: string; matterId: string },
  rawPrepared: PreparedPostMeetingSource,
): Promise<{ source: PostMeetingSourceOption; businessReplayed: boolean }> {
  await authorizeMount(db, ctx, policy, mount);
  const prepared = validatePrepared(rawPrepared);
  const idempotencyDomain = transcriptIdempotencyDomainForCreator(ctx.actorId);
  const existing = await findEncryptedTranscriptByIdentity(db, {
    tenantId: ctx.tenantId,
    idempotencyDomain,
    source: prepared.source,
    externalRef: prepared.externalRef,
  });
  if (existing) return replayExisting(db, ctx, mount, prepared, existing);
  const created = await createEncryptedTranscriptWithProjection(db, {
    tenantId: ctx.tenantId,
    accountId: mount.customerId,
    matterId: mount.matterId,
    personId: null,
    source: prepared.source,
    externalRef: prepared.externalRef,
    idempotencyDomain,
    title: prepared.title,
    text: prepared.text,
    durationSec: prepared.durationSec,
    recordedAt: prepared.recordedAt,
    createdBy: ctx.actorId,
    createdByUserId: ctx.actorId,
    visibility: 'private',
    aclVersion: 1,
  });
  const exactProjection = await db.sourceArtifact.findFirst({
    where: { id: created.artifact.id, tenantId: ctx.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!exactProjection
    || exactProjection.backingId !== created.transcript.id
    || exactProjection.source !== prepared.source
    || exactProjection.externalRef !== prepared.externalRef
    || exactProjection.createdByUserId !== ctx.actorId
    || exactProjection.visibility !== 'private'
    || exactProjection.accountId !== mount.customerId
    || exactProjection.matterId !== mount.matterId) {
    throw new PostMeetingImportError('post_meeting_import_projection_invalid', 409);
  }
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID().replaceAll('-', '')}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'source_artifact.import',
    entityKind: 'source_artifact',
    entityId: exactProjection.id,
    requestId: ctx.requestId,
    changedFields: JSON.stringify(['create']),
    metadata: JSON.stringify({
      sourceKind: prepared.source,
      customerId: mount.customerId,
      matterId: mount.matterId,
      aclVersion: exactProjection.aclVersion,
      sourceFingerprint: exactProjection.sourceFingerprint,
    }),
  } });
  return { source: sourceOption(exactProjection), businessReplayed: false };
}
