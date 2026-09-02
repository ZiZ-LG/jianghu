import type { FastifyInstance } from 'fastify';
import {
  ActorRoleSchema,
  RelationshipWorkspaceQuerySchema,
  ReviewHypothesisVerificationCommandSchema,
  ReviewHypothesisVerificationReceiptSchema,
  type CapabilityPolicy,
  type CommandContext,
  type ReviewHypothesisVerificationReceipt,
} from '@jianghu/domain-contracts';
import { runCommand } from '../mutation/commandRunner.js';
import { prisma } from '../prisma.js';
import {
  assertHypothesisVerificationReviewAccess,
  executeHypothesisVerificationReview,
  relationshipWorkspace,
  RelationshipWorkspaceError,
} from './service.js';

const serializable = {
  isolationLevel: 'Serializable' as const,
  maxWait: 5_000,
  timeout: 30_000,
};

function context(req: any): CommandContext {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
    channel: 'web',
    requestId: req.id,
    assertionMode: 'user_asserted',
  };
}

function idempotencyKey(req: any, reply: any): string | undefined {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string'
    || value.length < 8
    || value.length > 200
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key', code: 'idempotency_key_invalid' });
    return undefined;
  }
  return value;
}

function sendError(req: any, reply: any, error: unknown) {
  if (error instanceof RelationshipWorkspaceError) {
    return reply.code(error.statusCode).send({
      error: error.scopedNotFound ? '资源不存在' : '请求未完成',
      code: error.scopedNotFound ? 'relationship_workspace_not_found' : error.code,
    });
  }
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; scopedNotFound?: unknown }
    : {};
  if (known.scopedNotFound === true) {
    return reply.code(404).send({ error: '资源不存在', code: 'relationship_workspace_not_found' });
  }
  if (typeof known.statusCode === 'number') {
    return reply.code(known.statusCode).send({
      error: '请求未完成',
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '请求未完成', code: 'relationship_workspace_failed' });
}

export function relationshipWorkspaceRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.get('/api/relationship-workspace', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const query = RelationshipWorkspaceQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        error: '关系工作台查询参数无效',
        code: 'relationship_workspace_query_invalid',
      });
    }
    try {
      return await prisma.$transaction(
        (tx) => relationshipWorkspace(tx, context(req), policy, query.data),
        serializable,
      );
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.post('/api/commands/hypothesis-verification-review', {
    preHandler: [app.authenticate],
  }, async (req: any, reply) => {
    const key = idempotencyKey(req, reply);
    if (!key) return;
    const parsed = ReviewHypothesisVerificationCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: '假设验证复核参数无效',
        code: 'hypothesis_verification_review_invalid',
      });
    }
    const ctx = context(req);
    try {
      await prisma.$transaction(
        (tx) => assertHypothesisVerificationReviewAccess(tx, ctx, policy, parsed.data),
        serializable,
      );
      const command = await runCommand<Omit<ReviewHypothesisVerificationReceipt, 'replayed'>>(
        ctx,
        {
          kind: 'hypothesis-verification-review',
          idempotencyKey: key,
          payload: parsed.data,
          authorizeReplay: (tx) => assertHypothesisVerificationReviewAccess(
            tx, ctx, policy, parsed.data,
          ),
        },
        (tx) => executeHypothesisVerificationReview(tx, ctx, policy, parsed.data),
        prisma,
      );
      return ReviewHypothesisVerificationReceiptSchema.parse({
        ...command.result,
        replayed: command.replayed,
      });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
