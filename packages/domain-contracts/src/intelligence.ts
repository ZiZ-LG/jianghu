import { z } from 'zod';

const visibleId = z.string()
  .min(1)
  .max(200)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, 'expected a visible identifier without whitespace or control characters');
const version = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const reason = boundedText(500);
const cursor = visibleId.nullable().default(null);
const limit = z.number().int().min(1).max(50).default(50);

function instantMillis(value: string): number {
  return new Date(value).valueOf();
}

function rejectDuplicateRefs(
  values: readonly { kind: string; id: string }[],
  path: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = `${value.kind}\u0000${value.id}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index],
        message: 'duplicate reference',
      });
    }
    seen.add(key);
  });
}

export const IntelligenceAssertionTypeSchema = z.enum(['observed', 'reported', 'inferred']);
export const IntelligenceSourceKindSchema = z.enum(['manual', 'interaction', 'evidence']);
export const IntelligenceTargetKindSchema = z.enum(['customer', 'matter', 'person', 'relation']);
export const IntelligenceItemStatusSchema = z.enum(['active', 'archived']);

export const IntelligenceSourceSchema = z.object({
  kind: IntelligenceSourceKindSchema.default('manual'),
  description: boundedText(1_000),
  refId: visibleId.nullable().default(null),
  refVersion: version.nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'manual') {
    if (value.refId !== null || value.refVersion !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refId'],
        message: 'manual source cannot carry a linked reference',
      });
    }
    return;
  }
  if (value.refId === null || value.refVersion === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.refId === null ? ['refId'] : ['refVersion'],
      message: 'linked source requires an exact reference and snapshot version',
    });
  }
});

export const IntelligenceTargetRefSchema = z.object({
  kind: IntelligenceTargetKindSchema,
  id: visibleId,
}).strict();

const intelligenceContentFields = {
  assertionType: IntelligenceAssertionTypeSchema.default('reported'),
  statement: boundedText(2_000),
  source: IntelligenceSourceSchema,
  occurredAt: instant.nullable().default(null),
  learnedAt: instant,
  confidence: z.number().finite().min(0).max(1),
  targets: z.array(IntelligenceTargetRefSchema).min(1).max(12),
};

function validateIntelligenceContent(
  value: {
    assertionType?: z.infer<typeof IntelligenceAssertionTypeSchema>;
    occurredAt?: string | null;
    learnedAt?: string;
    targets?: readonly z.infer<typeof IntelligenceTargetRefSchema>[];
  },
  ctx: z.RefinementCtx,
): void {
  if (value.assertionType === 'observed' && value.occurredAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['occurredAt'],
      message: 'observed intelligence requires an occurrence time',
    });
  }
  if (value.occurredAt && value.learnedAt && instantMillis(value.occurredAt) > instantMillis(value.learnedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['occurredAt'],
      message: 'occurrence cannot follow learning time',
    });
  }
  if (value.targets) rejectDuplicateRefs(value.targets, 'targets', ctx);
}

export const IntelligenceItemCreateInputSchema = z.object({
  id: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  ...intelligenceContentFields,
}).strict().superRefine(validateIntelligenceContent);

export const IntelligenceItemUpdateChangesSchema = z.object({
  assertionType: IntelligenceAssertionTypeSchema.optional(),
  statement: boundedText(2_000).optional(),
  source: IntelligenceSourceSchema.optional(),
  occurredAt: instant.nullable().optional(),
  learnedAt: instant.optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  targets: z.array(IntelligenceTargetRefSchema).min(1).max(12).optional(),
}).strict().superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one change is required' });
  }
  validateIntelligenceContent(value, ctx);
});

export const IntelligenceItemViewSchema = z.object({
  id: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  ...intelligenceContentFields,
  status: IntelligenceItemStatusSchema,
  createdByUserId: visibleId,
  version,
  createdAt: instant,
  updatedAt: instant,
}).strict().superRefine((value, ctx) => {
  validateIntelligenceContent(value, ctx);
  if (instantMillis(value.createdAt) > instantMillis(value.updatedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'update cannot precede creation' });
  }
});

export const CreateIntelligenceItemCommandSchema = z.object({
  type: z.literal('CREATE_INTELLIGENCE_ITEM'),
  item: IntelligenceItemCreateInputSchema,
}).strict();

export const UpdateIntelligenceItemCommandSchema = z.object({
  type: z.literal('UPDATE_INTELLIGENCE_ITEM'),
  intelligenceItemId: visibleId,
  expectedVersion: version,
  changes: IntelligenceItemUpdateChangesSchema,
}).strict();

export const ArchiveIntelligenceItemCommandSchema = z.object({
  type: z.literal('ARCHIVE_INTELLIGENCE_ITEM'),
  intelligenceItemId: visibleId,
  expectedVersion: version,
  reason,
}).strict();

export const RestoreIntelligenceItemCommandSchema = z.object({
  type: z.literal('RESTORE_INTELLIGENCE_ITEM'),
  intelligenceItemId: visibleId,
  expectedVersion: version,
}).strict();

export const IntelligenceItemCommandSchema = z.union([
  CreateIntelligenceItemCommandSchema,
  UpdateIntelligenceItemCommandSchema,
  ArchiveIntelligenceItemCommandSchema,
  RestoreIntelligenceItemCommandSchema,
]);

export const IntelligenceItemCommandTypeSchema = z.enum([
  'CREATE_INTELLIGENCE_ITEM',
  'UPDATE_INTELLIGENCE_ITEM',
  'ARCHIVE_INTELLIGENCE_ITEM',
  'RESTORE_INTELLIGENCE_ITEM',
]);

export const IntelligenceItemCommandReceiptSchema = z.object({
  type: IntelligenceItemCommandTypeSchema,
  intelligenceItemId: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  assertionType: IntelligenceAssertionTypeSchema,
  sourceKind: IntelligenceSourceKindSchema,
  status: IntelligenceItemStatusSchema,
  version,
  replayed: z.boolean(),
  undoable: z.literal(false),
}).strict();

export const IntelligenceItemListQuerySchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
  assertionType: IntelligenceAssertionTypeSchema.optional(),
  includeArchived: z.boolean().default(false),
  cursor,
  limit,
}).strict();

export const IntelligenceItemListResponseSchema = z.object({
  items: z.array(IntelligenceItemViewSchema).max(50),
  nextCursor: visibleId.nullable(),
}).strict();

export const IntelligenceItemDetailResponseSchema = z.object({
  item: IntelligenceItemViewSchema,
}).strict();

export const StakeholderFocusBasisKindSchema = z.enum(['intelligence_item', 'interaction', 'evidence']);
export const StakeholderFocusStatusSchema = z.enum(['active', 'expired', 'retired']);

export const StakeholderFocusBasisRefSchema = z.object({
  kind: StakeholderFocusBasisKindSchema,
  id: visibleId,
  version,
}).strict();

const stakeholderFocusInputObject = z.object({
  id: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  personId: visibleId,
  desiredChange: boundedText(2_000),
  rationale: boundedText(1_000),
  evidenceGap: boundedText(1_000).nullable().default(null),
  basisRefs: z.array(StakeholderFocusBasisRefSchema).max(8).default([]),
  validUntil: instant,
}).strict();

function validateFocusBasis(
  value: { evidenceGap: string | null; basisRefs: readonly z.infer<typeof StakeholderFocusBasisRefSchema>[] },
  ctx: z.RefinementCtx,
): void {
  if (value.evidenceGap === null && value.basisRefs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceGap'],
      message: 'focus requires basis references or an explicit evidence gap',
    });
  }
  rejectDuplicateRefs(value.basisRefs, 'basisRefs', ctx);
}

export const StakeholderFocusInputSchema = stakeholderFocusInputObject.superRefine(validateFocusBasis);

export const StakeholderFocusViewSchema = stakeholderFocusInputObject.extend({
  status: StakeholderFocusStatusSchema,
  confirmedByUserId: visibleId,
  confirmedAt: instant,
  retiredByUserId: visibleId.nullable(),
  retiredAt: instant.nullable(),
  version,
  createdAt: instant,
  updatedAt: instant,
}).strict().superRefine((value, ctx) => {
  validateFocusBasis(value, ctx);
  if (instantMillis(value.validUntil) <= instantMillis(value.confirmedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validUntil'], message: 'focus validity must follow confirmation' });
  }
  if (value.status === 'retired') {
    if (value.retiredByUserId === null || value.retiredAt === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retiredAt'], message: 'retired focus requires retirement metadata' });
    }
  } else if (value.retiredByUserId !== null || value.retiredAt !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retiredAt'], message: 'current focus cannot carry retirement metadata' });
  }
  if (value.retiredAt && instantMillis(value.retiredAt) < instantMillis(value.confirmedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retiredAt'], message: 'retirement cannot precede confirmation' });
  }
  if (instantMillis(value.createdAt) > instantMillis(value.updatedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'update cannot precede creation' });
  }
});

export const SetStakeholderFocusCommandSchema = z.object({
  type: z.literal('SET_STAKEHOLDER_FOCUS'),
  focus: StakeholderFocusInputSchema,
  expectedCurrentFocusId: visibleId.nullable(),
  expectedCurrentFocusVersion: version.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.expectedCurrentFocusId === null) !== (value.expectedCurrentFocusVersion === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedCurrentFocusVersion'],
      message: 'expected current focus ID and version must both be null or both be present',
    });
  }
  if (value.expectedCurrentFocusId === value.focus.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['focus', 'id'],
      message: 'replacement focus must use a new identifier',
    });
  }
});

export const RetireStakeholderFocusCommandSchema = z.object({
  type: z.literal('RETIRE_STAKEHOLDER_FOCUS'),
  stakeholderFocusId: visibleId,
  expectedVersion: version,
  reason,
}).strict();

export const StakeholderFocusCommandSchema = z.union([
  SetStakeholderFocusCommandSchema,
  RetireStakeholderFocusCommandSchema,
]);

export const StakeholderFocusCommandTypeSchema = z.enum([
  'SET_STAKEHOLDER_FOCUS',
  'RETIRE_STAKEHOLDER_FOCUS',
]);

export const StakeholderFocusCommandReceiptSchema = z.object({
  type: StakeholderFocusCommandTypeSchema,
  stakeholderFocusId: visibleId,
  customerId: visibleId,
  matterId: visibleId,
  personId: visibleId,
  status: StakeholderFocusStatusSchema,
  version,
  replayed: z.boolean(),
  undoable: z.literal(false),
}).strict();

export const StakeholderFocusListQuerySchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
  includeRetired: z.boolean().default(false),
  cursor,
  limit,
}).strict();

export const StakeholderFocusListResponseSchema = z.object({
  items: z.array(StakeholderFocusViewSchema).max(50),
  nextCursor: visibleId.nullable(),
}).strict();

export const StakeholderFocusDetailResponseSchema = z.object({
  item: StakeholderFocusViewSchema,
}).strict();

export type IntelligenceAssertionType = z.infer<typeof IntelligenceAssertionTypeSchema>;
export type IntelligenceSourceKind = z.infer<typeof IntelligenceSourceKindSchema>;
export type IntelligenceTargetKind = z.infer<typeof IntelligenceTargetKindSchema>;
export type IntelligenceItemStatus = z.infer<typeof IntelligenceItemStatusSchema>;
export type IntelligenceSource = z.infer<typeof IntelligenceSourceSchema>;
export type IntelligenceTargetRef = z.infer<typeof IntelligenceTargetRefSchema>;
export type IntelligenceItemCreateInput = z.infer<typeof IntelligenceItemCreateInputSchema>;
export type IntelligenceItemUpdateChanges = z.infer<typeof IntelligenceItemUpdateChangesSchema>;
export type IntelligenceItemView = z.infer<typeof IntelligenceItemViewSchema>;
export type IntelligenceItemCommandInput = z.input<typeof IntelligenceItemCommandSchema>;
export type IntelligenceItemCommand = z.infer<typeof IntelligenceItemCommandSchema>;
export type IntelligenceItemCommandReceipt = z.infer<typeof IntelligenceItemCommandReceiptSchema>;
export type IntelligenceItemListQuery = z.infer<typeof IntelligenceItemListQuerySchema>;
export type IntelligenceItemListResponse = z.infer<typeof IntelligenceItemListResponseSchema>;
export type IntelligenceItemDetailResponse = z.infer<typeof IntelligenceItemDetailResponseSchema>;
export type StakeholderFocusBasisKind = z.infer<typeof StakeholderFocusBasisKindSchema>;
export type StakeholderFocusStatus = z.infer<typeof StakeholderFocusStatusSchema>;
export type StakeholderFocusBasisRef = z.infer<typeof StakeholderFocusBasisRefSchema>;
export type StakeholderFocusInput = z.infer<typeof StakeholderFocusInputSchema>;
export type StakeholderFocusView = z.infer<typeof StakeholderFocusViewSchema>;
export type StakeholderFocusCommandInput = z.input<typeof StakeholderFocusCommandSchema>;
export type StakeholderFocusCommand = z.infer<typeof StakeholderFocusCommandSchema>;
export type StakeholderFocusCommandReceipt = z.infer<typeof StakeholderFocusCommandReceiptSchema>;
export type StakeholderFocusListQuery = z.infer<typeof StakeholderFocusListQuerySchema>;
export type StakeholderFocusListResponse = z.infer<typeof StakeholderFocusListResponseSchema>;
export type StakeholderFocusDetailResponse = z.infer<typeof StakeholderFocusDetailResponseSchema>;
