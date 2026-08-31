import type {
  CommitmentV2,
  RelationshipVerificationReadiness,
} from '@jianghu/domain-contracts';

export function verificationReadiness(
  commitment: CommitmentV2,
  currentRevisionId: string,
  linkedEvidenceCount: number,
): RelationshipVerificationReadiness {
  if (commitment.verificationReviewDisposition !== null) return 'reviewed';
  if (commitment.hypothesisRevisionId !== currentRevisionId) return 'superseded_revision';
  if (commitment.executionStatus !== 'completed') return 'planned';
  if (commitment.completionResult.length > 0 || linkedEvidenceCount > 0) return 'ready_for_review';
  return 'awaiting_result_or_evidence';
}
