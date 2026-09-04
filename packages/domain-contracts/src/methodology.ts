import { z } from 'zod';
import { MatterLifecycleStatusSchema } from './crm.js';
import { OpaqueEntityIdSchema } from './ids.js';

const id = z.string().min(1);
const version = z.number().int().nonnegative();
const openKey = z.string().trim().min(1).max(200);
const instant = z.string().datetime({ offset: true }).refine(
  (value) => value.endsWith('Z'),
  'expected canonical UTC instant ending in Z',
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase SHA-256');
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'expected a real YYYY-MM-DD calendar date');

const jsonString = (description: string, predicate: (value: unknown) => boolean) => z.string().refine((value) => {
  try {
    return predicate(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}, `expected a JSON-string encoded ${description}`);

const jsonValueString = jsonString('value', () => true);
const jsonObjectString = jsonString(
  'object',
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);
const jsonArrayString = jsonString('array', Array.isArray);
const jsonStringArray = jsonString(
  'string array',
  (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0),
);

export const MethodologyVersionStatusSchema = z.enum([
  'draft',
  'validated',
  'piloting',
  'published',
  'deprecated',
  'archived',
]);

export const MethodologyPilotStatusSchema = z.enum(['active', 'completed', 'canceled']);

export const MethodologyPackSchema = z.object({
  id,
  key: openKey,
  name: z.string().trim().min(1).max(200),
  sourceTemplateRef: openKey.nullable(),
  currentPublishedVersionId: id.nullable(),
  archivedAt: instant.nullable(),
  version,
}).strict();

export type MethodologyPack = z.infer<typeof MethodologyPackSchema>;

export const MethodologyPackVersionSchema = z.object({
  id,
  packId: id,
  versionKey: openKey,
  status: MethodologyVersionStatusSchema,
  engineRef: openKey,
  contentHash: sha256,
  learningContentRef: openKey.nullable(),
  sourceTemplateRef: openKey.nullable(),
  createdByUserId: id,
  createdAt: instant,
  publishedByUserId: id.nullable(),
  publishedAt: instant.nullable(),
}).strict().superRefine((value, ctx) => {
  const released = value.status === 'published' || value.status === 'deprecated' || value.status === 'archived';
  if (released && (!value.publishedByUserId || !value.publishedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publishedAt'],
      message: 'released methodology version requires publication metadata',
    });
  }
  if (!released && (value.publishedByUserId || value.publishedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publishedAt'],
      message: 'unreleased methodology version cannot carry publication metadata',
    });
  }
});

export type MethodologyPackVersion = z.infer<typeof MethodologyPackVersionSchema>;

export const MethodologyBindingSchema = z.object({
  id,
  customerId: id,
  matterId: id,
  packId: id,
  versionId: id,
  decisionProfileRef: id.nullable(),
  createdByUserId: id,
  createdAt: instant,
}).strict();

export type MethodologyBinding = z.infer<typeof MethodologyBindingSchema>;

export const G64111_BUILTIN_TEMPLATE_KEY = 'g64111' as const;
export const G64111_BUILTIN_PACK_KEY = 'platform.g64111' as const;
export const G64111_BUILTIN_SOURCE_TEMPLATE_REF = 'builtin:g64111:1' as const;
export const G64111_BUILTIN_VERSION_KEY = '1.0.0' as const;
export const G64111_BUILTIN_ENGINE_REF = 'g64111:0.1.0' as const;

interface G64111Identity {
  packKey: string;
  sourceTemplateRef: string | null;
  versionKey: string;
  engineRef: string;
}

function hasExactG64111Identity(identity: G64111Identity): boolean {
  return identity.packKey === G64111_BUILTIN_PACK_KEY
    && identity.sourceTemplateRef === G64111_BUILTIN_SOURCE_TEMPLATE_REF
    && identity.versionKey === G64111_BUILTIN_VERSION_KEY
    && identity.engineRef === G64111_BUILTIN_ENGINE_REF;
}

export const MethodologyActiveBindingSummarySchema = z.object({
  bindingId: id,
  customerId: id,
  matterId: id,
  packId: id,
  versionId: id,
  packKey: openKey,
  packName: z.string().trim().min(1).max(200),
  sourceTemplateRef: openKey.nullable(),
  versionKey: openKey,
  engineRef: openKey,
}).strict().superRefine((value, ctx) => {
  const resemblesG64111 = value.packKey === G64111_BUILTIN_PACK_KEY
    || value.sourceTemplateRef === G64111_BUILTIN_SOURCE_TEMPLATE_REF;
  if (resemblesG64111 && !hasExactG64111Identity(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versionKey'],
      message: 'G64111 binding identity must match the built-in version and engine',
    });
  }
});

export type MethodologyActiveBindingSummary = z.infer<typeof MethodologyActiveBindingSummarySchema>;

export function isG64111Active(binding: MethodologyActiveBindingSummary | null): boolean {
  return Boolean(binding && hasExactG64111Identity(binding));
}

export const G64111MethodologyInstallationSchema = z.object({
  packId: id,
  versionId: id,
  packKey: z.literal(G64111_BUILTIN_PACK_KEY),
  packName: z.string().trim().min(1).max(200),
  sourceTemplateRef: z.literal(G64111_BUILTIN_SOURCE_TEMPLATE_REF),
  versionKey: z.literal(G64111_BUILTIN_VERSION_KEY),
  engineRef: z.literal(G64111_BUILTIN_ENGINE_REF),
}).strict();

export type G64111MethodologyInstallation = z.infer<typeof G64111MethodologyInstallationSchema>;

export const G64111MethodologyMatterSchema = z.object({
  customerId: id,
  customerName: z.string().trim().min(1).max(500),
  matterId: id,
  matterTitle: z.string().trim().min(1).max(500),
  matterKind: openKey,
  lifecycleStatus: MatterLifecycleStatusSchema,
  matterVersion: version,
  activeBinding: MethodologyActiveBindingSummarySchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.activeBinding?.customerId !== undefined
    && value.activeBinding.customerId !== value.customerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activeBinding', 'customerId'],
      message: 'active binding customer must match its projected parent',
    });
  }
  if (value.activeBinding?.matterId !== undefined
    && value.activeBinding.matterId !== value.matterId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activeBinding', 'matterId'],
      message: 'active binding Matter must match its projected parent',
    });
  }
});

export type G64111MethodologyMatter = z.infer<typeof G64111MethodologyMatterSchema>;

export function isG64111LifecycleEligible(
  lifecycleStatus: z.infer<typeof MatterLifecycleStatusSchema>,
): boolean {
  return lifecycleStatus === 'active' || lifecycleStatus === 'paused';
}

export function isG64111RunnableMatter(matter: G64111MethodologyMatter): boolean {
  return isG64111LifecycleEligible(matter.lifecycleStatus)
    && isG64111Active(matter.activeBinding);
}

export const G64111MethodologyReadModelSchema = z.object({
  generatedAtUtc: instant,
  commandsEnabled: z.boolean(),
  canManage: z.boolean(),
  installation: G64111MethodologyInstallationSchema.nullable(),
  matters: z.array(G64111MethodologyMatterSchema),
}).strict().superRefine((value, ctx) => {
  const matterIds = new Set<string>();
  for (const [index, matter] of value.matters.entries()) {
    if (matterIds.has(matter.matterId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matters', index, 'matterId'],
        message: 'duplicate Matter projection',
      });
    }
    matterIds.add(matter.matterId);
    const binding = matter.activeBinding;
    if (!binding || !isG64111Active(binding)) continue;
    if (!value.installation
      || binding.packId !== value.installation.packId
      || binding.versionId !== value.installation.versionId
      || binding.versionKey !== value.installation.versionKey
      || binding.engineRef !== value.installation.engineRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matters', index, 'activeBinding', 'versionId'],
        message: 'active G64111 binding requires the exact current tenant installation',
      });
    }
  }
});

export type G64111MethodologyReadModel = z.infer<typeof G64111MethodologyReadModelSchema>;

export const MethodologyPilotAssignmentSchema = z.object({
  id,
  customerId: id,
  matterId: id,
  candidatePackId: id,
  candidateVersionId: id,
  baselineBindingId: id.nullable(),
  matterVersion: version,
  status: MethodologyPilotStatusSchema,
  assignedByUserId: id,
  assignedAt: instant,
  completedAt: instant.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'active' && value.completedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedAt'],
      message: 'active pilot cannot be completed',
    });
  }
  if (value.status !== 'active' && !value.completedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedAt'],
      message: 'closed pilot requires completedAt',
    });
  }
});

export type MethodologyPilotAssignment = z.infer<typeof MethodologyPilotAssignmentSchema>;

export const MethodologyStorageBindingKindSchema = z.enum([
  'core_path',
  'methodology_value',
  'legacy_path',
]);

export const MethodologyTargetKindSchema = z.enum(['matter', 'person', 'relation']);
export const MethodologyReviewStatusSchema = z.enum(['pending', 'confirmed', 'rejected']);

const definitionIdentity = {
  id,
  packId: id,
  versionId: id,
  key: openKey,
};

export const MethodologyFieldDefinitionSchema = z.object({
  ...definitionIdentity,
  targetKind: MethodologyTargetKindSchema,
  dataType: openKey,
  valueDomainJson: jsonObjectString,
  required: z.boolean(),
  missingValuePolicy: openKey,
  storageBindingKind: MethodologyStorageBindingKindSchema,
  storageBindingPath: z.string().trim().min(1).max(500),
  legacyStopDate: businessDate.nullable(),
  legacyConsumersJson: jsonStringArray,
  position: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  let legacyConsumers: unknown[] = [];
  try {
    legacyConsumers = JSON.parse(value.legacyConsumersJson) as unknown[];
  } catch {
    return;
  }
  if (value.storageBindingKind === 'legacy_path') {
    if (!value.legacyStopDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['legacyStopDate'],
        message: 'legacy storage binding requires a stop date',
      });
    }
    if (legacyConsumers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['legacyConsumersJson'],
        message: 'legacy storage binding requires a consumer inventory',
      });
    }
  } else if (value.legacyStopDate || legacyConsumers.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['legacyConsumersJson'],
      message: 'non-legacy storage binding cannot carry legacy migration metadata',
    });
  }
});

export type MethodologyFieldDefinition = z.infer<typeof MethodologyFieldDefinitionSchema>;

export const MethodologyStageDefinitionSchema = z.object({
  ...definitionIdentity,
  name: z.string().trim().min(1).max(200),
  position: z.number().int().nonnegative(),
  entryConditionsJson: jsonArrayString,
  exitConditionsJson: jsonArrayString,
}).strict();

export type MethodologyStageDefinition = z.infer<typeof MethodologyStageDefinitionSchema>;

export const MethodologyRoleDefinitionSchema = z.object({
  ...definitionIdentity,
  name: z.string().trim().min(1).max(200),
  appliesTo: z.literal('person'),
  constraintsJson: jsonObjectString,
  minimumAssignments: z.number().int().nonnegative(),
  maximumAssignments: z.number().int().positive(),
  position: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.minimumAssignments > value.maximumAssignments) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maximumAssignments'],
      message: 'maximumAssignments must be greater than or equal to minimumAssignments',
    });
  }
});

export type MethodologyRoleDefinition = z.infer<typeof MethodologyRoleDefinitionSchema>;

export const MethodologyRuleDefinitionSchema = z.object({
  ...definitionIdentity,
  operator: openKey,
  inputRefsJson: jsonStringArray,
  weightsJson: jsonObjectString,
  thresholdsJson: jsonObjectString,
  outputKey: openKey,
  position: z.number().int().nonnegative(),
}).strict();

export type MethodologyRuleDefinition = z.infer<typeof MethodologyRuleDefinitionSchema>;

export const MethodologyActionTemplateSchema = z.object({
  ...definitionIdentity,
  gapKey: openKey,
  title: z.string().trim().min(1).max(500),
  script: z.string().max(20_000),
  evidenceRequirementsJson: jsonStringArray,
  position: z.number().int().nonnegative(),
}).strict();

export type MethodologyActionTemplate = z.infer<typeof MethodologyActionTemplateSchema>;

const boundInstanceIdentity = {
  id,
  matterId: id,
  bindingId: id,
  packId: id,
  versionId: id,
};

export const MethodologyStageStateSchema = z.object({
  ...boundInstanceIdentity,
  stageKey: openKey,
  enteredAt: instant,
  humanOverride: z.boolean(),
  overrideReason: z.string().trim().min(1).max(2_000).nullable(),
  evidenceIdsJson: jsonStringArray,
  updatedByUserId: id,
  updatedAt: instant,
}).strict().superRefine((value, ctx) => {
  if (value.humanOverride !== Boolean(value.overrideReason)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overrideReason'],
      message: 'human override and override reason must be present together',
    });
  }
});

export type MethodologyStageState = z.infer<typeof MethodologyStageStateSchema>;

export const MethodologyRoleAssignmentSchema = z.object({
  ...boundInstanceIdentity,
  roleKey: openKey,
  personId: id,
  source: openKey,
  reviewStatus: MethodologyReviewStatusSchema,
  evidenceIdsJson: jsonStringArray,
  assignedByUserId: id,
  assignedAt: instant,
}).strict();

export type MethodologyRoleAssignment = z.infer<typeof MethodologyRoleAssignmentSchema>;

export const MethodologyValueSchema = z.object({
  ...boundInstanceIdentity,
  fieldKey: openKey,
  targetKind: MethodologyTargetKindSchema,
  targetId: id,
  normalizedValueJson: jsonValueString,
  source: openKey,
  reviewStatus: MethodologyReviewStatusSchema,
  evidenceIdsJson: jsonStringArray,
  updatedByUserId: id,
  updatedAt: instant,
}).strict();

export type MethodologyValue = z.infer<typeof MethodologyValueSchema>;

export const MethodologyEvaluationSchema = z.object({
  ...boundInstanceIdentity,
  trigger: openKey,
  inputsJson: jsonObjectString,
  resultJson: jsonObjectString,
  evidenceIdsJson: jsonStringArray,
  aclVersion: version,
  packVersionKey: openKey,
  engineRef: openKey,
  inputsHash: sha256,
  resultHash: sha256,
  createdByUserId: id,
  createdAt: instant,
}).strict();

export type MethodologyEvaluation = z.infer<typeof MethodologyEvaluationSchema>;

export const MethodologyMigrationStatusSchema = z.enum([
  'planned',
  'confirmed',
  'running',
  'completed',
  'failed',
  'rolled_back',
]);

export const MethodologyMigrationRunSchema = z.object({
  id,
  matterId: id,
  sourceBindingId: id,
  sourcePackId: id,
  sourceVersionId: id,
  targetPackId: id,
  targetVersionId: id,
  matterVersion: version,
  status: MethodologyMigrationStatusSchema,
  dryRunJson: jsonObjectString,
  mappingJson: jsonObjectString,
  conflictsJson: jsonArrayString,
  confirmationJson: jsonObjectString,
  executionJson: jsonObjectString,
  rollbackJson: jsonObjectString,
  confirmedByUserId: id.nullable(),
  confirmedAt: instant.nullable(),
  executedByUserId: id.nullable(),
  executedAt: instant.nullable(),
  rolledBackByUserId: id.nullable(),
  rolledBackAt: instant.nullable(),
  createdByUserId: id,
  createdAt: instant,
}).strict().superRefine((value, ctx) => {
  const confirmationPresent = Boolean(value.confirmedByUserId && value.confirmedAt);
  const executionPresent = Boolean(value.executedByUserId && value.executedAt);
  const rollbackPresent = Boolean(value.rolledBackByUserId && value.rolledBackAt);
  const pairsComplete = [
    [value.confirmedByUserId, value.confirmedAt, 'confirmedAt'],
    [value.executedByUserId, value.executedAt, 'executedAt'],
    [value.rolledBackByUserId, value.rolledBackAt, 'rolledBackAt'],
  ] as const;
  for (const [actor, timestamp, path] of pairsComplete) {
    if (Boolean(actor) !== Boolean(timestamp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'actor and timestamp must be present together' });
    }
  }
  if (['confirmed', 'running', 'completed', 'rolled_back'].includes(value.status) && !confirmationPresent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmedAt'], message: 'confirmed migration state requires confirmation' });
  }
  if (['running', 'completed', 'rolled_back'].includes(value.status) && !executionPresent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['executedAt'], message: 'executed migration state requires execution metadata' });
  }
  if (value.status === 'rolled_back' && !rollbackPresent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rolledBackAt'], message: 'rolled back migration requires rollback metadata' });
  }
  if (value.status === 'planned' && (confirmationPresent || executionPresent || rollbackPresent)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'planned migration cannot carry lifecycle completion metadata' });
  }
});

export type MethodologyMigrationRun = z.infer<typeof MethodologyMigrationRunSchema>;

const command = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const METHODOLOGY_COMMAND_TYPES = [
  'MATERIALIZE_BUILTIN_METHODOLOGY',
  'ACTIVATE_METHODOLOGY_BINDING',
  'UNBIND_METHODOLOGY',
  'ASSIGN_METHODOLOGY_PILOT',
] as const;

export const MaterializeBuiltinMethodologyCommandSchema = command({
  type: z.literal('MATERIALIZE_BUILTIN_METHODOLOGY'),
  templateKey: openKey,
  packId: OpaqueEntityIdSchema,
  versionId: OpaqueEntityIdSchema,
});

export const ActivateMethodologyBindingCommandSchema = command({
  type: z.literal('ACTIVATE_METHODOLOGY_BINDING'),
  bindingId: OpaqueEntityIdSchema,
  customerId: id,
  matterId: id,
  versionId: id,
  baseMatterVersion: version,
  expectedActiveBindingId: id.nullable(),
  decisionProfileRef: id.nullable().default(null),
});

export const UnbindMethodologyCommandSchema = command({
  type: z.literal('UNBIND_METHODOLOGY'),
  customerId: id,
  matterId: id,
  baseMatterVersion: version,
  expectedActiveBindingId: id,
});

export const AssignMethodologyPilotCommandSchema = command({
  type: z.literal('ASSIGN_METHODOLOGY_PILOT'),
  pilotAssignmentId: OpaqueEntityIdSchema,
  customerId: id,
  matterId: id,
  candidateVersionId: id,
  baselineBindingId: id.nullable(),
  baseMatterVersion: version,
});

export const MethodologyCommandSchema = z.discriminatedUnion('type', [
  MaterializeBuiltinMethodologyCommandSchema,
  ActivateMethodologyBindingCommandSchema,
  UnbindMethodologyCommandSchema,
  AssignMethodologyPilotCommandSchema,
]);

export type MethodologyCommand = z.infer<typeof MethodologyCommandSchema>;

const materializedReceipt = z.object({
  action: z.literal('template_materialized'),
  packId: id,
  versionId: id,
}).strict();

const activatedReceipt = z.object({
  action: z.literal('binding_activated'),
  matterId: id,
  bindingId: id,
  activeMethodologyBindingId: id,
  matterVersion: version,
}).strict();

const unboundReceipt = z.object({
  action: z.literal('methodology_unbound'),
  matterId: id,
  previousBindingId: id,
  activeMethodologyBindingId: z.null(),
  matterVersion: version,
}).strict();

const pilotReceipt = z.object({
  action: z.literal('pilot_assigned'),
  matterId: id,
  pilotAssignmentId: id,
  candidateVersionId: id,
  activeMethodologyBindingId: id.nullable(),
  matterVersion: version,
}).strict();

export const MethodologyCommandReceiptSchema = z.discriminatedUnion('action', [
  materializedReceipt,
  activatedReceipt,
  unboundReceipt,
  pilotReceipt,
]);

export type MethodologyCommandReceipt = z.infer<typeof MethodologyCommandReceiptSchema>;
