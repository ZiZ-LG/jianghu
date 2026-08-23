import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlanAction, Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  CommandContextSchema,
  CommitmentCommandReceiptSchema,
  CommitmentCommandSchema,
  type CommandContext,
  type CommitmentCommand,
  type CommitmentCommandReceipt,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import {
  resolveEffectiveResourceScope,
  type EffectiveResourceScope,
} from '../resourceScope.js';
import { syncCommitmentToWeCom } from '../wecom.js';
import { runCommand } from './commandRunner.js';
import {
  requireScopedRow,
  ScopedNotFoundError,
} from './scopeGuards.js';

type CreateInput = Extract<CommitmentCommand, { type: 'CREATE_COMMITMENT' }>['commitment'];
type ScheduleInput = Extract<CommitmentCommand, { type: 'RESCHEDULE_COMMITMENT' }>['schedule'];

class CommitmentPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'commitment_write_forbidden';
  constructor() { super('无权修改跟进承诺'); }
}

class CommitmentAssignmentPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'commitment_assign_forbidden';
  constructor() { super('无权把跟进承诺指派给其他成员'); }
}

class CommitmentVersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'commitment_version_conflict';
  constructor() { super('跟进承诺已变化，请刷新后重试'); }
}

class CommitmentStateConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'commitment_state_conflict';
  constructor(message = '当前跟进承诺状态不允许该操作') { super(message); }
}

class CommitmentIdConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'commitment_id_conflict';
  constructor() { super('跟进承诺标识已存在'); }
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

function localParts(instant: string, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    calendar: 'gregory', numberingSystem: 'latn',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = Number(get('hour'));
  if (!year || !month || !day || !Number.isFinite(hour)) throw new Error('unable to derive legacy schedule projection');
  return { date: `${year}-${month}-${day}`, hour };
}

function legacySchedule(input: Pick<CreateInput, 'scheduledAtUtc' | 'dueAtUtc' | 'timeZone' | 'isAllDay' | 'localDate'>) {
  if (input.isAllDay) return { startDate: input.localDate!, endDate: input.localDate!, half: 'am' };
  const eventAt = input.scheduledAtUtc ?? input.dueAtUtc;
  if (!eventAt) throw new Error('timed Commitment is missing its event instant');
  const local = localParts(eventAt, input.timeZone);
  return { startDate: local.date, endDate: local.date, half: local.hour < 12 ? 'am' : local.hour < 18 ? 'pm' : 'eve' };
}

function createData(input: CreateInput, tenantId: string, actorId: string): Prisma.PlanActionUncheckedCreateInput {
  const legacy = legacySchedule(input);
  return {
    id: input.id,
    tenantId,
    accountId: input.customerId,
    opportunityId: input.matterId,
    gapItem: '',
    personId: input.personId,
    title: input.title,
    scene: '', scripts: '', target: '',
    ownerId: input.ownerUserId,
    startDate: legacy.startDate,
    endDate: legacy.endDate,
    half: legacy.half,
    done: false,
    doneAt: null,
    draft: false,
    review: '', resources: '', cautions: '', props: '',
    origin: input.source,
    createdBy: actorId,
    kind: input.kind,
    ownerUserId: input.ownerUserId,
    executionStatus: 'planned',
    confirmationStatus: input.confirmationStatus,
    scheduledAtUtc: input.scheduledAtUtc ? new Date(input.scheduledAtUtc) : null,
    dueAtUtc: input.dueAtUtc ? new Date(input.dueAtUtc) : null,
    timeZone: input.timeZone,
    isAllDay: input.isAllDay,
    localDate: input.localDate,
    confirmationDueAtUtc: input.confirmationDueAtUtc ? new Date(input.confirmationDueAtUtc) : null,
    confirmedAtUtc: null,
    confirmedByUserId: null,
    scheduleVersion: 0,
    nextCommitmentId: null,
    source: input.source,
    sourceRef: input.sourceRef,
    archivedAt: null,
    version: 0,
  };
}

function receipt(row: PlanAction, linkedFromCommitmentId: string | null = null): CommitmentCommandReceipt {
  const repairCommands: CommitmentCommandReceipt['repairCommands'] = row.executionStatus === 'planned'
    ? ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT']
    : row.executionStatus === 'completed' && !row.nextCommitmentId
      ? ['CREATE_NEXT_COMMITMENT']
      : [];
  return CommitmentCommandReceiptSchema.parse({
    commitmentId: row.id,
    customerId: row.accountId,
    matterId: row.opportunityId,
    executionStatus: row.executionStatus,
    confirmationStatus: row.confirmationStatus,
    version: row.version,
    scheduleVersion: row.scheduleVersion,
    nextCommitmentId: row.nextCommitmentId,
    linkedFromCommitmentId,
    undoable: false,
    repairCommands,
  });
}

async function lockWritableActor(
  ctx: CommandContext,
  db: Prisma.TransactionClient,
): Promise<Exclude<CommandContext['actorRole'], 'viewer'>> {
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success || role.data === 'viewer') throw new CommitmentPermissionError();
  const locked = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: role.data },
    data: { role: role.data },
  });
  if (locked.count !== 1) throw new CommitmentPermissionError();
  return role.data;
}

async function lockCustomer(ctx: CommandContext, customerId: string, db: Prisma.TransactionClient): Promise<void> {
  const customer = await requireScopedRow(db.account.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId, archivedAt: null },
    select: { name: true },
  }));
  const locked = await db.account.updateMany({
    where: { id: customerId, tenantId: ctx.tenantId, archivedAt: null, name: customer.name },
    data: { name: customer.name },
  });
  if (locked.count !== 1) throw new ScopedNotFoundError();
}

async function lockMatter(
  ctx: CommandContext,
  customerId: string,
  matterId: string,
  db: Prisma.TransactionClient,
): Promise<void> {
  const locked = await db.opportunity.updateMany({
    where: {
      id: matterId, tenantId: ctx.tenantId, accountId: customerId, archivedAt: null,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    data: { version: { increment: 0 } },
  });
  if (locked.count !== 1) throw new ScopedNotFoundError();
}

async function lockPerson(
  ctx: CommandContext,
  customerId: string,
  personId: string,
  db: Prisma.TransactionClient,
): Promise<void> {
  const locked = await db.person.updateMany({
    where: {
      id: personId, tenantId: ctx.tenantId, accountId: customerId,
      archivedAt: null, mergedIntoPersonId: null,
    },
    data: { version: { increment: 0 } },
  });
  if (locked.count !== 1) throw new ScopedNotFoundError();
}

async function lockOwner(ctx: CommandContext, ownerUserId: string, db: Prisma.TransactionClient): Promise<void> {
  const owner = await requireScopedRow(db.user.findFirst({
    where: { id: ownerUserId, tenantId: ctx.tenantId },
    select: { role: true },
  }));
  const ownerRole = ActorRoleSchema.safeParse(owner.role);
  if (!ownerRole.success) throw new ScopedNotFoundError();
  const locked = await db.user.updateMany({
    where: { id: ownerUserId, tenantId: ctx.tenantId, role: ownerRole.data },
    data: { role: ownerRole.data },
  });
  if (locked.count !== 1) throw new ScopedNotFoundError();
}

async function requireCreateScope(
  ctx: CommandContext,
  actorRole: Exclude<CommandContext['actorRole'], 'viewer'>,
  input: CreateInput,
  db: Prisma.TransactionClient,
  scope: EffectiveResourceScope,
): Promise<void> {
  if (!scope.canReadAccountContainer(input.customerId)) throw new ScopedNotFoundError();
  if (input.matterId === null) {
    if (!scope.canReadAccountData(input.customerId)) throw new ScopedNotFoundError();
  } else if (!scope.canReadMatter(input.matterId)) {
    throw new ScopedNotFoundError();
  }
  if (input.personId !== null && !scope.canReadAccountData(input.customerId)) {
    throw new ScopedNotFoundError();
  }
  await lockCustomer(ctx, input.customerId, db);
  if (input.matterId) await lockMatter(ctx, input.customerId, input.matterId, db);
  if (input.personId) await lockPerson(ctx, input.customerId, input.personId, db);
  if (actorRole === 'member' && input.ownerUserId !== ctx.actorId) {
    throw new CommitmentAssignmentPermissionError();
  }
  await lockOwner(ctx, input.ownerUserId, db);
}

async function ensureNewId(input: CreateInput, db: Prisma.TransactionClient): Promise<void> {
  const existing = await db.planAction.findUnique({ where: { id: input.id }, select: { id: true } });
  if (existing) throw new CommitmentIdConflictError();
}

async function insertCommitment(
  ctx: CommandContext,
  actorRole: Exclude<CommandContext['actorRole'], 'viewer'>,
  input: CreateInput,
  db: Prisma.TransactionClient,
  scope: EffectiveResourceScope,
): Promise<PlanAction> {
  await requireCreateScope(ctx, actorRole, input, db, scope);
  await ensureNewId(input, db);
  try {
    return await db.planAction.create({ data: createData(input, ctx.tenantId, ctx.actorId) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new CommitmentIdConflictError();
    }
    throw error;
  }
}

async function loadCommitment(
  ctx: CommandContext,
  customerId: string,
  commitmentId: string,
  db: Prisma.TransactionClient,
  scope: EffectiveResourceScope,
): Promise<PlanAction> {
  const row = await requireScopedRow(db.planAction.findFirst({
    where: { id: commitmentId, tenantId: ctx.tenantId, accountId: customerId, archivedAt: null },
  }));
  if (!scope.canReadAccountContainer(customerId)) throw new ScopedNotFoundError();
  if (row.opportunityId) {
    if (!scope.canReadMatter(row.opportunityId)) throw new ScopedNotFoundError();
  } else if (!scope.canReadAccountData(customerId)) {
    throw new ScopedNotFoundError();
  }
  if (row.personId && !scope.canReadAccountData(customerId)) throw new ScopedNotFoundError();
  await lockCustomer(ctx, customerId, db);
  if (row.opportunityId) await lockMatter(ctx, customerId, row.opportunityId, db);
  if (row.personId) await lockPerson(ctx, customerId, row.personId, db);
  return row;
}

function requireCas(row: PlanAction, baseVersion: number, expectedScheduleVersion: number): void {
  if (row.version !== baseVersion || row.scheduleVersion !== expectedScheduleVersion) {
    throw new CommitmentVersionConflictError();
  }
}

async function updateCas(
  ctx: CommandContext,
  row: PlanAction,
  baseVersion: number,
  expectedScheduleVersion: number,
  data: Prisma.PlanActionUpdateManyMutationInput,
  db: Prisma.TransactionClient,
): Promise<PlanAction> {
  const changed = await db.planAction.updateMany({
    where: {
      id: row.id,
      tenantId: ctx.tenantId,
      accountId: row.accountId,
      archivedAt: null,
      version: baseVersion,
      scheduleVersion: expectedScheduleVersion,
    },
    data: { ...data, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new CommitmentVersionConflictError();
  return db.planAction.findUniqueOrThrow({ where: { id: row.id } });
}

async function audit(
  ctx: CommandContext,
  action: string,
  entityId: string,
  changedFields: string[],
  metadata: Record<string, unknown>,
  db: Prisma.TransactionClient,
  sourceRef: string | null = null,
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action,
    entityKind: 'commitment',
    entityId,
    requestId: ctx.requestId,
    sourceRef,
    changedFields: JSON.stringify(changedFields),
    metadata: JSON.stringify(metadata),
  } });
}

const scheduleMetadata = (row: PlanAction) => ({
  scheduledAtUtc: iso(row.scheduledAtUtc),
  dueAtUtc: iso(row.dueAtUtc),
  timeZone: row.timeZone,
  isAllDay: row.isAllDay,
  localDate: row.localDate,
  confirmationDueAtUtc: iso(row.confirmationDueAtUtc),
});

async function previousConfirmationMetadata(
  ctx: CommandContext,
  row: PlanAction,
  db: Prisma.TransactionClient,
) {
  const action = row.confirmationStatus === 'confirmed'
    ? 'commitment_confirmed'
    : row.confirmationStatus === 'declined' ? 'commitment_declined' : null;
  const event = action ? await db.auditEvent.findFirst({
    where: { tenantId: ctx.tenantId, entityKind: 'commitment', entityId: row.id, action },
    orderBy: { createdAt: 'desc' },
    select: { id: true, metadata: true },
  }) : null;
  let eventMetadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = event?.metadata ? JSON.parse(event.metadata) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) eventMetadata = parsed as Record<string, unknown>;
  } catch { /* malformed legacy audit remains referenced only by id */ }
  const eventScheduleVersion = Number(eventMetadata.scheduleVersion);
  const currentEvent = event && Number.isInteger(eventScheduleVersion) && eventScheduleVersion === row.scheduleVersion
    ? event
    : null;
  return {
    status: row.confirmationStatus,
    confirmedAtUtc: iso(row.confirmedAtUtc),
    declinedAtUtc: currentEvent && typeof eventMetadata.declinedAtUtc === 'string'
      ? eventMetadata.declinedAtUtc
      : null,
    confirmedByUserId: row.confirmedByUserId,
    auditEventId: currentEvent?.id ?? null,
    stale: true,
  };
}

export async function executeCommitmentCommand(
  ctx: CommandContext,
  rawInput: CommitmentCommand,
  db: Prisma.TransactionClient,
): Promise<CommitmentCommandReceipt> {
  CommandContextSchema.parse(ctx);
  const input = CommitmentCommandSchema.parse(rawInput) as CommitmentCommand;
  const actorRole = await lockWritableActor(ctx, db);
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: actorRole,
  });

  if (input.type === 'CREATE_COMMITMENT') {
    const row = await insertCommitment(ctx, actorRole, input.commitment, db, scope);
    await audit(ctx, 'commitment_created', row.id,
      ['kind', 'ownerUserId', 'executionStatus', 'confirmationStatus', 'schedule', 'source', 'version'],
      {
        customerId: row.accountId, matterId: row.opportunityId, personId: row.personId,
        ownerUserId: row.ownerUserId, executionStatus: row.executionStatus,
        confirmationStatus: row.confirmationStatus, scheduleVersion: row.scheduleVersion,
        version: row.version,
      }, db, row.sourceRef);
    return receipt(row);
  }

  if (input.type === 'CREATE_NEXT_COMMITMENT') {
    const previous = await loadCommitment(
      ctx, input.commitment.customerId, input.previousCommitmentId, db, scope,
    );
    if (previous.version !== input.expectedPreviousVersion) throw new CommitmentVersionConflictError();
    if (previous.executionStatus !== 'completed') throw new CommitmentStateConflictError('只有已完成的承诺可以关联下一步');
    if (previous.nextCommitmentId) throw new CommitmentStateConflictError('该承诺已经关联下一步');
    if (input.commitment.customerId !== previous.accountId
      || input.commitment.matterId !== previous.opportunityId) {
      throw new CommitmentStateConflictError('下一步必须属于同一客户和事项');
    }
    const next = await insertCommitment(ctx, actorRole, input.commitment, db, scope);
    const linked = await db.planAction.updateMany({
      where: {
        id: previous.id, tenantId: ctx.tenantId, accountId: previous.accountId,
        version: input.expectedPreviousVersion, nextCommitmentId: null, archivedAt: null,
      },
      data: { nextCommitmentId: next.id, version: { increment: 1 } },
    });
    if (linked.count !== 1) throw new CommitmentVersionConflictError();
    await audit(ctx, 'commitment_created', next.id,
      ['kind', 'ownerUserId', 'executionStatus', 'confirmationStatus', 'schedule', 'source', 'version'],
      {
        customerId: next.accountId, matterId: next.opportunityId, personId: next.personId,
        linkedFromCommitmentId: previous.id, scheduleVersion: next.scheduleVersion, version: next.version,
      }, db, next.sourceRef);
    await audit(ctx, 'commitment_next_linked', previous.id, ['nextCommitmentId', 'version'], {
      nextCommitmentId: next.id,
      fromVersion: input.expectedPreviousVersion,
      toVersion: input.expectedPreviousVersion + 1,
    }, db);
    return receipt(next, previous.id);
  }

  const row = await loadCommitment(ctx, input.customerId, input.commitmentId, db, scope);
  requireCas(row, input.baseVersion, input.expectedScheduleVersion);

  if (input.type === 'RESCHEDULE_COMMITMENT') {
    if (row.executionStatus !== 'planned') throw new CommitmentStateConflictError();
    const schedule: ScheduleInput = input.schedule;
    const legacy = legacySchedule(schedule);
    const previousConfirmation = await previousConfirmationMetadata(ctx, row, db);
    const updated = await updateCas(ctx, row, input.baseVersion, input.expectedScheduleVersion, {
      scheduledAtUtc: schedule.scheduledAtUtc ? new Date(schedule.scheduledAtUtc) : null,
      dueAtUtc: schedule.dueAtUtc ? new Date(schedule.dueAtUtc) : null,
      timeZone: schedule.timeZone,
      isAllDay: schedule.isAllDay,
      localDate: schedule.localDate,
      confirmationDueAtUtc: schedule.confirmationDueAtUtc ? new Date(schedule.confirmationDueAtUtc) : null,
      confirmationStatus: schedule.requiresConfirmation ? 'pending' : 'not_required',
      confirmedAtUtc: null,
      confirmedByUserId: null,
      scheduleVersion: { increment: 1 },
      startDate: legacy.startDate,
      endDate: legacy.endDate,
      half: legacy.half,
    }, db);
    await audit(ctx, 'commitment_rescheduled', row.id,
      ['schedule', 'scheduleVersion', 'confirmationStatus', 'confirmedAtUtc', 'confirmedByUserId', 'version'],
      {
        fromVersion: row.version,
        toVersion: updated.version,
        fromScheduleVersion: row.scheduleVersion,
        toScheduleVersion: updated.scheduleVersion,
        previousSchedule: scheduleMetadata(row),
        nextSchedule: scheduleMetadata(updated),
        previousConfirmation,
      }, db);
    return receipt(updated);
  }

  if (row.executionStatus !== 'planned') throw new CommitmentStateConflictError();

  if (input.type === 'CONFIRM_COMMITMENT') {
    if (row.confirmationStatus !== 'pending') throw new CommitmentStateConflictError('只有待确认承诺可以确认');
    const updated = await updateCas(ctx, row, input.baseVersion, input.expectedScheduleVersion, {
      confirmationStatus: 'confirmed',
      confirmedAtUtc: new Date(input.confirmedAtUtc),
      confirmedByUserId: ctx.actorId,
    }, db);
    await audit(ctx, 'commitment_confirmed', row.id,
      ['confirmationStatus', 'confirmedAtUtc', 'confirmedByUserId', 'version'],
      { confirmedAtUtc: input.confirmedAtUtc, scheduleVersion: row.scheduleVersion, fromVersion: row.version, toVersion: updated.version }, db);
    return receipt(updated);
  }

  if (input.type === 'DECLINE_COMMITMENT') {
    if (row.confirmationStatus !== 'pending') throw new CommitmentStateConflictError('只有待确认承诺可以拒绝');
    const updated = await updateCas(ctx, row, input.baseVersion, input.expectedScheduleVersion, {
      confirmationStatus: 'declined', confirmedAtUtc: null, confirmedByUserId: null,
    }, db);
    await audit(ctx, 'commitment_declined', row.id, ['confirmationStatus', 'version'], {
      declinedAtUtc: input.declinedAtUtc, scheduleVersion: row.scheduleVersion,
      fromVersion: row.version, toVersion: updated.version,
    }, db);
    return receipt(updated);
  }

  if (input.type === 'COMPLETE_COMMITMENT') {
    const doneAt = localParts(input.completedAtUtc, row.timeZone).date;
    const updated = await updateCas(ctx, row, input.baseVersion, input.expectedScheduleVersion, {
      executionStatus: 'completed', done: true, doneAt,
    }, db);
    await audit(ctx, 'commitment_completed', row.id, ['executionStatus', 'version'], {
      completedAtUtc: input.completedAtUtc, scheduleVersion: row.scheduleVersion,
      fromVersion: row.version, toVersion: updated.version,
    }, db);
    return receipt(updated);
  }

  if (input.type === 'CANCEL_COMMITMENT') {
    const updated = await updateCas(ctx, row, input.baseVersion, input.expectedScheduleVersion, {
      executionStatus: 'canceled', done: false, doneAt: null,
    }, db);
    await audit(ctx, 'commitment_canceled', row.id, ['executionStatus', 'version'], {
      canceledAtUtc: input.canceledAtUtc, reasonProvided: Boolean(input.reason),
      scheduleVersion: row.scheduleVersion, fromVersion: row.version, toVersion: updated.version,
    }, db);
    return receipt(updated);
  }

  const updated = await updateCas(ctx, row, input.baseVersion, input.expectedScheduleVersion, {
    executionStatus: 'missed', done: false, doneAt: null,
  }, db);
  await audit(ctx, 'commitment_missed', row.id, ['executionStatus', 'version'], {
    missedAtUtc: input.missedAtUtc, scheduleVersion: row.scheduleVersion,
    fromVersion: row.version, toVersion: updated.version,
  }, db);
  return receipt(updated);
}

const commandContext = (req: any): CommandContext => ({
  tenantId: req.user.tenantId,
  actorId: req.user.userId,
  actorRole: ActorRoleSchema.parse(req.user.role),
  channel: 'web',
  requestId: req.id,
  assertionMode: 'user_asserted',
});

const canWrite = (req: any, reply: any): boolean => {
  if (req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'member') return true;
  reply.code(403).send({ error: '权限不足' });
  return false;
};

const readIdempotencyKey = (req: any, reply: any): string | undefined => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    return undefined;
  }
  return value;
};

const sendError = (req: any, reply: any, error: unknown) => {
  if (error instanceof ScopedNotFoundError) return reply.code(404).send({ error: '跟进承诺或关联对象不存在' });
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; message?: unknown }
    : {};
  if (typeof known.statusCode === 'number') {
    return reply.code(known.statusCode).send({
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
      error: typeof known.message === 'string' ? known.message : '跟进承诺命令失败',
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '跟进承诺命令失败' });
};

export function commitmentRoutes(app: FastifyInstance): void {
  app.post('/api/commands/commitment', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!canWrite(req, reply)) return;
    if (process.env.COMMITMENT_COMMANDS_ENABLED === '0') {
      return reply.code(503).send({ code: 'commitment_commands_disabled', error: '跟进承诺命令暂未启用' });
    }
    const key = readIdempotencyKey(req, reply);
    if (!key) return;
    const parsed = CommitmentCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '跟进承诺参数无效' });
    const input = parsed.data as CommitmentCommand;
    const ctx = commandContext(req);
    try {
      const result = await runCommand<CommitmentCommandReceipt>(
        ctx,
        { kind: 'commitment', idempotencyKey: key, payload: input },
        (tx) => executeCommitmentCommand(ctx, input, tx),
        prisma,
      );
      if (!result.replayed) {
        void syncCommitmentToWeCom(ctx.tenantId, result.result.commitmentId).catch(() => {});
      }
      return { ...result.result, replayed: result.replayed };
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
