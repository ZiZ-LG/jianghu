import { z } from 'zod';
import {
  COMMITMENT_COMMAND_TYPES,
  IanaTimeZoneSchema,
  LocalDateSchema,
  UtcInstantSchema,
} from './crm.js';

export const INTERVENTION_ITEM_ID_MAX_LENGTH = 240;

// Existing CRM identities are intentionally open strings. Bounding them here would make
// a read-only projection capable of rejecting records that the authoritative contracts accept.
const entityId = z.string().min(1);
const interventionId = z.string().min(1).max(INTERVENTION_ITEM_ID_MAX_LENGTH);
const version = z.number().int().nonnegative().max(2_147_483_647);
const openKey = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9._-]*$/);
const shortText = z.string().trim().min(1).max(240);

export const TodaySectionKeySchema = z.enum([
  'pending_confirmation',
  'follow_up',
  'completed',
]);

export const InterventionSourceRefSchema = z.object({
  entityKind: openKey,
  entityId,
  version,
  scheduleVersion: version.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.entityKind === 'commitment' && value.scheduleVersion === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduleVersion'],
      message: 'Commitment source requires scheduleVersion',
    });
  }
  if (value.entityKind !== 'commitment' && value.scheduleVersion !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduleVersion'],
      message: 'Only Commitment sources carry scheduleVersion',
    });
  }
});

export const InterventionTimeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('instant'),
    atUtc: UtcInstantSchema,
    timeZone: IanaTimeZoneSchema,
    relation: z.enum(['overdue', 'due', 'upcoming']),
    label: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    kind: z.literal('local_date'),
    localDate: LocalDateSchema,
    timeZone: IanaTimeZoneSchema,
    relation: z.enum(['overdue', 'due', 'upcoming', 'completed']),
    label: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    kind: z.literal('observed'),
    atUtc: UtcInstantSchema,
    relation: z.literal('missing'),
    label: z.string().trim().min(1).max(120),
  }).strict(),
]);

export const InterventionSuggestedActionSchema = z.object({
  kind: openKey,
  label: z.string().trim().min(1).max(120),
  commandType: z.enum(COMMITMENT_COMMAND_TYPES).nullable(),
}).strict();

export const InterventionTargetSchema = z.object({
  entityKind: openKey,
  entityId,
  customerId: entityId,
  matterId: entityId.nullable(),
  commitmentId: entityId.nullable(),
  version,
  scheduleVersion: version.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.entityKind === 'commitment') {
    if (value.commitmentId !== value.entityId || value.scheduleVersion === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commitmentId'],
        message: 'Commitment target must identify its revision',
      });
    }
    return;
  }
  if (value.entityKind === 'matter') {
    if (value.matterId !== value.entityId || value.commitmentId !== null || value.scheduleVersion !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matterId'],
        message: 'Matter target must identify only its Matter revision',
      });
    }
  }
});

export const InterventionItemSchema = z.object({
  id: interventionId,
  section: TodaySectionKeySchema,
  providerKey: openKey,
  title: z.string().trim().min(1).max(200),
  context: z.object({
    customerName: shortText,
    matterName: shortText.nullable(),
  }).strict(),
  reasonCode: openKey,
  explanation: z.string().trim().min(1).max(500),
  sourceRefs: z.array(InterventionSourceRefSchema).min(1).max(8),
  observedAtUtc: UtcInstantSchema,
  ruleVersion: openKey,
  time: InterventionTimeSchema,
  suggestedAction: InterventionSuggestedActionSchema,
  target: InterventionTargetSchema,
}).strict().superRefine((value, ctx) => {
  const targetSource = value.sourceRefs.some((source) => (
    source.entityKind === value.target.entityKind
    && source.entityId === value.target.entityId
    && source.version === value.target.version
    && source.scheduleVersion === value.target.scheduleVersion
  ));
  if (!targetSource) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceRefs'],
      message: 'Intervention sources must include the exact target revision',
    });
  }

  if (value.suggestedAction.commandType
    && value.suggestedAction.commandType !== 'CREATE_COMMITMENT'
    && value.target.entityKind !== 'commitment') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['suggestedAction', 'commandType'],
      message: 'Existing Commitment commands require a Commitment target',
    });
  }
  if (value.suggestedAction.commandType === 'CREATE_COMMITMENT'
    && value.target.entityKind !== 'matter'
    && value.target.entityKind !== 'customer'
    && value.target.entityKind !== 'account') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['suggestedAction', 'commandType'],
      message: 'CREATE_COMMITMENT requires a Customer or Matter target',
    });
  }
});

export type TodaySectionKey = z.infer<typeof TodaySectionKeySchema>;
export type InterventionSourceRef = z.infer<typeof InterventionSourceRefSchema>;
export type InterventionTime = z.infer<typeof InterventionTimeSchema>;
export type InterventionSuggestedAction = z.infer<typeof InterventionSuggestedActionSchema>;
export type InterventionTarget = z.infer<typeof InterventionTargetSchema>;
export type InterventionItem = z.infer<typeof InterventionItemSchema>;

export const TodaySourceViewSchema = z.object({
  sourceRef: InterventionSourceRefSchema,
  customerId: entityId,
  matterId: entityId.nullable(),
  label: z.string().trim().min(1).max(200),
  detail: z.string().trim().min(1).max(300),
}).strict().superRefine((value, ctx) => {
  const { sourceRef } = value;
  if (sourceRef.entityKind === 'matter' && value.matterId !== sourceRef.entityId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['matterId'],
      message: 'Matter source view must preserve the exact Matter identity',
    });
  }
  if ((sourceRef.entityKind === 'customer' || sourceRef.entityKind === 'account')
    && (value.customerId !== sourceRef.entityId || value.matterId !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customerId'],
      message: 'Customer source view must preserve the exact Customer identity',
    });
  }
});

export type TodaySourceView = z.infer<typeof TodaySourceViewSchema>;

export const TodaySourceRequestSchema = z.union([
  InterventionSourceRefSchema,
  z.object({
    providerKey: z.literal('relationship_radar'),
    customerId: entityId,
    matterId: entityId,
    sourceRef: InterventionSourceRefSchema,
  }).strict(),
]);

export type TodaySourceRequest = z.infer<typeof TodaySourceRequestSchema>;

const section = <TSection extends TodaySectionKey, TLabel extends string>(
  key: TSection,
  label: TLabel,
) => z.object({
  key: z.literal(key),
  label: z.literal(label),
  items: z.array(InterventionItemSchema.refine(
    (item) => item.section === key,
    `Today item must belong to ${key}`,
  )),
}).strict();

export const TodayReadModelSchema = z.object({
  generatedAtUtc: UtcInstantSchema,
  sections: z.tuple([
    section('pending_confirmation', '待确认'),
    section('follow_up', '待跟进'),
    section('completed', '已完成'),
  ]),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.sections.forEach((entry, sectionIndex) => {
    entry.items.forEach((item, itemIndex) => {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', sectionIndex, 'items', itemIndex, 'id'],
          message: 'Today intervention ids must be globally unique',
        });
      }
      seen.add(item.id);
    });
  });
});

export type TodayReadModel = z.infer<typeof TodayReadModelSchema>;
