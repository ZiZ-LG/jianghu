import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  CommandContextSchema,
  MethodologyCommandReceiptSchema,
  MethodologyCommandSchema,
  type CommandContext,
  type MethodologyCommand,
  type MethodologyCommandReceipt,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import { ScopedNotFoundError } from '../mutation/scopeGuards.js';
import { createPublishedBuiltinMethodologySnapshot } from './repository.js';
import { findBuiltinMethodologyTemplate, instantiateBuiltinMethodologyDefinitions } from './templates.js';

class MethodologyPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'methodology_manage_forbidden';
  constructor() { super('无权管理方法论'); }
}

class UnknownMethodologyTemplateError extends Error {
  readonly statusCode = 400;
  readonly code = 'unknown_methodology_template';
  constructor() { super('内置方法论模板不存在'); }
}

class MethodologyTemplateAlreadyMaterializedError extends Error {
  readonly statusCode = 409;
  readonly code = 'methodology_template_already_materialized';
  constructor() { super('该内置方法论模板已物化'); }
}

class MethodologyMatterVersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'methodology_matter_version_conflict';
  constructor() { super('事项或当前方法论已变化，请刷新后重试'); }
}

class MethodologyVersionNotBindableError extends Error {
  readonly statusCode = 409;
  readonly code = 'methodology_version_not_bindable';
  constructor() { super('只有当前租户已发布的方法论版本可以绑定'); }
}

class MethodologyVersionNotPilotableError extends Error {
  readonly statusCode = 409;
  readonly code = 'methodology_version_not_pilotable';
  constructor() { super('该方法论版本不可用于试点'); }
}

type Db = Prisma.TransactionClient;

async function assertMethodologyManager(ctx: CommandContext, db: Db): Promise<void> {
  CommandContextSchema.parse(ctx);
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success || (role.data !== 'owner' && role.data !== 'admin')) {
    throw new MethodologyPermissionError();
  }
  // Lock the exact current role so a concurrent downgrade/deletion cannot win between authorization and write.
  const locked = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: role.data },
    data: { role: role.data },
  });
  if (locked.count !== 1) throw new MethodologyPermissionError();
}

async function lockTenant(ctx: CommandContext, db: Db): Promise<void> {
  const tenant = await db.tenant.findFirst({
    where: { id: ctx.tenantId },
    select: { name: true },
  });
  if (!tenant) throw new ScopedNotFoundError();
  const locked = await db.tenant.updateMany({
    where: { id: ctx.tenantId, name: tenant.name },
    data: { name: tenant.name },
  });
  if (locked.count !== 1) throw new ScopedNotFoundError();
}

async function loadMatter(
  ctx: CommandContext,
  customerId: string,
  matterId: string,
  db: Db,
) {
  const matter = await db.opportunity.findFirst({
    where: {
      id: matterId,
      tenantId: ctx.tenantId,
      accountId: customerId,
      archivedAt: null,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { id: true, version: true, activeMethodologyBindingId: true },
  });
  if (!matter) throw new ScopedNotFoundError();
  return matter;
}

async function assertBindingBelongsToMatter(
  ctx: CommandContext,
  bindingId: string,
  matterId: string,
  db: Db,
) {
  const binding = await db.methodologyBinding.findFirst({
    where: { id: bindingId, tenantId: ctx.tenantId, opportunityId: matterId },
    select: { id: true, packId: true, versionId: true },
  });
  if (!binding) throw new ScopedNotFoundError();
  return binding;
}

async function writeAudit(
  ctx: CommandContext,
  db: Db,
  input: {
    action: string;
    entityKind: string;
    entityId: string;
    changedFields: string[];
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: input.action,
    entityKind: input.entityKind,
    entityId: input.entityId,
    requestId: ctx.requestId ?? null,
    sourceRef: null,
    changedFields: JSON.stringify(input.changedFields),
    metadata: JSON.stringify(input.metadata),
  } });
}

async function materializeBuiltin(
  ctx: CommandContext,
  input: Extract<MethodologyCommand, { type: 'MATERIALIZE_BUILTIN_METHODOLOGY' }>,
  db: Db,
): Promise<MethodologyCommandReceipt> {
  await assertMethodologyManager(ctx, db);
  const template = findBuiltinMethodologyTemplate(input.templateKey);
  if (!template) throw new UnknownMethodologyTemplateError();
  // Serialize different idempotency keys attempting to install the same tenant template.
  await lockTenant(ctx, db);
  const existing = await db.methodologyPack.findFirst({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { key: template.packKey },
        { sourceTemplateRef: template.sourceTemplateRef },
      ],
    },
    select: { id: true },
  });
  if (existing) throw new MethodologyTemplateAlreadyMaterializedError();

  const now = new Date();
  await db.methodologyPack.create({ data: {
    id: input.packId,
    tenantId: ctx.tenantId,
    key: template.packKey,
    name: template.name,
    sourceTemplateRef: template.sourceTemplateRef,
    currentPublishedVersionId: null,
    version: 0,
    createdByUserId: ctx.actorId,
    createdAt: now,
  } });
  const definitions = instantiateBuiltinMethodologyDefinitions(template, input.packId, input.versionId);
  await createPublishedBuiltinMethodologySnapshot({ tenantId: ctx.tenantId, actorId: ctx.actorId }, {
    ...definitions,
    versionKey: template.versionKey,
    engineRef: template.engineRef,
    contentHash: template.contentHash,
    learningContentRef: template.learningContentRef,
    sourceTemplateRef: template.sourceTemplateRef,
    publishedAt: now.toISOString(),
  }, db);
  await writeAudit(ctx, db, {
    action: 'methodology_template_materialized',
    entityKind: 'methodology_pack',
    entityId: input.packId,
    changedFields: ['pack', 'publishedVersion', 'definitions'],
    metadata: {
      templateKey: input.templateKey,
      versionId: input.versionId,
      versionKey: template.versionKey,
      engineRef: template.engineRef,
    },
  });
  return {
    action: 'template_materialized',
    packId: input.packId,
    versionId: input.versionId,
  };
}

async function activateBinding(
  ctx: CommandContext,
  input: Extract<MethodologyCommand, { type: 'ACTIVATE_METHODOLOGY_BINDING' }>,
  db: Db,
): Promise<MethodologyCommandReceipt> {
  await assertMethodologyManager(ctx, db);
  const matter = await loadMatter(ctx, input.customerId, input.matterId, db);
  if (
    matter.version !== input.baseMatterVersion
    || matter.activeMethodologyBindingId !== input.expectedActiveBindingId
  ) {
    throw new MethodologyMatterVersionConflictError();
  }
  if (input.expectedActiveBindingId) {
    await assertBindingBelongsToMatter(ctx, input.expectedActiveBindingId, input.matterId, db);
  }

  const version = await db.methodologyPackVersion.findFirst({
    where: {
      id: input.versionId,
      tenantId: ctx.tenantId,
      pack: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { packId: true, status: true },
  });
  if (!version) throw new ScopedNotFoundError();
  if (version.status !== 'published') throw new MethodologyVersionNotBindableError();

  if (input.decisionProfileRef) {
    const decisionProfile = await db.industryPack.findFirst({
      where: { id: input.decisionProfileRef, tenantId: ctx.tenantId, active: true },
      select: { id: true },
    });
    if (!decisionProfile) throw new ScopedNotFoundError();
  }

  await db.methodologyBinding.create({ data: {
    id: input.bindingId,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    packId: version.packId,
    versionId: input.versionId,
    decisionProfileRef: input.decisionProfileRef,
    createdByUserId: ctx.actorId,
  } });
  const updated = await db.opportunity.updateMany({
    where: {
      id: input.matterId,
      tenantId: ctx.tenantId,
      accountId: input.customerId,
      archivedAt: null,
      version: input.baseMatterVersion,
      activeMethodologyBindingId: input.expectedActiveBindingId,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    data: {
      activeMethodologyBindingId: input.bindingId,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) throw new MethodologyMatterVersionConflictError();

  const nextVersion = input.baseMatterVersion + 1;
  await writeAudit(ctx, db, {
    action: 'methodology_binding_activated',
    entityKind: 'matter',
    entityId: input.matterId,
    changedFields: ['activeMethodologyBindingId', 'version'],
    metadata: {
      previousBindingId: input.expectedActiveBindingId,
      bindingId: input.bindingId,
      packId: version.packId,
      versionId: input.versionId,
      hasDecisionProfile: input.decisionProfileRef !== null,
      fromMatterVersion: input.baseMatterVersion,
      toMatterVersion: nextVersion,
    },
  });
  return {
    action: 'binding_activated',
    matterId: input.matterId,
    bindingId: input.bindingId,
    activeMethodologyBindingId: input.bindingId,
    matterVersion: nextVersion,
  };
}

async function unbindMethodology(
  ctx: CommandContext,
  input: Extract<MethodologyCommand, { type: 'UNBIND_METHODOLOGY' }>,
  db: Db,
): Promise<MethodologyCommandReceipt> {
  await assertMethodologyManager(ctx, db);
  const matter = await loadMatter(ctx, input.customerId, input.matterId, db);
  if (
    matter.version !== input.baseMatterVersion
    || matter.activeMethodologyBindingId !== input.expectedActiveBindingId
  ) {
    throw new MethodologyMatterVersionConflictError();
  }
  await assertBindingBelongsToMatter(ctx, input.expectedActiveBindingId, input.matterId, db);
  const updated = await db.opportunity.updateMany({
    where: {
      id: input.matterId,
      tenantId: ctx.tenantId,
      accountId: input.customerId,
      archivedAt: null,
      version: input.baseMatterVersion,
      activeMethodologyBindingId: input.expectedActiveBindingId,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    data: {
      activeMethodologyBindingId: null,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) throw new MethodologyMatterVersionConflictError();

  const nextVersion = input.baseMatterVersion + 1;
  await writeAudit(ctx, db, {
    action: 'methodology_unbound',
    entityKind: 'matter',
    entityId: input.matterId,
    changedFields: ['activeMethodologyBindingId', 'version'],
    metadata: {
      previousBindingId: input.expectedActiveBindingId,
      fromMatterVersion: input.baseMatterVersion,
      toMatterVersion: nextVersion,
      coreBusinessRowsDeleted: false,
    },
  });
  return {
    action: 'methodology_unbound',
    matterId: input.matterId,
    previousBindingId: input.expectedActiveBindingId,
    activeMethodologyBindingId: null,
    matterVersion: nextVersion,
  };
}

async function assignPilot(
  ctx: CommandContext,
  input: Extract<MethodologyCommand, { type: 'ASSIGN_METHODOLOGY_PILOT' }>,
  db: Db,
): Promise<MethodologyCommandReceipt> {
  await assertMethodologyManager(ctx, db);
  const matter = await loadMatter(ctx, input.customerId, input.matterId, db);
  if (matter.version !== input.baseMatterVersion) throw new MethodologyMatterVersionConflictError();

  // Lock the exact Matter snapshot without changing its version or active binding.
  const locked = await db.opportunity.updateMany({
    where: {
      id: input.matterId,
      tenantId: ctx.tenantId,
      accountId: input.customerId,
      archivedAt: null,
      version: input.baseMatterVersion,
      activeMethodologyBindingId: matter.activeMethodologyBindingId,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    data: { version: { increment: 0 } },
  });
  if (locked.count !== 1) throw new MethodologyMatterVersionConflictError();

  const candidate = await db.methodologyPackVersion.findFirst({
    where: {
      id: input.candidateVersionId,
      tenantId: ctx.tenantId,
      pack: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { packId: true, status: true },
  });
  if (!candidate) throw new ScopedNotFoundError();
  if (candidate.status !== 'piloting' && candidate.status !== 'published') {
    throw new MethodologyVersionNotPilotableError();
  }
  if (input.baselineBindingId) {
    await assertBindingBelongsToMatter(ctx, input.baselineBindingId, input.matterId, db);
  }

  await db.methodologyPilotAssignment.create({ data: {
    id: input.pilotAssignmentId,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    candidatePackId: candidate.packId,
    candidateVersionId: input.candidateVersionId,
    baselineBindingId: input.baselineBindingId,
    matterVersion: input.baseMatterVersion,
    status: 'active',
    assignedByUserId: ctx.actorId,
  } });
  await writeAudit(ctx, db, {
    action: 'methodology_pilot_assigned',
    entityKind: 'methodology_pilot',
    entityId: input.pilotAssignmentId,
    changedFields: ['pilotAssignment'],
    metadata: {
      matterId: input.matterId,
      candidatePackId: candidate.packId,
      candidateVersionId: input.candidateVersionId,
      baselineBindingId: input.baselineBindingId,
      activeMethodologyBindingId: matter.activeMethodologyBindingId,
      matterVersion: input.baseMatterVersion,
    },
  });
  return {
    action: 'pilot_assigned',
    matterId: input.matterId,
    pilotAssignmentId: input.pilotAssignmentId,
    candidateVersionId: input.candidateVersionId,
    activeMethodologyBindingId: matter.activeMethodologyBindingId,
    matterVersion: input.baseMatterVersion,
  };
}

export async function executeMethodologyCommand(
  ctx: CommandContext,
  input: MethodologyCommand,
  db: Db,
): Promise<MethodologyCommandReceipt> {
  switch (input.type) {
    case 'MATERIALIZE_BUILTIN_METHODOLOGY': return materializeBuiltin(ctx, input, db);
    case 'ACTIVATE_METHODOLOGY_BINDING': return activateBinding(ctx, input, db);
    case 'UNBIND_METHODOLOGY': return unbindMethodology(ctx, input, db);
    case 'ASSIGN_METHODOLOGY_PILOT': return assignPilot(ctx, input, db);
  }
}

const commandContext = (req: any): CommandContext => ({
  tenantId: req.user.tenantId,
  actorId: req.user.userId,
  actorRole: ActorRoleSchema.parse(req.user.role),
  channel: 'web',
  requestId: req.id,
  assertionMode: 'user_asserted',
});

const canManageMethodology = (req: any, reply: any): boolean => {
  if (req.user.role === 'owner' || req.user.role === 'admin') return true;
  reply.code(403).send({ code: 'methodology_manage_forbidden', error: '权限不足' });
  return false;
};

const readIdempotencyKey = (req: any, reply: any): string | undefined => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    return undefined;
  }
  return value;
};

const sendMethodologyError = (req: any, reply: any, error: unknown) => {
  if (error instanceof ScopedNotFoundError || (error as any)?.scopedNotFound === true) {
    return reply.code(404).send({ error: '方法论资源不存在或无权限' });
  }
  const known = error && typeof error === 'object'
    ? error as { statusCode?: unknown; code?: unknown; message?: unknown }
    : {};
  if (typeof known.statusCode === 'number' && [400, 403, 409, 503].includes(known.statusCode)) {
    return reply.code(known.statusCode).send({
      ...(typeof known.code === 'string' ? { code: known.code } : {}),
      error: typeof known.message === 'string' ? known.message : '方法论命令失败',
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '方法论命令失败' });
};

export function methodologyCommandRoutes(app: FastifyInstance): void {
  app.post('/api/commands/methodology', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!canManageMethodology(req, reply)) return;
    // Expand-only rollback gate: no default enablement in any environment.
    if (process.env.METHODOLOGY_COMMANDS_ENABLED !== '1') {
      return reply.code(503).send({
        code: 'methodology_commands_disabled',
        error: '方法论命令暂未启用',
      });
    }
    const key = readIdempotencyKey(req, reply);
    if (!key) return;
    const parsed = MethodologyCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '方法论命令参数无效' });
    const input = parsed.data as MethodologyCommand;
    const ctx = commandContext(req);
    try {
      const command = await runCommand<MethodologyCommandReceipt>(
        ctx,
        { kind: 'methodology', idempotencyKey: key, payload: input },
        (tx) => executeMethodologyCommand(ctx, input, tx),
        prisma,
      );
      return {
        ...MethodologyCommandReceiptSchema.parse(command.result),
        replayed: command.replayed,
      };
    } catch (error) {
      return sendMethodologyError(req, reply, error);
    }
  });
}
