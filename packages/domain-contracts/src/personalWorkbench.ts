import { z } from 'zod';
import { CommitmentV2Schema, CustomerV2Schema, MatterV2Schema, PersonSummaryV2Schema, UtcInstantSchema } from './crm.js';
import { OpaqueEntityIdSchema } from './ids.js';
import { RelationshipWorkspaceResponseSchema } from './relationshipWorkspace.js';

const id = z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const version = z.number().int().nonnegative();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).nullable();
export const PersonalRoleBasisSchema = z.object({ id, version }).strict();
const role = {
  decisionRole: optionalText(120),
  basis: PersonalRoleBasisSchema.nullable(),
};
const fields = {
  title: text(100),
  customerBusinessGoal: optionalText(2_000),
  salesProgress: optionalText(40),
  priority: z.enum(['high', 'normal']).nullable(),
};
const parent = { customerId: id, matterId: id };
export const PersonalWorkbenchCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CREATE_PERSONAL_MATTER'), customerId: id, matterId: OpaqueEntityIdSchema, ...fields }).strict(),
  z.object({ type: z.literal('UPDATE_PERSONAL_MATTER'), ...parent, baseVersion: version,
    patch: z.object({ ...fields, lifecycle: z.enum(['active', 'paused', 'won', 'lost']) }).strict().partial()
      .refine(value => Object.keys(value).length > 0, 'an update must change a field'),
  }).strict(),
  z.object({ type: z.literal('CREATE_MATTER_PERSON'), ...parent, personId: OpaqueEntityIdSchema,
    name: text(80), title: z.string().trim().max(120), decisionRole: optionalText(120),
  }).strict(),
  z.object({ type: z.literal('JOIN_MATTER_PERSON'), ...parent, personId: id }).strict(),
  z.object({ type: z.literal('SET_PERSON_DECISION_ROLE'), ...parent, personId: id, baseVersion: version, ...role }).strict(),
  z.object({ type: z.literal('CREATE_PERSONAL_RELATION'), ...parent, relationId: OpaqueEntityIdSchema,
    sourcePersonId: id, targetPersonId: id, label: text(200), directed: z.boolean(),
    basis: z.object({ statement: text(2_000), assertionType: z.enum(['observed', 'reported', 'inferred']),
      sourceDescription: text(1_000), occurredAt: UtcInstantSchema.nullable(),
    }).strict(),
  }).strict(),
]);
export type PersonalWorkbenchCommand = z.infer<typeof PersonalWorkbenchCommandSchema>;

export const PersonalWorkbenchReceiptSchema = z.object({
  type: z.string().min(1), customerId: id, matterId: id, entityId: id, version, replayed: z.boolean(),
}).strict();
export type PersonalWorkbenchReceipt = z.infer<typeof PersonalWorkbenchReceiptSchema>;

export const PersonalMatterSchema = z.object({
  matter: MatterV2Schema,
  customerBusinessGoal: z.string().nullable(),
  salesProgress: z.string().nullable(),
}).strict();
export const PersonalWorkbenchListSchema = z.object({
  generatedAtUtc: UtcInstantSchema,
  customers: z.array(CustomerV2Schema),
  entries: z.array(PersonalMatterSchema.extend({
    customerName: z.string(),
    nextCommitment: CommitmentV2Schema.nullable(),
    keyGap: z.string().nullable(),
  }).strict()),
}).strict();
export type PersonalWorkbenchList = z.infer<typeof PersonalWorkbenchListSchema>;

export const PersonalParticipantSchema = z.object({
  personId: id, version, decisionRole: z.string().nullable(),
  basis: PersonalRoleBasisSchema.nullable(),
  basisState: z.enum(['unverified', 'current', 'needs_review']),
}).strict();
export const PersonalWorkbenchDetailSchema = z.object({
  opportunity: PersonalMatterSchema,
  workspace: RelationshipWorkspaceResponseSchema,
  participants: z.array(PersonalParticipantSchema),
  availablePeople: z.array(PersonSummaryV2Schema),
  commitments: z.array(CommitmentV2Schema),
}).strict().superRefine((value, ctx) => {
  const matter = value.opportunity.matter;
  if (value.workspace.matter.id !== matter.id || value.workspace.customer.id !== matter.customerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'personal workbench parent mismatch' });
  }
  const people = new Set(value.workspace.people.map(person => person.id));
  if (new Set(value.participants.map(person => person.personId)).size !== value.participants.length
    || value.participants.some(person => !people.has(person.personId))
    || value.availablePeople.some(person => person.customerId !== matter.customerId)
    || value.commitments.some(action => action.customerId !== matter.customerId || action.matterId !== matter.id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'personal workbench entity closure mismatch' });
  }
});
export type PersonalWorkbenchDetail = z.infer<typeof PersonalWorkbenchDetailSchema>;
