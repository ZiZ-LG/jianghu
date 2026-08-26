import { z } from 'zod';

export const AGENT_JOB_KEYS = [
  'pre_meeting_brief',
  'post_meeting_extract',
  'relationship_radar',
] as const;
export const AGENT_TRIGGER_KINDS = ['manual', 'event', 'schedule'] as const;
export const AGENT_ACTION_MODES = ['read_only', 'draft', 'candidate'] as const;
export const AGENT_INPUT_REF_KINDS = ['customer', 'matter', 'source_artifact'] as const;
export const AGENT_OUTPUT_REF_KINDS = [
  'research_brief',
  'relationship_signal',
  'intervention_item',
  'draft_action',
  'review_batch',
] as const;
export const AGENT_SOURCE_KINDS = [
  'transcript',
  'uploaded_file',
  'note',
  'external_reference',
] as const;
export const AGENT_RUN_STATUSES = ['running', 'succeeded', 'failed', 'discarded'] as const;

export const AgentJobKeySchema = z.enum(AGENT_JOB_KEYS);
export const AgentTriggerKindSchema = z.enum(AGENT_TRIGGER_KINDS);
export const AgentActionModeSchema = z.enum(AGENT_ACTION_MODES);
export const AgentInputRefKindSchema = z.enum(AGENT_INPUT_REF_KINDS);
export const AgentOutputRefKindSchema = z.enum(AGENT_OUTPUT_REF_KINDS);
export const AgentSourceKindSchema = z.enum(AGENT_SOURCE_KINDS);
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);

const entityId = z.string().trim().min(1).max(500);
const safeRef = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/);
const safeVersion = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/);
const safeCode = z.string().max(120).regex(/^(?:|[a-z][a-z0-9._-]*)$/);
const nonnegativeVersion = z.number().int().nonnegative().max(2_147_483_647);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const utcInstant = z.string().datetime({ offset: true });

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const AgentInputRefSchema = z.object({
  kind: AgentInputRefKindSchema,
  id: entityId,
  version: nonnegativeVersion,
}).strict();

export const AgentEvidenceRefSchema = z.object({
  sourceArtifactId: entityId,
  locatorId: safeRef,
  sourceFingerprint: sha256,
  observedAt: utcInstant,
}).strict();

export const AgentOutputRefSchema = z.object({
  kind: AgentOutputRefKindSchema,
  // Outputs are persisted as body-free authority references. Keep the identity
  // deliberately narrower than arbitrary entity text so model/provider content
  // cannot be smuggled into AgentRun through an output id.
  id: safeRef,
  version: nonnegativeVersion,
}).strict();

export const AgentScopeManifestSchema = z.object({
  customer: z.literal('required'),
  matter: z.enum(['optional', 'required', 'forbidden']),
  sourceArtifact: z.enum(['optional', 'required', 'forbidden']),
  allowedSourceKinds: z.array(AgentSourceKindSchema).max(AGENT_SOURCE_KINDS.length),
  allowedInputRefKinds: z.array(AgentInputRefKindSchema).min(1).max(AGENT_INPUT_REF_KINDS.length),
}).strict().superRefine((value, ctx) => {
  if (!uniqueValues(value.allowedSourceKinds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedSourceKinds'], message: 'Source kinds must be unique' });
  }
  if (!uniqueValues(value.allowedInputRefKinds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedInputRefKinds'], message: 'Input kinds must be unique' });
  }
  if (value.sourceArtifact === 'forbidden' && value.allowedSourceKinds.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedSourceKinds'], message: 'Forbidden source scope cannot declare source kinds' });
  }
  if (value.sourceArtifact !== 'forbidden' && value.allowedSourceKinds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedSourceKinds'], message: 'Readable source scope requires source kinds' });
  }
});

export const AgentEvidencePolicySchema = z.object({
  required: z.boolean(),
  minimumRefs: z.number().int().nonnegative().max(50),
  maximumRefs: z.number().int().nonnegative().max(50),
  requireSourceFingerprint: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.minimumRefs > value.maximumRefs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minimumRefs'], message: 'Evidence minimum exceeds maximum' });
  }
  if (value.required !== (value.minimumRefs > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['required'], message: 'Required evidence must have a positive minimum' });
  }
});

export const AgentBudgetSchema = z.object({
  maxInputRefs: z.number().int().min(1).max(100),
  maxEvidenceRefs: z.number().int().nonnegative().max(50),
  maxOutputRefs: z.number().int().min(1).max(100),
  maxCostUnits: z.number().int().nonnegative().max(1_000_000),
}).strict();

export const AgentJobControlLimitsSchema = z.object({
  maxCostUnits: z.number().int().nonnegative().max(1_000_000),
  timeoutMs: z.number().int().min(25).max(120_000),
  maxAttempts: z.number().int().min(1).max(3),
}).strict();

const definitionObject = z.object({
  jobKey: AgentJobKeySchema,
  jobVersion: safeVersion,
  purpose: z.string().trim().min(1).max(240),
  triggers: z.array(AgentTriggerKindSchema).min(1).max(AGENT_TRIGGER_KINDS.length),
  scopeManifest: AgentScopeManifestSchema,
  actionMode: AgentActionModeSchema,
  evidencePolicy: AgentEvidencePolicySchema,
  outputRefKinds: z.array(AgentOutputRefKindSchema).min(1).max(AGENT_OUTPUT_REF_KINDS.length),
  modelRef: safeRef,
  connectorRefs: z.array(safeRef).max(10),
  budget: AgentBudgetSchema,
  timeoutMs: z.number().int().min(25).max(120_000),
  maxAttempts: z.number().int().min(1).max(3),
}).strict();

type DefinitionShape = z.infer<typeof definitionObject>;

function refineDefinition(value: DefinitionShape, ctx: z.RefinementCtx): void {
  if (!uniqueValues(value.triggers)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggers'], message: 'Triggers must be unique' });
  }
  if (!value.triggers.includes('manual')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggers'], message: 'Built-in jobs require a manual trigger' });
  }
  if (!uniqueValues(value.outputRefKinds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRefKinds'], message: 'Output kinds must be unique' });
  }
  if (!uniqueValues(value.connectorRefs)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connectorRefs'], message: 'Connector refs must be unique' });
  }
  if (value.evidencePolicy.maximumRefs > value.budget.maxEvidenceRefs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidencePolicy', 'maximumRefs'], message: 'Evidence policy exceeds the job budget' });
  }
  if (value.timeoutMs > 120_000 || value.maxAttempts > 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsafe execution limits' });
  }
  if (value.actionMode === 'candidate') {
    if (value.outputRefKinds.length !== 1 || value.outputRefKinds[0] !== 'review_batch') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRefKinds'], message: 'Candidate jobs may output only ReviewBatch refs' });
    }
  } else if (value.outputRefKinds.includes('review_batch')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRefKinds'], message: 'Only candidate jobs may output ReviewBatch refs' });
  }
  if (value.actionMode === 'read_only' && value.outputRefKinds.includes('draft_action')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRefKinds'], message: 'Read-only jobs cannot emit drafts' });
  }
}

export const AgentJobDefinitionSchema = definitionObject.superRefine(refineDefinition);

export const AgentJobCardSchema = definitionObject.extend({
  available: z.boolean(),
  enabled: z.boolean(),
  controlState: z.enum(['missing', 'valid', 'invalid']),
  controlVersion: nonnegativeVersion,
  limits: AgentJobControlLimitsSchema,
}).strict().superRefine((value, ctx) => {
  refineDefinition(value, ctx);
  if ((!value.available || value.controlState !== 'valid') && value.enabled) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['enabled'], message: 'Unavailable or invalid jobs must fail closed' });
  }
  if (value.controlState === 'missing' && value.controlVersion !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['controlVersion'], message: 'Missing controls use version zero' });
  }
});

export const AgentJobControlRequestSchema = z.object({
  jobVersion: safeVersion,
  enabled: z.boolean(),
  expectedVersion: nonnegativeVersion,
  limits: AgentJobControlLimitsSchema.optional(),
}).strict();

const anchoredInputObject = z.object({
  jobVersion: safeVersion,
  customerId: entityId,
  matterId: entityId.nullable(),
  sourceArtifactId: entityId.nullable(),
  inputRefs: z.array(AgentInputRefSchema).min(1).max(100),
}).strict();

type AnchoredInput = Pick<z.infer<typeof anchoredInputObject>,
  'customerId' | 'matterId' | 'sourceArtifactId' | 'inputRefs'>;

function refineAnchoredInput(value: AnchoredInput, ctx: z.RefinementCtx): void {
  const identities = value.inputRefs.map((ref) => `${ref.kind}\0${ref.id}`);
  if (!uniqueValues(identities)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputRefs'], message: 'Input refs must be unique' });
  }
  const customers = value.inputRefs.filter((ref) => ref.kind === 'customer');
  if (customers.length !== 1 || customers[0]?.id !== value.customerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputRefs'], message: 'Input refs must contain exactly the Customer anchor' });
  }
  const matters = value.inputRefs.filter((ref) => ref.kind === 'matter');
  if (matters.length !== (value.matterId === null ? 0 : 1)
    || (value.matterId !== null && matters[0]?.id !== value.matterId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputRefs'], message: 'Input refs must contain exactly the optional Matter anchor' });
  }
  if (value.sourceArtifactId !== null
    && !value.inputRefs.some((ref) => ref.kind === 'source_artifact' && ref.id === value.sourceArtifactId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputRefs'], message: 'Input refs must contain the exact SourceArtifact anchor' });
  }
}

export const AgentManualRunRequestSchema = anchoredInputObject.superRefine(refineAnchoredInput);

export const AgentPreparedAuditSchema = z.object({
  costUnits: z.number().int().nonnegative().max(1_000_000),
  evidenceRefs: z.array(AgentEvidenceRefSchema).max(50),
  outputRefs: z.array(AgentOutputRefSchema).max(100),
}).strict();

const runViewObject = z.object({
  id: entityId,
  jobKey: AgentJobKeySchema,
  jobVersion: safeVersion,
  actionMode: AgentActionModeSchema,
  trigger: AgentTriggerKindSchema,
  status: AgentRunStatusSchema,
  customerId: entityId,
  matterId: entityId.nullable(),
  sourceArtifactId: entityId.nullable(),
  actorId: entityId,
  attemptCount: z.number().int().nonnegative().max(3),
  maxAttempts: z.number().int().min(1).max(3),
  budgetLimit: z.number().int().nonnegative().max(1_000_000),
  costUsed: z.number().int().nonnegative().max(1_000_000),
  timeoutMs: z.number().int().min(25).max(120_000),
  authorizationFingerprint: sha256,
  modelRef: safeRef,
  connectorRefs: z.array(safeRef).max(10),
  inputRefs: z.array(AgentInputRefSchema).min(1).max(100),
  evidenceRefs: z.array(AgentEvidenceRefSchema).max(50),
  outputRefs: z.array(AgentOutputRefSchema).max(100),
  failureCode: safeCode,
  createdAt: utcInstant,
  startedAt: utcInstant.nullable(),
  completedAt: utcInstant.nullable(),
  version: nonnegativeVersion,
}).strict();

export const AgentRunViewSchema = runViewObject.superRefine((value, ctx) => {
  refineAnchoredInput(value, ctx);
  if (value.attemptCount > value.maxAttempts) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attemptCount'], message: 'Run attempts exceed the fixed limit' });
  }
  if (value.costUsed > value.budgetLimit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costUsed'], message: 'Persisted cost exceeds the fixed budget' });
  }
  if (value.status === 'running') {
    if (value.completedAt !== null || value.failureCode !== '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Running state has terminal metadata' });
    }
  } else if (value.completedAt === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'Terminal runs require completion time' });
  }
  if (value.status === 'succeeded' && value.failureCode !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureCode'], message: 'Successful runs cannot have a failure code' });
  }
  if ((value.status === 'failed' || value.status === 'discarded') && value.failureCode === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureCode'], message: 'Failed runs require a stable failure code' });
  }
  const sourceIds = new Set(value.inputRefs
    .filter((ref) => ref.kind === 'source_artifact')
    .map((ref) => ref.id));
  if (value.evidenceRefs.some((ref) => !sourceIds.has(ref.sourceArtifactId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRefs'], message: 'Evidence must reference an authorized source input' });
  }
  if (value.actionMode === 'candidate'
    ? value.outputRefs.some((ref) => ref.kind !== 'review_batch')
    : value.outputRefs.some((ref) => ref.kind === 'review_batch')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputRefs'], message: 'Run outputs violate the fixed action mode' });
  }
});

export const AgentRunReceiptSchema = z.object({
  run: AgentRunViewSchema,
  replayed: z.boolean(),
}).strict();

export type AgentJobKey = z.infer<typeof AgentJobKeySchema>;
export type AgentTriggerKind = z.infer<typeof AgentTriggerKindSchema>;
export type AgentActionMode = z.infer<typeof AgentActionModeSchema>;
export type AgentInputRef = z.infer<typeof AgentInputRefSchema>;
export type AgentEvidenceRef = z.infer<typeof AgentEvidenceRefSchema>;
export type AgentOutputRef = z.infer<typeof AgentOutputRefSchema>;
export type AgentScopeManifest = z.infer<typeof AgentScopeManifestSchema>;
export type AgentEvidencePolicy = z.infer<typeof AgentEvidencePolicySchema>;
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
export type AgentJobControlLimits = z.infer<typeof AgentJobControlLimitsSchema>;
export type AgentJobDefinition = z.infer<typeof AgentJobDefinitionSchema>;
export type AgentJobCard = z.infer<typeof AgentJobCardSchema>;
export type AgentJobControlRequest = z.infer<typeof AgentJobControlRequestSchema>;
export type AgentManualRunRequest = z.infer<typeof AgentManualRunRequestSchema>;
export type AgentPreparedAudit = z.infer<typeof AgentPreparedAuditSchema>;
export type AgentRunView = z.infer<typeof AgentRunViewSchema>;
export type AgentRunReceipt = z.infer<typeof AgentRunReceiptSchema>;
