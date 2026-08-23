import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { z } from 'zod';
import { prisma } from './prisma.js';
import {
  requireAccount,
  requireOpportunity,
  requirePerson,
  requireScopedRow,
  ScopedNotFoundError,
} from './mutation/scopeGuards.js';
import { archiveEntity, restoreEntity, type ArchiveTarget } from './mutation/audit.js';
import { mapLegacyOpportunityStatus } from './matter/lifecycle.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';

const accountPatchSchema = z.object({
  base: z.object({
    name: z.string().max(200),
    customerType: z.number().int().min(1).max(4).nullable(),
    primaryOwner: z.string().max(100),
    primaryOwnerUserId: z.string().max(100).nullable(),
  }).strict(),
  name: z.string().trim().min(1).max(200).optional(),
  customerType: z.number().int().min(1).max(4).optional(),
  primaryOwnerUserId: z.string().min(1).max(100).nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).some((field) => field !== 'base'));

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

const opportunityPatchSchema = z.object({
  baseVersion: z.number().int().min(0),
  name: z.string().trim().min(1).max(200).optional(),
  pipelineStage: z.enum(['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签']).optional(),
  status: z.enum(['active', 'paused', 'won', 'lost']).optional(),
  expectedAmountW: z.number().finite().min(0).optional(),
  expectedSignDate: z.union([z.literal(''), z.string().refine(isCalendarDate)]).optional(),
  singleSalesGoal: z.string().trim().max(2000).optional(),
  competitiveSituation: z.enum(['', '领先', '胶着', '落后', '未识别']).optional(),
}).strict().refine((patch) => Object.keys(patch).some((field) => field !== 'baseVersion'));

const rebindSchema = z.object({
  kind: z.enum(['visitNote', 'note']),
  id: z.string().min(1),
  accountId: z.string().min(1),
  opportunityId: z.string().min(1).nullable().optional(),
}).strict();
const contextKindSchema = z.enum(['account', 'opportunity', 'visitNote', 'note']);
const archiveParamsSchema = z.object({ kind: z.enum(['account', 'opportunity']), id: z.string().min(1) });
const archiveReasonSchema = z.object({ reason: z.string().trim().min(1).max(200) }).strict();

type RepairTransaction = Prisma.TransactionClient;

class VersionConflictError extends Error {}

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

async function writeRepairAudit(
  tx: RepairTransaction,
  ctx: CommandContext,
  input: {
    action: 'repair' | 'rebind';
    entityKind: 'account' | 'opportunity' | 'visitNote' | 'note';
    entityId: string;
    sourceRef: string | null;
    changedFields: string[];
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: `audit_${randomUUID()}`,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      channel: ctx.channel,
      action: input.action,
      entityKind: input.entityKind,
      entityId: input.entityId,
      requestId: ctx.requestId ?? null,
      sourceRef: input.sourceRef,
      changedFields: JSON.stringify(input.changedFields),
    },
  });
}

async function repairAccount(ctx: CommandContext, id: string, patch: z.infer<typeof accountPatchSchema>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const account = await requireScopedRow(tx.account.findFirst({
      where: { id, tenantId: ctx.tenantId, archivedAt: null },
      select: {
        id: true,
        externalRef: true,
        name: true,
        customerType: true,
        primaryOwner: true,
        primaryOwnerUserId: true,
      },
    }));
    const { base, primaryOwnerUserId, ...approvedPatch } = patch;
    if (account.name !== base.name
      || account.customerType !== base.customerType
      || account.primaryOwner !== base.primaryOwner
      || account.primaryOwnerUserId !== base.primaryOwnerUserId) {
      throw new VersionConflictError();
    }
    const ownerPatch: { primaryOwner?: string; primaryOwnerUserId?: string | null } = {};
    if (primaryOwnerUserId !== undefined) {
      if (primaryOwnerUserId === null) {
        ownerPatch.primaryOwner = '';
        ownerPatch.primaryOwnerUserId = null;
      } else {
        const owner = await requireScopedRow(tx.user.findFirst({
          where: { id: primaryOwnerUserId, tenantId: ctx.tenantId },
          select: { id: true, name: true },
        }));
        ownerPatch.primaryOwner = owner.name;
        ownerPatch.primaryOwnerUserId = owner.id;
      }
    }
    const effectivePatch: {
      name?: string;
      customerType?: number;
      primaryOwner?: string;
      primaryOwnerUserId?: string | null;
    } = {};
    if (approvedPatch.name !== undefined && approvedPatch.name !== account.name) effectivePatch.name = approvedPatch.name;
    if (approvedPatch.customerType !== undefined && approvedPatch.customerType !== account.customerType) effectivePatch.customerType = approvedPatch.customerType;
    if (primaryOwnerUserId !== undefined
      && (ownerPatch.primaryOwner !== account.primaryOwner || ownerPatch.primaryOwnerUserId !== account.primaryOwnerUserId)) {
      Object.assign(effectivePatch, ownerPatch);
    }
    if (Object.keys(effectivePatch).length === 0) return;
    const updated = await tx.account.updateMany({
      where: {
        id: account.id,
        tenantId: ctx.tenantId,
        archivedAt: null,
        name: base.name,
        customerType: base.customerType,
        primaryOwner: base.primaryOwner,
        primaryOwnerUserId: base.primaryOwnerUserId,
      },
      data: effectivePatch,
    });
    if (updated.count !== 1) throw new VersionConflictError();
    await writeRepairAudit(tx, ctx, {
      action: 'repair',
      entityKind: 'account',
      entityId: account.id,
      sourceRef: account.externalRef,
      changedFields: Object.keys(effectivePatch),
    });
  });
}

async function repairOpportunity(ctx: CommandContext, id: string, patch: z.infer<typeof opportunityPatchSchema>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { baseVersion, ...approvedPatch } = patch;
    const opportunity = await requireScopedRow(tx.opportunity.findFirst({
      where: { id, tenantId: ctx.tenantId, archivedAt: null, account: { archivedAt: null } },
      select: {
        id: true,
        accountId: true,
        externalRef: true,
        version: true,
        name: true,
        pipelineStage: true,
        status: true,
        expectedAmountW: true,
        expectedSignDate: true,
        singleSalesGoal: true,
        competitiveSituation: true,
      },
    }));
    await requireAccount(tx, ctx.tenantId, opportunity.accountId);
    if (opportunity.version !== baseVersion) throw new VersionConflictError();
    const effectivePatch: typeof approvedPatch = {};
    if (approvedPatch.name !== undefined && approvedPatch.name !== opportunity.name) effectivePatch.name = approvedPatch.name;
    if (approvedPatch.pipelineStage !== undefined && approvedPatch.pipelineStage !== opportunity.pipelineStage) effectivePatch.pipelineStage = approvedPatch.pipelineStage;
    if (approvedPatch.status !== undefined && approvedPatch.status !== opportunity.status) effectivePatch.status = approvedPatch.status;
    if (approvedPatch.expectedAmountW !== undefined && approvedPatch.expectedAmountW !== opportunity.expectedAmountW) effectivePatch.expectedAmountW = approvedPatch.expectedAmountW;
    if (approvedPatch.expectedSignDate !== undefined && approvedPatch.expectedSignDate !== opportunity.expectedSignDate) effectivePatch.expectedSignDate = approvedPatch.expectedSignDate;
    if (approvedPatch.singleSalesGoal !== undefined && approvedPatch.singleSalesGoal !== opportunity.singleSalesGoal) effectivePatch.singleSalesGoal = approvedPatch.singleSalesGoal;
    if (approvedPatch.competitiveSituation !== undefined && approvedPatch.competitiveSituation !== opportunity.competitiveSituation) effectivePatch.competitiveSituation = approvedPatch.competitiveSituation;
    if (Object.keys(effectivePatch).length === 0) return;
    const matterLifecyclePatch = effectivePatch.status === undefined
      ? {}
      : mapLegacyOpportunityStatus(effectivePatch.status);
    const updated = await tx.opportunity.updateMany({
      where: {
        id: opportunity.id,
        tenantId: ctx.tenantId,
        accountId: opportunity.accountId,
        archivedAt: null,
        version: baseVersion,
      },
      data: { ...effectivePatch, ...matterLifecyclePatch, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new VersionConflictError();
    await writeRepairAudit(tx, ctx, {
      action: 'repair',
      entityKind: 'opportunity',
      entityId: opportunity.id,
      sourceRef: opportunity.externalRef,
      changedFields: effectivePatch.status === undefined
        ? Object.keys(effectivePatch)
        : [...Object.keys(effectivePatch), 'lifecycleStatus', 'outcomeKey'],
    });
  });
}

async function rebind(ctx: CommandContext, input: z.infer<typeof rebindSchema>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await requireAccount(tx, ctx.tenantId, input.accountId);
    if (input.opportunityId) {
      await requireOpportunity(tx, ctx.tenantId, input.accountId, input.opportunityId);
    }

    if (input.kind === 'visitNote') {
      const current = await requireScopedRow(tx.visitNote.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        select: { accountId: true, opportunityId: true, externalRef: true },
      }));
      await requireAccount(tx, ctx.tenantId, current.accountId);
      if (current.opportunityId) {
        await requireOpportunity(tx, ctx.tenantId, current.accountId, current.opportunityId);
      }
      if (current.accountId === input.accountId && current.opportunityId === (input.opportunityId ?? null)) return;
      const updated = await tx.visitNote.updateMany({
        where: {
          id: input.id,
          tenantId: ctx.tenantId,
          accountId: current.accountId,
          opportunityId: current.opportunityId,
        },
        data: { accountId: input.accountId, opportunityId: input.opportunityId ?? null },
      });
      if (updated.count !== 1) throw new ScopedNotFoundError();
      await writeRepairAudit(tx, ctx, {
        action: 'rebind',
        entityKind: 'visitNote',
        entityId: input.id,
        sourceRef: current.externalRef,
        changedFields: ['accountId', 'opportunityId'],
      });
      return;
    }

    const current = await requireScopedRow(tx.note.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
      select: { accountId: true, opportunityId: true, personId: true },
    }));
    if (current.accountId) {
      await requireAccount(tx, ctx.tenantId, current.accountId);
      if (current.opportunityId) {
        await requireOpportunity(tx, ctx.tenantId, current.accountId, current.opportunityId);
      }
      if (current.personId) {
        await requirePerson(tx, ctx.tenantId, current.accountId, current.personId);
      }
    } else if (current.opportunityId || current.personId) {
      throw new ScopedNotFoundError();
    }
    if (current.personId) {
      await requirePerson(tx, ctx.tenantId, input.accountId, current.personId);
    }
    if (current.accountId === input.accountId && current.opportunityId === (input.opportunityId ?? null)) return;
    const updated = await tx.note.updateMany({
      where: {
        id: input.id,
        tenantId: ctx.tenantId,
        accountId: current.accountId,
        opportunityId: current.opportunityId,
        personId: current.personId,
      },
      data: { accountId: input.accountId, opportunityId: input.opportunityId ?? null },
    });
    if (updated.count !== 1) throw new ScopedNotFoundError();
    await writeRepairAudit(tx, ctx, {
      action: 'rebind',
      entityKind: 'note',
      entityId: input.id,
      sourceRef: null,
      changedFields: ['accountId', 'opportunityId'],
    });
  });
}

const OPPORTUNITY_PROPOSAL_FIELDS = new Set([
  'name', 'pipelineStage', 'engageStage', 'status', 'changeMode', 'productSolution', 'competitor',
  'competitiveSituation', 'singleSalesGoal', 'customerBusinessGoal', 'buyingMotivation',
  'expectedSignDate', 'expectedAmountW', 'c3Items', 'c5Items', 'meta',
]);

function receiptReferences(receipt: string, prefix: string, sourceRef: string): boolean {
  try {
    const parsed: unknown = JSON.parse(receipt);
    if (!parsed || typeof parsed !== 'object') return false;
    const target = `${prefix}:${sourceRef}`;
    return Object.entries(parsed).some(([bucket, value]) => Array.isArray(value) && value.some((item) => {
      const ref = typeof item === 'string'
        ? item
        : !!item && typeof item === 'object' && 'ref' in item && typeof item.ref === 'string'
          ? item.ref
          : null;
      if (!ref) return false;
      if (bucket !== 'proposed') return ref === target;
      if (prefix !== 'opportunity') return ref === target;
      const separator = ref.lastIndexOf(':');
      if (separator < 0 || !OPPORTUNITY_PROPOSAL_FIELDS.has(ref.slice(separator + 1))) return false;
      return ref.slice(0, separator) === target;
    }));
  } catch {
    return false;
  }
}

async function loadRelatedSyncRuns(tenantId: string, prefix: string, sourceRef: string) {
  const matches: Array<{
    id: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  let cursor: string | undefined;
  do {
    const page = await prisma.syncRun.findMany({
      where: { tenantId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, status: true, receipt: true, createdAt: true, updatedAt: true },
    });
    for (const { receipt, ...run } of page) {
      if (receiptReferences(receipt, prefix, sourceRef)) matches.push(run);
      if (matches.length === 10) return matches;
    }
    if (page.length < 100) break;
    cursor = page.at(-1)?.id;
  } while (cursor);
  return matches;
}

async function loadRepairContext(ctx: CommandContext, kind: z.infer<typeof contextKindSchema>, id: string) {
  const scope = await resolveEffectiveResourceScope(prisma, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (scope.actorRole === 'viewer') throw new ScopedNotFoundError();
  let source = 'manual';
  let sourceRef: string | null = null;
  let syncPrefix = '';
  if (kind === 'account') {
    if (!scope.canReadAccountData(id)) throw new ScopedNotFoundError();
    const row = await requireScopedRow(prisma.account.findFirst({
      where: { id, tenantId: ctx.tenantId, archivedAt: null },
      select: { externalRef: true },
    }));
    sourceRef = row.externalRef;
    source = sourceRef ? 'workbuddy' : 'manual';
    syncPrefix = 'account';
  } else if (kind === 'opportunity') {
    if (!scope.canReadMatter(id)) throw new ScopedNotFoundError();
    const row = await requireScopedRow(prisma.opportunity.findFirst({
      where: { id, tenantId: ctx.tenantId, archivedAt: null, account: { archivedAt: null } },
      select: { accountId: true, externalRef: true },
    }));
    await requireAccount(prisma, ctx.tenantId, row.accountId);
    sourceRef = row.externalRef;
    source = sourceRef ? 'workbuddy' : 'manual';
    syncPrefix = 'opportunity';
  } else if (kind === 'visitNote') {
    const parent = await requireScopedRow(prisma.visitNote.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { accountId: true, opportunityId: true },
    }));
    const canRead = parent.opportunityId
      ? scope.canReadMatter(parent.opportunityId)
      : scope.canReadAccountData(parent.accountId);
    if (!canRead) throw new ScopedNotFoundError();
    const row = await requireScopedRow(prisma.visitNote.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { accountId: true, opportunityId: true, externalRef: true, origin: true },
    }));
    await requireAccount(prisma, ctx.tenantId, row.accountId);
    if (row.opportunityId) await requireOpportunity(prisma, ctx.tenantId, row.accountId, row.opportunityId);
    sourceRef = row.externalRef;
    source = row.origin || (sourceRef ? 'workbuddy' : 'manual');
    syncPrefix = 'visit';
  } else {
    const parent = await requireScopedRow(prisma.note.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { accountId: true, opportunityId: true, personId: true },
    }));
    const canReadUnfiled = scope.actorRole === 'owner'
      || scope.actorRole === 'admin'
      || (scope.actorRole === 'member' && scope.policy === 'legacy_tenant_shared');
    const canRead = parent.opportunityId
      ? scope.canReadMatter(parent.opportunityId)
      : parent.accountId
        ? scope.canReadAccountData(parent.accountId)
        : !parent.personId && canReadUnfiled;
    if (!canRead) throw new ScopedNotFoundError();
    const row = await requireScopedRow(prisma.note.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { accountId: true, opportunityId: true, personId: true, source: true },
    }));
    if (row.accountId) {
      await requireAccount(prisma, ctx.tenantId, row.accountId);
      if (row.opportunityId) await requireOpportunity(prisma, ctx.tenantId, row.accountId, row.opportunityId);
      if (row.personId) await requirePerson(prisma, ctx.tenantId, row.accountId, row.personId);
    } else if (row.opportunityId || row.personId) {
      throw new ScopedNotFoundError();
    }
    source = row.source || 'manual';
  }

  const [candidateRuns, auditEvents] = await Promise.all([
    sourceRef
      ? loadRelatedSyncRuns(ctx.tenantId, syncPrefix, sourceRef)
      : Promise.resolve([]),
    prisma.auditEvent.findMany({
      where: { tenantId: ctx.tenantId, entityKind: kind, entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, action: true, actorId: true, channel: true, changedFields: true, createdAt: true },
    }),
  ]);
  const syncRuns = candidateRuns
    .map(({ createdAt, updatedAt, ...run }) => ({
      ...run,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    }));
  return {
    source,
    sourceRef,
    syncedAt: syncRuns[0]?.updatedAt ?? null,
    syncRuns,
    auditEvents: auditEvents.map(({ createdAt, changedFields, ...event }) => ({
      ...event,
      changedFields: (() => {
        try {
          const parsed: unknown = JSON.parse(changedFields);
          return Array.isArray(parsed) && parsed.every((field) => typeof field === 'string') ? parsed : [];
        } catch {
          return [];
        }
      })(),
      createdAt: createdAt.toISOString(),
    })),
  };
}

function requireWriter(req: any, reply: any): boolean {
  if (!['owner', 'admin', 'member'].includes(req.user.role)) {
    reply.code(403).send({ error: '权限不足' });
    return false;
  }
  return true;
}

function handleRepairError(req: any, reply: any, error: unknown) {
  if (error instanceof VersionConflictError) {
    return reply.code(409).send({ error: '数据已更新，请刷新后重试', code: 'VERSION_CONFLICT' });
  }
  if (error instanceof ScopedNotFoundError || (error as any)?.scopedNotFound === true) {
    return reply.code(404).send({ error: '资源不存在' });
  }
  req.log.warn(error);
  return reply.code(400).send({ error: '纠错失败' });
}

export function repairRoutes(app: FastifyInstance): void {
  app.patch('/api/repair/account/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!requireWriter(req, reply)) return;
    const patch = accountPatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: '纠错参数无效' });
    try {
      await repairAccount(commandContext(req), req.params.id, patch.data);
      return { ok: true };
    } catch (error) {
      return handleRepairError(req, reply, error);
    }
  });

  app.patch('/api/repair/opportunity/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!requireWriter(req, reply)) return;
    const patch = opportunityPatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: '纠错参数无效' });
    try {
      await repairOpportunity(commandContext(req), req.params.id, patch.data);
      return { ok: true };
    } catch (error) {
      return handleRepairError(req, reply, error);
    }
  });

  app.post('/api/repair/rebind', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!requireWriter(req, reply)) return;
    const input = rebindSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: '重绑参数无效' });
    try {
      await rebind(commandContext(req), input.data);
      return { ok: true };
    } catch (error) {
      return handleRepairError(req, reply, error);
    }
  });

  app.get('/api/repair/context/:kind/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!requireWriter(req, reply)) return;
    const params = z.object({ kind: contextKindSchema, id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: '溯源参数无效' });
    try {
      return await loadRepairContext(commandContext(req), params.data.kind, params.data.id);
    } catch (error) {
      return handleRepairError(req, reply, error);
    }
  });

  app.post('/api/archive/:kind/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!requireWriter(req, reply)) return;
    const params = archiveParamsSchema.safeParse(req.params);
    const body = archiveReasonSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '归档参数无效' });
    try {
      await archiveEntity(commandContext(req), params.data.kind as ArchiveTarget, params.data.id, body.data.reason);
      return { ok: true };
    } catch (error) {
      return handleRepairError(req, reply, error);
    }
  });

  app.post('/api/archive/:kind/:id/restore', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!['owner', 'admin'].includes(req.user.role)) return reply.code(403).send({ error: '权限不足' });
    const params = archiveParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: '恢复参数无效' });
    try {
      await restoreEntity(commandContext(req), params.data.kind as ArchiveTarget, params.data.id);
      return { ok: true };
    } catch (error) {
      return handleRepairError(req, reply, error);
    }
  });
}
