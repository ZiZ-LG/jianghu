import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  PostMeetingReviewReceiptSchema,
  PostMeetingReviewRequestSchema,
  type CapabilityPolicy,
  type CommandContext,
  type PostMeetingReviewRequest,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import { runPostCommitEffect } from '../mutate.js';
import {
  acceptReviewBatch,
  ReviewBatchConflictError,
  type AcceptReviewBatchInput,
} from './acceptance.js';
import {
  assertReviewBatchCreateReplayAccess,
  assertReviewBatchReplayAccess,
  createReviewBatch,
  readableReviewBatches,
  ReviewBatchError,
} from './service.js';
import { readableReviewBatchTransport } from '../postMeeting/review.js';

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

function postMeetingAcceptanceInput(input: PostMeetingReviewRequest): AcceptReviewBatchInput {
  return {
    expectedVersion: input.expectedVersion,
    expectedAcceptanceVersion: input.expectedAcceptanceVersion,
    accountId: input.customerId,
    matterId: input.matterId,
    activityKind: input.activityKind,
    occurredAt: new Date(input.occurredAt),
    existingInteractionId: input.existingInteractionId,
    decisions: input.decisions.map((decision) => {
      const common = {
        candidateId: decision.candidateId,
        expectedVersion: decision.expectedVersion,
        expectedAclVersion: decision.expectedAclVersion,
        decision: decision.decision,
      };
      if (decision.kind === 'person') {
        return {
          ...common,
          kind: 'person' as const,
          person: decision.edit ? {
            ...(decision.edit.name !== undefined ? { name: decision.edit.name } : {}),
            ...(decision.edit.title !== undefined ? { title: decision.edit.title ?? '' } : {}),
          } : undefined,
        };
      }
      if (decision.kind === 'relation') {
        return {
          ...common,
          kind: 'relation' as const,
          relation: decision.edit ? {
            ...(decision.edit.layer !== undefined ? { layer: decision.edit.layer } : {}),
            ...(decision.edit.label !== undefined ? { label: decision.edit.label ?? '' } : {}),
          } : undefined,
        };
      }
      if (decision.kind === 'field') {
        return {
          ...common,
          kind: 'field' as const,
          ...(decision.edit ? { newValue: JSON.stringify(decision.edit.value) } : {}),
        };
      }
      if (decision.kind === 'evidence') {
        return { ...common, kind: 'evidence' as const, evidence: decision.edit };
      }
      return {
        ...common,
        kind: 'commitment' as const,
        commitmentCommand: decision.edit?.command,
      };
    }),
  };
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
      (tx) => readableReviewBatchTransport(tx, context(req), policy, params.data.id),
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
    const postMeetingBody = PostMeetingReviewRequestSchema.safeParse(req.body);
    const legacyBody = acceptSchema.safeParse(req.body);
    if (!params.success || (!postMeetingBody.success && !legacyBody.success)) {
      return reply.code(400).send({ error: '会后速审采纳参数无效' });
    }
    const isPostMeetingRequest = postMeetingBody.success;
    let commandInput: AcceptReviewBatchInput;
    let commandPayload: unknown;
    if (postMeetingBody.success) {
      commandInput = postMeetingAcceptanceInput(postMeetingBody.data);
      commandPayload = {
        id: params.data.id,
        transport: 'post_meeting_review_v1',
        ...postMeetingBody.data,
      };
    } else {
      if (!legacyBody.success) {
        return reply.code(400).send({ error: '会后速审采纳参数无效' });
      }
      commandInput = {
        ...legacyBody.data,
        occurredAt: new Date(legacyBody.data.occurredAt),
      };
      commandPayload = { id: params.data.id, ...legacyBody.data };
    }
    try {
      const command = await runCommand(context(req), {
        kind: `review-batch-accept:${params.data.id}:${commandInput.expectedAcceptanceVersion}`,
        idempotencyKey: key,
        payload: commandPayload,
        authorizeReplay: (tx) => assertReviewBatchReplayAccess(
          tx, context(req), policy, params.data.id,
        ),
      }, (tx) => acceptReviewBatch(tx, context(req), policy, params.data.id, commandInput));
      const { effects, ...result } = command.result;
      if (!command.replayed && !result.businessReplayed) {
        for (const effect of effects) await runPostCommitEffect(effect);
      }
      const response = { ...result, replayed: command.replayed };
      return isPostMeetingRequest ? PostMeetingReviewReceiptSchema.parse(response) : response;
    } catch (error) {
      if (isPostMeetingRequest && error instanceof ReviewBatchConflictError) {
        return reply.code(409).send({ code: error.code, items: error.items });
      }
      return mutationFailure(reply, error);
    }
  });
}
