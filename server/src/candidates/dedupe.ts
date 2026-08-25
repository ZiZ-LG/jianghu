const PRIVATE_DOMAIN_PREFIX = 'creator-private-v1:';

export type CandidateDedupeEndpoint = { kind: 'person' | 'suggestion'; id: string };

function normalizeDedupeText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function requiredDedupeText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

export function personCandidateDedupeKey(accountId: string, name: string): string {
  return `person-pending-v1:${accountId}:${normalizeDedupeText(name)}`;
}

export function relationCandidateDedupeKey(
  matterId: string,
  source: CandidateDedupeEndpoint,
  target: CandidateDedupeEndpoint,
): string {
  const pair = [`${source.kind}:${source.id}`, `${target.kind}:${target.id}`].sort().join('|');
  return `relation-pending-v1:${matterId}:${pair}`;
}

export function sourceCandidateDedupeKey(source: string, sourceRef: string): string {
  return `source-v1:${normalizeDedupeText(source)}:${requiredDedupeText(sourceRef, 'sourceRef')}`;
}

export function fieldCandidateDedupeKey(input: {
  tenantId: string;
  accountId: string;
  targetKind: string;
  targetId: string;
  fieldKey: string;
}): string {
  return JSON.stringify([
    input.tenantId, input.accountId, input.targetKind, input.targetId, input.fieldKey,
  ]);
}

export function reminderCandidateDedupeKey(dedupeKey: string): string {
  return `reminder-pending-v1:${dedupeKey}`;
}

export function evidenceCandidateDedupeKey(source: string, sourceRef: string): string {
  return `evidence-source-v1:${source.trim().toLowerCase()}:${sourceRef.trim()}`;
}

/**
 * Candidate semantic idempotency is scoped to the producer's ACL domain.
 *
 * System-owned quarantine candidates intentionally keep the tenant-wide semantic key.
 * A user-owned candidate gets a creator-specific key which remains immutable if the
 * candidate is later shared; visibility changes therefore cannot collide or reveal
 * another creator's private candidate.
 */
export function candidateDedupeKeyForCreator(
  semanticKey: string,
  createdByUserId: string | null,
): string {
  if (!createdByUserId) return semanticKey;
  return `${PRIVATE_DOMAIN_PREFIX}${JSON.stringify([createdByUserId, semanticKey])}`;
}

export function isCandidateDedupeKeyForCreator(
  dedupeKey: string,
  createdByUserId: string,
): boolean {
  return candidatePrivateDedupeDomain(dedupeKey)?.createdByUserId === createdByUserId;
}

export function candidatePrivateDedupeDomain(
  dedupeKey: string,
): { createdByUserId: string; semanticKey: string } | null {
  if (!dedupeKey.startsWith(PRIVATE_DOMAIN_PREFIX)) return null;
  try {
    const parsed = JSON.parse(dedupeKey.slice(PRIVATE_DOMAIN_PREFIX.length)) as unknown;
    return Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
      ? { createdByUserId: parsed[0], semanticKey: parsed[1] }
      : null;
  } catch {
    return null;
  }
}
