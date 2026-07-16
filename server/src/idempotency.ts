import { createHash } from 'node:crypto';

/** Persist only a one-way digest; callers keep using their original Idempotency-Key. */
export const hashIdempotencyKey = (raw: string): string => createHash('sha256')
  .update(raw)
  .digest('hex');

/** The raw form is retained temporarily for rolling compatibility with pre-INT-502 rows. */
export const storedIdempotencyKeyCandidates = (raw: string): string[] => {
  const hashed = hashIdempotencyKey(raw);
  // A valid raw key may itself be 64 hex. Treating it as a legacy stored value would
  // alias it to another command whose digest equals that raw value. PostgreSQL migration
  // handles those legacy rows; the runtime fallback is only for unambiguous pre-migration keys.
  return /^[0-9a-f]{64}$/.test(raw) ? [hashed] : [hashed, raw];
};
