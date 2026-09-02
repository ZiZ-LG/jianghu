import { createHash } from 'node:crypto';
import {
  CreateCommitmentCommandSchema,
  type CommitmentCommand,
} from '@jianghu/domain-contracts';
import { canonicalCandidateJson } from '../candidates/migration.js';
import { candidateDedupeKeyForCreator } from '../candidates/dedupe.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const stableId = (prefix: string, parts: readonly string[]): string => (
  `${prefix}_${sha256(JSON.stringify(parts)).slice(0, 32)}`
);

export const REVIEW_BATCH_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export const REVIEW_CANDIDATE_KINDS = [
  'commitment_create', 'evidence_create', 'field_change', 'person_create', 'relation_create',
] as const;
export type ReviewBatchStatus = typeof REVIEW_BATCH_STATUSES[number];

export function interactionIdForReviewBatch(tenantId: string, reviewBatchId: string): string {
  return stableId('interaction', [tenantId, reviewBatchId]);
}

export function personIdForReviewCandidate(tenantId: string, candidateId: string): string {
  return stableId('p', [tenantId, 'review-candidate-person', candidateId]);
}

export function edgeIdForReviewCandidate(tenantId: string, candidateId: string): string {
  return stableId('e', [tenantId, 'review-candidate-relation', candidateId]);
}

export function commitmentIdForReviewCandidate(tenantId: string, candidateId: string): string {
  return stableId('act', [tenantId, 'review-candidate-commitment', candidateId]);
}

export function reviewAcceptanceHash(value: unknown): string {
  return sha256(canonicalCandidateJson(value));
}

export function isReviewBatchStatus(value: string): value is ReviewBatchStatus {
  return REVIEW_BATCH_STATUSES.includes(value as ReviewBatchStatus);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function storedReviewBatchReceiptIsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (!hasExactKeys(receipt, [
    'batchId', 'status', 'interactionId', 'version', 'acceptanceVersion', 'items', 'effects',
  ])) return false;
  if (typeof receipt.batchId !== 'string' || !receipt.batchId
    || typeof receipt.status !== 'string' || !isReviewBatchStatus(receipt.status)
    || (receipt.interactionId !== null
      && (typeof receipt.interactionId !== 'string' || !receipt.interactionId))
    || !Number.isSafeInteger(receipt.version) || Number(receipt.version) < 1
    || !Number.isSafeInteger(receipt.acceptanceVersion) || Number(receipt.acceptanceVersion) < 1
    || !Array.isArray(receipt.items) || receipt.items.length < 1 || receipt.items.length > 100
    || !Array.isArray(receipt.effects) || receipt.effects.length !== 0) return false;
  if (receipt.status === 'accepted' && !receipt.interactionId) return false;
  if (receipt.status === 'rejected' && receipt.interactionId) return false;
  const ids = new Set<string>();
  return receipt.items.every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>;
    if (!hasExactKeys(item, ['candidateId', 'decision', 'status', 'formalKind', 'formalId'])
      || typeof item.candidateId !== 'string' || !item.candidateId || ids.has(item.candidateId)
      || !['accept', 'reject'].includes(String(item.decision))
      || !['accepted', 'rejected'].includes(String(item.status))) return false;
    ids.add(item.candidateId);
    if (item.decision === 'reject') {
      return item.status === 'rejected' && item.formalKind === null && item.formalId === null;
    }
    return item.status === 'accepted'
      && typeof item.formalKind === 'string' && item.formalKind.length > 0
      && typeof item.formalId === 'string' && item.formalId.length > 0;
  });
}

export interface ReviewBatchMetadataLike {
  id: string;
  tenantId: string;
  sourceArtifactId: string;
  accountId: string;
  matterId: string | null;
  status: string;
  activityKind: string;
  occurredAt: Date | null;
  interactionId: string | null;
  createdByUserId: string | null;
  visibility: string;
  aclVersion: number;
  acceptanceVersion: number;
  version: number;
  lastAcceptanceVersion: number | null;
  lastAcceptanceHash: string;
  lastAcceptanceResult: string;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
}

export function validateReviewBatchMetadata(row: ReviewBatchMetadataLike): { ok: true } | { ok: false; code: string } {
  if (!row.id || !row.tenantId || !row.sourceArtifactId || !row.accountId) {
    return { ok: false, code: 'identity_required' };
  }
  if (!isReviewBatchStatus(row.status)) return { ok: false, code: 'status_invalid' };
  if (!['private', 'matter_shared', 'owner_admin_only'].includes(row.visibility)) {
    return { ok: false, code: 'visibility_invalid' };
  }
  if ((row.createdByUserId === null) !== (row.visibility === 'owner_admin_only')) {
    return { ok: false, code: 'creator_visibility_invalid' };
  }
  if (row.visibility === 'matter_shared' && row.matterId === null) {
    return { ok: false, code: 'shared_matter_required' };
  }
  if (!Number.isSafeInteger(row.aclVersion) || row.aclVersion < 1
    || !Number.isSafeInteger(row.acceptanceVersion) || row.acceptanceVersion < 0
    || !Number.isSafeInteger(row.version) || row.version < 0) {
    return { ok: false, code: 'version_invalid' };
  }
  if (row.status === 'accepted' && !row.interactionId) {
    return { ok: false, code: 'accepted_interaction_required' };
  }
  if (row.status === 'rejected' && row.interactionId) {
    return { ok: false, code: 'rejected_interaction_forbidden' };
  }
  if (row.interactionId && (!row.activityKind.trim() || !row.occurredAt)) {
    return { ok: false, code: 'interaction_metadata_required' };
  }
  const hasLast = row.lastAcceptanceVersion !== null;
  if (hasLast !== Boolean(row.lastAcceptanceHash) || hasLast !== (row.lastAcceptanceResult !== '{}')) {
    return { ok: false, code: 'acceptance_receipt_incomplete' };
  }
  if (hasLast !== Boolean(row.reviewedByUserId) || hasLast !== Boolean(row.reviewedAt)) {
    return { ok: false, code: 'reviewer_receipt_incomplete' };
  }
  if (row.lastAcceptanceVersion !== null
    && (!Number.isSafeInteger(row.lastAcceptanceVersion)
      || row.lastAcceptanceVersion < 0
      || row.lastAcceptanceVersion !== row.acceptanceVersion - 1
      || !/^[a-f0-9]{64}$/.test(row.lastAcceptanceHash))) {
    return { ok: false, code: 'acceptance_receipt_invalid' };
  }
  if (hasLast) {
    try {
      const parsed: unknown = JSON.parse(row.lastAcceptanceResult);
      if (!storedReviewBatchReceiptIsValid(parsed)) {
        return { ok: false, code: 'acceptance_result_invalid' };
      }
      const receipt = parsed as Record<string, unknown>;
      if (receipt.batchId !== row.id
        || receipt.status !== row.status
        || receipt.interactionId !== row.interactionId
        || receipt.version !== row.version
        || receipt.acceptanceVersion !== row.acceptanceVersion) {
        return { ok: false, code: 'acceptance_result_mismatch' };
      }
    } catch {
      return { ok: false, code: 'acceptance_result_invalid' };
    }
  }
  return { ok: true };
}

interface CommitmentDraft {
  customerId: string;
  matterId: string | null;
  personId: string | null;
  title: string;
  kind: string;
  ownerUserId: string;
  confirmationStatus: 'not_required' | 'pending';
  scheduledAtUtc: string | null;
  dueAtUtc: string | null;
  timeZone: string;
  isAllDay: boolean;
  localDate: string | null;
  confirmationDueAtUtc: string | null;
}

interface CommitmentReviewCandidateInput {
  tenantId: string;
  accountId: string;
  matterId: string | null;
  sourceArtifactId: string;
  reviewBatchId: string | null;
  createdByUserId: string | null;
  visibility: 'private' | 'matter_shared' | 'owner_admin_only';
  aclVersion: number;
  source: string;
  sourceRef: string;
  evidence: string;
  confidence: number;
  commitment: CommitmentDraft;
}

/**
 * Internal producer seam for CORE-206/SAAS-202. It reuses the existing generic
 * Commitment command schema and returns one Candidate create payload; it does
 * not write a ReviewBatch, Interaction or formal Commitment by itself.
 */
export function createCommitmentReviewCandidate(input: CommitmentReviewCandidateInput) {
  if (!input.tenantId.trim()) throw new Error('commitment candidate tenant required');
  if (!input.accountId.trim()) throw new Error('commitment candidate account required');
  if (input.matterId !== null && !input.matterId.trim()) {
    throw new Error('commitment candidate matter invalid');
  }
  if (!input.sourceArtifactId.trim()) throw new Error('commitment candidate source artifact required');
  if (!input.source.trim()) throw new Error('commitment candidate source required');
  if (!input.sourceRef.trim()) throw new Error('commitment candidate source ref required');
  if (!input.evidence.trim()) throw new Error('commitment candidate evidence required');
  if (!Number.isSafeInteger(input.aclVersion) || input.aclVersion < 1) {
    throw new Error('commitment candidate ACL version invalid');
  }
  if (input.reviewBatchId !== null && !input.reviewBatchId.trim()) {
    throw new Error('commitment candidate review batch invalid');
  }
  if (input.commitment.customerId !== input.accountId
    || input.commitment.matterId !== input.matterId) {
    throw new Error('commitment candidate parent mismatch');
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('commitment candidate confidence invalid');
  }
  if ((input.createdByUserId === null) !== (input.visibility === 'owner_admin_only')) {
    throw new Error('commitment candidate creator visibility invalid');
  }
  if (input.visibility === 'matter_shared' && input.matterId === null) {
    throw new Error('commitment candidate shared matter required');
  }
  const candidateId = stableId('cand', [
    input.tenantId, input.sourceArtifactId, 'commitment_create', input.sourceRef,
  ]);
  const command = CreateCommitmentCommandSchema.parse({
    type: 'CREATE_COMMITMENT',
    commitment: {
      ...input.commitment,
      id: commitmentIdForReviewCandidate(input.tenantId, candidateId),
      source: 'review_batch_candidate',
      sourceRef: `candidate:${candidateId}`,
    },
  }) as Extract<CommitmentCommand, { type: 'CREATE_COMMITMENT' }>;
  const dedupeBase = `source-artifact-v1:${input.sourceArtifactId}:commitment:${input.sourceRef}`;
  return {
    id: candidateId,
    tenantId: input.tenantId,
    kind: 'commitment_create',
    status: 'pending',
    accountId: input.accountId,
    matterId: input.matterId,
    targetKind: input.matterId ? 'matter' : 'customer',
    targetId: input.matterId ?? input.accountId,
    fieldKey: null,
    oldValue: null,
    newValue: null,
    payload: canonicalCandidateJson({ command }),
    source: input.source,
    sourceRef: input.sourceRef,
    evidence: input.evidence,
    confidence: input.confidence,
    sourceArtifactId: input.sourceArtifactId,
    reviewBatchId: input.reviewBatchId,
    createdByUserId: input.createdByUserId,
    visibility: input.visibility,
    aclVersion: input.aclVersion,
    dedupeKey: candidateDedupeKeyForCreator(dedupeBase, input.createdByUserId),
    legacySourceKind: null,
    legacySourceId: null,
    version: 0,
  };
}
