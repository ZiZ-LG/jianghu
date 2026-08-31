import { z } from 'zod';

const visibleId = z.string()
  .min(1)
  .max(200)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, 'expected a visible identifier without whitespace or control characters');
const version = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const instant = z.string().datetime({ offset: true });
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedStoredText = (maximum: number) => z.string().max(maximum).refine(
  (value) => value.length === 0 || value.trim() === value,
  'stored text must be empty or trimmed',
);
const cursor = visibleId.nullable().default(null);
const limit = z.number().int().min(1).max(50).default(50);

function instantMillis(value: string): number {
  return new Date(value).valueOf();
}

function uniqueBoundedTextArray(minimum: number) {
  return z.array(boundedText(500)).min(minimum).max(8).superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'duplicate item' });
      }
      seen.add(value);
    });
  });
}

export const SalesHypothesisStatusSchema = z.enum([
  'untested', 'testing', 'supported', 'contradicted', 'retired',
]);
export const HypothesisEvidenceDirectionSchema = z.enum(['supporting', 'contradicting']);
export const SalesHypothesisRevisionOriginSchema = z.enum(['user', 'legacy_assumption']);

export const SalesHypothesisRevisionInputSchema = z.object({
  id: visibleId,
  claim: boundedText(2_000),
  reason: boundedText(1_000),
  expectedSignals: uniqueBoundedTextArray(1),
  falsificationConditions: uniqueBoundedTextArray(1),
}).strict();

const storedSignals = uniqueBoundedTextArray(0);

export const SalesHypothesisRevisionViewSchema = z.object({
  id: visibleId,
  revisionNumber: positiveInteger,
  claim: boundedText(2_000),
  reason: boundedStoredText(1_000),
  expectedSignals: storedSignals,
  falsificationConditions: storedSignals,
  origin: SalesHypothesisRevisionOriginSchema,
  createdByUserId: visibleId.nullable(),
  createdAt: instant,
}).strict().superRefine((value, ctx) => {
  if (value.origin === 'legacy_assumption') {
    if (value.revisionNumber !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revisionNumber'], message: 'legacy revision must be first' });
    }
    if (value.createdByUserId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdByUserId'], message: 'legacy creator cannot be invented' });
    }
    return;
  }
  if (value.createdByUserId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdByUserId'], message: 'user revision requires creator' });
  }
  if (value.reason.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'user revision requires reason' });
  }
  if (value.expectedSignals.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedSignals'], message: 'user revision requires expected signals' });
  }
  if (value.falsificationConditions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['falsificationConditions'],
      message: 'user revision requires falsification conditions',
    });
  }
});

export const HypothesisEvidenceLinkViewSchema = z.object({
  id: visibleId,
  hypothesisId: visibleId,
  hypothesisRevisionId: visibleId,
  evidenceId: visibleId,
  evidenceVersion: z.literal(0),
  direction: HypothesisEvidenceDirectionSchema,
  verificationCommitmentId: visibleId.nullable().default(null),
  linkedByUserId: visibleId,
  linkedAt: instant,
}).strict();

export const SalesHypothesisViewSchema = z.object({
  id: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  personId: visibleId.nullable(),
  status: SalesHypothesisStatusSchema,
  ownerUserId: visibleId.nullable(),
  nextReviewAt: instant.nullable(),
  currentRevisionId: visibleId,
  currentRevision: SalesHypothesisRevisionViewSchema,
  legacyStrategyRiskId: visibleId.nullable(),
  createdByUserId: visibleId.nullable(),
  statusConfirmedByUserId: visibleId.nullable(),
  statusConfirmedAt: instant.nullable(),
  version,
  createdAt: instant,
  updatedAt: instant,
}).strict().superRefine((value, ctx) => {
  if (value.currentRevisionId !== value.currentRevision.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentRevisionId'], message: 'current revision pointer mismatch' });
  }
  if ((value.ownerUserId === null) !== (value.nextReviewAt === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextReviewAt'], message: 'owner and review time must be paired' });
  }
  if ((value.statusConfirmedByUserId === null) !== (value.statusConfirmedAt === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['statusConfirmedAt'], message: 'status confirmation must be paired' });
  }
  if (value.legacyStrategyRiskId === null && value.createdByUserId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdByUserId'], message: 'canonical hypothesis requires creator' });
  }
  if (instantMillis(value.createdAt) > instantMillis(value.updatedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'update cannot precede creation' });
  }
  if (value.statusConfirmedAt && instantMillis(value.statusConfirmedAt) < instantMillis(value.createdAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['statusConfirmedAt'], message: 'confirmation cannot precede creation' });
  }
});

export const CreateSalesHypothesisCommandSchema = z.object({
  type: z.literal('CREATE_SALES_HYPOTHESIS'),
  hypothesis: z.object({
    id: visibleId,
    customerId: visibleId,
    matterId: visibleId,
    personId: visibleId.nullable().default(null),
    ownerUserId: visibleId,
    nextReviewAt: instant,
    revision: SalesHypothesisRevisionInputSchema,
  }).strict(),
}).strict();

export const ReviseSalesHypothesisCommandSchema = z.object({
  type: z.literal('REVISE_SALES_HYPOTHESIS'),
  salesHypothesisId: visibleId,
  expectedVersion: version,
  expectedCurrentRevisionId: visibleId,
  nextReviewAt: instant,
  revision: SalesHypothesisRevisionInputSchema,
}).strict().superRefine((value, ctx) => {
  if (value.revision.id === value.expectedCurrentRevisionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision', 'id'], message: 'new revision requires a new ID' });
  }
});

export const UpdateSalesHypothesisReviewCommandSchema = z.object({
  type: z.literal('UPDATE_SALES_HYPOTHESIS_REVIEW'),
  salesHypothesisId: visibleId,
  expectedVersion: version,
  ownerUserId: visibleId,
  nextReviewAt: instant,
}).strict();

export const SetSalesHypothesisStatusCommandSchema = z.object({
  type: z.literal('SET_SALES_HYPOTHESIS_STATUS'),
  salesHypothesisId: visibleId,
  expectedVersion: version,
  status: SalesHypothesisStatusSchema,
}).strict();

export const LinkHypothesisEvidenceCommandSchema = z.object({
  type: z.literal('LINK_HYPOTHESIS_EVIDENCE'),
  link: z.object({
    id: visibleId,
    salesHypothesisId: visibleId,
    expectedVersion: version,
    expectedCurrentRevisionId: visibleId,
        evidenceId: visibleId,
        evidenceVersion: z.literal(0),
        direction: HypothesisEvidenceDirectionSchema,
        verificationCommitmentId: visibleId.nullable().default(null),
  }).strict(),
}).strict();

export const SalesHypothesisCommandSchema = z.union([
  CreateSalesHypothesisCommandSchema,
  ReviseSalesHypothesisCommandSchema,
  UpdateSalesHypothesisReviewCommandSchema,
  SetSalesHypothesisStatusCommandSchema,
  LinkHypothesisEvidenceCommandSchema,
]);

export const SalesHypothesisCommandTypeSchema = z.enum([
  'CREATE_SALES_HYPOTHESIS',
  'REVISE_SALES_HYPOTHESIS',
  'UPDATE_SALES_HYPOTHESIS_REVIEW',
  'SET_SALES_HYPOTHESIS_STATUS',
  'LINK_HYPOTHESIS_EVIDENCE',
]);

export const SalesHypothesisCommandReceiptSchema = z.object({
  type: SalesHypothesisCommandTypeSchema,
  salesHypothesisId: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  currentRevisionId: visibleId,
  currentRevisionNumber: positiveInteger,
  evidenceLinkId: visibleId.nullable(),
  verificationCommitmentId: visibleId.nullable().default(null),
  status: SalesHypothesisStatusSchema,
  version,
  replayed: z.boolean(),
  undoable: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const isLink = value.type === 'LINK_HYPOTHESIS_EVIDENCE';
  if (isLink !== (value.evidenceLinkId !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceLinkId'],
      message: 'only evidence-link receipts carry a link ID',
    });
  }
  if (!isLink && value.verificationCommitmentId !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verificationCommitmentId'],
      message: 'only evidence-link receipts carry a verification Commitment ID',
    });
  }
});

export const SalesHypothesisListQuerySchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
  personId: visibleId.optional(),
  ownerUserId: visibleId.optional(),
  status: SalesHypothesisStatusSchema.optional(),
  includeRetired: z.boolean().default(false),
  cursor,
  limit,
}).strict();

export const SalesHypothesisListResponseSchema = z.object({
  items: z.array(SalesHypothesisViewSchema).max(50),
  nextCursor: visibleId.nullable(),
}).strict();

export const SalesHypothesisDetailQuerySchema = z.object({
  beforeRevisionNumber: positiveInteger.nullable().default(null),
  limit: z.number().int().min(1).max(20).default(20),
}).strict();

export const SalesHypothesisRevisionDetailSchema = z.object({
  revision: SalesHypothesisRevisionViewSchema,
  evidenceLinks: z.array(HypothesisEvidenceLinkViewSchema).max(50),
}).strict().superRefine((value, ctx) => {
  value.evidenceLinks.forEach((link, index) => {
    if (link.hypothesisRevisionId !== value.revision.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceLinks', index], message: 'link revision mismatch' });
    }
  });
});

export const SalesHypothesisDetailResponseSchema = z.object({
  item: SalesHypothesisViewSchema,
  revisions: z.array(SalesHypothesisRevisionDetailSchema).max(20),
  nextRevisionBefore: positiveInteger.nullable(),
}).strict().superRefine((value, ctx) => {
  value.revisions.forEach((entry, index) => {
    for (const link of entry.evidenceLinks) {
      if (link.hypothesisId !== value.item.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions', index], message: 'link hypothesis mismatch' });
      }
    }
  });
});

export const SalesHypothesisSuggestionReasonSchema = z.enum([
  'no_evidence', 'only_supporting', 'only_contradicting', 'mixed',
]);

export const HypothesisSuggestionEvidenceRefSchema = z.object({
  evidenceId: visibleId,
  evidenceVersion: z.literal(0),
  direction: HypothesisEvidenceDirectionSchema,
  linkedAt: instant,
}).strict();

export const SalesHypothesisStatusSuggestionSchema = z.object({
  hypothesisId: visibleId,
  hypothesisRevisionId: visibleId,
  formalStatus: SalesHypothesisStatusSchema,
  suggestedStatus: z.enum(['supported', 'contradicted']).nullable(),
  reasonCode: SalesHypothesisSuggestionReasonSchema,
  supportingCount: z.number().int().nonnegative().max(50),
  contradictingCount: z.number().int().nonnegative().max(50),
  evidenceRefs: z.array(HypothesisSuggestionEvidenceRefSchema).max(50),
  asOf: instant.nullable(),
  ruleVersion: z.literal('hypothesis-evidence-balance.v1'),
}).strict().superRefine((value, ctx) => {
  const supporting = value.evidenceRefs.filter((ref) => ref.direction === 'supporting').length;
  const contradicting = value.evidenceRefs.length - supporting;
  if (supporting !== value.supportingCount || contradicting !== value.contradictingCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRefs'], message: 'evidence counts mismatch' });
  }
  if (new Set(value.evidenceRefs.map((ref) => ref.evidenceId)).size !== value.evidenceRefs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRefs'], message: 'duplicate evidence reference' });
  }
  const expected = supporting > 0 && contradicting === 0
    ? { reason: 'only_supporting', suggestion: 'supported' }
    : contradicting > 0 && supporting === 0
      ? { reason: 'only_contradicting', suggestion: 'contradicted' }
      : supporting > 0
        ? { reason: 'mixed', suggestion: null }
        : { reason: 'no_evidence', suggestion: null };
  if (value.reasonCode !== expected.reason || value.suggestedStatus !== expected.suggestion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suggestedStatus'], message: 'suggestion rule mismatch' });
  }
  if ((value.evidenceRefs.length === 0) !== (value.asOf === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['asOf'], message: 'suggestion timestamp mismatch' });
  }
  if (value.evidenceRefs.length > 0) {
    const latest = Math.max(...value.evidenceRefs.map((ref) => instantMillis(ref.linkedAt)));
    if (instantMillis(value.asOf!) !== latest) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['asOf'], message: 'suggestion must use latest link time' });
    }
  }
});

export type SalesHypothesisStatus = z.infer<typeof SalesHypothesisStatusSchema>;
export type HypothesisEvidenceDirection = z.infer<typeof HypothesisEvidenceDirectionSchema>;
export type SalesHypothesisRevisionOrigin = z.infer<typeof SalesHypothesisRevisionOriginSchema>;
export type SalesHypothesisRevisionInput = z.infer<typeof SalesHypothesisRevisionInputSchema>;
export type SalesHypothesisRevisionView = z.infer<typeof SalesHypothesisRevisionViewSchema>;
export type HypothesisEvidenceLinkView = z.infer<typeof HypothesisEvidenceLinkViewSchema>;
export type SalesHypothesisView = z.infer<typeof SalesHypothesisViewSchema>;
export type SalesHypothesisCommandInput = z.input<typeof SalesHypothesisCommandSchema>;
export type SalesHypothesisCommand = z.infer<typeof SalesHypothesisCommandSchema>;
export type SalesHypothesisCommandReceipt = z.infer<typeof SalesHypothesisCommandReceiptSchema>;
export type SalesHypothesisListQuery = z.infer<typeof SalesHypothesisListQuerySchema>;
export type SalesHypothesisListResponse = z.infer<typeof SalesHypothesisListResponseSchema>;
export type SalesHypothesisDetailQuery = z.infer<typeof SalesHypothesisDetailQuerySchema>;
export type SalesHypothesisRevisionDetail = z.infer<typeof SalesHypothesisRevisionDetailSchema>;
export type SalesHypothesisDetailResponse = z.infer<typeof SalesHypothesisDetailResponseSchema>;
export type SalesHypothesisStatusSuggestion = z.infer<typeof SalesHypothesisStatusSuggestionSchema>;
