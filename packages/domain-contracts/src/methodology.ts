import { z } from 'zod';
import { OpaqueEntityIdSchema } from './ids.js';

const id = z.string().min(1);
const version = z.number().int().nonnegative();
const openKey = z.string().trim().min(1).max(200);
const instant = z.string().datetime({ offset: true }).refine(
  (value) => value.endsWith('Z'),
  'expected canonical UTC instant ending in Z',
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase SHA-256');

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
