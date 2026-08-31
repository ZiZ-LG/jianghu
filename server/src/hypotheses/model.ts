import { z } from 'zod';
import {
  HypothesisEvidenceLinkViewSchema,
  SalesHypothesisRevisionViewSchema,
  SalesHypothesisStatusSuggestionSchema,
  SalesHypothesisViewSchema,
  type HypothesisEvidenceLinkView,
  type SalesHypothesisRevisionView,
  type SalesHypothesisStatus,
  type SalesHypothesisStatusSuggestion,
  type SalesHypothesisView,
} from '@jianghu/domain-contracts';

export class SalesHypothesisStorageError extends Error {
  readonly code = 'sales_hypothesis_storage_invalid';
  constructor() {
    super('sales_hypothesis_storage_invalid');
    this.name = 'SalesHypothesisStorageError';
  }
}

const hypothesisStringList = (minimum: number) => z.array(
  z.string().trim().min(1).max(500),
).min(minimum).max(8).superRefine((values, ctx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'duplicate item' });
    }
    seen.add(value);
  });
});

function storageFailure(): never {
  throw new SalesHypothesisStorageError();
}

export function canonicalHypothesisStrings(values: readonly string[]): string {
  const parsed = hypothesisStringList(1).safeParse(values);
  if (!parsed.success) storageFailure();
  return JSON.stringify(parsed.data);
}

export function parseStoredHypothesisStrings(raw: string, allowEmpty: boolean): string[] {
  try {
    const decoded = JSON.parse(raw) as unknown;
    const parsed = hypothesisStringList(allowEmpty ? 0 : 1).safeParse(decoded);
    if (!parsed.success || JSON.stringify(parsed.data) !== raw) storageFailure();
    return parsed.data;
  } catch (error) {
    if (error instanceof SalesHypothesisStorageError) throw error;
    return storageFailure();
  }
}

export interface SalesHypothesisRevisionProjectionRow {
  id: string;
  revisionNumber: number;
  claim: string;
  reason: string;
  expectedSignals: string;
  falsificationConditions: string;
  origin: string;
  createdByUserId: string | null;
  createdAt: Date;
}

export function projectSalesHypothesisRevision(
  row: SalesHypothesisRevisionProjectionRow,
): SalesHypothesisRevisionView {
  const legacy = row.origin === 'legacy_assumption';
  const parsed = SalesHypothesisRevisionViewSchema.safeParse({
    id: row.id,
    revisionNumber: row.revisionNumber,
    claim: row.claim,
    reason: row.reason,
    expectedSignals: parseStoredHypothesisStrings(row.expectedSignals, legacy),
    falsificationConditions: parseStoredHypothesisStrings(row.falsificationConditions, legacy),
    origin: row.origin,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  });
  if (!parsed.success) storageFailure();
  return parsed.data;
}

export interface HypothesisEvidenceLinkProjectionRow {
  id: string;
  hypothesisId: string;
  hypothesisRevisionId: string;
  evidenceId: string;
  evidenceVersion: number;
  direction: string;
  verificationCommitmentId: string | null;
  linkedByUserId: string;
  linkedAt: Date;
}

export function projectHypothesisEvidenceLink(
  row: HypothesisEvidenceLinkProjectionRow,
): HypothesisEvidenceLinkView {
  const parsed = HypothesisEvidenceLinkViewSchema.safeParse({
    id: row.id,
    hypothesisId: row.hypothesisId,
    hypothesisRevisionId: row.hypothesisRevisionId,
    evidenceId: row.evidenceId,
    evidenceVersion: row.evidenceVersion,
    direction: row.direction,
    verificationCommitmentId: row.verificationCommitmentId,
    linkedByUserId: row.linkedByUserId,
    linkedAt: row.linkedAt.toISOString(),
  });
  if (!parsed.success) storageFailure();
  return parsed.data;
}

export interface SalesHypothesisProjectionRow {
  id: string;
  customerId: string;
  matterId: string;
  personId: string | null;
  status: string;
  ownerUserId: string | null;
  nextReviewAt: Date | null;
  currentRevisionId: string;
  legacyStrategyRiskId: string | null;
  createdByUserId: string | null;
  statusConfirmedByUserId: string | null;
  statusConfirmedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export function projectSalesHypothesis(
  row: SalesHypothesisProjectionRow,
  currentRevision: SalesHypothesisRevisionView,
): SalesHypothesisView {
  const parsed = SalesHypothesisViewSchema.safeParse({
    id: row.id,
    customerId: row.customerId,
    matterId: row.matterId,
    personId: row.personId,
    status: row.status,
    ownerUserId: row.ownerUserId,
    nextReviewAt: row.nextReviewAt?.toISOString() ?? null,
    currentRevisionId: row.currentRevisionId,
    currentRevision,
    legacyStrategyRiskId: row.legacyStrategyRiskId,
    createdByUserId: row.createdByUserId,
    statusConfirmedByUserId: row.statusConfirmedByUserId,
    statusConfirmedAt: row.statusConfirmedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) storageFailure();
  return parsed.data;
}

export function hypothesisStatusSuggestion(
  hypothesisId: string,
  hypothesisRevisionId: string,
  formalStatus: SalesHypothesisStatus,
  links: readonly HypothesisEvidenceLinkView[],
): SalesHypothesisStatusSuggestion {
  const sorted = [...links].sort((left, right) => (
    left.linkedAt.localeCompare(right.linkedAt) || left.evidenceId.localeCompare(right.evidenceId)
  ));
  const supportingCount = sorted.filter((link) => link.direction === 'supporting').length;
  const contradictingCount = sorted.length - supportingCount;
  const suggestedStatus = supportingCount > 0 && contradictingCount === 0
    ? 'supported' as const
    : contradictingCount > 0 && supportingCount === 0
      ? 'contradicted' as const
      : null;
  const reasonCode = supportingCount > 0 && contradictingCount === 0
    ? 'only_supporting' as const
    : contradictingCount > 0 && supportingCount === 0
      ? 'only_contradicting' as const
      : supportingCount > 0
        ? 'mixed' as const
        : 'no_evidence' as const;
  const parsed = SalesHypothesisStatusSuggestionSchema.safeParse({
    hypothesisId,
    hypothesisRevisionId,
    formalStatus,
    suggestedStatus,
    reasonCode,
    supportingCount,
    contradictingCount,
    evidenceRefs: sorted.map((link) => ({
      evidenceId: link.evidenceId,
      evidenceVersion: link.evidenceVersion,
      direction: link.direction,
      linkedAt: link.linkedAt,
    })),
    asOf: sorted.at(-1)?.linkedAt ?? null,
    ruleVersion: 'hypothesis-evidence-balance.v1',
  });
  if (!parsed.success) storageFailure();
  return parsed.data;
}
