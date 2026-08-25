import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  candidateDedupeKeyForCreator,
  candidatePrivateDedupeDomain,
  evidenceCandidateDedupeKey,
  fieldCandidateDedupeKey,
  personCandidateDedupeKey,
  relationCandidateDedupeKey,
  reminderCandidateDedupeKey,
} from '../candidates/dedupe.js';
import { canonicalCandidateJson } from '../candidates/migration.js';
import {
  SYSTEM_TRANSCRIPT_IDEMPOTENCY_DOMAIN,
  transcriptIdempotencyDomainForCreator,
} from '../transcriptDedupe.js';

export const SENSITIVE_ACL_MIGRATION_MARKER = 'CORE-204-sensitive-acl-v1';
const SENSITIVE_ACL_MARKER_VERSION = 1;
const SENSITIVE_KINDS = new Set(['source_artifact', 'transcript', 'note', 'candidate']);
const VISIBILITIES = new Set(['private', 'matter_shared', 'owner_admin_only']);
export const SENSITIVE_ACL_ONLINE_ROW_LIMIT = 25_000;
export const SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT = 5_000;
export const SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT = 100_000;

export function sensitiveAclOnlineVolumeConflicts(input: {
  notes: number;
  transcripts: number;
  candidates: number;
  sourceArtifacts: number;
  grants: number;
  parentRows: number;
}, markerValid = false): string[] {
  // The online envelope protects only the initial materializing backfill. Once a
  // cryptographically valid marker exists, legitimate post-cutover growth must not
  // permanently lock every later deployment out.
  if (markerValid) return [];
  const sensitiveRows = input.notes + input.transcripts + input.candidates
    + input.sourceArtifacts + input.grants;
  const conflicts: string[] = [];
  if (sensitiveRows > SENSITIVE_ACL_ONLINE_ROW_LIMIT) {
    conflicts.push(`online_sensitive_row_limit_exceeded:${sensitiveRows}:${SENSITIVE_ACL_ONLINE_ROW_LIMIT}`);
  }
  if (input.candidates > SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT) {
    conflicts.push(`online_candidate_row_limit_exceeded:${input.candidates}:${SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT}`);
  }
  if (input.parentRows > SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT) {
    conflicts.push(`online_parent_row_limit_exceeded:${input.parentRows}:${SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT}`);
  }
  return conflicts.sort();
}

export type SensitiveAclSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface SensitiveAclMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  notes: number;
  transcripts: number;
  candidates: number;
  sourceArtifacts: number;
  grants: number;
  creatorMapped: number;
  quarantined: number;
  conflicts: string[];
  receiptChecksum: string;
}

export interface SensitiveAclMigrationApplyResult extends SensitiveAclMigrationReport {
  writes: number;
}

interface MutableRow {
  kind: 'note' | 'transcript' | 'candidate';
  id: string;
  tenantId: string;
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
  legacyCreatedBy: string;
  createdByUserId: string | null;
  visibility: string;
  aclVersion: number;
  status: string | null;
  dedupeKey: string | null;
  payload: string | null;
  candidateKind: string | null;
  targetKind: string | null;
  targetId: string | null;
  fieldKey: string | null;
  source: string | null;
  sourceRef: string | null;
  externalRef: string | null;
  idempotencyDomain: string | null;
  legacySourceKind: string | null;
  legacySourceId: string | null;
  linkedDedupeKey: string | null;
  linkedStatus: string | null;
}

interface PlannedRow extends MutableRow {
  nextCreatedByUserId: string | null;
  nextVisibility: 'private' | 'matter_shared' | 'owner_admin_only';
  nextAclVersion: number;
  nextDedupeKey: string | null;
  nextIdempotencyDomain: string | null;
  nextPayload: string | null;
  nextLinkedDedupeKey: string | null;
}

interface SensitiveAclMarkerReceipt {
  version: number;
  markerChecksum: string;
  receiptChecksum: string;
  notes: number;
  transcripts: number;
  candidates: number;
  sourceArtifacts: number;
  grants: number;
  creatorMapped: number;
  quarantined: number;
}

interface SensitiveAclMarkerDetails extends SensitiveAclMarkerReceipt {
  receiptIntegrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function sensitiveAclMarkerChecksum(): string {
  return sha256(JSON.stringify({
    marker: SENSITIVE_ACL_MIGRATION_MARKER,
    version: SENSITIVE_ACL_MARKER_VERSION,
    kinds: [...SENSITIVE_KINDS].sort(),
    visibilities: [...VISIBILITIES].sort(),
    grantKind: 'reviewer',
    privateCandidateDedupeDomain: 'creator-private-v1',
    candidateSemanticDedupe: 'producer-v1',
    fieldProjectionDedupeAligned: true,
    transcriptIdempotencyDomain: 'creator-private-v1',
  }));
}

function markerReceiptIntegrityChecksum(receipt: SensitiveAclMarkerReceipt): string {
  return sha256(JSON.stringify({
    version: receipt.version,
    markerChecksum: receipt.markerChecksum,
    receiptChecksum: receipt.receiptChecksum,
    notes: receipt.notes,
    transcripts: receipt.transcripts,
    candidates: receipt.candidates,
    sourceArtifacts: receipt.sourceArtifacts,
    grants: receipt.grants,
    creatorMapped: receipt.creatorMapped,
    quarantined: receipt.quarantined,
  }));
}

function markerDetails(report: SensitiveAclMigrationReport): SensitiveAclMarkerDetails {
  const receipt: SensitiveAclMarkerReceipt = {
    version: SENSITIVE_ACL_MARKER_VERSION,
    markerChecksum: sensitiveAclMarkerChecksum(),
    receiptChecksum: report.receiptChecksum,
    notes: report.notes,
    transcripts: report.transcripts,
    candidates: report.candidates,
    sourceArtifacts: report.sourceArtifacts,
    grants: report.grants,
    creatorMapped: report.creatorMapped,
    quarantined: report.quarantined,
  };
  return { ...receipt, receiptIntegrityChecksum: markerReceiptIntegrityChecksum(receipt) };
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function markerDetailsAreValid(value: unknown): value is SensitiveAclMarkerDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (details.version !== SENSITIVE_ACL_MARKER_VERSION
    || details.markerChecksum !== sensitiveAclMarkerChecksum()
    || typeof details.receiptChecksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(details.receiptChecksum)
    || typeof details.receiptIntegrityChecksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(details.receiptIntegrityChecksum)
    || ![
      details.notes,
      details.transcripts,
      details.candidates,
      details.sourceArtifacts,
      details.grants,
      details.creatorMapped,
      details.quarantined,
    ].every(isNonNegativeInteger)) return false;
  const receipt: SensitiveAclMarkerReceipt = {
    version: details.version,
    markerChecksum: details.markerChecksum,
    receiptChecksum: details.receiptChecksum,
    notes: Number(details.notes),
    transcripts: Number(details.transcripts),
    candidates: Number(details.candidates),
    sourceArtifacts: Number(details.sourceArtifacts),
    grants: Number(details.grants),
    creatorMapped: Number(details.creatorMapped),
    quarantined: Number(details.quarantined),
  };
  return details.receiptIntegrityChecksum === markerReceiptIntegrityChecksum(receipt);
}

function receiptChecksum(rows: readonly PlannedRow[]): string {
  return sha256(JSON.stringify(rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    tenantId: row.tenantId,
    accountId: row.accountId,
    matterId: row.matterId,
    personId: row.personId,
    createdByUserId: row.nextCreatedByUserId,
    visibility: row.nextVisibility,
    aclVersion: row.nextAclVersion,
    dedupeKey: row.nextDedupeKey,
    idempotencyDomain: row.nextIdempotencyDomain,
    payload: row.nextPayload,
  })).sort((a, b) => a.kind.localeCompare(b.kind)
    || a.tenantId.localeCompare(b.tenantId)
    || a.id.localeCompare(b.id))));
}

function candidatePayloadObject(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function candidateSemanticKey(row: MutableRow): { key: string | null; conflict: string | null } {
  const currentSemantic = row.dedupeKey
    ? candidatePrivateDedupeDomain(row.dedupeKey)?.semanticKey ?? row.dedupeKey
    : null;
  if (row.kind !== 'candidate' || row.status !== 'pending') {
    return { key: currentSemantic, conflict: null };
  }
  const payload = candidatePayloadObject(row.payload);
  if (row.legacySourceKind === 'PersonSuggestion') {
    const name = payload?.name;
    return row.accountId && typeof name === 'string' && name.trim()
      ? { key: personCandidateDedupeKey(row.accountId, name), conflict: null }
      : { key: currentSemantic, conflict: 'person_semantic_key_unrecoverable' };
  }
  if (row.legacySourceKind === 'RelSuggestion') {
    const sourceKind = payload?.sourceKind;
    const sourceId = payload?.sourcePersonId;
    const targetKind = payload?.targetKind;
    const targetId = payload?.targetPersonId;
    const endpointKind = (value: unknown): value is 'person' | 'suggestion' => (
      value === 'person' || value === 'suggestion'
    );
    return row.matterId && endpointKind(sourceKind) && typeof sourceId === 'string' && sourceId
      && endpointKind(targetKind) && typeof targetId === 'string' && targetId
      ? {
        key: relationCandidateDedupeKey(
          row.matterId,
          { kind: sourceKind, id: sourceId },
          { kind: targetKind, id: targetId },
        ),
        conflict: null,
      }
      : { key: currentSemantic, conflict: 'relation_semantic_key_unrecoverable' };
  }
  if (row.legacySourceKind === 'ChangeProposal') {
    return row.accountId && row.targetKind && row.targetId && row.fieldKey
      ? {
        key: fieldCandidateDedupeKey({
          tenantId: row.tenantId,
          accountId: row.accountId,
          targetKind: row.targetKind,
          targetId: row.targetId,
          fieldKey: row.fieldKey,
        }),
        conflict: null,
      }
      : { key: currentSemantic, conflict: 'field_semantic_key_unrecoverable' };
  }
  if (row.legacySourceKind === 'Reminder') {
    const legacyDedupeKey = payload?.legacyDedupeKey;
    return typeof legacyDedupeKey === 'string' && legacyDedupeKey
      ? { key: reminderCandidateDedupeKey(legacyDedupeKey), conflict: null }
      : { key: currentSemantic, conflict: 'reminder_semantic_key_unrecoverable' };
  }
  if (row.legacySourceKind === 'EvidenceEvent') {
    // CORE-203 preserved only an identity sourceRef for historical EvidenceEvent
    // rows. That is the safest recoverable semantic seed; createEvidenceCandidate
    // atomically adopts the real producer sourceRef on the first exact replay.
    return row.source && row.sourceRef
      ? { key: evidenceCandidateDedupeKey(row.source, row.sourceRef), conflict: null }
      : { key: currentSemantic, conflict: 'evidence_semantic_key_unrecoverable' };
  }
  return currentSemantic
    ? { key: currentSemantic, conflict: null }
    : { key: null, conflict: 'semantic_key_missing' };
}

async function inspect(db: DbClient): Promise<{
  report: SensitiveAclMigrationReport;
  rows: PlannedRow[];
}> {
  const [marker, noteCount, transcriptCount, candidateCount, artifactCount, grantCount,
    tenantCount, userCount, accountCount, matterCount, personCount, changeProposalCount] = await Promise.all([
    db.dataMigrationState.findUnique({
      where: { key: SENSITIVE_ACL_MIGRATION_MARKER }, select: { details: true },
    }),
    db.note.count(),
    db.transcript.count(),
    db.candidate.count(),
    db.sourceArtifact.count(),
    db.sensitiveResourceGrant.count(),
    db.tenant.count(),
    db.user.count(),
    db.account.count(),
    db.opportunity.count(),
    db.person.count(),
    db.changeProposal.count(),
  ]);
  const sensitiveRows = noteCount + transcriptCount + candidateCount + artifactCount + grantCount;
  let markerValid = false;
  if (marker) {
    try {
      markerValid = markerDetailsAreValid(JSON.parse(marker.details) as unknown);
    } catch {
      markerValid = false;
    }
  }
  const parentRows = tenantCount + userCount + accountCount + matterCount + personCount + changeProposalCount;
  const volumeConflicts = sensitiveAclOnlineVolumeConflicts({
    notes: noteCount,
    transcripts: transcriptCount,
    candidates: candidateCount,
    sourceArtifacts: artifactCount,
    grants: grantCount,
    parentRows,
  }, markerValid);
  if (volumeConflicts.length) {
    if (marker) {
      try {
        if (!markerDetailsAreValid(JSON.parse(marker.details) as unknown)) volumeConflicts.push('marker_invalid');
      } catch {
        volumeConflicts.push('marker_invalid');
      }
    }
    volumeConflicts.sort();
    return {
      rows: [],
      report: {
        ok: false,
        markerPresent: Boolean(marker),
        notes: noteCount,
        transcripts: transcriptCount,
        candidates: candidateCount,
        sourceArtifacts: artifactCount,
        grants: grantCount,
        creatorMapped: 0,
        quarantined: 0,
        conflicts: volumeConflicts,
        receiptChecksum: sha256(JSON.stringify({ sensitiveRows, parentRows, volumeConflicts })),
      },
    };
  }

  const [tenants, users, accounts, matters, persons, notes, transcripts, candidates,
    changeProposals, artifacts, grants] = await Promise.all([
    db.tenant.findMany({ select: { id: true } }),
    db.user.findMany({ select: { id: true, tenantId: true } }),
    db.account.findMany({ select: { id: true, tenantId: true } }),
    db.opportunity.findMany({ select: { id: true, tenantId: true, accountId: true } }),
    db.person.findMany({ select: { id: true, tenantId: true, accountId: true } }),
    db.note.findMany({ select: {
      id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
      createdBy: true, createdByUserId: true, visibility: true, aclVersion: true,
    } }),
    db.transcript.findMany({ select: {
      id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
      source: true, externalRef: true, idempotencyDomain: true,
      createdBy: true, createdByUserId: true, visibility: true, aclVersion: true,
    } }),
    db.candidate.findMany({ select: {
      id: true, tenantId: true, accountId: true, matterId: true,
      createdByUserId: true, visibility: true, aclVersion: true, status: true, dedupeKey: true,
      payload: true, kind: true, targetKind: true, targetId: true, fieldKey: true,
      source: true, sourceRef: true, legacySourceKind: true, legacySourceId: true,
    } }),
    db.changeProposal.findMany({ select: {
      id: true, tenantId: true, dedupeKey: true, status: true,
    } }),
    db.sourceArtifact.findMany({ select: {
      id: true, tenantId: true, accountId: true, matterId: true, personId: true,
      createdByUserId: true, visibility: true, aclVersion: true,
    } }),
    db.sensitiveResourceGrant.findMany({ select: {
      id: true, tenantId: true, resourceKind: true, resourceId: true,
      granteeUserId: true, grantedByUserId: true, grantKind: true,
      resourceAclVersion: true, revokedAt: true, revokedByUserId: true,
    } }),
  ]);
  const tenantIds = new Set(tenants.map((row) => row.id));
  const usersByTenant = new Set(users.map((row) => `${row.tenantId}\u0000${row.id}`));
  const accountsByTenant = new Map(accounts.map((row) => [`${row.tenantId}\u0000${row.id}`, row]));
  const mattersByTenant = new Map(matters.map((row) => [`${row.tenantId}\u0000${row.id}`, row]));
  const personsByTenant = new Map(persons.map((row) => [`${row.tenantId}\u0000${row.id}`, row]));
  const changeProposalsByTenant = new Map(
    changeProposals.map((row) => [`${row.tenantId}\u0000${row.id}`, row]),
  );
  const conflicts: string[] = [];
  const mutableRows: MutableRow[] = [
    ...notes.map((row) => ({
      kind: 'note' as const, id: row.id, tenantId: row.tenantId, accountId: row.accountId,
      matterId: row.opportunityId, personId: row.personId, legacyCreatedBy: row.createdBy,
      createdByUserId: row.createdByUserId, visibility: row.visibility, aclVersion: row.aclVersion,
      status: null, dedupeKey: null,
      payload: null, candidateKind: null, targetKind: null, targetId: null, fieldKey: null,
      source: null, sourceRef: null, externalRef: null, idempotencyDomain: null,
      legacySourceKind: null, legacySourceId: null,
      linkedDedupeKey: null, linkedStatus: null,
    })),
    ...transcripts.map((row) => ({
      kind: 'transcript' as const, id: row.id, tenantId: row.tenantId, accountId: row.accountId,
      matterId: row.opportunityId, personId: row.personId, legacyCreatedBy: row.createdBy,
      createdByUserId: row.createdByUserId, visibility: row.visibility, aclVersion: row.aclVersion,
      status: null, dedupeKey: null,
      payload: null, candidateKind: null, targetKind: null, targetId: null, fieldKey: null,
      source: row.source, sourceRef: null, externalRef: row.externalRef,
      idempotencyDomain: row.idempotencyDomain,
      legacySourceKind: null, legacySourceId: null,
      linkedDedupeKey: null, linkedStatus: null,
    })),
    ...candidates.map((row) => ({
      kind: 'candidate' as const, id: row.id, tenantId: row.tenantId, accountId: row.accountId,
      matterId: row.matterId, personId: null, legacyCreatedBy: '',
      createdByUserId: row.createdByUserId, visibility: row.visibility, aclVersion: row.aclVersion,
      status: row.status, dedupeKey: row.dedupeKey,
      payload: row.payload, candidateKind: row.kind, targetKind: row.targetKind,
      targetId: row.targetId, fieldKey: row.fieldKey, source: row.source, sourceRef: row.sourceRef,
      externalRef: null, idempotencyDomain: null,
      legacySourceKind: row.legacySourceKind, legacySourceId: row.legacySourceId,
      linkedDedupeKey: row.legacySourceKind === 'ChangeProposal' && row.legacySourceId
        ? changeProposalsByTenant.get(`${row.tenantId}\u0000${row.legacySourceId}`)?.dedupeKey ?? null
        : null,
      linkedStatus: row.legacySourceKind === 'ChangeProposal' && row.legacySourceId
        ? changeProposalsByTenant.get(`${row.tenantId}\u0000${row.legacySourceId}`)?.status ?? null
        : null,
    })),
  ];

  const planned: PlannedRow[] = [];
  for (const row of mutableRows) {
    if (!tenantIds.has(row.tenantId)) conflicts.push(`${row.kind}:${row.id}:tenant_missing`);
    const account = row.accountId ? accountsByTenant.get(`${row.tenantId}\u0000${row.accountId}`) : null;
    if (row.accountId && !account) conflicts.push(`${row.kind}:${row.id}:account_invalid`);
    const matter = row.matterId ? mattersByTenant.get(`${row.tenantId}\u0000${row.matterId}`) : null;
    if (row.matterId && (!matter || !row.accountId || matter.accountId !== row.accountId)) {
      conflicts.push(`${row.kind}:${row.id}:matter_invalid`);
    }
    const person = row.personId ? personsByTenant.get(`${row.tenantId}\u0000${row.personId}`) : null;
    if (row.personId && (!person || !row.accountId || person.accountId !== row.accountId)) {
      conflicts.push(`${row.kind}:${row.id}:person_invalid`);
    }
    if (!VISIBILITIES.has(row.visibility)) conflicts.push(`${row.kind}:${row.id}:visibility_invalid`);
    if (row.visibility === 'matter_shared' && !row.matterId) {
      conflicts.push(`${row.kind}:${row.id}:shared_matter_missing`);
    }

    const stableCreator = row.createdByUserId
      && usersByTenant.has(`${row.tenantId}\u0000${row.createdByUserId}`)
      ? row.createdByUserId
      : row.legacyCreatedBy
        && usersByTenant.has(`${row.tenantId}\u0000${row.legacyCreatedBy}`)
        ? row.legacyCreatedBy
        : null;
    let nextVisibility: PlannedRow['nextVisibility'];
    if (!stableCreator) {
      nextVisibility = 'owner_admin_only';
    } else if (row.createdByUserId && row.visibility === 'matter_shared' && row.matterId) {
      nextVisibility = 'matter_shared';
    } else {
      nextVisibility = 'private';
    }
    let nextIdempotencyDomain = row.idempotencyDomain;
    if (row.kind === 'transcript') {
      const currentCreatorDomain = row.createdByUserId
        ? transcriptIdempotencyDomainForCreator(row.createdByUserId)
        : SYSTEM_TRANSCRIPT_IDEMPOTENCY_DOMAIN;
      if (row.idempotencyDomain !== SYSTEM_TRANSCRIPT_IDEMPOTENCY_DOMAIN
        && row.idempotencyDomain !== currentCreatorDomain) {
        conflicts.push(`${row.kind}:${row.id}:idempotency_domain_invalid`);
      }
      nextIdempotencyDomain = transcriptIdempotencyDomainForCreator(stableCreator);
    }
    let nextDedupeKey = row.dedupeKey;
    if (row.kind === 'candidate' && row.status === 'pending' && row.dedupeKey) {
      const existingPrivateDomain = candidatePrivateDedupeDomain(row.dedupeKey);
      const semantic = candidateSemanticKey(row);
      if (semantic.conflict) conflicts.push(`${row.kind}:${row.id}:${semantic.conflict}`);
      if (stableCreator) {
        if (existingPrivateDomain && existingPrivateDomain.createdByUserId !== stableCreator) {
          conflicts.push(`${row.kind}:${row.id}:dedupe_creator_invalid`);
        }
        if (semantic.key) nextDedupeKey = candidateDedupeKeyForCreator(semantic.key, stableCreator);
      } else if (semantic.key) {
        nextDedupeKey = semantic.key;
      }
    }
    let nextLinkedDedupeKey = row.linkedDedupeKey;
    let nextPayload = row.payload;
    if (row.kind === 'candidate'
      && row.status === 'pending'
      && row.legacySourceKind === 'ChangeProposal'
      && row.legacySourceId) {
      const linked = changeProposalsByTenant.get(`${row.tenantId}\u0000${row.legacySourceId}`);
      if (!linked) {
        conflicts.push(`${row.kind}:${row.id}:field_projection_missing`);
      } else if (linked.status !== 'pending' && linked.status !== 'applying') {
        conflicts.push(`${row.kind}:${row.id}:field_projection_dedupe_invalid`);
      } else {
        nextLinkedDedupeKey = nextDedupeKey;
        nextPayload = canonicalCandidateJson({
          legacyDedupeKey: nextDedupeKey,
          legacyStatus: linked.status,
        });
      }
    }
    planned.push({
      ...row,
      nextCreatedByUserId: stableCreator,
      nextVisibility,
      nextAclVersion: Number.isSafeInteger(row.aclVersion) && row.aclVersion >= 1 ? row.aclVersion : 1,
      nextDedupeKey,
      nextIdempotencyDomain,
      nextPayload,
      nextLinkedDedupeKey,
    });
  }

  const plannedCandidateKeys = new Map<string, string>();
  const plannedTranscriptKeys = new Map<string, string>();
  for (const row of planned) {
    if (row.kind === 'candidate' && row.nextDedupeKey) {
      const key = `${row.tenantId}\u0000${row.nextDedupeKey}`;
      const prior = plannedCandidateKeys.get(key);
      if (prior && prior !== row.id) conflicts.push(`candidate:${row.id}:dedupe_domain_collision`);
      else plannedCandidateKeys.set(key, row.id);
    }
    if (row.kind === 'transcript' && row.externalRef && row.source && row.nextIdempotencyDomain) {
      const key = JSON.stringify([
        row.tenantId, row.nextIdempotencyDomain, row.source, row.externalRef,
      ]);
      const prior = plannedTranscriptKeys.get(key);
      if (prior && prior !== row.id) conflicts.push(`transcript:${row.id}:idempotency_domain_collision`);
      else plannedTranscriptKeys.set(key, row.id);
    }
  }

  for (const artifact of artifacts) {
    if (!tenantIds.has(artifact.tenantId)) conflicts.push(`source_artifact:${artifact.id}:tenant_missing`);
    const account = artifact.accountId
      ? accountsByTenant.get(`${artifact.tenantId}\u0000${artifact.accountId}`)
      : null;
    if (artifact.accountId && !account) {
      conflicts.push(`source_artifact:${artifact.id}:account_invalid`);
    }
    const matter = artifact.matterId
      ? mattersByTenant.get(`${artifact.tenantId}\u0000${artifact.matterId}`)
      : null;
    if (artifact.matterId && (!matter || !artifact.accountId || matter.accountId !== artifact.accountId)) {
      conflicts.push(`source_artifact:${artifact.id}:matter_invalid`);
    }
    const person = artifact.personId
      ? personsByTenant.get(`${artifact.tenantId}\u0000${artifact.personId}`)
      : null;
    if (artifact.personId && (!person || !artifact.accountId || person.accountId !== artifact.accountId)) {
      conflicts.push(`source_artifact:${artifact.id}:person_invalid`);
    }
    if (!VISIBILITIES.has(artifact.visibility)) conflicts.push(`source_artifact:${artifact.id}:visibility_invalid`);
    if (!Number.isSafeInteger(artifact.aclVersion) || artifact.aclVersion < 1) {
      conflicts.push(`source_artifact:${artifact.id}:acl_version_invalid`);
    }
    const creatorValid = artifact.createdByUserId
      ? usersByTenant.has(`${artifact.tenantId}\u0000${artifact.createdByUserId}`)
      : false;
    if (artifact.createdByUserId && !creatorValid) conflicts.push(`source_artifact:${artifact.id}:creator_invalid`);
    if (!artifact.createdByUserId && artifact.visibility !== 'owner_admin_only') {
      conflicts.push(`source_artifact:${artifact.id}:quarantine_invalid`);
    }
    if (artifact.createdByUserId && artifact.visibility === 'owner_admin_only') {
      conflicts.push(`source_artifact:${artifact.id}:creator_quarantine_invalid`);
    }
    if (artifact.visibility === 'matter_shared' && !artifact.matterId) {
      conflicts.push(`source_artifact:${artifact.id}:shared_matter_missing`);
    }
  }

  const candidateById = new Map(candidates.map((row) => [`${row.tenantId}\u0000${row.id}`, row]));
  for (const grant of grants) {
    const candidate = candidateById.get(`${grant.tenantId}\u0000${grant.resourceId}`);
    if (grant.resourceKind !== 'candidate' || grant.grantKind !== 'reviewer') {
      conflicts.push(`grant:${grant.id}:kind_invalid`);
    }
    if (!candidate) conflicts.push(`grant:${grant.id}:candidate_missing`);
    if (!usersByTenant.has(`${grant.tenantId}\u0000${grant.granteeUserId}`)
      || !usersByTenant.has(`${grant.tenantId}\u0000${grant.grantedByUserId}`)) {
      conflicts.push(`grant:${grant.id}:user_invalid`);
    }
    if (!Number.isSafeInteger(grant.resourceAclVersion) || grant.resourceAclVersion < 1
      || (candidate && grant.resourceAclVersion > candidate.aclVersion)) {
      conflicts.push(`grant:${grant.id}:acl_version_invalid`);
    }
    if (grant.revokedAt) {
      if (!grant.revokedByUserId
        || !usersByTenant.has(`${grant.tenantId}\u0000${grant.revokedByUserId}`)) {
        conflicts.push(`grant:${grant.id}:revoker_invalid`);
      }
    } else if (grant.revokedByUserId) {
      conflicts.push(`grant:${grant.id}:revocation_state_invalid`);
    }
    if (!grant.revokedAt && candidate
      && (candidate.visibility !== 'matter_shared'
        || grant.resourceAclVersion !== candidate.aclVersion)) {
      conflicts.push(`grant:${grant.id}:active_version_invalid`);
    }
  }

  let markerConflict: string | null = null;
  if (marker) {
    try {
      if (!markerDetailsAreValid(JSON.parse(marker.details) as unknown)) markerConflict = 'marker_invalid';
    } catch {
      markerConflict = 'marker_invalid';
    }
  }
  if (markerConflict) conflicts.push(markerConflict);
  conflicts.sort();
  const checksum = receiptChecksum(planned);
  return {
    rows: planned,
    report: {
      ok: conflicts.length === 0,
      markerPresent: Boolean(marker),
      notes: notes.length,
      transcripts: transcripts.length,
      candidates: candidates.length,
      sourceArtifacts: artifacts.length,
      grants: grants.length,
      creatorMapped: planned.filter((row) => row.nextCreatedByUserId !== null).length,
      quarantined: planned.filter((row) => row.nextVisibility === 'owner_admin_only').length,
      conflicts,
      receiptChecksum: checksum,
    },
  };
}

export async function reportSensitiveAclMigration(db: DbClient): Promise<SensitiveAclMigrationReport> {
  return (await inspect(db)).report;
}

const ACL_MIGRATION_BATCH_SIZE = 400;

function rowNeedsMigration(row: PlannedRow): boolean {
  return row.createdByUserId !== row.nextCreatedByUserId
    || row.visibility !== row.nextVisibility
    || row.aclVersion !== row.nextAclVersion
    || row.dedupeKey !== row.nextDedupeKey
    || row.idempotencyDomain !== row.nextIdempotencyDomain
    || row.payload !== row.nextPayload
    || row.linkedDedupeKey !== row.nextLinkedDedupeKey;
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

export async function applySensitiveAclMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<SensitiveAclMigrationApplyResult> {
  const root = db as PrismaClient;
  if (typeof root.$transaction !== 'function') throw new Error('sensitive ACL apply requires root client');
  return root.$transaction(async (tx) => {
    const inspection = await inspect(tx);
    if (!inspection.report.ok) throw new Error(inspection.report.conflicts.join(','));
    let writes = 0;
    const maybeInjectFailure = () => {
      if (options.failAfterWrites === writes) throw new Error('injected sensitive ACL migration failure');
    };

    // Notes and transcripts often dominate volume. Rows with identical current/next ACL
    // state are updated in bounded tenant-scoped batches, while Candidate keys remain
    // per-row because their creator-domain key and compatibility payload are unique.
    const simpleGroups = new Map<string, PlannedRow[]>();
    for (const row of inspection.rows) {
      if (row.kind === 'candidate' || !rowNeedsMigration(row)) continue;
      const key = JSON.stringify([
        row.kind, row.tenantId,
        row.createdByUserId, row.visibility, row.aclVersion, row.idempotencyDomain,
        row.nextCreatedByUserId, row.nextVisibility, row.nextAclVersion, row.nextIdempotencyDomain,
      ]);
      const group = simpleGroups.get(key) ?? [];
      group.push(row);
      simpleGroups.set(key, group);
    }
    for (const group of simpleGroups.values()) {
      for (const batch of chunks(group, ACL_MIGRATION_BATCH_SIZE)) {
        const exemplar = batch[0]!;
        const aclWhere = {
          tenantId: exemplar.tenantId,
          id: { in: batch.map((row) => row.id) },
          createdByUserId: exemplar.createdByUserId,
          visibility: exemplar.visibility,
          aclVersion: exemplar.aclVersion,
        };
        const aclData = {
          createdByUserId: exemplar.nextCreatedByUserId,
          visibility: exemplar.nextVisibility,
          aclVersion: exemplar.nextAclVersion,
        };
        const changed = exemplar.kind === 'note'
          ? await tx.note.updateMany({ where: aclWhere, data: aclData })
          : await tx.transcript.updateMany({
            where: { ...aclWhere, idempotencyDomain: exemplar.idempotencyDomain! },
            data: { ...aclData, idempotencyDomain: exemplar.nextIdempotencyDomain! },
          });
        if (changed.count !== batch.length) {
          throw new Error(`${exemplar.kind}:${exemplar.tenantId}:batch_write_conflict`);
        }
        writes += 1;
        maybeInjectFailure();
      }
    }

    for (const row of inspection.rows) {
      if (row.kind !== 'candidate' || !rowNeedsMigration(row)) continue;
      const data = {
        createdByUserId: row.nextCreatedByUserId,
        visibility: row.nextVisibility,
        aclVersion: row.nextAclVersion,
      };
      const changed = await tx.candidate.updateMany({
        where: {
          id: row.id,
          tenantId: row.tenantId,
          createdByUserId: row.createdByUserId,
          visibility: row.visibility,
          aclVersion: row.aclVersion,
          dedupeKey: row.dedupeKey!,
        },
        data: { ...data, dedupeKey: row.nextDedupeKey!, payload: row.nextPayload! },
      });
      if (changed.count !== 1) throw new Error(`${row.kind}:${row.id}:write_conflict`);
      writes += 1;
      maybeInjectFailure();
      if (row.kind === 'candidate'
        && row.legacySourceKind === 'ChangeProposal'
        && row.legacySourceId
        && row.linkedDedupeKey !== row.nextLinkedDedupeKey) {
        const linked = await tx.changeProposal.updateMany({
          where: {
            id: row.legacySourceId,
            tenantId: row.tenantId,
            dedupeKey: row.linkedDedupeKey,
          },
          data: { dedupeKey: row.nextLinkedDedupeKey },
        });
        if (linked.count !== 1) throw new Error(`${row.kind}:${row.id}:projection_write_conflict`);
        writes += 1;
        maybeInjectFailure();
      }
    }
    const details = JSON.stringify(markerDetails(inspection.report));
    await tx.dataMigrationState.upsert({
      where: { key: SENSITIVE_ACL_MIGRATION_MARKER },
      update: { details },
      create: { key: SENSITIVE_ACL_MIGRATION_MARKER, details },
    });
    writes += 1;
    maybeInjectFailure();
    const verified = await inspect(tx);
    if (!verified.report.ok || !verified.report.markerPresent) {
      throw new Error(verified.report.conflicts.join(',') || 'sensitive ACL marker missing');
    }
    return { ...verified.report, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 60_000,
  });
}

export async function verifySensitiveAclMigration(db: DbClient): Promise<SensitiveAclMigrationReport> {
  const inspection = await inspect(db);
  if (!inspection.report.markerPresent) {
    return {
      ...inspection.report,
      ok: false,
      conflicts: [...inspection.report.conflicts, 'marker_missing'].sort(),
    };
  }
  const semanticConflicts = [...inspection.report.conflicts];
  for (const row of inspection.rows) {
    if (row.createdByUserId !== row.nextCreatedByUserId || row.visibility !== row.nextVisibility) {
      semanticConflicts.push(`${row.kind}:${row.id}:creator_mapping_drift`);
    }
    if (row.kind === 'candidate' && row.dedupeKey !== row.nextDedupeKey) {
      semanticConflicts.push(`${row.kind}:${row.id}:dedupe_domain_drift`);
    }
    if (row.kind === 'transcript' && row.idempotencyDomain !== row.nextIdempotencyDomain) {
      semanticConflicts.push(`${row.kind}:${row.id}:idempotency_domain_drift`);
    }
    if (row.kind === 'candidate'
      && (row.payload !== row.nextPayload || row.linkedDedupeKey !== row.nextLinkedDedupeKey)) {
      semanticConflicts.push(`${row.kind}:${row.id}:legacy_dedupe_domain_drift`);
    }
    if (row.createdByUserId) {
      if (row.visibility !== 'private' && row.visibility !== 'matter_shared') {
        semanticConflicts.push(`${row.kind}:${row.id}:creator_visibility_invalid`);
      }
    } else if (row.visibility !== 'owner_admin_only') {
      semanticConflicts.push(`${row.kind}:${row.id}:quarantine_invalid`);
    }
    if (!Number.isSafeInteger(row.aclVersion) || row.aclVersion < 1) {
      semanticConflicts.push(`${row.kind}:${row.id}:acl_version_invalid`);
    }
  }
  return {
    ...inspection.report,
    ok: semanticConflicts.length === 0,
    conflicts: [...new Set(semanticConflicts)].sort(),
  };
}

interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqliteColumnSpec {
  type: string;
  required: boolean;
  defaultValue: string | null;
  primaryKey?: boolean;
}

interface SqliteIndexSpec {
  unique: boolean;
  columns: readonly string[];
}

const SOURCE_ARTIFACT_COLUMNS = new Map<string, SqliteColumnSpec>([
  ['id', { type: 'TEXT', required: true, defaultValue: null, primaryKey: true }],
  ['tenantId', { type: 'TEXT', required: true, defaultValue: null }],
  ['accountId', { type: 'TEXT', required: false, defaultValue: null }],
  ['matterId', { type: 'TEXT', required: false, defaultValue: null }],
  ['personId', { type: 'TEXT', required: false, defaultValue: null }],
  ['backingKind', { type: 'TEXT', required: true, defaultValue: null }],
  ['backingId', { type: 'TEXT', required: true, defaultValue: null }],
  ['createdByUserId', { type: 'TEXT', required: false, defaultValue: null }],
  ['visibility', { type: 'TEXT', required: true, defaultValue: "'owner_admin_only'" }],
  ['aclVersion', { type: 'INTEGER', required: true, defaultValue: '1' }],
  ['createdAt', { type: 'DATETIME', required: true, defaultValue: 'CURRENT_TIMESTAMP' }],
  ['updatedAt', { type: 'DATETIME', required: true, defaultValue: null }],
]);

const SENSITIVE_GRANT_COLUMNS = new Map<string, SqliteColumnSpec>([
  ['id', { type: 'TEXT', required: true, defaultValue: null, primaryKey: true }],
  ['tenantId', { type: 'TEXT', required: true, defaultValue: null }],
  ['resourceKind', { type: 'TEXT', required: true, defaultValue: null }],
  ['resourceId', { type: 'TEXT', required: true, defaultValue: null }],
  ['granteeUserId', { type: 'TEXT', required: true, defaultValue: null }],
  ['grantedByUserId', { type: 'TEXT', required: true, defaultValue: null }],
  ['grantKind', { type: 'TEXT', required: true, defaultValue: null }],
  ['resourceAclVersion', { type: 'INTEGER', required: true, defaultValue: null }],
  ['grantedAt', { type: 'DATETIME', required: true, defaultValue: 'CURRENT_TIMESTAMP' }],
  ['revokedAt', { type: 'DATETIME', required: false, defaultValue: null }],
  ['revokedByUserId', { type: 'TEXT', required: false, defaultValue: null }],
]);

const SOURCE_ARTIFACT_INDEXES = new Map<string, SqliteIndexSpec>([
  ['SourceArtifact_tenantId_accountId_idx', { unique: false, columns: ['tenantId', 'accountId'] }],
  ['SourceArtifact_tenantId_matterId_idx', { unique: false, columns: ['tenantId', 'matterId'] }],
  ['SourceArtifact_tenantId_personId_idx', { unique: false, columns: ['tenantId', 'personId'] }],
  ['SourceArtifact_tenantId_createdByUserId_visibility_idx', {
    unique: false, columns: ['tenantId', 'createdByUserId', 'visibility'],
  }],
  ['SourceArtifact_tenantId_visibility_aclVersion_idx', {
    unique: false, columns: ['tenantId', 'visibility', 'aclVersion'],
  }],
  ['SourceArtifact_tenantId_backingKind_backingId_key', {
    unique: true, columns: ['tenantId', 'backingKind', 'backingId'],
  }],
]);

const SENSITIVE_GRANT_INDEXES = new Map<string, SqliteIndexSpec>([
  ['SensitiveResourceGrant_tenantId_resourceKind_resourceId_resourceAclVersion_idx', {
    unique: false, columns: ['tenantId', 'resourceKind', 'resourceId', 'resourceAclVersion'],
  }],
  ['SensitiveResourceGrant_tenantId_granteeUserId_grantKind_revokedAt_idx', {
    unique: false, columns: ['tenantId', 'granteeUserId', 'grantKind', 'revokedAt'],
  }],
  ['SensitiveResourceGrant_tenantId_resourceKind_resourceId_granteeUserId_grantKind_key', {
    unique: true, columns: ['tenantId', 'resourceKind', 'resourceId', 'granteeUserId', 'grantKind'],
  }],
]);

function columnsMatchExact(rows: readonly SqliteColumnRow[], expected: ReadonlyMap<string, SqliteColumnSpec>): boolean {
  return rows.length === expected.size && rows.every((row) => {
    const spec = expected.get(row.name);
    return Boolean(spec)
      && row.type.toUpperCase() === spec!.type
      && Number(row.notnull) === (spec!.required ? 1 : 0)
      && (row.dflt_value ?? null) === spec!.defaultValue
      && Number(row.pk) === (spec!.primaryKey ? 1 : 0);
  });
}

function columnsContain(rows: readonly SqliteColumnRow[], expected: ReadonlyMap<string, SqliteColumnSpec>): boolean {
  const byName = new Map(rows.map((row) => [row.name, row]));
  return [...expected].every(([name, spec]) => {
    const row = byName.get(name);
    return Boolean(row)
      && row!.type.toUpperCase() === spec.type
      && Number(row!.notnull) === (spec.required ? 1 : 0)
      && (row!.dflt_value ?? null) === spec.defaultValue;
  });
}

async function indexesMatch(
  db: Pick<DbClient, '$queryRawUnsafe'>,
  table: string,
  expected: ReadonlyMap<string, SqliteIndexSpec>,
  exact: boolean,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; unique: number }>>(
    `PRAGMA index_list("${table}")`,
  );
  const named = rows.filter((row) => !row.name.startsWith('sqlite_autoindex_'));
  if (exact && named.length !== expected.size) return false;
  const byName = new Map(named.map((row) => [row.name, row]));
  for (const [name, spec] of expected) {
    const row = byName.get(name);
    if (!row || Boolean(row.unique) !== spec.unique) return false;
    const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA index_info("${name}")`);
    if (columns.length !== spec.columns.length
      || columns.some((column, index) => column.name !== spec.columns[index])) return false;
  }
  return true;
}

async function namedIndexAbsent(
  db: Pick<DbClient, '$queryRawUnsafe'>,
  table: string,
  name: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA index_list("${table}")`);
  return rows.every((row) => row.name !== name);
}

async function hasExactTenantForeignKey(
  db: Pick<DbClient, '$queryRawUnsafe'>,
  table: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{
    table: string; from: string; to: string; on_update: string; on_delete: string;
  }>>(`PRAGMA foreign_key_list("${table}")`);
  return rows.length === 1
    && rows[0]?.table === 'Tenant'
    && rows[0].from === 'tenantId'
    && rows[0].to === 'id'
    && rows[0].on_update.toUpperCase() === 'CASCADE'
    && rows[0].on_delete.toUpperCase() === 'CASCADE';
}

export async function inspectSensitiveAclSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<SensitiveAclSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('Tenant', 'Candidate', 'Note', 'Transcript', 'SourceArtifact', 'SensitiveResourceGrant')`,
  );
  const names = new Set(tables.map((row) => row.name));
  if (!names.has('Tenant')) return names.size === 0 ? 'uninitialized' : 'partial';
  const basePresent = ['Note', 'Transcript'].every((name) => names.has(name));
  if (!basePresent) return 'partial';
  const [candidateColumns, noteColumns, transcriptColumns] = await Promise.all([
    names.has('Candidate')
      ? db.$queryRawUnsafe<SqliteColumnRow[]>('PRAGMA table_info("Candidate")')
      : Promise.resolve([]),
    db.$queryRawUnsafe<SqliteColumnRow[]>('PRAGMA table_info("Note")'),
    db.$queryRawUnsafe<SqliteColumnRow[]>('PRAGMA table_info("Transcript")'),
  ]);
  const hasCandidateAcl = candidateColumns.some((column) => column.name === 'aclVersion');
  const noteExpanded = columnsContain(noteColumns, new Map<string, SqliteColumnSpec>([
    ['createdByUserId', { type: 'TEXT', required: false, defaultValue: null }],
    ['visibility', { type: 'TEXT', required: true, defaultValue: "'owner_admin_only'" }],
    ['aclVersion', { type: 'INTEGER', required: true, defaultValue: '1' }],
  ]));
  const transcriptExpanded = columnsContain(transcriptColumns, new Map<string, SqliteColumnSpec>([
    ['createdByUserId', { type: 'TEXT', required: false, defaultValue: null }],
    ['idempotencyDomain', { type: 'TEXT', required: true, defaultValue: "'system-quarantine-v1'" }],
    ['visibility', { type: 'TEXT', required: true, defaultValue: "'owner_admin_only'" }],
    ['aclVersion', { type: 'INTEGER', required: true, defaultValue: '1' }],
  ]));
  const expansionTables = ['SourceArtifact', 'SensitiveResourceGrant'].filter((name) => names.has(name)).length;
  const hasTranscriptDomain = transcriptColumns.some((column) => column.name === 'idempotencyDomain');
  if (!hasCandidateAcl && !noteExpanded && !transcriptExpanded
    && !hasTranscriptDomain && expansionTables === 0) return 'legacy';
  if (!names.has('Candidate') || !hasCandidateAcl || !noteExpanded || !transcriptExpanded
    || expansionTables !== 2) return 'partial';

  const [artifactColumns, grantColumns] = await Promise.all([
    db.$queryRawUnsafe<SqliteColumnRow[]>('PRAGMA table_info("SourceArtifact")'),
    db.$queryRawUnsafe<SqliteColumnRow[]>('PRAGMA table_info("SensitiveResourceGrant")'),
  ]);
  if (!columnsMatchExact(artifactColumns, SOURCE_ARTIFACT_COLUMNS)
    || !columnsMatchExact(grantColumns, SENSITIVE_GRANT_COLUMNS)) return 'partial';

  const [artifactIndexes, grantIndexes, noteIndexes, transcriptIndexes, legacyTranscriptIndexAbsent,
    candidateIndexes,
    artifactForeignKey, grantForeignKey] = await Promise.all([
    indexesMatch(db, 'SourceArtifact', SOURCE_ARTIFACT_INDEXES, true),
    indexesMatch(db, 'SensitiveResourceGrant', SENSITIVE_GRANT_INDEXES, true),
    indexesMatch(db, 'Note', new Map<string, SqliteIndexSpec>([
      ['Note_tenantId_createdByUserId_visibility_idx', {
        unique: false, columns: ['tenantId', 'createdByUserId', 'visibility'],
      }],
      ['Note_tenantId_visibility_aclVersion_idx', {
        unique: false, columns: ['tenantId', 'visibility', 'aclVersion'],
      }],
    ]), false),
    indexesMatch(db, 'Transcript', new Map<string, SqliteIndexSpec>([
      ['Transcript_tenantId_idempotencyDomain_source_externalRef_key', {
        unique: true, columns: ['tenantId', 'idempotencyDomain', 'source', 'externalRef'],
      }],
      ['Transcript_tenantId_createdByUserId_visibility_idx', {
        unique: false, columns: ['tenantId', 'createdByUserId', 'visibility'],
      }],
      ['Transcript_tenantId_visibility_aclVersion_idx', {
        unique: false, columns: ['tenantId', 'visibility', 'aclVersion'],
      }],
    ]), false),
    namedIndexAbsent(db, 'Transcript', 'Transcript_tenantId_source_externalRef_key'),
    indexesMatch(db, 'Candidate', new Map<string, SqliteIndexSpec>([
      ['Candidate_tenantId_visibility_aclVersion_idx', {
        unique: false, columns: ['tenantId', 'visibility', 'aclVersion'],
      }],
    ]), false),
    hasExactTenantForeignKey(db, 'SourceArtifact'),
    hasExactTenantForeignKey(db, 'SensitiveResourceGrant'),
  ]);
  return artifactIndexes && grantIndexes && noteIndexes && transcriptIndexes
    && legacyTranscriptIndexAbsent && candidateIndexes
    && artifactForeignKey && grantForeignKey
    ? 'expanded'
    : 'partial';
}
