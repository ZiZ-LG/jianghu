import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ActorRoleSchema,
  QuickCaptureCommandReceiptSchema,
  QuickCaptureCommandSchema,
  capabilityPolicyAllows,
  capabilityRequirementForActionType,
  type CapabilityPolicy,
  type CommandContext,
  type ProductAccess,
  type QuickCaptureCommand,
  type QuickCaptureCommandReceipt,
} from '@jianghu/domain-contracts';
import { denyViewer } from '../scope.js';
import { applyAction, type DbClient } from '../mutate.js';
import { CloneOpportunitySchema, cloneOpportunityInTransaction } from '../opp.js';
import { acceptProposalInTransaction, rejectProposalInTransaction } from '../proposals.js';
import { acceptRelationSuggestionInTransaction, materializePerson } from '../suggest.js';
import { createPdeSnapshot } from '../pde/routes.js';
import { businessYmd } from '../businessDate.js';
import { ScopedNotFoundError } from './scopeGuards.js';
import { runCommand } from './commandRunner.js';
import { syncCommitmentToWeCom } from '../wecom.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import { executeCustomerCommand } from './customers.js';
import { executeCommitmentCommand } from './commitments.js';

class ActionAlreadyCompletedError extends Error {
  readonly statusCode = 409;
  readonly code = 'action_already_completed';
  constructor() { super('该行动已完成，请刷新后查看'); }
}

class ActionFeedbackVersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'commitment_version_conflict';
  constructor() { super('跟进承诺已变化，请刷新后重试'); }
}

class ActionFeedbackPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'commitment_write_forbidden';
  constructor() { super('无权回填跟进承诺'); }
}

class CapabilityDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = 'capability_denied';
  constructor() { super('能力未启用'); }
}

class QuickCapturePermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'quick_capture_scope_forbidden';
  constructor() { super('快速记录必须由当前用户负责客户和下一步'); }
}

const requireActionCapability = (policyInput: unknown, actionType: unknown): void => {
  const requirement = capabilityRequirementForActionType(actionType);
  if (!requirement || !capabilityPolicyAllows(policyInput, requirement)) throw new CapabilityDeniedError();
};

const requireCoreCapability = (policyInput: unknown): void => {
  if (!capabilityPolicyAllows(policyInput, { entitlement: 'crm.core' })) throw new CapabilityDeniedError();
};

const SkeletonRoleSchema = z.object({
  title: z.string().min(1).max(80),
  role: z.enum(['A', 'D', 'U', 'R', 'C']),
  orgLevel: z.number().int().min(1).max(4),
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

export const OpportunitySkeletonCommandSchema = CloneOpportunitySchema.extend({
  skeleton: z.array(SkeletonRoleSchema).max(50).default([]),
}).strict();

export const ActionFeedbackCommandSchema = z.object({
  accountId: z.string().min(1),
  opportunityId: z.string().min(1).nullable(),
  actionId: z.string().min(1),
  outcome: z.enum(['up', 'flat', 'down']),
  occurredAt: z.string().min(1),
  baseVersion: z.number().int().nonnegative().default(0),
  expectedScheduleVersion: z.number().int().nonnegative().default(0),
}).strict();

type ActionFeedbackInput = z.input<typeof ActionFeedbackCommandSchema>;

const InboxBatchItemSchema = z.object({
  kind: z.enum(['proposal', 'person', 'rel', 'evidence', 'reminder']),
  id: z.string().min(1),
  decision: z.enum(['accept', 'reject']),
  overrideValue: z.string().optional(),
  personOverride: z.object({ name: z.string().trim().min(1).max(40).optional(), title: z.string().trim().max(60).optional() }).optional(),
  relOverride: z.object({ layer: z.enum(['L1', 'L2', 'L3', 'L4']).optional(), label: z.string().trim().min(1).max(30).optional() }).optional(),
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
}).strict();
export const InboxBatchCommandSchema = z.object({ items: z.array(InboxBatchItemSchema).min(1).max(100) }).strict();

type FaultOptions = { failAfterStep?: number };
const fault = (options: FaultOptions | undefined, step: number) => {
  if (options?.failAfterStep === step) throw new Error(`injected failure after step ${step}`);
};

export async function executeOpportunitySkeleton(
  ctx: CommandContext,
  input: z.infer<typeof OpportunitySkeletonCommandSchema>,
  db: DbClient,
  policyInput: unknown,
  options?: FaultOptions,
): Promise<{ opportunityId: string; memberCount: number; skeletonPersonIds: string[] }> {
  requireActionCapability(policyInput, 'ADD_OPP');
  const cloned = await cloneOpportunityInTransaction(ctx, input, db);
  fault(options, 1);
  const skeletonPersonIds: string[] = [];
  for (const role of input.skeleton) {
    requireActionCapability(policyInput, 'ADD_PERSON');
    const personId = 'p_' + randomUUID().replaceAll('-', '');
    await applyAction(ctx, {
      type: 'ADD_PERSON', accId: input.accountId,
      person: { id: personId, name: role.title, title: role.title, orgLevel: role.orgLevel, x: role.x, y: role.y },
    }, db);
    skeletonPersonIds.push(personId);
    fault(options, 2);
    requireActionCapability(policyInput, 'ADD_OPP_MEMBER');
    await applyAction(ctx, { type: 'ADD_OPP_MEMBER', accId: input.accountId, oppId: cloned.opportunityId, personId }, db);
    requireActionCapability(policyInput, 'SET_ROLE');
    await applyAction(ctx, {
      type: 'SET_ROLE', accId: input.accountId, oppId: cloned.opportunityId, personId,
      patch: { role: role.role, sentiment: 'unknown', confidence: '不清' },
    }, db);
    fault(options, 3);
  }
  return { ...cloned, skeletonPersonIds };
}

export async function executeActionFeedback(
  ctx: CommandContext,
  rawInput: ActionFeedbackInput,
  db: DbClient,
  policyInput: unknown,
  options?: FaultOptions,
): Promise<{ evidenceId?: string }> {
  requireActionCapability(policyInput, 'ADD_EVIDENCE');
  const input = ActionFeedbackCommandSchema.parse(rawInput);
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const actorRole = ActorRoleSchema.safeParse(actor?.role);
  if (!actorRole.success || actorRole.data === 'viewer') throw new ActionFeedbackPermissionError();
  const actorLock = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: actorRole.data },
    data: { role: actorRole.data },
  });
  if (actorLock.count !== 1) throw new ActionFeedbackPermissionError();
  const plan = await db.planAction.findFirst({
    where: { id: input.actionId, tenantId: ctx.tenantId, accountId: input.accountId, opportunityId: input.opportunityId },
  });
  if (!plan) throw new ScopedNotFoundError();
  const account = await db.account.findFirst({
    where: { id: input.accountId, tenantId: ctx.tenantId, archivedAt: null },
    select: { name: true },
  });
  if (!account) throw new ScopedNotFoundError();
  const accountLock = await db.account.updateMany({
    where: { id: input.accountId, tenantId: ctx.tenantId, archivedAt: null, name: account.name },
    data: { name: account.name },
  });
  if (accountLock.count !== 1) throw new ScopedNotFoundError();
  if (input.opportunityId) {
    const matterLock = await db.opportunity.updateMany({
      where: {
        id: input.opportunityId, tenantId: ctx.tenantId, accountId: input.accountId, archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      data: { version: { increment: 0 } },
    });
    if (matterLock.count !== 1) throw new ScopedNotFoundError();
  }
  if (plan.personId) {
    const personLock = await db.person.updateMany({
      where: {
        id: plan.personId, tenantId: ctx.tenantId, accountId: input.accountId,
        archivedAt: null, mergedIntoPersonId: null,
      },
      data: { version: { increment: 0 } },
    });
    if (personLock.count !== 1) throw new ScopedNotFoundError();
  }
  if (plan.version !== input.baseVersion || plan.scheduleVersion !== input.expectedScheduleVersion) {
    throw new ActionFeedbackVersionConflictError();
  }
  const claimed = await db.planAction.updateMany({
    where: {
      id: input.actionId, tenantId: ctx.tenantId, accountId: input.accountId,
      opportunityId: input.opportunityId, done: false, executionStatus: 'planned',
      version: input.baseVersion, scheduleVersion: input.expectedScheduleVersion,
    },
    data: {
      done: true,
      doneAt: input.occurredAt,
      executionStatus: 'completed',
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) {
    const current = await db.planAction.findFirst({
      where: { id: input.actionId, tenantId: ctx.tenantId, accountId: input.accountId, opportunityId: input.opportunityId },
      select: { version: true, scheduleVersion: true, executionStatus: true, done: true },
    });
    if (!current) throw new ScopedNotFoundError();
    if (current.version !== input.baseVersion || current.scheduleVersion !== input.expectedScheduleVersion) {
      throw new ActionFeedbackVersionConflictError();
    }
    throw new ActionAlreadyCompletedError();
  }
  fault(options, 1);
  let evidenceId: string | undefined;
  if (plan.personId && input.opportunityId && input.outcome !== 'flat') {
    evidenceId = 'ev_action_' + createHash('sha256')
      .update(`${ctx.tenantId}:${input.opportunityId}:${input.actionId}`)
      .digest('hex').slice(0, 16);
    await applyAction(ctx, {
      type: 'ADD_EVIDENCE', accId: input.accountId, oppId: input.opportunityId,
      evidence: {
        id: evidenceId, personId: plan.personId,
        signalKey: input.outcome === 'up' ? 'positive_interaction' : 'negative_interaction',
        direction: input.outcome === 'up' ? 1 : -1, tier: 'mid',
        rawContent: `行动结果回填：${plan.title || '行动'}`, occurredAt: input.occurredAt,
        origin: 'manual', status: 'approved',
      },
    }, db);
    fault(options, 2);
  }
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'action_feedback',
    entityKind: 'commitment',
    entityId: input.actionId,
    requestId: ctx.requestId ?? null,
    sourceRef: evidenceId ?? null,
    changedFields: JSON.stringify(evidenceId
      ? ['executionStatus', 'version', 'done', 'doneAt', 'evidenceId']
      : ['executionStatus', 'version', 'done', 'doneAt']),
    metadata: JSON.stringify({
      fromVersion: input.baseVersion,
      toVersion: input.baseVersion + 1,
      scheduleVersion: input.expectedScheduleVersion,
      ...(evidenceId ? { evidenceId } : {}),
    }),
  } });
  fault(options, 3);
  return evidenceId ? { evidenceId } : {};
}

export async function executeInboxBatch(
  ctx: CommandContext,
  input: z.infer<typeof InboxBatchCommandSchema>,
  db: DbClient,
  options?: FaultOptions,
): Promise<{ items: Array<{ kind: string; id: string; status: string }> }> {
  const items: Array<{ kind: string; id: string; status: string }> = [];
  let step = 0;
  for (const item of input.items) {
    let status = 'ok';
    if (item.kind === 'proposal') {
      if (item.decision === 'accept') {
        const outcome = await acceptProposalInTransaction(ctx, item.id, item.overrideValue, db as any);
        status = outcome.result;
      } else status = await rejectProposalInTransaction(ctx.tenantId, item.id, db as any);
    } else if (item.kind === 'person') {
      if (item.decision === 'accept') {
        await materializePerson(db, ctx.tenantId, item.id, { override: item.personOverride, allowAcceptedReuse: false });
      } else {
        const changed = await db.personSuggestion.updateMany({ where: { id: item.id, tenantId: ctx.tenantId, status: 'pending' }, data: { status: 'rejected' } });
        if (!changed.count) throw new Error('候选干系人不存在或已处理');
      }
    } else if (item.kind === 'rel') {
      if (item.decision === 'reject') {
        const changed = await db.relSuggestion.updateMany({ where: { id: item.id, tenantId: ctx.tenantId, status: 'pending' }, data: { status: 'rejected' } });
        if (!changed.count) throw new Error('候选关系不存在或已处理');
      } else {
        await acceptRelationSuggestionInTransaction(db as any, ctx.tenantId, item.id, item.relOverride);
      }
    } else if (item.kind === 'evidence') {
      const today = businessYmd();
      const evidence = await db.evidenceEvent.findFirst({ where: { id: item.id, tenantId: ctx.tenantId, status: 'pending_review' } });
      if (!evidence) throw new Error('证据不存在或已处理');
      const changed = await db.evidenceEvent.updateMany({ where: { id: item.id, tenantId: ctx.tenantId, status: 'pending_review' }, data: {
        status: item.decision === 'accept' ? 'approved' : 'rejected', reviewedBy: ctx.actorId, reviewedAt: today,
        ...(item.decision === 'accept' && item.direction !== undefined ? { direction: item.direction } : {}),
      } });
      if (!changed.count) throw new Error('证据不存在或已处理');
      if (item.decision === 'accept') await createPdeSnapshot(db, ctx.tenantId, evidence.opportunityId, 'evidence_review', ctx.actorId);
    } else {
      if (item.decision !== 'reject') throw new Error('提醒只能忽略');
      const changed = await db.reminder.updateMany({ where: { id: item.id, tenantId: ctx.tenantId, status: 'pending' }, data: { status: 'dismissed' } });
      if (!changed.count) throw new Error('提醒不存在或已处理');
      status = 'dismissed';
    }
    items.push({ kind: item.kind, id: item.id, status });
    step += 1;
    fault(options, step);
  }
  return { items };
}

export async function executeQuickCapture(
  ctx: CommandContext,
  rawInput: QuickCaptureCommand,
  db: Prisma.TransactionClient,
  policy: CapabilityPolicy,
): Promise<QuickCaptureCommandReceipt> {
  requireCoreCapability(policy);
  const input = QuickCaptureCommandSchema.parse(rawInput);
  const commitmentInput = input.commitment.commitment;
  let customer: QuickCaptureCommandReceipt['customer'] = null;

  if (commitmentInput.ownerUserId !== ctx.actorId) throw new QuickCapturePermissionError();

  if (input.customer.mode === 'create') {
    if (input.customer.command.customer.primaryOwnerUserId !== ctx.actorId) {
      throw new QuickCapturePermissionError();
    }
    customer = await executeCustomerCommand(ctx, input.customer.command, db, policy);
  } else {
    const scope = await resolveEffectiveResourceScope(db, {
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      role: ctx.actorRole,
    });
    if (!scope.canReadAccountContainer(input.customer.customerId)) throw new ScopedNotFoundError();
    if (commitmentInput.matterId === null) {
      if (!scope.canReadAccountData(input.customer.customerId)) throw new ScopedNotFoundError();
    } else if (!scope.canReadMatter(commitmentInput.matterId)) {
      throw new ScopedNotFoundError();
    }
    if (commitmentInput.personId !== null && !scope.canReadAccountData(input.customer.customerId)) {
      throw new ScopedNotFoundError();
    }
  }

  const commitmentReceipt = await executeCommitmentCommand(ctx, input.commitment, db);
  return QuickCaptureCommandReceiptSchema.parse({ customer, commitment: commitmentReceipt });
}

const idempotencyKey = (req: any, reply: any): string | undefined => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    return undefined;
  }
  return value;
};

const commandContext = (req: any): CommandContext => ({
  tenantId: req.user.tenantId,
  actorId: req.user.userId,
  actorRole: ActorRoleSchema.parse(req.user.role),
  channel: 'web',
  requestId: req.id,
  assertionMode: 'user_asserted',
});

const commandFailure = (req: any, reply: any, error: any, message: string) => {
  if (error instanceof ScopedNotFoundError || error?.scopedNotFound) return reply.code(404).send({ error: '资源不存在' });
  if (error?.statusCode === 403) return reply.code(403).send({ code: error.code, error: error.message });
  if (error?.statusCode === 409 || error?.commandInProgress) return reply.code(409).send({ code: error.code, error: error.message });
  if (error?.statusCode === 503) return reply.code(503).send({ code: error.code, error: error.message });
  req.log.error({ err: error, requestId: req.id }, `${message}: unexpected command failure`);
  return reply.code(500).send({ error: message });
};

export function compoundCommandRoutes(app: FastifyInstance, product: ProductAccess): void {
  app.post('/api/commands/quick-capture', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const key = idempotencyKey(req, reply); if (!key) return;
    const body = QuickCaptureCommandSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '快速记录参数无效' });
    if (process.env.COMMITMENT_COMMANDS_ENABLED === '0') {
      return reply.code(503).send({ code: 'commitment_commands_disabled', error: '跟进承诺命令暂未启用' });
    }
    if (body.data.customer.mode === 'create' && process.env.CUSTOMER_COMMANDS_ENABLED === '0') {
      return reply.code(503).send({ code: 'customer_commands_disabled', error: '客户命令暂未启用' });
    }
    const ctx = commandContext(req);
    try {
      const result = await runCommand<QuickCaptureCommandReceipt>(
        ctx,
        { kind: 'quick-capture', idempotencyKey: key, payload: body.data },
        (tx) => executeQuickCapture(ctx, body.data, tx, product.policy),
      );
      if (!result.replayed) {
        void syncCommitmentToWeCom(ctx.tenantId, result.result.commitment.commitmentId).catch(() => {});
      }
      return { ...result.result, replayed: result.replayed };
    } catch (error) { return commandFailure(req, reply, error, '快速记录失败'); }
  });

  app.post('/api/commands/opportunity-skeleton', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const key = idempotencyKey(req, reply); if (!key) return;
    const body = OpportunitySkeletonCommandSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '商机骨架参数无效' });
    try {
      const result = await runCommand(commandContext(req), { kind: 'opportunity-skeleton', idempotencyKey: key, payload: body.data },
        (tx) => executeOpportunitySkeleton(commandContext(req), body.data, tx, product.policy));
      return { ...result.result, replayed: result.replayed };
    } catch (error) { return commandFailure(req, reply, error, '商机创建失败'); }
  });

  app.post('/api/commands/action-feedback', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const key = idempotencyKey(req, reply); if (!key) return;
    const body = ActionFeedbackCommandSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '行动回填参数无效' });
    try {
      const result = await runCommand(commandContext(req), { kind: 'action-feedback', idempotencyKey: key, payload: body.data },
        (tx) => executeActionFeedback(commandContext(req), body.data, tx, product.policy));
      if (!result.replayed) {
        void syncCommitmentToWeCom(req.user.tenantId, body.data.actionId).catch(() => {});
      }
      return { ...result.result, replayed: result.replayed };
    } catch (error) { return commandFailure(req, reply, error, '行动回填失败'); }
  });

  app.post('/api/commands/inbox-batch', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const key = idempotencyKey(req, reply); if (!key) return;
    const body = InboxBatchCommandSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '批量审核参数无效' });
    try {
      const result = await runCommand(commandContext(req), { kind: 'inbox-batch', idempotencyKey: key, payload: body.data },
        (tx) => executeInboxBatch(commandContext(req), body.data, tx));
      return { items: result.result.items, replayed: result.replayed };
    } catch (error) { return commandFailure(req, reply, error, '批量审核失败'); }
  });
}
