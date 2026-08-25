import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import { runPostCommitEffect } from '../mutate.js';
import {
  acceptReviewBatch,
  ReviewBatchConflictError,
} from './acceptance.js';
import {
  assertReviewBatchCreateReplayAccess,
  assertReviewBatchReplayAccess,
  createReviewBatch,
  readableReviewBatchById,
  readableReviewBatches,
  ReviewBatchError,
} from './service.js';

const id = z.string().trim().min(1).max(200);
const expectedVersion = z.number().int().min(0);
const expectedAclVersion = z.number().int().min(1);
const paramsSchema = z.object({ id }).strict();
const listSchema = z.object({
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const createSchema = z.object({
  sourceArtifactId: id,
  expectedSourceAclVersion: expectedAclVersion,
  candidates: z.array(z.object({
    id,
    expectedVersion,
    expectedAclVersion,
  }).strict()).min(1).max(100),
}).strict();
const decisionSchema = z.object({
  candidateId: id,
  expectedVersion,
  expectedAclVersion,
  decision: z.enum(['accept', 'reject']),
  person: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().max(200).optional(),
  }).strict().optional(),
  relation: z.object({
    layer: z.enum(['L1', 'L2', 'L3', 'L4']).optional(),
    label: z.string().trim().max(200).optional(),
  }).strict().optional(),
  newValue: z.string().max(20_000).optional(),
  evidence: z.object({
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
    tier: z.enum(['weak', 'mid', 'strong']).optional(),
  }).strict().optional(),
}).strict();
const acceptSchema = z.object({
  expectedVersion,
  expectedAcceptanceVersion: expectedVersion,
  accountId: id,
  matterId: id.nullable(),
  activityKind: z.string().trim().min(1).max(80),
  occurredAt: z.string().datetime({ offset: true }),
  existingInteractionId: id.nullable().optional(),
  decisions: z.array(decisionSchema).min(1).max(100),
}).strict();

function context(req: any): CommandContext & { actorRole: 'owner' | 'admin' | 'member' | 'viewer' } {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
    channel: 'web',
    requestId: req.id,
    assertionMode: 'user_asserted',
  };
}

function idempotencyKey(req: any): string | null {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= 8 && normalized.length <= 200 ? normalized : null;
}

function mutationPreflight(req: any, reply: any): string | null {
  if (req.user.role === 'viewer') {
    reply.code(403).send({ error: '只读成员不可操作', code: 'viewer_write_denied' });
    return null;
  }
  const key = idempotencyKey(req);
  if (!key) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key', code: 'idempotency_key_required' });
    return null;
  }
  return key;
}

function mutationFailure(reply: any, error: unknown) {
  if (error instanceof ReviewBatchConflictError) {
    return reply.code(409).send({ error: error.message, code: error.code, items: error.items });
  }
  if (error instanceof ReviewBatchError) {
    return reply.code(error.statusCode).send({
      error: error.statusCode === 404 ? '会后速审批次不存在' : '会后速审操作失败',
      code: error.code,
    });
  }
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof error.statusCode === 'number') {
    return reply.code(error.statusCode).send({
      error: error instanceof Error ? error.message : '命令执行失败',
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    });
  }
  throw error;
}

export function reviewBatchRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.get('/api/review-batches', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const query = listSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: '会后速审查询参数无效' });
    return prisma.$transaction((tx) => readableReviewBatches(tx, context(req), policy, query.data), {
      isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000,
    });
  });

  app.get('/api/review-batches/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: '会后速审参数无效' });
    const readable = await prisma.$transaction(
      (tx) => readableReviewBatchById(tx, context(req), policy, params.data.id),
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
    );
    return readable?.view ?? reply.code(404).send({
      error: '会后速审批次不存在', code: 'review_batch_not_found',
    });
  });

  app.post('/api/review-batches', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '会后速审创建参数无效' });
    try {
      const command = await runCommand(context(req), {
        kind: 'review-batch-create', idempotencyKey: key, payload: body.data,
        authorizeReplay: (tx) => assertReviewBatchCreateReplayAccess(
          tx, context(req), policy, body.data,
        ),
      }, (tx) => createReviewBatch(tx, context(req), policy, body.data));
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });

  app.post('/api/review-batches/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const params = paramsSchema.safeParse(req.params);
    const body = acceptSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '会后速审采纳参数无效' });
    }
    const payload = { id: params.data.id, ...body.data };
    try {
      const command = await runCommand(context(req), {
        kind: `review-batch-accept:${params.data.id}:${body.data.expectedAcceptanceVersion}`,
        idempotencyKey: key,
        payload,
        authorizeReplay: (tx) => assertReviewBatchReplayAccess(
          tx, context(req), policy, params.data.id,
        ),
      }, (tx) => acceptReviewBatch(tx, context(req), policy, params.data.id, {
        ...body.data,
        occurredAt: new Date(body.data.occurredAt),
      }));
      const { effects, ...result } = command.result;
      if (!command.replayed && !result.businessReplayed) {
        for (const effect of effects) await runPostCommitEffect(effect);
      }
      return { ...result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });
}
