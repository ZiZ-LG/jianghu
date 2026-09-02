import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  IntelligenceItemCommandReceiptSchema,
  IntelligenceItemCommandSchema,
  IntelligenceItemListQuerySchema,
  StakeholderFocusCommandReceiptSchema,
  StakeholderFocusCommandSchema,
  StakeholderFocusListQuerySchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import {
  assertIntelligenceItemCommandAccess,
  assertStakeholderFocusCommandAccess,
  executeIntelligenceItemCommand,
  executeStakeholderFocusCommand,
  intelligenceItemDetail,
  IntelligenceFocusError,
  listIntelligenceItems,
  listStakeholderFocuses,
  stakeholderFocusDetail,
} from './service.js';

const visibleId = z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const paramsSchema = z.object({ id: visibleId }).strict();
const booleanQuery = z.enum(['true', 'false']).optional();
const limitQuery = z.coerce.number().int().min(1).max(50).optional();
const intelligenceQueryTransportSchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
  assertionType: z.enum(['observed', 'reported', 'inferred']).optional(),
  includeArchived: booleanQuery,
  cursor: visibleId.optional(),
  limit: limitQuery,
}).strict();
const focusQueryTransportSchema = z.object({
  customerId: visibleId,
  matterId: visibleId,
  includeRetired: booleanQuery,
  cursor: visibleId.optional(),
  limit: limitQuery,
}).strict();

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

function sendError(req: any, reply: any, error: unknown, entity: 'intelligence_item' | 'stakeholder_focus') {
  if (error instanceof IntelligenceFocusError) {
    if (error.scopedNotFound || error.statusCode === 404) {
      const code = entity === 'intelligence_item'
        ? 'intelligence_item_not_found'
        : 'stakeholder_focus_not_found';
      return reply.code(404).send({ error: '资源不存在', code });
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
  return reply.code(500).send({ error: '请求未完成', code: 'intelligence_focus_failed' });
}

const serializableRead = {
  isolationLevel: 'Serializable' as const,
  maxWait: 5_000,
  timeout: 30_000,
};

export function intelligenceFocusRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.post('/api/commands/intelligence-item', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = idempotencyKey(req, reply);
    if (!key) return;
    const parsed = IntelligenceItemCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '情报命令参数无效', code: 'intelligence_item_command_invalid' });
    }
    const ctx = commandContext(req);
    try {
      await prisma.$transaction(
        (tx) => assertIntelligenceItemCommandAccess(tx, ctx, policy, parsed.data),
        serializableRead,
      );
      const command = await runCommand(ctx, {
        kind: 'intelligence-item-command',
        idempotencyKey: key,
        payload: parsed.data,
        authorizeReplay: (tx) => assertIntelligenceItemCommandAccess(tx, ctx, policy, parsed.data),
      }, (tx) => executeIntelligenceItemCommand(tx, ctx, policy, parsed.data), prisma);
      return IntelligenceItemCommandReceiptSchema.parse({ ...command.result, replayed: command.replayed });
    } catch (error) {
      return sendError(req, reply, error, 'intelligence_item');
    }
  });

  app.get('/api/intelligence-items', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const transport = intelligenceQueryTransportSchema.safeParse(req.query);
    if (!transport.success) {
      return reply.code(400).send({ error: '情报查询参数无效', code: 'intelligence_item_query_invalid' });
    }
    const query = IntelligenceItemListQuerySchema.parse({
      ...transport.data,
      includeArchived: transport.data.includeArchived === 'true',
      cursor: transport.data.cursor ?? null,
      limit: transport.data.limit ?? 50,
    });
    try {
      return await prisma.$transaction(
        (tx) => listIntelligenceItems(tx, commandContext(req), policy, query),
        serializableRead,
      );
    } catch (error) {
      return sendError(req, reply, error, 'intelligence_item');
    }
  });

  app.get('/api/intelligence-items/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: '情报查询参数无效', code: 'intelligence_item_query_invalid' });
    }
    try {
      const item = await prisma.$transaction(
        (tx) => intelligenceItemDetail(tx, commandContext(req), policy, params.data.id),
        serializableRead,
      );
      return item ?? reply.code(404).send({ error: '资源不存在', code: 'intelligence_item_not_found' });
    } catch (error) {
      return sendError(req, reply, error, 'intelligence_item');
    }
  });

  app.post('/api/commands/stakeholder-focus', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = idempotencyKey(req, reply);
    if (!key) return;
    const parsed = StakeholderFocusCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '干系人聚焦命令参数无效', code: 'stakeholder_focus_command_invalid' });
    }
    const ctx = commandContext(req);
    try {
      await prisma.$transaction(
        (tx) => assertStakeholderFocusCommandAccess(tx, ctx, policy, parsed.data),
        serializableRead,
      );
      const command = await runCommand(ctx, {
        kind: 'stakeholder-focus-command',
        idempotencyKey: key,
        payload: parsed.data,
        authorizeReplay: (tx) => assertStakeholderFocusCommandAccess(tx, ctx, policy, parsed.data),
      }, (tx) => executeStakeholderFocusCommand(tx, ctx, policy, parsed.data), prisma);
      return StakeholderFocusCommandReceiptSchema.parse({ ...command.result, replayed: command.replayed });
    } catch (error) {
      return sendError(req, reply, error, 'stakeholder_focus');
    }
  });

  app.get('/api/stakeholder-focuses', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const transport = focusQueryTransportSchema.safeParse(req.query);
    if (!transport.success) {
      return reply.code(400).send({ error: '干系人聚焦查询参数无效', code: 'stakeholder_focus_query_invalid' });
    }
    const query = StakeholderFocusListQuerySchema.parse({
      ...transport.data,
      includeRetired: transport.data.includeRetired === 'true',
      cursor: transport.data.cursor ?? null,
      limit: transport.data.limit ?? 50,
    });
    try {
      return await prisma.$transaction(
        (tx) => listStakeholderFocuses(tx, commandContext(req), policy, query),
        serializableRead,
      );
    } catch (error) {
      return sendError(req, reply, error, 'stakeholder_focus');
    }
  });

  app.get('/api/stakeholder-focuses/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: '干系人聚焦查询参数无效', code: 'stakeholder_focus_query_invalid' });
    }
    try {
      const item = await prisma.$transaction(
        (tx) => stakeholderFocusDetail(tx, commandContext(req), policy, params.data.id),
        serializableRead,
      );
      return item ?? reply.code(404).send({ error: '资源不存在', code: 'stakeholder_focus_not_found' });
    } catch (error) {
      return sendError(req, reply, error, 'stakeholder_focus');
    }
  });
}
