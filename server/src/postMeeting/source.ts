import { ActorRoleSchema, type CapabilityPolicy } from '@jianghu/domain-contracts';
import type { Prisma } from '@prisma/client';
import { dec } from '../ai.js';
import { AgentPreparationError } from '../agents/model.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  authorizeSensitiveResource,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import {
  sourceArtifactProjectionForNote,
  sourceArtifactProjectionForTranscript,
  type SourceArtifactProjection,
} from '../sourceArtifacts/model.js';
import {
  SOURCE_ARTIFACT_METADATA_SELECT,
  sourceArtifactMetadataIsValid,
} from '../sourceArtifacts/service.js';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_CONTEXT_PEOPLE = 500;

type SourceRow = Prisma.SourceArtifactGetPayload<{
  select: typeof SOURCE_ARTIFACT_METADATA_SELECT;
}>;

export interface PostMeetingSourceInput {
  tenantId: string;
  actorId: string;
  customerId: string;
  matterId: string | null;
  sourceArtifactId: string;
  expectedAclVersion: number;
}

export interface PostMeetingSourceLoadOptions {
  decrypt?: (ciphertext: string) => string;
  maxBodyBytes?: number;
}

export interface PostMeetingPersonContext {
  id: string;
  name: string;
  title: string;
  version: number;
}

export interface AuthorizedPostMeetingSource {
  id: string;
  artifactKind: 'transcript' | 'uploaded_file' | 'note';
  title: string;
  sourceFingerprint: string;
  aclVersion: number;
  occurredAt: string | null;
  observedAt: string;
  body: string;
  customer: {
    id: string;
    name: string;
    categoryKey: string | null;
    version: number;
  };
  matter: {
    id: string;
    customerId: string;
    title: string;
    kind: string;
    priority: string | null;
    targetDate: string | null;
    version: number;
  } | null;
  people: PostMeetingPersonContext[];
}

function fail(code: string): never {
  throw new AgentPreparationError(code);
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

/**
 * Compares the backing-derived projection with the stored metadata authority.
 * The body is intentionally absent from this comparison boundary.
 */
function projectionMatchesStored(projection: SourceArtifactProjection, stored: SourceRow): boolean {
  return projection.id === stored.id
    && projection.tenantId === stored.tenantId
    && projection.accountId === stored.accountId
    && projection.matterId === stored.matterId
    && projection.personId === stored.personId
    && projection.backingKind === stored.backingKind
    && projection.backingId === stored.backingId
    && projection.artifactKind === stored.artifactKind
    && projection.source === stored.source
    && projection.externalRef === stored.externalRef
    && projection.idempotencyDomain === stored.idempotencyDomain
    && projection.title === stored.title
    && sameInstant(projection.occurredAt, stored.occurredAt)
    && projection.fingerprintKind === stored.fingerprintKind
    && projection.sourceFingerprint === stored.sourceFingerprint
    && projection.retentionState === stored.retentionState
    && projection.createdByUserId === stored.createdByUserId
    && projection.visibility === stored.visibility
    && projection.aclVersion === stored.aclVersion
    && projection.createdAt.getTime() === stored.createdAt.getTime();
}

function checkedBody(body: string, maxBodyBytes: number): string {
  if (!body.trim()) fail('post_meeting_source_unavailable');
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) fail('post_meeting_source_too_large');
  return body;
}

/**
 * Loads one source body only after current database role/scope, creator/share ACL,
 * exact anchors, ACL generation and backing fingerprint all pass. The returned
 * object is request-local and must never be persisted as an Agent audit payload.
 */
export async function loadAuthorizedPostMeetingSource(
  db: DbClient,
  policy: CapabilityPolicy,
  input: PostMeetingSourceInput,
  options: PostMeetingSourceLoadOptions = {},
): Promise<AuthorizedPostMeetingSource> {
  const actor = await db.user.findFirst({
    where: { id: input.actorId, tenantId: input.tenantId },
    select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success) fail('post_meeting_source_not_found');
  if (role.data === 'viewer') fail('viewer_write_denied');

  const source = await db.sourceArtifact.findFirst({
    where: { id: input.sourceArtifactId, tenantId: input.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!source
    || !sourceArtifactMetadataIsValid(source)
    || source.accountId !== input.customerId
    || source.matterId !== input.matterId) {
    fail('post_meeting_source_not_found');
  }
  if (source.retentionState !== 'available'
    || !['transcript', 'uploaded_file', 'note'].includes(source.artifactKind)
    || !['transcript', 'note'].includes(source.backingKind)) {
    fail('post_meeting_source_unavailable');
  }

  const access = await authorizeSensitiveResource(db, {
    tenantId: input.tenantId,
    userId: input.actorId,
    role: role.data,
  }, policy, sourceArtifactDescriptor(source), 'read');
  if (!access.allowed) fail('post_meeting_source_not_found');
  if (source.aclVersion !== input.expectedAclVersion) fail('post_meeting_source_stale');

  const [customer, matter, people] = await Promise.all([
    db.account.findFirst({
      where: { id: input.customerId, tenantId: input.tenantId, archivedAt: null },
      select: { id: true, name: true, categoryKey: true, version: true },
    }),
    input.matterId === null ? Promise.resolve(null) : db.opportunity.findFirst({
      where: {
        id: input.matterId,
        tenantId: input.tenantId,
        accountId: input.customerId,
        archivedAt: null,
        account: { tenantId: input.tenantId, archivedAt: null },
      },
      select: {
        id: true, accountId: true, name: true, kind: true,
        priority: true, targetDate: true, version: true,
      },
    }),
    db.person.findMany({
      where: {
        tenantId: input.tenantId,
        accountId: input.customerId,
        archivedAt: null,
        mergedIntoPersonId: null,
      },
      orderBy: { id: 'asc' },
      take: MAX_CONTEXT_PEOPLE + 1,
      select: { id: true, name: true, title: true, version: true },
    }),
  ]);
  if (!customer || (input.matterId !== null && !matter)) fail('post_meeting_source_not_found');
  if (people.length > MAX_CONTEXT_PEOPLE) fail('post_meeting_context_too_large');

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > DEFAULT_MAX_BODY_BYTES) {
    fail('post_meeting_source_limit_invalid');
  }

  let body: string;
  if (source.backingKind === 'note') {
    const note = await db.note.findFirst({
      where: { id: source.backingId, tenantId: input.tenantId },
      select: {
        id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
        content: true, source: true, createdByUserId: true, visibility: true,
        aclVersion: true, createdAt: true,
      },
    });
    if (!note) fail('post_meeting_source_unavailable');
    const projection = sourceArtifactProjectionForNote(note);
    if (!projectionMatchesStored(projection, source)) {
      fail('post_meeting_source_fingerprint_mismatch');
    }
    body = checkedBody(note.content, maxBodyBytes);
  } else {
    const transcript = await db.transcript.findFirst({
      where: { id: source.backingId, tenantId: input.tenantId },
      select: {
        id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
        source: true, externalRef: true, idempotencyDomain: true, title: true,
        contentEnc: true, recordedAt: true, status: true, createdByUserId: true,
        visibility: true, aclVersion: true, createdAt: true,
      },
    });
    if (!transcript || transcript.status === 'redacted' || !transcript.contentEnc) {
      fail('post_meeting_source_unavailable');
    }
    const projection = sourceArtifactProjectionForTranscript(transcript);
    if (!projectionMatchesStored(projection, source)) {
      fail('post_meeting_source_fingerprint_mismatch');
    }
    body = checkedBody((options.decrypt ?? dec)(transcript.contentEnc), maxBodyBytes);
  }

  return {
    id: source.id,
    artifactKind: source.artifactKind as AuthorizedPostMeetingSource['artifactKind'],
    title: source.title,
    sourceFingerprint: source.sourceFingerprint,
    aclVersion: source.aclVersion,
    occurredAt: source.occurredAt?.toISOString() ?? null,
    observedAt: (source.occurredAt ?? source.createdAt).toISOString(),
    body,
    customer,
    matter: matter ? {
      id: matter.id,
      customerId: matter.accountId,
      title: matter.name,
      kind: matter.kind,
      priority: matter.priority,
      targetDate: matter.targetDate,
      version: matter.version,
    } : null,
    people,
  };
}
