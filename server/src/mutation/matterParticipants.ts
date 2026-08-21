import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  CommandContextSchema,
  MatterParticipantCommandSchema,
  type CommandContext,
  type MatterParticipantCommand,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from './commandRunner.js';
import { requireOpportunity, requirePerson, ScopedNotFoundError } from './scopeGuards.js';

class MatterParticipantPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'matter_participant_forbidden';
  constructor() { super('无权修改事项参与人'); }
}

export interface MatterParticipantCommandReceipt {
  customerId: string;
  matterId: string;
  personId: string;
  participating: boolean;
  changed: boolean;
}

export async function executeMatterParticipantCommand(
  ctx: CommandContext,
  input: MatterParticipantCommand,
  db: Prisma.TransactionClient,
): Promise<MatterParticipantCommandReceipt> {
  CommandContextSchema.parse(ctx);
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const actorRole = ActorRoleSchema.safeParse(actor?.role);
  if (!actorRole.success || actorRole.data === 'viewer') throw new MatterParticipantPermissionError();
  const actorLock = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: actorRole.data },
    data: { role: actorRole.data },
  });
  if (actorLock.count !== 1) throw new MatterParticipantPermissionError();

  await requireOpportunity(db, ctx.tenantId, input.customerId, input.matterId);
  await requirePerson(db, ctx.tenantId, input.customerId, input.personId);
  const key = {
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    personId: input.personId,
  };
  const existing = await db.matterParticipant.findUnique({
    where: { tenantId_opportunityId_personId: key },
    select: { id: true, accountId: true },
  });
  if (existing && existing.accountId !== input.customerId) throw new ScopedNotFoundError();

  const participating = input.type === 'ADD_MATTER_PARTICIPANT';
  let changed = false;
  if (participating) {
    if (!existing) {
      await db.matterParticipant.create({ data: {
        tenantId: ctx.tenantId,
        accountId: input.customerId,
        opportunityId: input.matterId,
        personId: input.personId,
      } });
      changed = true;
    }
  } else if (existing) {
    const removed = await db.matterParticipant.deleteMany({
      where: {
        id: existing.id,
        tenantId: ctx.tenantId,
        accountId: input.customerId,
        opportunityId: input.matterId,
        personId: input.personId,
      },
    });
    changed = removed.count === 1;
  }

  if (changed) {
    await db.auditEvent.create({ data: {
      id: `audit_${randomUUID()}`,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      channel: ctx.channel,
      action: participating ? 'matter_participant_add' : 'matter_participant_remove',
      entityKind: 'matter_participant',
      entityId: `${input.matterId}:${input.personId}`,
      requestId: ctx.requestId,
      sourceRef: input.personId,
      changedFields: JSON.stringify(['participating']),
      metadata: JSON.stringify({
        customerId: input.customerId,
        matterId: input.matterId,
        personId: input.personId,
        participating,
      }),
    } });
  }

  return {
    customerId: input.customerId,
    matterId: input.matterId,
    personId: input.personId,
    participating,
    changed,
  };
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

const idempotencyKey = (req: any, reply: any): string | undefined => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    return undefined;
  }
  return value;
};

const sendError = (req: any, reply: any, error: unknown) => {
  if (error instanceof ScopedNotFoundError) return reply.code(404).send({ error: '事项或人物不存在' });
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; message?: unknown }
    : {};
  if (typeof known.statusCode === 'number') {
    return reply.code(known.statusCode).send({
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
      error: typeof known.message === 'string' ? known.message : '事项参与人修改失败',
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '事项参与人修改失败' });
};

export function matterParticipantRoutes(app: FastifyInstance): void {
  app.post('/api/commands/matter-participant', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!canWrite(req, reply)) return;
    const key = idempotencyKey(req, reply);
    if (!key) return;
    const parsed = MatterParticipantCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '事项参与人参数无效' });
    const ctx = commandContext(req);
    try {
      const command = await runCommand<MatterParticipantCommandReceipt>(
        ctx,
        {
          kind: 'matter-participant',
          idempotencyKey: key,
          payload: parsed.data,
          discardReservationOnScopedError: true,
        },
        (tx) => executeMatterParticipantCommand(ctx, parsed.data, tx),
        prisma,
      );
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
