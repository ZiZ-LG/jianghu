import { createHash } from 'node:crypto';

export const SOURCE_ARTIFACT_BACKING_KINDS = ['transcript', 'note', 'external_reference'] as const;
export const SOURCE_ARTIFACT_KINDS = ['transcript', 'uploaded_file', 'note', 'external_reference'] as const;
export const SOURCE_ARTIFACT_RETENTION_STATES = ['available', 'degraded', 'reference_only', 'deleted'] as const;
export const SOURCE_ARTIFACT_FINGERPRINT_KINDS = ['content_sha256_v1', 'reference_sha256_v1'] as const;

export type SourceArtifactBackingKind = typeof SOURCE_ARTIFACT_BACKING_KINDS[number];
export type SourceArtifactKind = typeof SOURCE_ARTIFACT_KINDS[number];
export type SourceArtifactRetentionState = typeof SOURCE_ARTIFACT_RETENTION_STATES[number];
export type SourceArtifactFingerprintKind = typeof SOURCE_ARTIFACT_FINGERPRINT_KINDS[number];
export type SourceArtifactVisibility = 'private' | 'matter_shared' | 'owner_admin_only';

export interface SourceArtifactProjection {
  id: string;
  tenantId: string;
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
  backingKind: SourceArtifactBackingKind;
  backingId: string;
  artifactKind: SourceArtifactKind;
  source: string;
  externalRef: string | null;
  idempotencyDomain: string;
  title: string;
  occurredAt: Date | null;
  fingerprintKind: SourceArtifactFingerprintKind;
  sourceFingerprint: string;
  retentionState: SourceArtifactRetentionState;
  retentionUpdatedAt: Date;
  createdByUserId: string | null;
  visibility: SourceArtifactVisibility;
  aclVersion: number;
  createdAt: Date;
}

export interface NoteProjectionAuthority {
  id: string;
  tenantId: string;
  accountId: string | null;
  opportunityId: string | null;
  personId: string | null;
  content: string;
  source: string;
  createdByUserId: string | null;
  visibility: string;
  aclVersion: number;
  createdAt: Date;
}

export interface TranscriptProjectionAuthority {
  id: string;
  tenantId: string;
  accountId: string | null;
  opportunityId: string | null;
  personId: string | null;
  source: string;
  externalRef: string | null;
  idempotencyDomain: string;
  title: string;
  contentEnc: string;
  recordedAt: Date | null;
  status: string;
  createdByUserId: string | null;
  visibility: string;
  aclVersion: number;
  createdAt: Date;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function canonical(value: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

export function contentFingerprint(content: string): string {
  return sha256(content);
}

export function referenceFingerprint(input: {
  idempotencyDomain: string;
  source: string;
  externalRef: string;
}): string {
  return sha256(canonical(input));
}

export function sourceArtifactIdempotencyDomain(createdByUserId: string | null): string {
  return createdByUserId ? `creator-private-v1:${JSON.stringify(createdByUserId)}` : 'system-quarantine-v1';
}

export function artifactIdForBacking(
  tenantId: string,
  backingKind: Exclude<SourceArtifactBackingKind, 'external_reference'>,
  backingId: string,
): string {
  return `src_${sha256(JSON.stringify(['backing-v1', tenantId, backingKind, backingId])).slice(0, 32)}`;
}

export function artifactIdForExternalReference(
  tenantId: string,
  idempotencyDomain: string,
  source: string,
  externalRef: string,
): string {
  return `src_${sha256(JSON.stringify([
    'external-reference-v1', tenantId, idempotencyDomain, source, externalRef,
  ])).slice(0, 32)}`;
}

function asVisibility(value: string): SourceArtifactVisibility {
  return value as SourceArtifactVisibility;
}

function fallbackReferenceFingerprint(input: {
  tenantId: string;
  idempotencyDomain: string;
  source: string;
  externalRef: string | null;
  backingKind: string;
  backingId: string;
}): string {
  return sha256(canonical({
    tenantId: input.tenantId,
    idempotencyDomain: input.idempotencyDomain,
    source: input.source,
    externalRef: input.externalRef ?? '',
    backingKind: input.backingKind,
    backingId: input.backingId,
  }));
}

export function sourceArtifactProjectionForNote(row: NoteProjectionAuthority): SourceArtifactProjection {
  const idempotencyDomain = sourceArtifactIdempotencyDomain(row.createdByUserId);
  return {
    id: artifactIdForBacking(row.tenantId, 'note', row.id),
    tenantId: row.tenantId,
    accountId: row.accountId,
    matterId: row.opportunityId,
    personId: row.personId,
    backingKind: 'note',
    backingId: row.id,
    artifactKind: 'note',
    source: row.source,
    externalRef: null,
    idempotencyDomain,
    title: '',
    occurredAt: row.createdAt,
    fingerprintKind: 'content_sha256_v1',
    sourceFingerprint: contentFingerprint(row.content),
    retentionState: 'available',
    retentionUpdatedAt: row.createdAt,
    createdByUserId: row.createdByUserId,
    visibility: asVisibility(row.visibility),
    aclVersion: row.aclVersion,
    createdAt: row.createdAt,
  };
}

export function sourceArtifactProjectionForTranscript(row: TranscriptProjectionAuthority): SourceArtifactProjection {
  const available = row.status !== 'redacted' && row.contentEnc.length > 0;
  const fingerprintKind: SourceArtifactFingerprintKind = available
    ? 'content_sha256_v1'
    : 'reference_sha256_v1';
  const sourceFingerprint = available
    ? contentFingerprint(row.contentEnc)
    : fallbackReferenceFingerprint({
        tenantId: row.tenantId,
        idempotencyDomain: row.idempotencyDomain,
        source: row.source,
        externalRef: row.externalRef,
        backingKind: 'transcript',
        backingId: row.id,
      });
  return {
    id: artifactIdForBacking(row.tenantId, 'transcript', row.id),
    tenantId: row.tenantId,
    accountId: row.accountId,
    matterId: row.opportunityId,
    personId: row.personId,
    backingKind: 'transcript',
    backingId: row.id,
    artifactKind: row.source === 'upload' ? 'uploaded_file' : 'transcript',
    source: row.source,
    externalRef: row.externalRef,
    idempotencyDomain: row.idempotencyDomain,
    title: row.title.slice(0, 200),
    occurredAt: row.recordedAt,
    fingerprintKind,
    sourceFingerprint,
    retentionState: available ? 'available' : 'degraded',
    retentionUpdatedAt: row.createdAt,
    createdByUserId: row.createdByUserId,
    visibility: asVisibility(row.visibility),
    aclVersion: row.aclVersion,
    createdAt: row.createdAt,
  };
}

const inSet = <T extends string>(values: readonly T[], value: unknown): value is T => (
  typeof value === 'string' && (values as readonly string[]).includes(value)
);

export type SourceArtifactValidationResult = { ok: true } | { ok: false; code: string };

export function validateSourceArtifactProjection(row: SourceArtifactProjection): SourceArtifactValidationResult {
  if (!inSet(SOURCE_ARTIFACT_BACKING_KINDS, row.backingKind)) return { ok: false, code: 'backing_kind_invalid' };
  if (!inSet(SOURCE_ARTIFACT_KINDS, row.artifactKind)) return { ok: false, code: 'artifact_kind_invalid' };
  if (!inSet(SOURCE_ARTIFACT_RETENTION_STATES, row.retentionState)) return { ok: false, code: 'retention_state_invalid' };
  if (!inSet(SOURCE_ARTIFACT_FINGERPRINT_KINDS, row.fingerprintKind)) return { ok: false, code: 'fingerprint_kind_invalid' };
  if (!/^[a-f0-9]{64}$/.test(row.sourceFingerprint)) return { ok: false, code: 'fingerprint_invalid' };
  if (!Number.isSafeInteger(row.aclVersion) || row.aclVersion < 1) return { ok: false, code: 'acl_version_invalid' };
  if (!['private', 'matter_shared', 'owner_admin_only'].includes(row.visibility)) return { ok: false, code: 'visibility_invalid' };
  if (row.visibility === 'matter_shared' && !row.matterId) return { ok: false, code: 'shared_matter_required' };
  if ((!row.createdByUserId && row.visibility !== 'owner_admin_only')
    || (row.createdByUserId && row.visibility === 'owner_admin_only')) {
    return { ok: false, code: 'creator_visibility_invalid' };
  }
  if (row.idempotencyDomain !== sourceArtifactIdempotencyDomain(row.createdByUserId)) {
    return { ok: false, code: 'idempotency_domain_invalid' };
  }
  if (row.retentionState === 'available' && row.fingerprintKind !== 'content_sha256_v1') {
    return { ok: false, code: 'available_content_fingerprint_required' };
  }
  // A lifecycle degradation preserves the original content digest; rows already
  // redacted before projection use a reference digest because no body remains.
  if (row.retentionState === 'reference_only' && row.fingerprintKind !== 'reference_sha256_v1') {
    return { ok: false, code: 'reference_fingerprint_required' };
  }
  if (row.retentionState === 'degraded' && row.backingKind !== 'transcript') {
    return { ok: false, code: 'degraded_transcript_required' };
  }
  if (row.retentionState === 'reference_only' && row.backingKind !== 'external_reference') {
    return { ok: false, code: 'reference_external_backing_required' };
  }
  if (row.backingKind === 'external_reference') {
    if (row.backingId !== row.id || row.artifactKind !== 'external_reference' || !row.externalRef) {
      return { ok: false, code: 'external_reference_identity_invalid' };
    }
    if (row.retentionState !== 'reference_only' && row.retentionState !== 'deleted') {
      return { ok: false, code: 'external_reference_retention_invalid' };
    }
  } else if (row.backingKind === 'note') {
    if (row.artifactKind !== 'note') return { ok: false, code: 'note_artifact_kind_invalid' };
  } else {
    const expectedKind = row.source === 'upload' ? 'uploaded_file' : 'transcript';
    if (row.artifactKind !== expectedKind) return { ok: false, code: 'transcript_artifact_kind_invalid' };
  }
  return { ok: true };
}

export function sourceArtifactCreateData(projection: SourceArtifactProjection) {
  return { ...projection };
}
