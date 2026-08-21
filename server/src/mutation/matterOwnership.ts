import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  ActorRoleSchema,
  CommandContextSchema,
  MatterOwnerAssignmentReportSchema,
  MatterOwnerTransferCommandSchema,
  type CommandContext,
  type MatterOwnerTransferCommand,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { inspectMatterOwnerAssignments } from '../matter/ownership.js';
import { runCommand } from './commandRunner.js';
import { ScopedNotFoundError } from './scopeGuards.js';

export class MatterOwnerVersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'matter_owner_version_conflict';
  constructor() { super('事项负责人已变化，请刷新后重试'); }
}

export class InvalidMatterOwnerError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_matter_owner';
  constructor() { super('目标负责人无效'); }
}

class MatterOwnerPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'matter_owner_transfer_forbidden';
  constructor() { super('无权转交该事项'); }
}

export interface MatterOwnerTransferReceipt {
  matterId: string;
  primaryOwnerUserId: string | null;
  version: number;
}

export async function executeMatterOwnerTransfer(
  ctx: CommandContext,
  input: MatterOwnerTransferCommand,
  db: Prisma.TransactionClient,
): Promise<MatterOwnerTransferReceipt> {
  CommandContextSchema.parse(ctx);
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const currentRole = ActorRoleSchema.safeParse(actor?.role);
  if (!currentRole.success || currentRole.data === 'viewer') throw new MatterOwnerPermissionError();

  // Acquire a write lock on the exact current role. A concurrent deletion or
  // downgrade must serialize after this command, rather than winning a TOCTOU
  // race between authentication and the ownership update.
  const actorLock = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: currentRole.data },
    data: { role: currentRole.data },
  });
  if (actorLock.count !== 1) throw new MatterOwnerPermissionError();

  const matter = await db.opportunity.findFirst({
    where: {
      id: input.matterId,
      tenantId: ctx.tenantId,
      accountId: input.customerId,
      archivedAt: null,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { id: true, version: true, primaryOwnerUserId: true },
  });
  if (!matter) throw new ScopedNotFoundError();
  if (currentRole.data === 'member' && matter.primaryOwnerUserId !== ctx.actorId) throw new ScopedNotFoundError();
  if (matter.version !== input.baseVersion || matter.primaryOwnerUserId !== input.fromOwnerUserId) {
    throw new MatterOwnerVersionConflictError();
  }

  if (input.toOwnerUserId) {
    const target = await db.user.findFirst({
      where: { id: input.toOwnerUserId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!target) throw new InvalidMatterOwnerError();
  }

  const updated = await db.opportunity.updateMany({
    where: {
      id: input.matterId,
      tenantId: ctx.tenantId,
      accountId: input.customerId,
      archivedAt: null,
      version: input.baseVersion,
      primaryOwnerUserId: input.fromOwnerUserId,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    data: { primaryOwnerUserId: input.toOwnerUserId, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new MatterOwnerVersionConflictError();

  const nextVersion = input.baseVersion + 1;
  await db.auditEvent.create({
    data: {
      id: `audit_${randomUUID()}`,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      channel: ctx.channel,
      action: 'matter_owner_transfer',
      entityKind: 'matter',
      entityId: input.matterId,
      requestId: ctx.requestId,
      sourceRef: null,
      changedFields: JSON.stringify(['primaryOwnerUserId', 'version']),
      metadata: JSON.stringify({
        fromOwnerUserId: input.fromOwnerUserId,
        toOwnerUserId: input.toOwnerUserId,
        fromVersion: input.baseVersion,
        toVersion: nextVersion,
      }),
    },
  });
  return { matterId: input.matterId, primaryOwnerUserId: input.toOwnerUserId, version: nextVersion };
}

const commandContext = (req: any): CommandContext => ({
  tenantId: req.user.tenantId,
  actorId: req.user.userId,
  actorRole: ActorRoleSchema.parse(req.user.role),
  channel: 'web',
  requestId: req.id,
  assertionMode: 'user_asserted',
});

const ownerOrAdmin = (req: any, reply: any): boolean => {
  if (req.user.role === 'owner' || req.user.role === 'admin') return true;
  reply.code(403).send({ error: '权限不足' });
  return false;
};

const transferWriter = (req: any, reply: any): boolean => {
  if (req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'member') return true;
  reply.code(403).send({ error: '权限不足' });
  return false;
};

const idempotencyKey = (req: any, reply: any): string | undefined => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    return undefined;
  }
  return value;
};

const sendMatterOwnerError = (req: any, reply: any, error: unknown) => {
  if (error instanceof ScopedNotFoundError) return reply.code(404).send({ error: '事项不存在或无权限' });
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; message?: unknown }
    : {};
  if (typeof known.statusCode === 'number') {
    return reply.code(known.statusCode).send({
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
      error: typeof known.message === 'string' ? known.message : '事项负责人转交失败',
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '事项负责人转交失败' });
};

export function matterOwnershipRoutes(app: FastifyInstance): void {
  app.get('/api/matter-owners/unassigned', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!ownerOrAdmin(req, reply)) return;
    const query = z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).strict().safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: '未归属事项查询参数无效' });
    const report = await inspectMatterOwnerAssignments(prisma, {
      tenantId: req.user.tenantId,
      cursor: query.data.cursor,
      limit: query.data.limit,
    });
    return MatterOwnerAssignmentReportSchema.parse(report);
  });

  app.post('/api/commands/matter-owner-transfer', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!transferWriter(req, reply)) return;
    const key = idempotencyKey(req, reply);
    if (!key) return;
    const parsed = MatterOwnerTransferCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '事项负责人转交参数无效' });
    const ctx = commandContext(req);
    try {
      const command = await runCommand<MatterOwnerTransferReceipt>(
        ctx,
        { kind: 'matter-owner-transfer', idempotencyKey: key, payload: parsed.data },
        (tx) => executeMatterOwnerTransfer(ctx, parsed.data, tx),
        prisma,
      );
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return sendMatterOwnerError(req, reply, error);
    }
  });
}
