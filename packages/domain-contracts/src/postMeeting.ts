import { z } from 'zod';
import { AgentJobCardSchema, AgentRunViewSchema } from './agents.js';
import {
  CreateCommitmentCommandSchema,
  LocalDateSchema,
  UtcInstantSchema,
} from './crm.js';

const entityId = z.string().trim().min(1).max(500);
const nonnegativeVersion = z.number().int().nonnegative().max(2_147_483_647);
const positiveAclVersion = z.number().int().min(1).max(2_147_483_647);
const safeRef = z.string().trim().min(1).max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/);
const openKey = z.string().trim().min(1).max(80);
const shortText = z.string().trim().min(1).max(200);
const optionalShortText = z.string().trim().max(200).nullable();
const sourceQuote = z.string().trim().min(1).max(2_000);
const confidence = z.number().finite().min(0).max(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const candidateEvidenceFields = {
  itemRef: safeRef,
  sourceLocator: safeRef,
  sourceQuote,
  confidence,
} satisfies z.ZodRawShape;

export const PostMeetingPersonEndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing_person'), personId: entityId }).strict(),
  z.object({ kind: z.literal('new_person'), itemRef: safeRef }).strict(),
]);

const personValueSchema = z.object({
  name: shortText,
  title: optionalShortText,
}).strict();

export const PostMeetingPersonCandidateSchema = z.object({
  kind: z.literal('person'),
  ...candidateEvidenceFields,
  person: personValueSchema,
}).strict();

export const PostMeetingRelationCandidateSchema = z.object({
  kind: z.literal('relation'),
  ...candidateEvidenceFields,
  sourcePerson: PostMeetingPersonEndpointSchema,
  targetPerson: PostMeetingPersonEndpointSchema,
  layer: z.enum(['L1', 'L2', 'L3', 'L4']),
  label: optionalShortText,
}).strict();

export const PostMeetingFieldTargetSchema = z.union([
  z.object({ kind: z.literal('customer'), field: z.enum(['name', 'categoryKey']) }).strict(),
  z.object({
    kind: z.literal('matter'),
    field: z.enum(['title', 'kind', 'priority', 'targetDate']),
  }).strict(),
]);

export const PostMeetingFieldCandidateSchema = z.object({
  kind: z.literal('field'),
  ...candidateEvidenceFields,
  target: PostMeetingFieldTargetSchema,
  proposedValue: z.string().trim().max(500).nullable(),
}).strict();

export const PostMeetingEvidenceCandidateSchema = z.object({
  kind: z.literal('evidence'),
  ...candidateEvidenceFields,
  person: PostMeetingPersonEndpointSchema,
  signalKey: openKey,
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  tier: z.enum(['weak', 'mid', 'strong']),
  occurredAt: UtcInstantSchema,
}).strict();

export const PostMeetingCommitmentCandidateSchema = z.object({
  kind: z.literal('commitment'),
  ...candidateEvidenceFields,
  command: CreateCommitmentCommandSchema,
}).strict();

export const PostMeetingCandidateItemSchema = z.discriminatedUnion('kind', [
  PostMeetingPersonCandidateSchema,
  PostMeetingRelationCandidateSchema,
  PostMeetingFieldCandidateSchema,
  PostMeetingEvidenceCandidateSchema,
  PostMeetingCommitmentCandidateSchema,
]);

type CandidateItem = z.infer<typeof PostMeetingCandidateItemSchema>;

function endpointIdentity(endpoint: z.infer<typeof PostMeetingPersonEndpointSchema>): string {
  return endpoint.kind === 'existing_person'
    ? `existing\0${endpoint.personId}`
    : `new\0${endpoint.itemRef}`;
}

function validFieldValue(item: Extract<CandidateItem, { kind: 'field' }>): boolean {
  const value = item.proposedValue;
  if (item.target.kind === 'customer' && item.target.field === 'name') {
    return value !== null && value.length > 0 && value.length <= 120;
  }
  if (item.target.kind === 'matter' && item.target.field === 'title') {
    return value !== null && value.length > 0 && value.length <= 200;
  }
  if (item.target.kind === 'matter' && item.target.field === 'kind') {
    return value !== null && openKey.safeParse(value).success;
  }
  if (item.target.kind === 'matter' && item.target.field === 'targetDate') {
    return value === null || LocalDateSchema.safeParse(value).success;
  }
  return value === null || openKey.safeParse(value).success;
}

export const PostMeetingCandidateBatchSchema = z.object({
  customerId: entityId,
  matterId: entityId.nullable(),
  sourceArtifactId: entityId,
  items: z.array(PostMeetingCandidateItemSchema).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const personRefs = new Set(value.items
    .filter((item): item is Extract<CandidateItem, { kind: 'person' }> => item.kind === 'person')
    .map((item) => item.itemRef));
  const seen = new Set<string>();

  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.itemRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'itemRef'],
        message: 'post-meeting item references must be unique',
      });
    }
    seen.add(item.itemRef);

    const endpoints = item.kind === 'relation'
      ? [item.sourcePerson, item.targetPerson]
      : item.kind === 'evidence' ? [item.person] : [];
    for (const endpoint of endpoints) {
      if (endpoint.kind === 'new_person' && !personRefs.has(endpoint.itemRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'new-person endpoints must reference a Person item in the same batch',
        });
      }
    }

    if (item.kind === 'relation') {
      if (endpointIdentity(item.sourcePerson) === endpointIdentity(item.targetPerson)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'relation endpoints must differ',
        });
      }
      if (value.matterId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matterId'], message: 'relation candidates require a Matter' });
      }
    }
    if (item.kind === 'evidence' && value.matterId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matterId'], message: 'evidence candidates require a Matter' });
    }
    if (item.kind === 'field') {
      if (item.target.kind === 'matter' && value.matterId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matterId'], message: 'Matter fields require a Matter anchor' });
      }
      if (!validFieldValue(item)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'proposedValue'],
          message: 'field candidate value is incompatible with the fixed target field',
        });
      }
    }
    if (item.kind === 'commitment') {
      const commitment = item.command.commitment;
      if (commitment.customerId !== value.customerId || commitment.matterId !== value.matterId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'command'],
          message: 'Commitment candidate must use the exact batch anchors',
        });
      }
    }
  }
});

export const PostMeetingSourceOptionSchema = z.object({
  id: entityId,
  customerId: entityId,
  matterId: entityId.nullable(),
  title: z.string().trim().min(1).max(240),
  kind: z.enum(['transcript', 'uploaded_file', 'note']),
  fingerprint: sha256,
  aclVersion: positiveAclVersion,
  version: nonnegativeVersion,
  occurredAt: UtcInstantSchema.nullable(),
}).strict();

export const PostMeetingJobCardsResponseSchema = z.object({
  items: z.array(AgentJobCardSchema).max(3),
}).strict();

export const PostMeetingRunListResponseSchema = z.object({
  items: z.array(AgentRunViewSchema).max(100),
  nextCursor: entityId.nullable(),
}).strict();

const reviewItemCommon = {
  candidateId: entityId,
  status: z.enum(['pending', 'accepted', 'rejected']),
  itemRef: safeRef,
  expectedVersion: nonnegativeVersion,
  expectedAclVersion: positiveAclVersion,
  sourceLocator: safeRef,
  sourceQuote,
  confidence,
  defaultSelected: z.literal(false),
} satisfies z.ZodRawShape;

export const PostMeetingReviewItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    ...reviewItemCommon,
    before: z.null(),
    after: personValueSchema,
  }).strict(),
  z.object({
    kind: z.literal('relation'),
    ...reviewItemCommon,
    before: z.null(),
    after: z.object({
      sourcePerson: PostMeetingPersonEndpointSchema,
      targetPerson: PostMeetingPersonEndpointSchema,
      layer: z.enum(['L1', 'L2', 'L3', 'L4']),
      label: optionalShortText,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('field'),
    ...reviewItemCommon,
    target: PostMeetingFieldTargetSchema,
    before: z.string().max(500).nullable(),
    after: z.string().max(500).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('evidence'),
    ...reviewItemCommon,
    before: z.null(),
    after: z.object({
      person: PostMeetingPersonEndpointSchema,
      signalKey: openKey,
      direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
      tier: z.enum(['weak', 'mid', 'strong']),
      occurredAt: UtcInstantSchema,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('commitment'),
    ...reviewItemCommon,
    before: z.null(),
    after: CreateCommitmentCommandSchema,
  }).strict(),
]);

export const PostMeetingReviewBatchDetailSchema = z.object({
  id: entityId,
  source: z.object({
    id: entityId,
    title: z.string().trim().min(1).max(240),
    kind: z.enum(['transcript', 'uploaded_file', 'note']),
    fingerprint: sha256,
    occurredAt: UtcInstantSchema.nullable(),
  }).strict(),
  customerId: entityId,
  matterId: entityId.nullable(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  activityKind: openKey.nullable(),
  occurredAt: UtcInstantSchema.nullable(),
  interactionId: entityId.nullable(),
  acceptanceVersion: nonnegativeVersion,
  version: nonnegativeVersion,
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
  items: z.array(PostMeetingReviewItemSchema).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const candidateIds = new Set<string>();
  const itemRefs = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (candidateIds.has(item.candidateId) || itemRefs.has(item.itemRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index],
        message: 'review items must have unique candidate and item references',
      });
    }
    candidateIds.add(item.candidateId);
    itemRefs.add(item.itemRef);
  }
});

const reviewDecisionCommon = {
  candidateId: entityId,
  expectedVersion: nonnegativeVersion,
  expectedAclVersion: positiveAclVersion,
  decision: z.enum(['accept', 'reject']),
} satisfies z.ZodRawShape;

const reviewDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    ...reviewDecisionCommon,
    edit: personValueSchema.partial().strict().refine(
      (value) => Object.keys(value).length > 0,
      'person edit must change at least one field',
    ).optional(),
  }).strict(),
  z.object({
    kind: z.literal('relation'),
    ...reviewDecisionCommon,
    edit: z.object({
      layer: z.enum(['L1', 'L2', 'L3', 'L4']).optional(),
      label: optionalShortText.optional(),
    }).strict().refine(
      (value) => Object.keys(value).length > 0,
      'relation edit must change at least one field',
    ).optional(),
  }).strict(),
  z.object({
    kind: z.literal('field'),
    ...reviewDecisionCommon,
    edit: z.object({ value: z.string().max(500).nullable() }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('evidence'),
    ...reviewDecisionCommon,
    edit: z.object({
      direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
      tier: z.enum(['weak', 'mid', 'strong']).optional(),
    }).strict().refine(
      (value) => Object.keys(value).length > 0,
      'evidence edit must change at least one field',
    ).optional(),
  }).strict(),
  z.object({
    kind: z.literal('commitment'),
    ...reviewDecisionCommon,
    edit: z.object({ command: CreateCommitmentCommandSchema }).strict().optional(),
  }).strict(),
]);

export const PostMeetingReviewRequestSchema = z.object({
  expectedVersion: nonnegativeVersion,
  expectedAcceptanceVersion: nonnegativeVersion,
  customerId: entityId,
  matterId: entityId.nullable(),
  activityKind: openKey,
  occurredAt: UtcInstantSchema,
  existingInteractionId: entityId.nullable().optional(),
  decisions: z.array(reviewDecisionSchema).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const candidateIds = new Set<string>();
  for (const [index, decision] of value.decisions.entries()) {
    if (candidateIds.has(decision.candidateId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisions', index, 'candidateId'],
        message: 'review decisions must be unique',
      });
    }
    candidateIds.add(decision.candidateId);
    if (decision.decision === 'reject' && decision.edit !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisions', index, 'edit'],
        message: 'rejected candidates cannot carry edits',
      });
    }
  }
});

const receiptItemSchema = z.object({
  candidateId: entityId,
  decision: z.enum(['accept', 'reject']),
  status: z.enum(['accepted', 'rejected']),
  formalKind: openKey.nullable(),
  formalId: entityId.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.formalKind === null) !== (value.formalId === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'formal kind and id must appear together' });
  }
  if (value.decision === 'accept'
    ? value.status !== 'accepted' || value.formalId === null
    : value.status !== 'rejected' || value.formalId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'review receipt item is inconsistent' });
  }
});

const successReceiptSchema = z.object({
  batchId: entityId,
  status: z.enum(['pending', 'accepted', 'rejected']),
  interactionId: entityId.nullable(),
  version: nonnegativeVersion,
  acceptanceVersion: nonnegativeVersion,
  items: z.array(receiptItemSchema).min(1).max(20),
  businessReplayed: z.boolean(),
  replayed: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const acceptedInReceipt = value.items.some((item) => item.status === 'accepted');
  if ((acceptedInReceipt && value.interactionId === null)
    || (value.status === 'accepted' && value.interactionId === null)
    || (value.status === 'rejected' && value.interactionId !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'batch status and Interaction are inconsistent' });
  }
});

const conflictReceiptSchema = z.object({
  code: z.literal('review_batch_conflict'),
  items: z.array(z.object({
    candidateId: entityId,
    status: z.enum(['conflict', 'not_applied']),
    reason: z.string().min(1).max(120).regex(/^[a-z][a-z0-9._:-]*$/),
  }).strict()).min(1).max(20),
}).strict();

export const PostMeetingReviewReceiptSchema = z.union([
  successReceiptSchema,
  conflictReceiptSchema,
]);

export type PostMeetingPersonEndpoint = z.infer<typeof PostMeetingPersonEndpointSchema>;
export type PostMeetingCandidateItem = z.infer<typeof PostMeetingCandidateItemSchema>;
export type PostMeetingCandidateBatch = z.infer<typeof PostMeetingCandidateBatchSchema>;
export type PostMeetingSourceOption = z.infer<typeof PostMeetingSourceOptionSchema>;
export type PostMeetingReviewItem = z.infer<typeof PostMeetingReviewItemSchema>;
export type PostMeetingReviewBatchDetail = z.infer<typeof PostMeetingReviewBatchDetailSchema>;
export type PostMeetingReviewRequest = z.infer<typeof PostMeetingReviewRequestSchema>;
export type PostMeetingReviewReceipt = z.infer<typeof PostMeetingReviewReceiptSchema>;
