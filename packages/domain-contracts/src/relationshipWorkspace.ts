import { z } from 'zod';
import {
  CommitmentV2Schema,
  CustomerV2Schema,
  HypothesisVerificationDispositionSchema,
  MatterV2Schema,
  PersonSummaryV2Schema,
  RelationV2Schema,
  UtcInstantSchema,
} from './crm.js';
import {
  HypothesisEvidenceLinkViewSchema,
  SalesHypothesisRevisionInputSchema,
  SalesHypothesisViewSchema,
} from './hypotheses.js';
import { IntelligenceItemViewSchema, StakeholderFocusViewSchema } from './intelligence.js';

const visibleId = z.string()
  .min(1)
  .max(500)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, 'expected a visible identifier without whitespace or control characters');
const version = z.number().int().nonnegative();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const RelationshipWorkspaceQuerySchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
}).strict();
export type RelationshipWorkspaceQuery = z.infer<typeof RelationshipWorkspaceQuerySchema>;

export const RelationshipCandidateEndpointSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    personId: visibleId,
    label: boundedText(200),
    title: z.string().trim().max(200).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('candidate_person'),
    candidateId: visibleId,
    itemRef: visibleId,
    label: boundedText(200),
    title: z.string().trim().max(200).nullable(),
  }).strict(),
]);
export type RelationshipCandidateEndpoint = z.infer<typeof RelationshipCandidateEndpointSchema>;

const formalRelation = RelationV2Schema.extend({
  rendering: z.literal('solid'),
}).strict();

const candidateRelation = z.object({
  candidateId: visibleId,
  reviewBatchId: visibleId,
  sourceArtifactId: visibleId,
  sourceEndpoint: RelationshipCandidateEndpointSchema,
  targetEndpoint: RelationshipCandidateEndpointSchema,
  layer: z.enum(['L1', 'L2', 'L3', 'L4']),
  label: z.string().trim().max(200).nullable(),
  directed: z.boolean(),
  confidence: z.number().finite().min(0).max(1),
  source: z.object({
    artifactKind: visibleId,
    title: boundedText(240),
    externalRef: z.string().trim().min(1).max(500).nullable(),
    occurredAtUtc: UtcInstantSchema.nullable(),
    locator: z.string().trim().min(1).max(200),
    quote: boundedText(2_000),
  }).strict(),
  candidateCreatedAtUtc: UtcInstantSchema,
  rendering: z.literal('muted_dashed_question'),
}).strict();

export const RelationshipVerificationReadinessSchema = z.enum([
  'planned',
  'awaiting_result_or_evidence',
  'ready_for_review',
  'reviewed',
  'superseded_revision',
]);
export type RelationshipVerificationReadiness = z.infer<typeof RelationshipVerificationReadinessSchema>;

const verificationCommitment = z.object({
  commitment: CommitmentV2Schema,
  linkedEvidenceIds: z.array(visibleId).max(50),
  readiness: RelationshipVerificationReadinessSchema,
}).strict();

const hypothesisProjection = z.object({
  hypothesis: SalesHypothesisViewSchema,
  evidenceLinks: z.array(HypothesisEvidenceLinkViewSchema).max(50),
  verificationCommitments: z.array(verificationCommitment).max(50),
  rendering: z.literal('dotted_annotation').default('dotted_annotation'),
}).strict();

function endpointIdentity(endpoint: z.infer<typeof RelationshipCandidateEndpointSchema>): string {
  return endpoint.kind === 'person'
    ? `person\u0000${endpoint.personId}`
    : `candidate\u0000${endpoint.candidateId}`;
}

function expectedReadiness(
  commitment: z.infer<typeof CommitmentV2Schema>,
  currentRevisionId: string,
  linkedEvidenceCount: number,
): z.infer<typeof RelationshipVerificationReadinessSchema> {
  if (commitment.verificationReviewDisposition !== null) return 'reviewed';
  if (commitment.hypothesisRevisionId !== currentRevisionId) return 'superseded_revision';
  if (commitment.executionStatus !== 'completed') return 'planned';
  if (commitment.completionResult.length > 0 || linkedEvidenceCount > 0) return 'ready_for_review';
  return 'awaiting_result_or_evidence';
}

export const RelationshipWorkspaceResponseSchema = z.object({
  generatedAtUtc: UtcInstantSchema,
  customer: CustomerV2Schema,
  matter: MatterV2Schema,
  people: z.array(PersonSummaryV2Schema).max(200),
  formalRelations: z.array(formalRelation).max(400),
  candidateRelations: z.array(candidateRelation).max(100),
  intelligence: z.array(IntelligenceItemViewSchema).max(50),
  focus: StakeholderFocusViewSchema.nullable(),
  hypotheses: z.array(hypothesisProjection).max(50),
}).strict().superRefine((value, ctx) => {
  if (value.matter.customerId !== value.customer.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matter', 'customerId'], message: 'Matter must belong to Customer' });
  }

  const people = new Set<string>();
  value.people.forEach((person, index) => {
    if (people.has(person.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['people', index, 'id'], message: 'duplicate Person' });
    }
    people.add(person.id);
    if (person.customerId !== value.customer.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['people', index, 'customerId'], message: 'Person must belong to Customer' });
    }
  });

  const relationIds = new Set<string>();
  value.formalRelations.forEach((relation, index) => {
    relationIds.add(relation.id);
    if (relation.customerId !== value.customer.id
      || (relation.matterId !== null && relation.matterId !== value.matter.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['formalRelations', index], message: 'Relation parent mismatch' });
    }
    if (!people.has(relation.sourcePersonId) || !people.has(relation.targetPersonId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['formalRelations', index], message: 'Relation endpoint missing' });
    }
  });

  value.candidateRelations.forEach((relation, index) => {
    if (endpointIdentity(relation.sourceEndpoint) === endpointIdentity(relation.targetEndpoint)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidateRelations', index], message: 'candidate endpoints must differ' });
    }
    for (const [endpointName, endpoint] of [
      ['sourceEndpoint', relation.sourceEndpoint],
      ['targetEndpoint', relation.targetEndpoint],
    ] as const) {
      if (endpoint.kind === 'person' && !people.has(endpoint.personId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidateRelations', index, endpointName, 'personId'],
          message: 'candidate existing Person endpoint missing',
        });
      }
    }
  });

  value.intelligence.forEach((item, index) => {
    if (item.customerId !== value.customer.id || item.matterId !== value.matter.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intelligence', index], message: 'Intelligence parent mismatch' });
    }
    item.targets.forEach((target, targetIndex) => {
      const valid = target.kind === 'customer'
        ? target.id === value.customer.id
        : target.kind === 'matter'
          ? target.id === value.matter.id
          : target.kind === 'person'
            ? people.has(target.id)
            : relationIds.has(target.id);
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['intelligence', index, 'targets', targetIndex],
          message: 'Intelligence target missing from workspace',
        });
      }
    });
  });

  if (value.focus && (value.focus.customerId !== value.customer.id
    || value.focus.matterId !== value.matter.id
    || !people.has(value.focus.personId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['focus'], message: 'Focus parent or Person mismatch' });
  }

  value.hypotheses.forEach((projection, index) => {
    const current = projection.hypothesis;
    if (current.customerId !== value.customer.id || current.matterId !== value.matter.id
      || (current.personId !== null && !people.has(current.personId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hypotheses', index, 'hypothesis'], message: 'Hypothesis parent or Person mismatch' });
    }
    const evidenceIds = new Set<string>();
    projection.evidenceLinks.forEach((link, linkIndex) => {
      evidenceIds.add(link.evidenceId);
      if (link.hypothesisId !== current.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hypotheses', index, 'evidenceLinks', linkIndex], message: 'Evidence link hypothesis mismatch' });
      }
    });
    projection.verificationCommitments.forEach((entry, commitmentIndex) => {
      const commitment = entry.commitment;
      if (commitment.customerId !== value.customer.id || commitment.matterId !== value.matter.id
        || commitment.hypothesisId !== current.id || commitment.hypothesisRevisionId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hypotheses', index, 'verificationCommitments', commitmentIndex], message: 'verification Commitment closure mismatch' });
      }
      const linked = projection.evidenceLinks.filter(
        (link) => link.verificationCommitmentId === commitment.id,
      );
      if (entry.linkedEvidenceIds.length !== linked.length
        || entry.linkedEvidenceIds.some((id, evidenceIndex) => id !== linked[evidenceIndex]?.evidenceId)
        || entry.linkedEvidenceIds.some((id) => !evidenceIds.has(id))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hypotheses', index, 'verificationCommitments', commitmentIndex, 'linkedEvidenceIds'], message: 'verification Evidence references mismatch' });
      }
      if (entry.readiness !== expectedReadiness(commitment, current.currentRevisionId, linked.length)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hypotheses', index, 'verificationCommitments', commitmentIndex, 'readiness'], message: 'verification readiness mismatch' });
      }
    });
  });
});
export type RelationshipWorkspaceResponse = z.infer<typeof RelationshipWorkspaceResponseSchema>;

const reviewCommon = {
  type: z.literal('REVIEW_HYPOTHESIS_VERIFICATION'),
  customerId: visibleId,
  matterId: visibleId,
  commitmentId: visibleId,
  expectedCommitmentVersion: version,
  expectedCommitmentScheduleVersion: version,
  salesHypothesisId: visibleId,
  expectedHypothesisVersion: version,
  expectedCurrentRevisionId: visibleId,
} satisfies z.ZodRawShape;

export const ReviewHypothesisVerificationCommandSchema = z.discriminatedUnion('disposition', [
  z.object({
    ...reviewCommon,
    disposition: z.literal('keep'),
    ownerUserId: visibleId,
    nextReviewAt: UtcInstantSchema,
  }).strict(),
  z.object({
    ...reviewCommon,
    disposition: z.literal('revise'),
    nextReviewAt: UtcInstantSchema,
    revision: SalesHypothesisRevisionInputSchema,
  }).strict(),
  z.object({
    ...reviewCommon,
    disposition: z.literal('retire'),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.disposition === 'revise' && value.revision.id === value.expectedCurrentRevisionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision', 'id'], message: 'revision review requires a new revision ID' });
  }
});

export type ReviewHypothesisVerificationCommand = z.infer<typeof ReviewHypothesisVerificationCommandSchema>;

export const ReviewHypothesisVerificationReceiptSchema = z.object({
  type: z.literal('REVIEW_HYPOTHESIS_VERIFICATION'),
  customerId: visibleId,
  matterId: visibleId,
  commitmentId: visibleId,
  salesHypothesisId: visibleId,
  previousRevisionId: visibleId,
  currentRevisionId: visibleId,
  disposition: HypothesisVerificationDispositionSchema,
  commitmentVersion: version,
  hypothesisVersion: version,
  replayed: z.boolean(),
  undoable: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const revisionChanged = value.previousRevisionId !== value.currentRevisionId;
  if ((value.disposition === 'revised') !== revisionChanged) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentRevisionId'], message: 'only a revised review changes revision ID' });
  }
});

export type ReviewHypothesisVerificationReceipt = z.infer<typeof ReviewHypothesisVerificationReceiptSchema>;
