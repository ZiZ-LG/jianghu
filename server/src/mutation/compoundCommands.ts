import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { denyViewer } from '../scope.js';
import { applyAction, type DbClient } from '../mutate.js';
import { CloneOpportunitySchema, cloneOpportunityInTransaction } from '../opp.js';
import { acceptProposalInTransaction, rejectProposalInTransaction } from '../proposals.js';
import { acceptRelationSuggestionInTransaction, materializePerson } from '../suggest.js';
import { createPdeSnapshot } from '../pde/routes.js';
import { businessYmd } from '../businessDate.js';
import { ScopedNotFoundError } from './scopeGuards.js';
import { runCommand } from './commandRunner.js';

class ActionAlreadyCompletedError extends Error {
  readonly statusCode = 409;
  readonly code = 'action_already_completed';
  constructor() { super('该行动已完成，请刷新后查看'); }
}

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
  opportunityId: z.string().min(1),
  actionId: z.string().min(1),
  outcome: z.enum(['up', 'flat', 'down']),
  occurredAt: z.string().min(1),
}).strict();

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
  options?: FaultOptions,
): Promise<{ opportunityId: string; memberCount: number; skeletonPersonIds: string[] }> {
  const cloned = await cloneOpportunityInTransaction(ctx, input, db);
  fault(options, 1);
  const skeletonPersonIds: string[] = [];
  for (const role of input.skeleton) {
    const personId = 'p_' + randomUUID().slice(0, 12);
    await applyAction(ctx, {
      type: 'ADD_PERSON', accId: input.accountId,
      person: { id: personId, name: role.title, title: role.title, orgLevel: role.orgLevel, x: role.x, y: role.y },
    }, db);
    skeletonPersonIds.push(personId);
    fault(options, 2);
    await applyAction(ctx, { type: 'ADD_OPP_MEMBER', accId: input.accountId, oppId: cloned.opportunityId, personId }, db);
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
  input: z.infer<typeof ActionFeedbackCommandSchema>,
  db: DbClient,
  options?: FaultOptions,
): Promise<{ evidenceId?: string }> {
  const plan = await db.planAction.findFirst({
    where: { id: input.actionId, tenantId: ctx.tenantId, accountId: input.accountId, opportunityId: input.opportunityId },
  });
  if (!plan) throw new ScopedNotFoundError();
  const claimed = await db.planAction.updateMany({
    where: {
      id: input.actionId, tenantId: ctx.tenantId, accountId: input.accountId,
      opportunityId: input.opportunityId, done: false,
    },
    data: { done: true, doneAt: input.occurredAt },
  });
  if (claimed.count !== 1) throw new ActionAlreadyCompletedError();
  fault(options, 1);
  let evidenceId: string | undefined;
  if (plan.personId && input.outcome !== 'flat') {
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
    entityKind: 'plan_action',
    entityId: input.actionId,
    requestId: ctx.requestId ?? null,
    sourceRef: evidenceId ?? null,
    changedFields: JSON.stringify(evidenceId ? ['done', 'doneAt', 'evidenceId'] : ['done', 'doneAt']),
    metadata: JSON.stringify(evidenceId ? { evidenceId } : {}),
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
        if (outcome.effect?.type === 'opportunity_stage_changed') {
          await createPdeSnapshot(db, ctx.tenantId, outcome.effect.opportunityId, 'stage_gate', ctx.actorId);
        }
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

const commandFailure = (reply: any, error: any, message: string) => {
  if (error instanceof ScopedNotFoundError || error?.scopedNotFound) return reply.code(404).send({ error: '资源不存在' });
  if (error?.statusCode === 409 || error?.commandInProgress) return reply.code(409).send({ code: error.code, error: error.message });
  if (error?.statusCode === 503) return reply.code(503).send({ code: error.code, error: error.message });
  return reply.code(500).send({ error: message });
};

export function compoundCommandRoutes(app: FastifyInstance): void {
  app.post('/api/commands/opportunity-skeleton', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const key = idempotencyKey(req, reply); if (!key) return;
    const body = OpportunitySkeletonCommandSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '商机骨架参数无效' });
    try {
      const result = await runCommand(commandContext(req), { kind: 'opportunity-skeleton', idempotencyKey: key, payload: body.data },
        (tx) => executeOpportunitySkeleton(commandContext(req), body.data, tx));
      return { ...result.result, replayed: result.replayed };
    } catch (error) { return commandFailure(reply, error, '商机创建失败'); }
  });

  app.post('/api/commands/action-feedback', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const key = idempotencyKey(req, reply); if (!key) return;
    const body = ActionFeedbackCommandSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '行动回填参数无效' });
    try {
      const result = await runCommand(commandContext(req), { kind: 'action-feedback', idempotencyKey: key, payload: body.data },
        (tx) => executeActionFeedback(commandContext(req), body.data, tx));
      return { ...result.result, replayed: result.replayed };
    } catch (error) { return commandFailure(reply, error, '行动回填失败'); }
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
    } catch (error) { return commandFailure(reply, error, '批量审核失败'); }
  });
}
