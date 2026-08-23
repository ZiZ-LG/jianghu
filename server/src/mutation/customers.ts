import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  capabilityPolicyAllows,
  CommandContextSchema,
  CustomerCommandReceiptSchema,
  CustomerCreateCommandSchema,
  type CommandContext,
  type CapabilityPolicy,
  type CustomerCommandReceipt,
  type CustomerCreateCommand,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from './commandRunner.js';
import { ScopedNotFoundError } from './scopeGuards.js';

class CustomerPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'customer_write_forbidden';
  constructor() { super('无权创建客户'); }
}

class CustomerAssignmentPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'customer_assign_forbidden';
  constructor() { super('无权把客户指派给其他成员'); }
}

class CustomerIdConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'customer_id_conflict';
  constructor() { super('客户标识已存在'); }
}

async function lockWritableActor(
  ctx: CommandContext,
  db: Prisma.TransactionClient,
): Promise<'owner' | 'admin' | 'member'> {
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success || role.data === 'viewer') throw new CustomerPermissionError();
  const locked = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: role.data },
    data: { role: role.data },
  });
  if (locked.count !== 1) throw new CustomerPermissionError();
  return role.data;
}

async function lockOwner(
  ctx: CommandContext,
  ownerUserId: string,
  db: Prisma.TransactionClient,
): Promise<void> {
  const owner = await db.user.findFirst({
    where: { id: ownerUserId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(owner?.role);
  if (!role.success) throw new ScopedNotFoundError();
  const locked = await db.user.updateMany({
    where: { id: ownerUserId, tenantId: ctx.tenantId, role: role.data },
    data: { role: role.data },
  });
  if (locked.count !== 1) throw new ScopedNotFoundError();
}

const isUniqueConflict = (error: unknown): boolean => (
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
);

export async function executeCustomerCommand(
  ctx: CommandContext,
  rawInput: CustomerCreateCommand,
  db: Prisma.TransactionClient,
  policy: CapabilityPolicy,
): Promise<CustomerCommandReceipt> {
  CommandContextSchema.parse(ctx);
  const input = CustomerCreateCommandSchema.parse(rawInput);
  const actorRole = await lockWritableActor(ctx, db);
  const ownerUserId = input.customer.primaryOwnerUserId;
  if (actorRole === 'member'
    && ownerUserId !== null
    && ownerUserId !== ctx.actorId
    && !capabilityPolicyAllows(policy, { permission: 'commitment.assign' })) {
    throw new CustomerAssignmentPermissionError();
  }
  if (ownerUserId !== null) await lockOwner(ctx, ownerUserId, db);

  let row;
  try {
    row = await db.account.create({ data: {
      id: input.customer.id,
      tenantId: ctx.tenantId,
      name: input.customer.name,
      categoryKey: input.customer.categoryKey,
      primaryOwnerUserId: ownerUserId,
      version: 0,
    } });
  } catch (error) {
    if (isUniqueConflict(error)) throw new CustomerIdConflictError();
    throw error;
  }

  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'customer_created',
    entityKind: 'customer',
    entityId: row.id,
    requestId: ctx.requestId,
    changedFields: JSON.stringify(['name', 'categoryKey', 'primaryOwnerUserId', 'version']),
    metadata: JSON.stringify({
      categoryKey: row.categoryKey,
      primaryOwnerUserId: row.primaryOwnerUserId,
      version: row.version,
    }),
  } });

  return CustomerCommandReceiptSchema.parse({
    customerId: row.id,
    categoryKey: row.categoryKey,
    primaryOwnerUserId: row.primaryOwnerUserId,
    version: row.version,
    undoable: false,
  });
}

const commandContext = (req: any): CommandContext => ({
  tenantId: req.user.tenantId,
  actorId: req.user.userId,
  actorRole: ActorRoleSchema.parse(req.user.role),
  channel: 'web',
  requestId: req.id,
  assertionMode: 'user_asserted',
});

const readIdempotencyKey = (req: any, reply: any): string | undefined => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    return undefined;
  }
  return value;
};

const sendError = (req: any, reply: any, error: unknown) => {
  if (error instanceof ScopedNotFoundError) return reply.code(404).send({ error: '客户负责人不存在' });
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; message?: unknown }
    : {};
  if (typeof known.statusCode === 'number') {
    return reply.code(known.statusCode).send({
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
      error: typeof known.message === 'string' ? known.message : '客户命令失败',
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '客户命令失败' });
};

export function customerRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.post('/api/commands/customer', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (process.env.CUSTOMER_COMMANDS_ENABLED === '0') {
      return reply.code(503).send({ code: 'customer_commands_disabled', error: '客户命令暂未启用' });
    }
    const key = readIdempotencyKey(req, reply);
    if (!key) return;
    const parsed = CustomerCreateCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '客户参数无效或命令尚未支持' });
    const input = parsed.data;
    const ctx = commandContext(req);
    try {
      const result = await runCommand<CustomerCommandReceipt>(
        ctx,
        { kind: 'customer', idempotencyKey: key, payload: input },
        (tx) => executeCustomerCommand(ctx, input, tx, policy),
        prisma,
      );
      return { ...result.result, replayed: result.replayed };
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
