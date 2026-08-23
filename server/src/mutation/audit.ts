import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { type CommandContext, CommandContextSchema } from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { ScopedNotFoundError } from './scopeGuards.js';

export type ArchiveTarget = 'account' | 'opportunity';

const ARCHIVE_FIELDS = JSON.stringify(['archivedAt', 'archivedBy', 'archiveReason']);
const RESTORE_FIELDS = JSON.stringify(['archivedAt', 'archivedBy', 'archiveReason']);
const MATTER_ARCHIVE_FIELDS = JSON.stringify(['archivedAt', 'archivedBy', 'archiveReason', 'version']);
const MATTER_RESTORE_FIELDS = JSON.stringify(['archivedAt', 'archivedBy', 'archiveReason', 'version']);

function assertWriter(ctx: CommandContext): void {
  CommandContextSchema.parse(ctx);
  if (ctx.actorRole === 'viewer') throw new Error('mutation forbidden');
}

function assertRestorer(ctx: CommandContext): void {
  assertWriter(ctx);
  if (ctx.actorRole !== 'owner' && ctx.actorRole !== 'admin') throw new Error('restore forbidden');
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  ctx: CommandContext,
  action: 'archive' | 'restore',
  target: ArchiveTarget,
  id: string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: `audit_${randomUUID()}`,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      channel: ctx.channel,
      action,
      entityKind: target,
      entityId: id,
      requestId: ctx.requestId ?? null,
      sourceRef: null,
      changedFields: target === 'opportunity'
        ? action === 'archive' ? MATTER_ARCHIVE_FIELDS : MATTER_RESTORE_FIELDS
        : action === 'archive' ? ARCHIVE_FIELDS : RESTORE_FIELDS,
    },
  });
}

export async function archiveEntity(
  ctx: CommandContext,
  target: ArchiveTarget,
  id: string,
  reason: string,
): Promise<void> {
  assertWriter(ctx);
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const result = target === 'account'
      ? await tx.account.updateMany({
        where: { id, tenantId: ctx.tenantId, archivedAt: null },
        data: { archivedAt: now, archivedBy: ctx.actorId, archiveReason: reason },
      })
      : await tx.opportunity.updateMany({
        where: { id, tenantId: ctx.tenantId, archivedAt: null, account: { archivedAt: null } },
        data: { archivedAt: now, archivedBy: ctx.actorId, archiveReason: reason, version: { increment: 1 } },
      });
    if (result.count !== 1) throw new ScopedNotFoundError();
    await writeAudit(tx, ctx, 'archive', target, id);
  });
}

export async function restoreEntity(
  ctx: CommandContext,
  target: ArchiveTarget,
  id: string,
): Promise<void> {
  assertRestorer(ctx);
  await prisma.$transaction(async (tx) => {
    const result = target === 'account'
      ? await tx.account.updateMany({
        where: { id, tenantId: ctx.tenantId, archivedAt: { not: null } },
        data: { archivedAt: null, archivedBy: null, archiveReason: '' },
      })
      : await tx.opportunity.updateMany({
        where: {
          id,
          tenantId: ctx.tenantId,
          archivedAt: { not: null },
          account: { archivedAt: null },
        },
        data: { archivedAt: null, archivedBy: null, archiveReason: '', version: { increment: 1 } },
      });
    if (result.count !== 1) throw new ScopedNotFoundError();
    await writeAudit(tx, ctx, 'restore', target, id);
  });
}
