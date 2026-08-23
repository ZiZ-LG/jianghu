import { z } from 'zod';
import { OpaqueEntityIdSchema } from './ids.js';

const id = z.string().min(1);
const openKey = z.string().trim().min(1);
const version = z.number().int().nonnegative();

export const UtcInstantSchema = z.string().datetime({ offset: true }).refine(
  (value) => value.endsWith('Z'),
  'expected canonical UTC instant ending in Z',
);

function isRealLocalDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export const LocalDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealLocalDate, 'expected a real calendar date');

export const IanaTimeZoneSchema = z.string()
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9._+-]+)+$/, 'expected an IANA area/location time zone')
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'unknown IANA time zone');

const instant = UtcInstantSchema;
const localDate = LocalDateSchema;

export const MatterLifecycleStatusSchema = z.enum(['active', 'paused', 'completed', 'canceled']);
export const CommitmentExecutionStatusSchema = z.enum(['planned', 'completed', 'canceled', 'missed']);
export const CommitmentConfirmationStatusSchema = z.enum(['not_required', 'pending', 'confirmed', 'declined']);

export const CustomerV2Schema = z.object({
  id,
  name: z.string().trim().min(1),
  categoryKey: openKey.nullable(),
  primaryOwnerUserId: id.nullable(),
  archivedAt: instant.nullable(),
  version,
}).strict();

export type CustomerV2 = z.infer<typeof CustomerV2Schema>;

export const CUSTOMER_NAME_MAX_LENGTH = 120;

const matterObject = z.object({
  id,
  customerId: id,
  title: z.string().trim().min(1),
  kind: openKey,
  lifecycleStatus: MatterLifecycleStatusSchema,
  outcomeKey: openKey.nullable(),
  priority: openKey.nullable(),
  targetDate: localDate.nullable(),
  primaryOwnerUserId: id.nullable(),
  archivedAt: instant.nullable(),
  version,
}).strict();

function validateMatterOutcome(
  lifecycleStatus: z.infer<typeof MatterLifecycleStatusSchema>,
  outcomeKey: string | null,
  ctx: z.RefinementCtx,
): void {
  if ((lifecycleStatus === 'active' || lifecycleStatus === 'paused') && outcomeKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeKey'], message: 'open lifecycle state cannot carry an outcome' });
  }
}

export const MatterV2Schema = matterObject.superRefine((value, ctx) => {
  validateMatterOutcome(value.lifecycleStatus, value.outcomeKey, ctx);
});

export type MatterV2 = z.infer<typeof MatterV2Schema>;

const commitmentFields = {
  id,
  customerId: id,
  matterId: id.nullable(),
  personId: id.nullable(),
  title: z.string().trim().min(1),
  kind: openKey,
  // Legacy PlanAction rows may be explicitly unassigned during expand/migrate.
  // Generic CREATE_COMMITMENT still requires a stable owner id below.
  ownerUserId: id.nullable(),
  executionStatus: CommitmentExecutionStatusSchema,
  confirmationStatus: CommitmentConfirmationStatusSchema,
  scheduledAtUtc: instant.nullable(),
  dueAtUtc: instant.nullable(),
  timeZone: IanaTimeZoneSchema,
  isAllDay: z.boolean(),
  localDate: localDate.nullable(),
  confirmationDueAtUtc: instant.nullable(),
  confirmedAtUtc: instant.nullable(),
  confirmedByUserId: id.nullable(),
  scheduleVersion: version,
  nextCommitmentId: id.nullable(),
  source: openKey,
  sourceRef: z.string().min(1).nullable(),
  archivedAt: instant.nullable(),
  version,
} satisfies z.ZodRawShape;

function validateSchedule(
  value: {
    scheduledAtUtc: string | null;
    dueAtUtc: string | null;
    isAllDay: boolean;
    localDate: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.isAllDay) {
    if (!value.localDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['localDate'], message: 'all-day commitment requires localDate' });
    }
    if (value.scheduledAtUtc || value.dueAtUtc) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledAtUtc'], message: 'all-day commitment must not use a fabricated UTC instant' });
    }
    return;
  }

  if (!value.scheduledAtUtc && !value.dueAtUtc) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledAtUtc'], message: 'timed commitment requires scheduledAtUtc or dueAtUtc' });
  }
  if (value.localDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['localDate'], message: 'timed commitment must not also carry localDate' });
  }
}

function utcInstantToLocalDate(value: string, timeZone: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      calendar: 'gregory',
      numberingSystem: 'latn',
    }).formatToParts(new Date(timestamp));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function validateConfirmationDeadline(
  value: {
    scheduledAtUtc: string | null;
    dueAtUtc: string | null;
    timeZone: string;
    isAllDay: boolean;
    localDate: string | null;
    confirmationDueAtUtc: string | null;
  },
  mode: 'required' | 'forbidden' | 'optional',
  ctx: z.RefinementCtx,
): void {
  if (mode === 'required' && !value.confirmationDueAtUtc) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmationDueAtUtc'], message: 'pending confirmation requires a due instant' });
    return;
  }
  if (mode === 'forbidden' && value.confirmationDueAtUtc) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmationDueAtUtc'], message: 'confirmation deadline requires confirmation' });
    return;
  }

  if (value.confirmationDueAtUtc && value.isAllDay && value.localDate) {
    const confirmationLocalDate = utcInstantToLocalDate(value.confirmationDueAtUtc, value.timeZone);
    if (confirmationLocalDate && confirmationLocalDate > value.localDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationDueAtUtc'],
        message: 'all-day confirmation deadline must not fall after the event business date',
      });
    }
  }

  const eventAt = value.scheduledAtUtc ?? value.dueAtUtc;
  if (value.confirmationDueAtUtc && eventAt
    && Date.parse(value.confirmationDueAtUtc) >= Date.parse(eventAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmationDueAtUtc'], message: 'confirmation deadline must be before the event' });
  }
}

export const CommitmentV2Schema = z.object(commitmentFields).strict().superRefine((value, ctx) => {
  validateSchedule(value, ctx);
  validateConfirmationDeadline(
    value,
    value.confirmationStatus === 'pending'
      ? 'required'
      : value.confirmationStatus === 'not_required' ? 'forbidden' : 'optional',
    ctx,
  );
  const isConfirmed = value.confirmationStatus === 'confirmed';
  if (isConfirmed && (!value.confirmedAtUtc || !value.confirmedByUserId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmationStatus'], message: 'confirmed commitment requires confirmation metadata' });
  }
  if (!isConfirmed && (value.confirmedAtUtc || value.confirmedByUserId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmedAtUtc'], message: 'only confirmed commitment may carry current confirmation metadata' });
  }
});

export type CommitmentV2 = z.infer<typeof CommitmentV2Schema>;

const customerCreate = CustomerV2Schema.omit({ archivedAt: true, version: true }).extend({
  id: OpaqueEntityIdSchema,
  name: z.string().trim().min(1).max(CUSTOMER_NAME_MAX_LENGTH),
  categoryKey: openKey.nullable().default(null),
  primaryOwnerUserId: id.nullable().default(null),
});
const customerPatch = CustomerV2Schema.omit({ id: true, archivedAt: true, version: true }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'customer patch must change at least one field');

const matterCreate = matterObject.omit({
  lifecycleStatus: true,
  outcomeKey: true,
  archivedAt: true,
  version: true,
}).extend({
  id: OpaqueEntityIdSchema,
  kind: openKey.default('general'),
  lifecycleStatus: z.literal('active').default('active'),
  outcomeKey: z.null().default(null),
  priority: openKey.nullable().default(null),
  targetDate: localDate.nullable().default(null),
  primaryOwnerUserId: id.nullable().default(null),
});
const matterPatch = matterObject.omit({
  id: true,
  customerId: true,
  lifecycleStatus: true,
  outcomeKey: true,
  primaryOwnerUserId: true,
  archivedAt: true,
  version: true,
}).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'matter patch must change at least one field');

export const MatterOwnerTransferCommandSchema = z.object({
  type: z.literal('TRANSFER_MATTER_OWNER'),
  customerId: id,
  matterId: id,
  baseVersion: version,
  fromOwnerUserId: id.nullable(),
  toOwnerUserId: id.nullable(),
}).strict().refine(
  (value) => value.fromOwnerUserId !== value.toOwnerUserId,
  { path: ['toOwnerUserId'], message: 'owner transfer must change the owner' },
);

export type MatterOwnerTransferCommand = z.infer<typeof MatterOwnerTransferCommandSchema>;

export const MatterOwnerQueueReasonSchema = z.enum([
  'account_owner_suggestion',
  'unassigned',
  'legacy_account_owner_name_only',
  'duplicate_legacy_account_owner_name',
  'invalid_account_owner',
  'invalid_matter_owner',
  'invalid_customer',
  'archived_matter',
  'archived_customer',
]);

export const MatterOwnerQueueItemSchema = z.object({
  tenantId: id,
  customerId: id,
  matterId: id,
  baseVersion: version,
  currentOwnerUserId: id.nullable(),
  suggestedOwnerUserId: id.nullable(),
  reason: MatterOwnerQueueReasonSchema,
}).strict();

export const MatterOwnerAssignmentReportSchema = z.object({
  pageMatterCount: z.number().int().nonnegative(),
  pageAssignedCount: z.number().int().nonnegative(),
  pageUnassignedCount: z.number().int().nonnegative(),
  queue: z.array(MatterOwnerQueueItemSchema),
  nextCursor: id.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.pageAssignedCount + value.pageUnassignedCount !== value.pageMatterCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pageMatterCount'],
      message: 'assigned and queued Matter counts must cover the page exactly',
    });
  }
  if (value.queue.length !== value.pageUnassignedCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['queue'],
      message: 'queue length must match the queued Matter count',
    });
  }
});

export type MatterOwnerQueueReason = z.infer<typeof MatterOwnerQueueReasonSchema>;
export type MatterOwnerQueueItem = z.infer<typeof MatterOwnerQueueItemSchema>;
export type MatterOwnerAssignmentReport = z.infer<typeof MatterOwnerAssignmentReportSchema>;

const openMatterLifecycle = z.enum(['active', 'paused']);
const closedMatterLifecycle = z.enum(['completed', 'canceled']);
const matterLifecycleTransition = z.object({
  from: openMatterLifecycle,
  to: MatterLifecycleStatusSchema,
  outcomeKey: openKey.nullable(),
  reason: z.string().trim().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.from === value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'lifecycle transition must change state' });
  }
  validateMatterOutcome(value.to, value.outcomeKey, ctx);
  if (value.to === 'canceled' && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'cancellation requires a reason' });
  }
});

const commitmentCreateFields = {
  id: OpaqueEntityIdSchema,
  customerId: id,
  matterId: id.nullable(),
  personId: id.nullable(),
  title: z.string().trim().min(1),
  kind: openKey,
  ownerUserId: id,
  confirmationStatus: z.enum(['not_required', 'pending']),
  scheduledAtUtc: instant.nullable(),
  dueAtUtc: instant.nullable(),
  timeZone: IanaTimeZoneSchema,
  isAllDay: z.boolean(),
  localDate: localDate.nullable(),
  confirmationDueAtUtc: instant.nullable(),
  source: openKey,
  sourceRef: z.string().min(1).nullable(),
} satisfies z.ZodRawShape;

const commitmentCreate = z.object(commitmentCreateFields).strict().superRefine((value, ctx) => {
  validateSchedule(value, ctx);
  validateConfirmationDeadline(value, value.confirmationStatus === 'pending' ? 'required' : 'forbidden', ctx);
});

const commitmentSchedule = z.object({
  scheduledAtUtc: instant.nullable(),
  dueAtUtc: instant.nullable(),
  timeZone: IanaTimeZoneSchema,
  isAllDay: z.boolean(),
  localDate: localDate.nullable(),
  confirmationDueAtUtc: instant.nullable(),
  requiresConfirmation: z.boolean(),
}).strict().superRefine((value, ctx) => {
  validateSchedule(value, ctx);
  validateConfirmationDeadline(value, value.requiresConfirmation ? 'required' : 'forbidden', ctx);
});

const command = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const versionedEntityCommand = {
  customerId: id,
  baseVersion: version,
} satisfies z.ZodRawShape;
const scheduledCommitmentCommand = {
  ...versionedEntityCommand,
  commitmentId: id,
  expectedScheduleVersion: version,
} satisfies z.ZodRawShape;

const matterParticipantCommandFields = {
  customerId: id,
  matterId: id,
  personId: id,
} satisfies z.ZodRawShape;

export const AddMatterParticipantCommandSchema = command({
  type: z.literal('ADD_MATTER_PARTICIPANT'),
  ...matterParticipantCommandFields,
});
export const RemoveMatterParticipantCommandSchema = command({
  type: z.literal('REMOVE_MATTER_PARTICIPANT'),
  ...matterParticipantCommandFields,
});
export const MatterParticipantCommandSchema = z.union([
  AddMatterParticipantCommandSchema,
  RemoveMatterParticipantCommandSchema,
]);
export type MatterParticipantCommand = z.infer<typeof MatterParticipantCommandSchema>;

export const CustomerCreateCommandSchema = command({
  type: z.literal('CREATE_CUSTOMER'),
  customer: customerCreate,
});
export type CustomerCreateCommand = z.infer<typeof CustomerCreateCommandSchema>;

export const CreateCommitmentCommandSchema = command({
  type: z.literal('CREATE_COMMITMENT'),
  commitment: commitmentCreate,
});

export const QUICK_CAPTURE_TITLE_MAX_LENGTH = 200;

const quickCaptureCommitmentCreate = z.object({
  ...commitmentCreateFields,
  title: z.string().trim().min(1).max(QUICK_CAPTURE_TITLE_MAX_LENGTH),
  kind: z.literal('follow_up'),
  scheduledAtUtc: instant,
  dueAtUtc: z.null(),
  isAllDay: z.literal(false),
  localDate: z.null(),
  source: z.literal('manual_quick_capture'),
  sourceRef: z.null(),
}).strict().superRefine((value, ctx) => {
  validateSchedule(value, ctx);
  validateConfirmationDeadline(value, value.confirmationStatus === 'pending' ? 'required' : 'forbidden', ctx);
});

const quickCaptureCommitmentCommandSchema = command({
  type: z.literal('CREATE_COMMITMENT'),
  commitment: quickCaptureCommitmentCreate,
});

const quickCaptureCustomerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), customerId: id }).strict(),
  z.object({ mode: z.literal('create'), command: CustomerCreateCommandSchema }).strict(),
]);

/**
 * One user-confirmed application command. Inline Customer creation and the
 * customer-level Commitment must execute in one transaction; this schema is
 * deliberately not part of CrmCommandSchema because it only composes the two
 * existing formal domain commands.
 */
export const QuickCaptureCommandSchema = z.object({
  customer: quickCaptureCustomerSchema,
  commitment: quickCaptureCommitmentCommandSchema,
}).strict().superRefine((value, ctx) => {
  const customerId = value.customer.mode === 'existing'
    ? value.customer.customerId
    : value.customer.command.customer.id;
  if (value.commitment.commitment.customerId !== customerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['commitment', 'commitment', 'customerId'],
      message: 'Quick Capture Customer and Commitment must match',
    });
  }
  if (value.customer.mode === 'create') {
    if (value.commitment.commitment.matterId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commitment', 'commitment', 'matterId'],
        message: 'an inline new Customer cannot already have a Matter',
      });
    }
    if (value.commitment.commitment.personId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commitment', 'commitment', 'personId'],
        message: 'an inline new Customer cannot already have a Person',
      });
    }
  }
});

export type QuickCaptureCommand = z.infer<typeof QuickCaptureCommandSchema>;

export const CRM_COMMAND_TYPES = [
  'CREATE_CUSTOMER', 'UPDATE_CUSTOMER', 'ARCHIVE_CUSTOMER', 'RESTORE_CUSTOMER',
  'CREATE_MATTER', 'UPDATE_MATTER', 'TRANSFER_MATTER_OWNER', 'TRANSITION_MATTER_LIFECYCLE', 'REOPEN_MATTER',
  'ARCHIVE_MATTER', 'RESTORE_MATTER',
  'ADD_MATTER_PARTICIPANT', 'REMOVE_MATTER_PARTICIPANT',
  'CREATE_COMMITMENT', 'RESCHEDULE_COMMITMENT', 'CONFIRM_COMMITMENT',
  'DECLINE_COMMITMENT', 'COMPLETE_COMMITMENT', 'CANCEL_COMMITMENT',
  'MARK_COMMITMENT_MISSED', 'CREATE_NEXT_COMMITMENT',
] as const;

export type CrmCommandType = (typeof CRM_COMMAND_TYPES)[number];

const crmCommandSchemas = [
  CustomerCreateCommandSchema,
  command({ type: z.literal('UPDATE_CUSTOMER'), ...versionedEntityCommand, patch: customerPatch }),
  command({ type: z.literal('ARCHIVE_CUSTOMER'), ...versionedEntityCommand, reason: z.string().trim().min(1).optional() }),
  command({ type: z.literal('RESTORE_CUSTOMER'), ...versionedEntityCommand }),
  command({ type: z.literal('CREATE_MATTER'), matter: matterCreate }),
  command({ type: z.literal('UPDATE_MATTER'), ...versionedEntityCommand, matterId: id, patch: matterPatch }),
  MatterOwnerTransferCommandSchema,
  command({
    type: z.literal('TRANSITION_MATTER_LIFECYCLE'),
    ...versionedEntityCommand,
    matterId: id,
    transition: matterLifecycleTransition,
  }),
  command({
    type: z.literal('REOPEN_MATTER'),
    ...versionedEntityCommand,
    matterId: id,
    expectedLifecycleStatus: closedMatterLifecycle,
    reopenTo: openMatterLifecycle,
    reason: z.string().trim().min(1),
  }),
  command({ type: z.literal('ARCHIVE_MATTER'), ...versionedEntityCommand, matterId: id, reason: z.string().trim().min(1).optional() }),
  command({ type: z.literal('RESTORE_MATTER'), ...versionedEntityCommand, matterId: id }),
  AddMatterParticipantCommandSchema,
  RemoveMatterParticipantCommandSchema,
  CreateCommitmentCommandSchema,
  command({
    type: z.literal('RESCHEDULE_COMMITMENT'),
    ...scheduledCommitmentCommand,
    schedule: commitmentSchedule,
  }),
  command({ type: z.literal('CONFIRM_COMMITMENT'), ...scheduledCommitmentCommand, confirmedAtUtc: instant }),
  command({ type: z.literal('DECLINE_COMMITMENT'), ...scheduledCommitmentCommand, declinedAtUtc: instant }),
  command({ type: z.literal('COMPLETE_COMMITMENT'), ...scheduledCommitmentCommand, completedAtUtc: instant }),
  command({ type: z.literal('CANCEL_COMMITMENT'), ...scheduledCommitmentCommand, canceledAtUtc: instant, reason: z.string().trim().min(1).optional() }),
  command({ type: z.literal('MARK_COMMITMENT_MISSED'), ...scheduledCommitmentCommand, missedAtUtc: instant }),
  command({
    type: z.literal('CREATE_NEXT_COMMITMENT'),
    previousCommitmentId: id,
    expectedPreviousVersion: version,
    commitment: commitmentCreate,
  }).superRefine((value, ctx) => {
    if (value.previousCommitmentId === value.commitment.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commitment', 'id'], message: 'next commitment cannot reference itself' });
    }
  }),
] as const;

export const CrmCommandSchema = z.union(crmCommandSchemas);
export type CrmCommandInput = z.input<typeof CrmCommandSchema>;
export type CrmCommand = z.infer<typeof CrmCommandSchema>;

/** Non-sensitive replay summary for the create-only Customer command. */
export const CustomerCommandReceiptSchema = z.object({
  customerId: id,
  categoryKey: openKey.nullable(),
  primaryOwnerUserId: id.nullable(),
  version,
  undoable: z.literal(false),
}).strict();

export type CustomerCommandReceipt = z.infer<typeof CustomerCommandReceiptSchema>;

export const COMMITMENT_COMMAND_TYPES = [
  'CREATE_COMMITMENT', 'RESCHEDULE_COMMITMENT', 'CONFIRM_COMMITMENT',
  'DECLINE_COMMITMENT', 'COMPLETE_COMMITMENT', 'CANCEL_COMMITMENT',
  'MARK_COMMITMENT_MISSED', 'CREATE_NEXT_COMMITMENT',
] as const;
export type CommitmentCommandType = (typeof COMMITMENT_COMMAND_TYPES)[number];
export type CommitmentCommand = Extract<CrmCommand, { type: CommitmentCommandType }>;

const commitmentCommandTypes = new Set<string>(COMMITMENT_COMMAND_TYPES);
export const CommitmentCommandSchema = CrmCommandSchema.refine(
  (value): value is CommitmentCommand => commitmentCommandTypes.has(value.type),
  'expected a Commitment command',
);

export const CommitmentRepairCommandSchema = z.enum([
  'RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT', 'CREATE_NEXT_COMMITMENT',
]);

/**
 * A replay-safe command receipt deliberately excludes title/source text. The
 * client refreshes state for the full DTO, while the command journal stores
 * only this non-sensitive summary.
 */
export const CommitmentCommandReceiptSchema = z.object({
  commitmentId: id,
  customerId: id,
  matterId: id.nullable(),
  executionStatus: CommitmentExecutionStatusSchema,
  confirmationStatus: CommitmentConfirmationStatusSchema,
  version,
  scheduleVersion: version,
  nextCommitmentId: id.nullable(),
  linkedFromCommitmentId: id.nullable(),
  undoable: z.literal(false),
  repairCommands: z.array(CommitmentRepairCommandSchema),
}).strict();

export type CommitmentCommandReceipt = z.infer<typeof CommitmentCommandReceiptSchema>;

/** Non-sensitive replay summary for the atomic Quick Capture application command. */
export const QuickCaptureCommandReceiptSchema = z.object({
  customer: CustomerCommandReceiptSchema.nullable(),
  commitment: CommitmentCommandReceiptSchema,
}).strict();

export type QuickCaptureCommandReceipt = z.infer<typeof QuickCaptureCommandReceiptSchema>;
