export const SYSTEM_TRANSCRIPT_IDEMPOTENCY_DOMAIN = 'system-quarantine-v1';

/**
 * Transcript imports are idempotent inside the immutable sensitive-ACL creator domain.
 * Sharing a row never changes this value, so another creator's private import cannot
 * become an existence oracle or block their own import.
 */
export function transcriptIdempotencyDomainForCreator(createdByUserId: string | null): string {
  return createdByUserId
    ? `creator-private-v1:${JSON.stringify(createdByUserId)}`
    : SYSTEM_TRANSCRIPT_IDEMPOTENCY_DOMAIN;
}
