import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  SalesHypothesisCommandReceiptSchema,
  SalesHypothesisCommandSchema,
  SalesHypothesisDetailQuerySchema,
  SalesHypothesisListQuerySchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import {
  assertSalesHypothesisCommandAccess,
  executeSalesHypothesisCommand,
  listSalesHypotheses,
  salesHypothesisDetail,
  SalesHypothesisError,
  salesHypothesisStatusSuggestion,
} from './service.js';

const visibleId = z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const paramsSchema = z.object({ id: visibleId }).strict();
const emptyQuerySchema = z.object({}).strict();
const booleanQuery = z.enum(['true', 'false']).optional();
const listQueryTransportSchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
  personId: visibleId.optional(),
  ownerUserId: visibleId.optional(),
  status: z.enum(['untested', 'testing', 'supported', 'contradicted', 'retired']).optional(),
  includeRetired: booleanQuery,
  cursor: visibleId.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();
const detailQueryTransportSchema = z.object({
  beforeRevisionNumber: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
}).strict();

const serializable = {
  isolationLevel: 'Serializable' as const,
  maxWait: 5_000,
  timeout: 30_000,
};

function commandContext(req: any): CommandContext {
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
  if (error instanceof SalesHypothesisError) {
    if (error.scopedNotFound || error.statusCode === 404) {
      return reply.code(404).send({ error: '资源不存在', code: 'sales_hypothesis_not_found' });
    }
    return reply.code(error.statusCode).send({ error: '请求未完成', code: error.code });
  }
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; message?: unknown }
    : {};
  if (typeof known.statusCode === 'number') {
    return reply.code(known.statusCode).send({
      error: typeof known.message === 'string' ? known.message : '请求未完成',
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '请求未完成', code: 'sales_hypothesis_failed' });
}

function invalidQuery(reply: any) {
  return reply.code(400).send({ error: '销售假设查询参数无效', code: 'sales_hypothesis_query_invalid' });
}

export function salesHypothesisRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.post('/api/commands/sales-hypothesis', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = idempotencyKey(req, reply);
    if (!key) return;
    const parsed = SalesHypothesisCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: '销售假设命令参数无效',
        code: 'sales_hypothesis_command_invalid',
      });
    }
    const ctx = commandContext(req);
    try {
      await prisma.$transaction(
        (tx) => assertSalesHypothesisCommandAccess(tx, ctx, policy, parsed.data),
        serializable,
      );
      const command = await runCommand(ctx, {
        kind: 'sales-hypothesis-command',
        idempotencyKey: key,
        payload: parsed.data,
        authorizeReplay: (tx) => assertSalesHypothesisCommandAccess(tx, ctx, policy, parsed.data),
      }, (tx) => executeSalesHypothesisCommand(tx, ctx, policy, parsed.data), prisma);
      return SalesHypothesisCommandReceiptSchema.parse({
        ...command.result,
        replayed: command.replayed,
      });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.get('/api/sales-hypotheses', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const transport = listQueryTransportSchema.safeParse(req.query);
    if (!transport.success) return invalidQuery(reply);
    const query = SalesHypothesisListQuerySchema.parse({
      ...transport.data,
      includeRetired: transport.data.includeRetired === 'true',
      cursor: transport.data.cursor ?? null,
      limit: transport.data.limit ?? 50,
    });
    try {
      return await prisma.$transaction(
        (tx) => listSalesHypotheses(tx, commandContext(req), policy, query),
        serializable,
      );
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.get('/api/sales-hypotheses/:id/status-suggestion', {
    preHandler: [app.authenticate],
  }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const query = emptyQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return invalidQuery(reply);
    try {
      const result = await prisma.$transaction(
        (tx) => salesHypothesisStatusSuggestion(tx, commandContext(req), policy, params.data.id),
        serializable,
      );
      return result ?? reply.code(404).send({ error: '资源不存在', code: 'sales_hypothesis_not_found' });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.get('/api/sales-hypotheses/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const transport = detailQueryTransportSchema.safeParse(req.query);
    if (!params.success || !transport.success) return invalidQuery(reply);
    const query = SalesHypothesisDetailQuerySchema.parse({
      beforeRevisionNumber: transport.data.beforeRevisionNumber ?? null,
      limit: transport.data.limit ?? 20,
    });
    try {
      const result = await prisma.$transaction(
        (tx) => salesHypothesisDetail(tx, commandContext(req), policy, params.data.id, query),
        serializable,
      );
      return result ?? reply.code(404).send({ error: '资源不存在', code: 'sales_hypothesis_not_found' });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
