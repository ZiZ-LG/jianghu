import { z } from 'zod';

export const RESEARCH_BRIEF_SUBJECT_STATUSES = ['matched', 'ambiguous', 'unmatched'] as const;
export const RESEARCH_BRIEF_SNAPSHOT_STATUSES = ['ready', 'partial', 'blocked'] as const;
export const RESEARCH_BRIEF_SOURCE_STATUSES = ['fresh', 'stale', 'failed', 'unavailable'] as const;
export const RESEARCH_BRIEF_SOURCE_KINDS = [
  'crm_fact',
  'curated_human',
  'curated_ai_cache',
  'source_artifact',
  'qcc',
  'external_reference',
] as const;
export const RESEARCH_BRIEF_SECTION_KEYS = [
  'company_overview',
  'recent_changes',
  'existing_cooperation',
  'active_matters',
  'stakeholders',
  'open_hypotheses',
  'last_commitments',
  'questions_to_verify',
] as const;

export const ResearchBriefSubjectStatusSchema = z.enum(RESEARCH_BRIEF_SUBJECT_STATUSES);
export const ResearchBriefSnapshotStatusSchema = z.enum(RESEARCH_BRIEF_SNAPSHOT_STATUSES);
export const ResearchBriefSourceStatusSchema = z.enum(RESEARCH_BRIEF_SOURCE_STATUSES);
export const ResearchBriefSourceKindSchema = z.enum(RESEARCH_BRIEF_SOURCE_KINDS);
export const ResearchBriefSectionKeySchema = z.enum(RESEARCH_BRIEF_SECTION_KEYS);

const utcInstant = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nonnegativeInteger = z.number().int().nonnegative().max(2_147_483_647);
const positiveVersion = z.number().int().min(1).max(2_147_483_647);
const visibleReference = z.string().min(1).max(200).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'reference must contain only visible non-secret characters',
);
const safeCode = z.string().min(1).max(200).regex(/^[a-z][a-z0-9._-]*$/);
const boundedLabel = z.string().trim().min(1).max(300);
const sectionContent = z.string().min(1).max(4_000);
const httpsUrl = z.string().max(2_000).refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'citation URL must use HTTPS');

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function instantMillis(value: string): number {
  return Date.parse(value);
}

function selectedSubjectAnchor(subject: ResearchBriefSubject): string | null {
  if (!subject.selected) return null;
  return `${subject.selected.anchorKind}:${subject.selected.anchorValue}`;
}

const subjectCandidateSchema = z.object({
  legalName: boundedLabel,
  anchorKind: z.enum(['unified_credit_code', 'provider_subject_id']),
  anchorValue: visibleReference,
  provider: visibleReference,
}).strict();

const subjectObject = z.object({
  status: ResearchBriefSubjectStatusSchema,
  query: boundedLabel,
  crmCustomerId: visibleReference,
  selected: subjectCandidateSchema.nullable(),
  candidates: z.array(subjectCandidateSchema).max(5),
}).strict();

export const ResearchBriefSubjectSchema = subjectObject.superRefine((value, ctx) => {
  if (value.status === 'matched' && value.selected === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'], message: 'Matched subjects require an exact selected anchor' });
  }
  if (value.status !== 'matched' && value.selected !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'], message: 'Unresolved subjects cannot select an authority' });
  }
  if (value.status === 'ambiguous' && value.candidates.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates'], message: 'Ambiguous subjects require at least two candidates' });
  }
  const anchors = value.candidates.map((candidate) => (
    `${candidate.provider}\0${candidate.anchorKind}\0${candidate.anchorValue}`
  ));
  if (!unique(anchors)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates'], message: 'Subject candidates must be unique' });
  }
});

export const ResearchBriefSourceSchema = z.object({
  id: visibleReference,
  kind: ResearchBriefSourceKindSchema,
  refId: visibleReference,
  version: nonnegativeInteger,
  fingerprint: sha256,
  provider: visibleReference,
  label: boundedLabel,
  url: httpsUrl.nullable(),
  subjectAnchor: visibleReference,
  observedAt: utcInstant.nullable(),
  retrievedAt: utcInstant,
  freshUntil: utcInstant.nullable(),
  status: ResearchBriefSourceStatusSchema,
  failureCode: safeCode.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.observedAt !== null && instantMillis(value.observedAt) > instantMillis(value.retrievedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observedAt'], message: 'Observed time cannot follow retrieval time' });
  }
  if (value.freshUntil !== null && instantMillis(value.retrievedAt) > instantMillis(value.freshUntil)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['freshUntil'], message: 'Freshness expiry cannot precede retrieval' });
  }
  const unavailable = value.status === 'failed' || value.status === 'unavailable';
  if (unavailable !== (value.failureCode !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureCode'], message: 'Failure state and safe failure code must agree' });
  }
  if ((value.status === 'fresh' || value.status === 'stale') && value.freshUntil === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['freshUntil'], message: 'Freshness state requires an expiry' });
  }
});

export const ResearchBriefSectionSchema = z.object({
  key: ResearchBriefSectionKeySchema,
  title: boundedLabel,
  content: sectionContent,
  sourceIds: z.array(visibleReference).min(1).max(20),
  asOf: utcInstant,
}).strict().superRefine((value, ctx) => {
  if (!unique(value.sourceIds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceIds'], message: 'Section sources must be unique' });
  }
});

export const ResearchBriefUnknownSchema = z.object({
  key: visibleReference,
  question: boundedLabel,
  reasonCode: safeCode,
  sourceIds: z.array(visibleReference).max(20),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.sourceIds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceIds'], message: 'Unknown sources must be unique' });
  }
});

export const ResearchBriefFailureSchema = z.object({
  sourceId: visibleReference,
  code: safeCode,
  retryable: z.boolean(),
}).strict();

export const ResearchBriefGeneratorSchema = z.object({
  version: z.literal('saas-204.v1'),
  modelRef: visibleReference,
  connectorRefs: z.array(visibleReference).max(10),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.connectorRefs)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connectorRefs'], message: 'Connector references must be unique' });
  }
});

const preparedPayloadObject = z.object({
  subject: ResearchBriefSubjectSchema,
  sources: z.array(ResearchBriefSourceSchema).max(20),
  sections: z.array(ResearchBriefSectionSchema).max(8),
  unknowns: z.array(ResearchBriefUnknownSchema).max(20),
  failures: z.array(ResearchBriefFailureSchema).max(20),
  generator: ResearchBriefGeneratorSchema,
}).strict();

export const ResearchBriefPreparedPayloadSchema = preparedPayloadObject.superRefine((value, ctx) => {
  const sourceIds = value.sources.map((source) => source.id);
  const sourceSet = new Set(sourceIds);
  if (!unique(sourceIds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Source identifiers must be unique' });
  }
  const sectionKeys = value.sections.map((section) => section.key);
  if (!unique(sectionKeys)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: 'Section keys must be unique' });
  }
  const unknownKeys = value.unknowns.map((unknown) => unknown.key);
  if (!unique(unknownKeys)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unknowns'], message: 'Unknown keys must be unique' });
  }
  const failureKeys = value.failures.map((failure) => `${failure.sourceId}\0${failure.code}`);
  if (!unique(failureKeys)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failures'], message: 'Failures must be unique' });
  }
  for (const [index, section] of value.sections.entries()) {
    if (section.sourceIds.some((sourceId) => !sourceSet.has(sourceId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sections', index, 'sourceIds'], message: 'Section sources must exist in the snapshot' });
    }
  }
  for (const [index, unknown] of value.unknowns.entries()) {
    if (unknown.sourceIds.some((sourceId) => !sourceSet.has(sourceId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unknowns', index, 'sourceIds'], message: 'Unknown sources must exist in the snapshot' });
    }
  }
  for (const [index, failure] of value.failures.entries()) {
    if (!sourceSet.has(failure.sourceId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failures', index, 'sourceId'], message: 'Failure source must exist in the snapshot' });
    }
  }
  if (value.subject.status !== 'matched' && value.sections.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: 'Unresolved subjects cannot contain conclusive sections' });
  }
  if (value.subject.status === 'matched') {
    const externalAnchor = selectedSubjectAnchor(value.subject);
    for (const [index, source] of value.sources.entries()) {
      if ((source.kind === 'qcc' || source.kind === 'external_reference')
        && source.subjectAnchor !== externalAnchor) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index, 'subjectAnchor'], message: 'External sources must use the exact selected subject anchor' });
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 50_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Research brief payload exceeds 50,000 UTF-8 bytes' });
  }
});

const snapshotMetadataObject = z.object({
  id: visibleReference,
  customerId: visibleReference,
  matterId: visibleReference.nullable(),
  status: ResearchBriefSnapshotStatusSchema,
  subjectStatus: ResearchBriefSubjectStatusSchema,
  sourceCount: z.number().int().nonnegative().max(20),
  sectionCount: z.number().int().nonnegative().max(8),
  unknownCount: z.number().int().nonnegative().max(20),
  failureCount: z.number().int().nonnegative().max(20),
  version: positiveVersion,
  basedOnAt: utcInstant.nullable(),
  freshUntil: utcInstant.nullable(),
  generatedAt: utcInstant,
  createdAt: utcInstant,
}).strict();

export const ResearchBriefSnapshotMetadataSchema = snapshotMetadataObject.superRefine((value, ctx) => {
  if (value.subjectStatus !== 'matched' && value.status !== 'blocked') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Unresolved subjects require a blocked snapshot' });
  }
  if (value.subjectStatus !== 'matched' && value.sectionCount !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sectionCount'], message: 'Unresolved subjects cannot count conclusive sections' });
  }
  if (value.status === 'ready' && (value.sectionCount === 0 || value.unknownCount !== 0 || value.failureCount !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Ready snapshots require conclusive sections without unknowns or failures' });
  }
  if (value.basedOnAt !== null && instantMillis(value.basedOnAt) > instantMillis(value.generatedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['basedOnAt'], message: 'Snapshot basis cannot follow generation' });
  }
  if (instantMillis(value.generatedAt) > instantMillis(value.createdAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdAt'], message: 'Creation cannot precede generation' });
  }
});

const snapshotDetailObject = snapshotMetadataObject.extend({
  payload: ResearchBriefPreparedPayloadSchema,
}).strict();

export const ResearchBriefSnapshotDetailSchema = snapshotDetailObject.superRefine((value, ctx) => {
  if (value.subjectStatus !== value.payload.subject.status) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subjectStatus'], message: 'Subject metadata must match the payload' });
  }
  const counts = [
    ['sourceCount', value.sourceCount, value.payload.sources.length],
    ['sectionCount', value.sectionCount, value.payload.sections.length],
    ['unknownCount', value.unknownCount, value.payload.unknowns.length],
    ['failureCount', value.failureCount, value.payload.failures.length],
  ] as const;
  for (const [path, actual, expected] of counts) {
    if (actual !== expected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'Snapshot count must match the authorized payload' });
    }
  }
  if (value.subjectStatus !== 'matched' && value.status !== 'blocked') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Unresolved subjects require a blocked detail' });
  }
});

export const ResearchBriefSnapshotListResponseSchema = z.object({
  items: z.array(ResearchBriefSnapshotMetadataSchema).max(50),
  nextCursor: visibleReference.nullable(),
}).strict();

export const ResearchBriefSnapshotDetailResponseSchema = z.object({
  item: ResearchBriefSnapshotDetailSchema,
}).strict();

export type ResearchBriefSubjectStatus = z.infer<typeof ResearchBriefSubjectStatusSchema>;
export type ResearchBriefSnapshotStatus = z.infer<typeof ResearchBriefSnapshotStatusSchema>;
export type ResearchBriefSourceStatus = z.infer<typeof ResearchBriefSourceStatusSchema>;
export type ResearchBriefSourceKind = z.infer<typeof ResearchBriefSourceKindSchema>;
export type ResearchBriefSectionKey = z.infer<typeof ResearchBriefSectionKeySchema>;
export type ResearchBriefSubject = z.infer<typeof ResearchBriefSubjectSchema>;
export type ResearchBriefSource = z.infer<typeof ResearchBriefSourceSchema>;
export type ResearchBriefSection = z.infer<typeof ResearchBriefSectionSchema>;
export type ResearchBriefUnknown = z.infer<typeof ResearchBriefUnknownSchema>;
export type ResearchBriefFailure = z.infer<typeof ResearchBriefFailureSchema>;
export type ResearchBriefGenerator = z.infer<typeof ResearchBriefGeneratorSchema>;
export type ResearchBriefPreparedPayload = z.infer<typeof ResearchBriefPreparedPayloadSchema>;
export type ResearchBriefSnapshotMetadata = z.infer<typeof ResearchBriefSnapshotMetadataSchema>;
export type ResearchBriefSnapshotDetail = z.infer<typeof ResearchBriefSnapshotDetailSchema>;
export type ResearchBriefSnapshotListResponse = z.infer<typeof ResearchBriefSnapshotListResponseSchema>;
export type ResearchBriefSnapshotDetailResponse = z.infer<typeof ResearchBriefSnapshotDetailResponseSchema>;
