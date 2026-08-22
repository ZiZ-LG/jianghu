import type { Prisma } from '@prisma/client';
import {
  MethodologyActionTemplateSchema,
  MethodologyEvaluationSchema,
  MethodologyFieldDefinitionSchema,
  MethodologyMigrationRunSchema,
  MethodologyRoleAssignmentSchema,
  MethodologyRoleDefinitionSchema,
  MethodologyRuleDefinitionSchema,
  MethodologyStageDefinitionSchema,
  MethodologyStageStateSchema,
  MethodologyValueSchema,
  type MethodologyActionTemplate,
  type MethodologyEvaluation,
  type MethodologyFieldDefinition,
  type MethodologyMigrationRun,
  type MethodologyRoleAssignment,
  type MethodologyRoleDefinition,
  type MethodologyRuleDefinition,
  type MethodologyStageDefinition,
  type MethodologyStageState,
  type MethodologyValue,
} from '@jianghu/domain-contracts';
import { z } from 'zod';
import { activePersonWhere } from '../activePerson.js';
import { ScopedNotFoundError } from '../mutation/scopeGuards.js';

type Db = Prisma.TransactionClient;

export interface MethodologyRepositoryContext {
  tenantId: string;
  actorId: string;
}

export class MethodologyVersionImmutableError extends Error {
  readonly statusCode = 409;
  readonly code = 'methodology_version_immutable';

  constructor() {
    super('已发布的方法论版本不可原位修改');
    this.name = 'MethodologyVersionImmutableError';
  }
}

export class MethodologyDataConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'methodology_data_conflict';

  constructor(message = '方法论数据已变化，请刷新后重试') {
    super(message);
    this.name = 'MethodologyDataConflictError';
  }
}

export interface MethodologyDefinitionSetInput {
  packId: string;
  versionId: string;
  fields: MethodologyFieldDefinition[];
  stages: MethodologyStageDefinition[];
  roles: MethodologyRoleDefinition[];
  rules: MethodologyRuleDefinition[];
  actions: MethodologyActionTemplate[];
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const openKey = z.string().trim().min(1).max(200);
const updateDraftVersionSchema = z.object({
  packId: z.string().min(1),
  versionId: z.string().min(1),
  expectedContentHash: sha256,
  versionKey: openKey,
  engineRef: openKey,
  contentHash: sha256,
  learningContentRef: openKey.nullable(),
  sourceTemplateRef: openKey.nullable(),
}).strict();

export type UpdateDraftMethodologyVersionInput = z.infer<typeof updateDraftVersionSchema>;

function assertContext(ctx: MethodologyRepositoryContext): void {
  if (!ctx.tenantId || !ctx.actorId) throw new ScopedNotFoundError();
}

async function assertActor(ctx: MethodologyRepositoryContext, db: Db): Promise<void> {
  assertContext(ctx);
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!actor) throw new ScopedNotFoundError();
}

async function lockDraftVersion(
  ctx: MethodologyRepositoryContext,
  packId: string,
  versionId: string,
  db: Db,
) {
  const version = await db.methodologyPackVersion.findFirst({
    where: {
      id: versionId,
      tenantId: ctx.tenantId,
      packId,
      pack: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { id: true, status: true, contentHash: true },
  });
  if (!version) throw new ScopedNotFoundError();
  if (version.status !== 'draft') throw new MethodologyVersionImmutableError();

  // A no-op CAS update acquires the version row lock on PostgreSQL. All later
  // definition writes therefore observe one draft snapshot inside the caller's transaction.
  const locked = await db.methodologyPackVersion.updateMany({
    where: {
      id: versionId,
      tenantId: ctx.tenantId,
      packId,
      status: 'draft',
      contentHash: version.contentHash,
    },
    data: { status: 'draft' },
  });
  if (locked.count !== 1) throw new MethodologyDataConflictError();
  return version;
}

function assertDefinitionIdentity(
  definition: { packId: string; versionId: string },
  packId: string,
  versionId: string,
): void {
  if (definition.packId !== packId || definition.versionId !== versionId) {
    throw new ScopedNotFoundError();
  }
}

interface BindingAnchor {
  accountId: string;
  matterVersion: number;
  activeBindingId: string | null;
  versionKey: string;
  engineRef: string;
}

async function loadBindingAnchor(
  ctx: MethodologyRepositoryContext,
  input: { matterId: string; bindingId: string; packId: string; versionId: string },
  db: Db,
): Promise<BindingAnchor> {
  const binding = await db.methodologyBinding.findFirst({
    where: {
      id: input.bindingId,
      tenantId: ctx.tenantId,
      opportunityId: input.matterId,
      packId: input.packId,
      versionId: input.versionId,
      opportunity: {
        tenantId: ctx.tenantId,
        archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      methodologyVersion: {
        tenantId: ctx.tenantId,
        packId: input.packId,
        id: input.versionId,
        pack: { tenantId: ctx.tenantId, archivedAt: null },
      },
    },
    select: {
      opportunity: {
        select: { accountId: true, version: true, activeMethodologyBindingId: true },
      },
      methodologyVersion: { select: { status: true, versionKey: true, engineRef: true } },
    },
  });
  if (!binding) throw new ScopedNotFoundError();
  if (!['published', 'deprecated'].includes(binding.methodologyVersion.status)) {
    throw new MethodologyDataConflictError('实例数据只能绑定已发布的方法论版本');
  }
  return {
    accountId: binding.opportunity.accountId,
    matterVersion: binding.opportunity.version,
    activeBindingId: binding.opportunity.activeMethodologyBindingId,
    versionKey: binding.methodologyVersion.versionKey,
    engineRef: binding.methodologyVersion.engineRef,
  };
}

function assertEmbeddedActor(ctx: MethodologyRepositoryContext, actorId: string): void {
  if (actorId !== ctx.actorId) throw new ScopedNotFoundError();
}

async function assertEvidenceIds(
  ctx: MethodologyRepositoryContext,
  anchor: BindingAnchor,
  matterId: string,
  evidenceIdsJson: string,
  db: Db,
): Promise<void> {
  const evidenceIds = [...new Set(JSON.parse(evidenceIdsJson) as string[])];
  if (evidenceIds.length === 0) return;
  const evidence = await db.evidenceEvent.findMany({
    where: {
      id: { in: evidenceIds },
      tenantId: ctx.tenantId,
      accountId: anchor.accountId,
      opportunityId: matterId,
    },
    select: { id: true },
  });
  if (evidence.length !== evidenceIds.length) throw new ScopedNotFoundError();
}

async function lockMatterSnapshot(
  ctx: MethodologyRepositoryContext,
  matterId: string,
  expectedVersion: number,
  db: Db,
  expectedActiveBindingId?: string,
): Promise<void> {
  const locked = await db.opportunity.updateMany({
    where: {
      id: matterId,
      tenantId: ctx.tenantId,
      version: expectedVersion,
      ...(expectedActiveBindingId === undefined
        ? {}
        : { activeMethodologyBindingId: expectedActiveBindingId }),
    },
    data: { version: { increment: 0 } },
  });
  if (locked.count !== 1) throw new MethodologyDataConflictError();
}

export async function createMethodologyDefinitionSet(
  ctx: MethodologyRepositoryContext,
  input: MethodologyDefinitionSetInput,
  db: Db,
): Promise<void> {
  const fields = input.fields.map((item) => MethodologyFieldDefinitionSchema.parse(item));
  const stages = input.stages.map((item) => MethodologyStageDefinitionSchema.parse(item));
  const roles = input.roles.map((item) => MethodologyRoleDefinitionSchema.parse(item));
  const rules = input.rules.map((item) => MethodologyRuleDefinitionSchema.parse(item));
  const actions = input.actions.map((item) => MethodologyActionTemplateSchema.parse(item));
  const definitions = [...fields, ...stages, ...roles, ...rules, ...actions];
  for (const definition of definitions) {
    assertDefinitionIdentity(definition, input.packId, input.versionId);
  }

  await assertActor(ctx, db);
  await lockDraftVersion(ctx, input.packId, input.versionId, db);
  const withTenant = <T extends object>(item: T) => ({ tenantId: ctx.tenantId, ...item });
  if (fields.length > 0) {
    await db.methodologyFieldDefinition.createMany({ data: fields.map(withTenant) });
  }
  if (stages.length > 0) {
    await db.methodologyStageDefinition.createMany({ data: stages.map(withTenant) });
  }
  if (roles.length > 0) {
    await db.methodologyRoleDefinition.createMany({ data: roles.map(withTenant) });
  }
  if (rules.length > 0) {
    await db.methodologyRuleDefinition.createMany({ data: rules.map(withTenant) });
  }
  if (actions.length > 0) {
    await db.methodologyActionTemplate.createMany({ data: actions.map(withTenant) });
  }
}

export async function updateDraftMethodologyVersion(
  ctx: MethodologyRepositoryContext,
  rawInput: UpdateDraftMethodologyVersionInput,
  db: Db,
): Promise<void> {
  const input = updateDraftVersionSchema.parse(rawInput);
  await assertActor(ctx, db);
  const version = await lockDraftVersion(ctx, input.packId, input.versionId, db);
  if (version.contentHash !== input.expectedContentHash) throw new MethodologyDataConflictError();
  const updated = await db.methodologyPackVersion.updateMany({
    where: {
      id: input.versionId,
      tenantId: ctx.tenantId,
      packId: input.packId,
      status: 'draft',
      contentHash: input.expectedContentHash,
    },
    data: {
      versionKey: input.versionKey,
      engineRef: input.engineRef,
      contentHash: input.contentHash,
      learningContentRef: input.learningContentRef,
      sourceTemplateRef: input.sourceTemplateRef,
    },
  });
  if (updated.count !== 1) throw new MethodologyDataConflictError();
}

export async function createMethodologyStageState(
  ctx: MethodologyRepositoryContext,
  rawInput: MethodologyStageState,
  db: Db,
): Promise<void> {
  const input = MethodologyStageStateSchema.parse(rawInput);
  assertEmbeddedActor(ctx, input.updatedByUserId);
  await assertActor(ctx, db);
  const anchor = await loadBindingAnchor(ctx, input, db);
  const stage = await db.methodologyStageDefinition.findFirst({
    where: {
      tenantId: ctx.tenantId,
      packId: input.packId,
      versionId: input.versionId,
      key: input.stageKey,
    },
    select: { id: true },
  });
  if (!stage) throw new ScopedNotFoundError();
  await assertEvidenceIds(ctx, anchor, input.matterId, input.evidenceIdsJson, db);
  await db.methodologyStageState.create({ data: {
    id: input.id,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    bindingId: input.bindingId,
    packId: input.packId,
    versionId: input.versionId,
    stageKey: input.stageKey,
    enteredAt: new Date(input.enteredAt),
    humanOverride: input.humanOverride,
    overrideReason: input.overrideReason,
    evidenceIdsJson: input.evidenceIdsJson,
    updatedByUserId: input.updatedByUserId,
    updatedAt: new Date(input.updatedAt),
  } });
}

export async function createMethodologyRoleAssignment(
  ctx: MethodologyRepositoryContext,
  rawInput: MethodologyRoleAssignment,
  db: Db,
): Promise<void> {
  const input = MethodologyRoleAssignmentSchema.parse(rawInput);
  assertEmbeddedActor(ctx, input.assignedByUserId);
  await assertActor(ctx, db);
  const anchor = await loadBindingAnchor(ctx, input, db);

  // Role cardinality is an application invariant rather than a portable DB
  // constraint. Lock the Matter snapshot before counting so concurrent writers serialize.
  await lockMatterSnapshot(ctx, input.matterId, anchor.matterVersion, db);
  const role = await db.methodologyRoleDefinition.findFirst({
    where: {
      tenantId: ctx.tenantId,
      packId: input.packId,
      versionId: input.versionId,
      key: input.roleKey,
    },
    select: { maximumAssignments: true },
  });
  if (!role) throw new ScopedNotFoundError();
  const person = await db.person.findFirst({
    where: {
      id: input.personId,
      tenantId: ctx.tenantId,
      accountId: anchor.accountId,
      ...activePersonWhere,
    },
    select: { id: true },
  });
  if (!person) throw new ScopedNotFoundError();
  await assertEvidenceIds(ctx, anchor, input.matterId, input.evidenceIdsJson, db);
  const assigned = await db.methodologyRoleAssignment.count({
    where: {
      tenantId: ctx.tenantId,
      opportunityId: input.matterId,
      bindingId: input.bindingId,
      packId: input.packId,
      versionId: input.versionId,
      roleKey: input.roleKey,
    },
  });
  if (assigned >= role.maximumAssignments) {
    throw new MethodologyDataConflictError('该方法论角色已达到最大人数');
  }
  await db.methodologyRoleAssignment.create({ data: {
    id: input.id,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    bindingId: input.bindingId,
    packId: input.packId,
    versionId: input.versionId,
    roleKey: input.roleKey,
    personId: input.personId,
    source: input.source,
    reviewStatus: input.reviewStatus,
    evidenceIdsJson: input.evidenceIdsJson,
    assignedByUserId: input.assignedByUserId,
    assignedAt: new Date(input.assignedAt),
  } });
}

async function assertMethodologyValueTarget(
  ctx: MethodologyRepositoryContext,
  anchor: BindingAnchor,
  input: MethodologyValue,
  db: Db,
): Promise<void> {
  if (input.targetKind === 'matter') {
    if (input.targetId !== input.matterId) throw new ScopedNotFoundError();
    return;
  }
  if (input.targetKind === 'person') {
    const person = await db.person.findFirst({
      where: {
        id: input.targetId,
        tenantId: ctx.tenantId,
        accountId: anchor.accountId,
        ...activePersonWhere,
      },
      select: { id: true },
    });
    if (!person) throw new ScopedNotFoundError();
    return;
  }
  const relation = await db.edge.findFirst({
    where: {
      id: input.targetId,
      tenantId: ctx.tenantId,
      accountId: anchor.accountId,
      OR: [{ opportunityId: null }, { opportunityId: input.matterId }],
    },
    select: { id: true },
  });
  if (!relation) throw new ScopedNotFoundError();
}

export async function createMethodologyValue(
  ctx: MethodologyRepositoryContext,
  rawInput: MethodologyValue,
  db: Db,
): Promise<void> {
  const input = MethodologyValueSchema.parse(rawInput);
  assertEmbeddedActor(ctx, input.updatedByUserId);
  await assertActor(ctx, db);
  const anchor = await loadBindingAnchor(ctx, input, db);
  const field = await db.methodologyFieldDefinition.findFirst({
    where: {
      tenantId: ctx.tenantId,
      packId: input.packId,
      versionId: input.versionId,
      key: input.fieldKey,
    },
    select: { targetKind: true },
  });
  if (!field) throw new ScopedNotFoundError();
  if (field.targetKind !== input.targetKind) {
    throw new MethodologyDataConflictError('字段定义与目标类型不一致');
  }
  await assertMethodologyValueTarget(ctx, anchor, input, db);
  await assertEvidenceIds(ctx, anchor, input.matterId, input.evidenceIdsJson, db);
  await db.methodologyValue.create({ data: {
    id: input.id,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    bindingId: input.bindingId,
    packId: input.packId,
    versionId: input.versionId,
    fieldKey: input.fieldKey,
    targetKind: input.targetKind,
    targetId: input.targetId,
    normalizedValueJson: input.normalizedValueJson,
    source: input.source,
    reviewStatus: input.reviewStatus,
    evidenceIdsJson: input.evidenceIdsJson,
    updatedByUserId: input.updatedByUserId,
    updatedAt: new Date(input.updatedAt),
  } });
}

export async function createMethodologyEvaluation(
  ctx: MethodologyRepositoryContext,
  rawInput: MethodologyEvaluation,
  db: Db,
): Promise<void> {
  const input = MethodologyEvaluationSchema.parse(rawInput);
  assertEmbeddedActor(ctx, input.createdByUserId);
  await assertActor(ctx, db);
  const anchor = await loadBindingAnchor(ctx, input, db);
  if (input.packVersionKey !== anchor.versionKey || input.engineRef !== anchor.engineRef) {
    throw new MethodologyDataConflictError('评估快照与绑定的方法论版本不一致');
  }
  await assertEvidenceIds(ctx, anchor, input.matterId, input.evidenceIdsJson, db);
  await db.methodologyEvaluation.create({ data: {
    id: input.id,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    bindingId: input.bindingId,
    packId: input.packId,
    versionId: input.versionId,
    trigger: input.trigger,
    inputsJson: input.inputsJson,
    resultJson: input.resultJson,
    evidenceIdsJson: input.evidenceIdsJson,
    aclVersion: input.aclVersion,
    packVersionKey: input.packVersionKey,
    engineRef: input.engineRef,
    inputsHash: input.inputsHash,
    resultHash: input.resultHash,
    createdByUserId: input.createdByUserId,
    createdAt: new Date(input.createdAt),
  } });
}

export async function createMethodologyMigrationRun(
  ctx: MethodologyRepositoryContext,
  rawInput: MethodologyMigrationRun,
  db: Db,
): Promise<void> {
  const input = MethodologyMigrationRunSchema.parse(rawInput);
  if (input.status !== 'planned') {
    throw new MethodologyDataConflictError('基础仓储只允许创建待确认迁移计划');
  }
  assertEmbeddedActor(ctx, input.createdByUserId);
  await assertActor(ctx, db);
  const anchor = await loadBindingAnchor(ctx, {
    matterId: input.matterId,
    bindingId: input.sourceBindingId,
    packId: input.sourcePackId,
    versionId: input.sourceVersionId,
  }, db);
  if (
    anchor.matterVersion !== input.matterVersion
    || anchor.activeBindingId !== input.sourceBindingId
  ) {
    throw new MethodologyDataConflictError();
  }
  await lockMatterSnapshot(
    ctx,
    input.matterId,
    input.matterVersion,
    db,
    input.sourceBindingId,
  );
  const targetVersion = await db.methodologyPackVersion.findFirst({
    where: {
      id: input.targetVersionId,
      tenantId: ctx.tenantId,
      packId: input.targetPackId,
      status: 'published',
      pack: { tenantId: ctx.tenantId, archivedAt: null },
    },
    select: { id: true },
  });
  if (!targetVersion) throw new ScopedNotFoundError();

  await db.methodologyMigrationRun.create({ data: {
    id: input.id,
    tenantId: ctx.tenantId,
    opportunityId: input.matterId,
    sourceBindingId: input.sourceBindingId,
    sourcePackId: input.sourcePackId,
    sourceVersionId: input.sourceVersionId,
    targetPackId: input.targetPackId,
    targetVersionId: input.targetVersionId,
    matterVersion: input.matterVersion,
    status: input.status,
    dryRunJson: input.dryRunJson,
    mappingJson: input.mappingJson,
    conflictsJson: input.conflictsJson,
    confirmationJson: input.confirmationJson,
    executionJson: input.executionJson,
    rollbackJson: input.rollbackJson,
    confirmedByUserId: input.confirmedByUserId,
    confirmedAt: input.confirmedAt ? new Date(input.confirmedAt) : null,
    executedByUserId: input.executedByUserId,
    executedAt: input.executedAt ? new Date(input.executedAt) : null,
    rolledBackByUserId: input.rolledBackByUserId,
    rolledBackAt: input.rolledBackAt ? new Date(input.rolledBackAt) : null,
    createdByUserId: input.createdByUserId,
    createdAt: new Date(input.createdAt),
  } });
}
