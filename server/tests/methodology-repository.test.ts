import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  MethodologyDataConflictError,
  MethodologyVersionImmutableError,
  createMethodologyDefinitionSet,
  createMethodologyEvaluation,
  createMethodologyMigrationRun,
  createMethodologyRoleAssignment,
  createMethodologyStageState,
  createMethodologyValue,
  updateDraftMethodologyVersion,
} from '../src/methodology/repository.js';
import { ScopedNotFoundError } from '../src/mutation/scopeGuards.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type Tx = Prisma.TransactionClient;

interface MethodologyGraph {
  customerId: string;
  matterId: string;
  personId: string;
  relationId: string;
  evidenceId: string;
  packId: string;
  versionId: string;
  bindingId: string;
  targetVersionId: string;
}

const repositoryContext = (context: TestContext) => ({
  tenantId: context.tenant.id,
  actorId: context.owner.id,
});

const definitionSet = (packId: string, versionId: string) => ({
  packId,
  versionId,
  fields: [
    {
      id: `field-matter-${versionId}`, packId, versionId, key: 'followup.note', targetKind: 'matter' as const,
      dataType: 'string', valueDomainJson: '{}', required: false, missingValuePolicy: 'null',
      storageBindingKind: 'methodology_value' as const,
      storageBindingPath: 'MethodologyValue(followup.note)', legacyStopDate: null,
      legacyConsumersJson: '[]', position: 0,
    },
    {
      id: `field-person-${versionId}`, packId, versionId, key: 'stakeholder.signal', targetKind: 'person' as const,
      dataType: 'string', valueDomainJson: '{}', required: false, missingValuePolicy: 'null',
      storageBindingKind: 'methodology_value' as const,
      storageBindingPath: 'MethodologyValue(stakeholder.signal)', legacyStopDate: null,
      legacyConsumersJson: '[]', position: 1,
    },
    {
      id: `field-relation-${versionId}`, packId, versionId, key: 'relation.strength', targetKind: 'relation' as const,
      dataType: 'number', valueDomainJson: '{}', required: false, missingValuePolicy: 'null',
      storageBindingKind: 'methodology_value' as const,
      storageBindingPath: 'MethodologyValue(relation.strength)', legacyStopDate: null,
      legacyConsumersJson: '[]', position: 2,
    },
  ],
  stages: [{
    id: `stage-${versionId}`, packId, versionId, key: 'discover', name: '发现', position: 0,
    entryConditionsJson: '[]', exitConditionsJson: '[]',
  }],
  roles: [{
    id: `role-${versionId}`, packId, versionId, key: 'sponsor', name: '发起人', appliesTo: 'person' as const,
    constraintsJson: '{}', minimumAssignments: 0, maximumAssignments: 1, position: 0,
  }],
  rules: [{
    id: `rule-${versionId}`, packId, versionId, key: 'note-present', operator: 'all',
    inputRefsJson: JSON.stringify(['followup.note']), weightsJson: '{}', thresholdsJson: '{}',
    outputKey: 'followup.ready', position: 0,
  }],
  actions: [{
    id: `action-${versionId}`, packId, versionId, key: 'confirm-note', gapKey: 'note_missing',
    title: '确认下一步', script: '请确认下一步安排', evidenceRequirementsJson: JSON.stringify(['meeting_note']),
    position: 0,
  }],
});

async function seedDraft(context: TestContext, suffix: string) {
  const customerId = `customer-${suffix}`;
  const matterId = `matter-${suffix}`;
  const packId = `pack-${suffix}`;
  const versionId = `version-${suffix}`;
  await context.prisma.account.create({ data: {
    id: customerId, tenantId: context.tenant.id, name: `Customer ${suffix}`, customerType: 1,
  } });
  await context.prisma.opportunity.create({ data: {
    id: matterId, tenantId: context.tenant.id, accountId: customerId, name: `Matter ${suffix}`,
    customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
  } });
  await context.prisma.methodologyPack.create({ data: {
    id: packId, tenantId: context.tenant.id, key: `methodology.${suffix}`, name: `Methodology ${suffix}`,
    createdByUserId: context.owner.id,
  } });
  await context.prisma.methodologyPackVersion.create({ data: {
    id: versionId, tenantId: context.tenant.id, packId, versionKey: '1.0.0-draft', status: 'draft',
    engineRef: 'none:1', contentHash: 'a'.repeat(64), createdByUserId: context.owner.id,
  } });
  return { customerId, matterId, packId, versionId };
}

async function seedPublishedGraph(context: TestContext, suffix: string): Promise<MethodologyGraph> {
  const draft = await seedDraft(context, suffix);
  await context.prisma.$transaction((tx) => createMethodologyDefinitionSet(
    repositoryContext(context), definitionSet(draft.packId, draft.versionId), tx,
  ));
  const now = new Date('2026-08-22T00:00:00.000Z');
  await context.prisma.methodologyPackVersion.update({
    where: { id: draft.versionId },
    data: { status: 'published', versionKey: '1.0.0', publishedByUserId: context.owner.id, publishedAt: now },
  });
  await context.prisma.methodologyPack.update({
    where: { id: draft.packId }, data: { currentPublishedVersionId: draft.versionId },
  });
  const bindingId = `binding-${suffix}`;
  await context.prisma.methodologyBinding.create({ data: {
    id: bindingId, tenantId: context.tenant.id, opportunityId: draft.matterId,
    packId: draft.packId, versionId: draft.versionId, createdByUserId: context.owner.id,
  } });
  await context.prisma.opportunity.update({
    where: { id: draft.matterId }, data: { activeMethodologyBindingId: bindingId, version: { increment: 1 } },
  });

  const personId = `person-${suffix}`;
  await context.prisma.person.create({ data: {
    id: personId, tenantId: context.tenant.id, accountId: draft.customerId, name: `Person ${suffix}`, title: 'Sponsor',
  } });
  const relationId = `relation-${suffix}`;
  await context.prisma.edge.create({ data: {
    id: relationId, tenantId: context.tenant.id, accountId: draft.customerId,
    opportunityId: draft.matterId, source: personId, target: personId,
    layer: 'L1', label: 'self fixture',
  } });
  const evidenceId = `evidence-${suffix}`;
  await context.prisma.evidenceEvent.create({ data: {
    id: evidenceId, tenantId: context.tenant.id, accountId: draft.customerId,
    opportunityId: draft.matterId, personId, signalKey: 'manual_confirmation',
  } });
  const targetVersionId = `version-target-${suffix}`;
  await context.prisma.methodologyPackVersion.create({ data: {
    id: targetVersionId, tenantId: context.tenant.id, packId: draft.packId, versionKey: '2.0.0',
    status: 'published', engineRef: 'none:2', contentHash: 'c'.repeat(64),
    createdByUserId: context.owner.id, publishedByUserId: context.owner.id, publishedAt: now,
  } });
  return { ...draft, personId, relationId, evidenceId, bindingId, targetVersionId };
}

describe('CORE-111 methodology base repository', () => {
  it('writes a draft definition set atomically and refuses every published-version mutation', async () => {
    const context = await createTestContext();
    try {
      const draft = await seedDraft(context, `draft-${randomUUID()}`);
      await context.prisma.$transaction((tx) => createMethodologyDefinitionSet(
        repositoryContext(context), definitionSet(draft.packId, draft.versionId), tx,
      ));
      expect({
        fields: await context.prisma.methodologyFieldDefinition.count(),
        stages: await context.prisma.methodologyStageDefinition.count(),
        roles: await context.prisma.methodologyRoleDefinition.count(),
        rules: await context.prisma.methodologyRuleDefinition.count(),
        actions: await context.prisma.methodologyActionTemplate.count(),
      }).toEqual({ fields: 3, stages: 1, roles: 1, rules: 1, actions: 1 });

      await context.prisma.$transaction((tx) => updateDraftMethodologyVersion(repositoryContext(context), {
        packId: draft.packId,
        versionId: draft.versionId,
        expectedContentHash: 'a'.repeat(64),
        versionKey: '1.0.1-draft',
        engineRef: 'none:2',
        contentHash: 'b'.repeat(64),
        learningContentRef: null,
        sourceTemplateRef: null,
      }, tx));
      expect(await context.prisma.methodologyPackVersion.findUniqueOrThrow({ where: { id: draft.versionId } }))
        .toMatchObject({ status: 'draft', versionKey: '1.0.1-draft', contentHash: 'b'.repeat(64) });

      await context.prisma.methodologyPackVersion.update({
        where: { id: draft.versionId },
        data: { status: 'published', publishedByUserId: context.owner.id, publishedAt: new Date() },
      });
      await expect(context.prisma.$transaction((tx) => updateDraftMethodologyVersion(repositoryContext(context), {
        packId: draft.packId,
        versionId: draft.versionId,
        expectedContentHash: 'b'.repeat(64),
        versionKey: '1.0.2',
        engineRef: 'none:3',
        contentHash: 'd'.repeat(64),
        learningContentRef: null,
        sourceTemplateRef: null,
      }, tx))).rejects.toBeInstanceOf(MethodologyVersionImmutableError);
      await expect(context.prisma.$transaction((tx) => createMethodologyDefinitionSet(
        repositoryContext(context), { ...definitionSet(draft.packId, draft.versionId), stages: [] }, tx,
      ))).rejects.toBeInstanceOf(MethodologyVersionImmutableError);
      expect(await context.prisma.methodologyPackVersion.findUniqueOrThrow({ where: { id: draft.versionId } }))
        .toMatchObject({ status: 'published', contentHash: 'b'.repeat(64) });
    } finally {
      await context.cleanup();
    }
  });

  it('rolls back every definition table when a later definition insert fails', async () => {
    const context = await createTestContext();
    try {
      const draft = await seedDraft(context, `atomic-${randomUUID()}`);
      const definitions = definitionSet(draft.packId, draft.versionId);
      await expect(context.prisma.$transaction((tx) => createMethodologyDefinitionSet(
        repositoryContext(context),
        {
          ...definitions,
          actions: [
            ...definitions.actions,
            { ...definitions.actions[0], id: `duplicate-action-${randomUUID()}` },
          ],
        },
        tx,
      ))).rejects.toBeTruthy();
      expect({
        fields: await context.prisma.methodologyFieldDefinition.count(),
        stages: await context.prisma.methodologyStageDefinition.count(),
        roles: await context.prisma.methodologyRoleDefinition.count(),
        rules: await context.prisma.methodologyRuleDefinition.count(),
        actions: await context.prisma.methodologyActionTemplate.count(),
      }).toEqual({ fields: 0, stages: 0, roles: 0, rules: 0, actions: 0 });
    } finally {
      await context.cleanup();
    }
  });

  it('persists bound stage, role, value, evaluation and migration snapshots without changing the active pointer', async () => {
    const context = await createTestContext();
    try {
      const graph = await seedPublishedGraph(context, `valid-${randomUUID()}`);
      const ctx = repositoryContext(context);
      await context.prisma.$transaction((tx) => createMethodologyStageState(ctx, {
        id: `stage-state-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, stageKey: 'discover',
        enteredAt: '2026-08-22T00:00:00Z', humanOverride: true, overrideReason: '人工确认',
        evidenceIdsJson: JSON.stringify([graph.evidenceId]), updatedByUserId: context.owner.id,
        updatedAt: '2026-08-22T00:00:00Z',
      }, tx));
      await context.prisma.$transaction((tx) => createMethodologyRoleAssignment(ctx, {
        id: `role-assignment-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, roleKey: 'sponsor', personId: graph.personId,
        source: 'manual', reviewStatus: 'confirmed', evidenceIdsJson: JSON.stringify([graph.evidenceId]),
        assignedByUserId: context.owner.id, assignedAt: '2026-08-22T00:00:00Z',
      }, tx));
      await context.prisma.$transaction((tx) => createMethodologyValue(ctx, {
        id: `value-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, fieldKey: 'followup.note',
        targetKind: 'matter', targetId: graph.matterId, normalizedValueJson: JSON.stringify('已确认'),
        source: 'manual', reviewStatus: 'confirmed', evidenceIdsJson: JSON.stringify([graph.evidenceId]),
        updatedByUserId: context.owner.id, updatedAt: '2026-08-22T00:00:00Z',
      }, tx));
      await context.prisma.$transaction((tx) => createMethodologyEvaluation(ctx, {
        id: `evaluation-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, trigger: 'manual',
        inputsJson: JSON.stringify({ note: '已确认' }), resultJson: JSON.stringify({ ready: true }),
        evidenceIdsJson: JSON.stringify([graph.evidenceId]), aclVersion: 1, packVersionKey: '1.0.0',
        engineRef: 'none:1', inputsHash: 'a'.repeat(64), resultHash: 'b'.repeat(64),
        createdByUserId: context.owner.id, createdAt: '2026-08-22T00:00:00Z',
      }, tx));
      await context.prisma.$transaction((tx) => createMethodologyMigrationRun(ctx, {
        id: `migration-${randomUUID()}`, matterId: graph.matterId, sourceBindingId: graph.bindingId,
        sourcePackId: graph.packId, sourceVersionId: graph.versionId,
        targetPackId: graph.packId, targetVersionId: graph.targetVersionId, matterVersion: 1,
        status: 'planned', dryRunJson: JSON.stringify({ affected: 1 }), mappingJson: '{}', conflictsJson: '[]',
        confirmationJson: '{}', executionJson: '{}', rollbackJson: '{}',
        confirmedByUserId: null, confirmedAt: null, executedByUserId: null, executedAt: null,
        rolledBackByUserId: null, rolledBackAt: null, createdByUserId: context.owner.id,
        createdAt: '2026-08-22T00:00:00Z',
      }, tx));

      expect({
        stages: await context.prisma.methodologyStageState.count(),
        roles: await context.prisma.methodologyRoleAssignment.count(),
        values: await context.prisma.methodologyValue.count(),
        evaluations: await context.prisma.methodologyEvaluation.count(),
        migrations: await context.prisma.methodologyMigrationRun.count(),
      }).toEqual({ stages: 1, roles: 1, values: 1, evaluations: 1, migrations: 1 });
      expect(await context.prisma.opportunity.findUniqueOrThrow({ where: { id: graph.matterId } }))
        .toMatchObject({ activeMethodologyBindingId: graph.bindingId, version: 1 });
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for wrong-account targets, cross-tenant bindings, evidence drift and engine drift', async () => {
    const context = await createTestContext();
    try {
      const graph = await seedPublishedGraph(context, `scope-${randomUUID()}`);
      const otherCustomerId = `other-customer-${randomUUID()}`;
      const otherMatterId = `other-matter-${randomUUID()}`;
      const otherPersonId = `other-person-${randomUUID()}`;
      const otherRelationId = `other-relation-${randomUUID()}`;
      const otherEvidenceId = `other-evidence-${randomUUID()}`;
      await context.prisma.account.create({ data: {
        id: otherCustomerId, tenantId: context.tenant.id, name: 'Other customer', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: otherMatterId, tenantId: context.tenant.id, accountId: otherCustomerId, name: 'Other matter',
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
      } });
      await context.prisma.person.create({ data: {
        id: otherPersonId, tenantId: context.tenant.id, accountId: otherCustomerId, name: 'Other person', title: 'Other',
      } });
      await context.prisma.edge.create({ data: {
        id: otherRelationId, tenantId: context.tenant.id, accountId: otherCustomerId,
        opportunityId: otherMatterId, source: otherPersonId, target: otherPersonId, layer: 'L1', label: 'Other',
      } });
      await context.prisma.evidenceEvent.create({ data: {
        id: otherEvidenceId, tenantId: context.tenant.id, accountId: otherCustomerId,
        opportunityId: otherMatterId, personId: otherPersonId, signalKey: 'other',
      } });

      const ctx = repositoryContext(context);
      await expect(context.prisma.$transaction((tx) => createMethodologyRoleAssignment(ctx, {
        id: `bad-role-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, roleKey: 'sponsor', personId: otherPersonId,
        source: 'manual', reviewStatus: 'confirmed', evidenceIdsJson: '[]',
        assignedByUserId: context.owner.id, assignedAt: '2026-08-22T00:00:00Z',
      }, tx))).rejects.toBeInstanceOf(ScopedNotFoundError);
      await expect(context.prisma.$transaction((tx) => createMethodologyValue(ctx, {
        id: `bad-person-value-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, fieldKey: 'stakeholder.signal',
        targetKind: 'person', targetId: otherPersonId, normalizedValueJson: JSON.stringify('wrong'),
        source: 'manual', reviewStatus: 'confirmed', evidenceIdsJson: '[]',
        updatedByUserId: context.owner.id, updatedAt: '2026-08-22T00:00:00Z',
      }, tx))).rejects.toBeInstanceOf(ScopedNotFoundError);
      await expect(context.prisma.$transaction((tx) => createMethodologyValue(ctx, {
        id: `bad-relation-value-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, fieldKey: 'relation.strength',
        targetKind: 'relation', targetId: otherRelationId, normalizedValueJson: '1',
        source: 'manual', reviewStatus: 'confirmed', evidenceIdsJson: '[]',
        updatedByUserId: context.owner.id, updatedAt: '2026-08-22T00:00:00Z',
      }, tx))).rejects.toBeInstanceOf(ScopedNotFoundError);

      const evaluationBase = {
        id: `bad-evaluation-${randomUUID()}`, matterId: graph.matterId, bindingId: graph.bindingId,
        packId: graph.packId, versionId: graph.versionId, trigger: 'manual', inputsJson: '{}', resultJson: '{}',
        evidenceIdsJson: JSON.stringify([otherEvidenceId]), aclVersion: 1, packVersionKey: '1.0.0',
        engineRef: 'none:1', inputsHash: 'a'.repeat(64), resultHash: 'b'.repeat(64),
        createdByUserId: context.owner.id, createdAt: '2026-08-22T00:00:00Z',
      };
      await expect(context.prisma.$transaction((tx) => createMethodologyEvaluation(ctx, evaluationBase, tx)))
        .rejects.toBeInstanceOf(ScopedNotFoundError);
      await expect(context.prisma.$transaction((tx) => createMethodologyEvaluation(ctx, {
        ...evaluationBase, id: `engine-drift-${randomUUID()}`,
        evidenceIdsJson: JSON.stringify([graph.evidenceId]), engineRef: 'none:999',
      }, tx))).rejects.toBeInstanceOf(MethodologyDataConflictError);

      const foreignTenantId = `foreign-tenant-${randomUUID()}`;
      const foreignUserId = `foreign-user-${randomUUID()}`;
      const foreignCustomerId = `foreign-customer-${randomUUID()}`;
      const foreignMatterId = `foreign-matter-${randomUUID()}`;
      const foreignPackId = `foreign-pack-${randomUUID()}`;
      const foreignVersionId = `foreign-version-${randomUUID()}`;
      const foreignBindingId = `foreign-binding-${randomUUID()}`;
      await context.prisma.tenant.create({ data: { id: foreignTenantId, name: 'Foreign tenant' } });
      await context.prisma.user.create({ data: {
        id: foreignUserId, tenantId: foreignTenantId, email: `${foreignUserId}@example.test`,
        passwordHash: 'unused', name: 'Foreign user', role: 'owner',
      } });
      await context.prisma.account.create({ data: {
        id: foreignCustomerId, tenantId: foreignTenantId, name: 'Foreign customer', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: foreignMatterId, tenantId: foreignTenantId, accountId: foreignCustomerId, name: 'Foreign matter',
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
      } });
      await context.prisma.methodologyPack.create({ data: {
        id: foreignPackId, tenantId: foreignTenantId, key: foreignPackId, name: 'Foreign pack', createdByUserId: foreignUserId,
      } });
      await context.prisma.methodologyPackVersion.create({ data: {
        id: foreignVersionId, tenantId: foreignTenantId, packId: foreignPackId, versionKey: '1.0.0',
        status: 'published', engineRef: 'none:1', contentHash: 'f'.repeat(64), createdByUserId: foreignUserId,
        publishedByUserId: foreignUserId, publishedAt: new Date(),
      } });
      await context.prisma.methodologyBinding.create({ data: {
        id: foreignBindingId, tenantId: foreignTenantId, opportunityId: foreignMatterId,
        packId: foreignPackId, versionId: foreignVersionId, createdByUserId: foreignUserId,
      } });
      await expect(context.prisma.$transaction((tx) => createMethodologyStageState(ctx, {
        id: `cross-stage-${randomUUID()}`, matterId: foreignMatterId, bindingId: foreignBindingId,
        packId: foreignPackId, versionId: foreignVersionId, stageKey: 'discover',
        enteredAt: '2026-08-22T00:00:00Z', humanOverride: false, overrideReason: null,
        evidenceIdsJson: '[]', updatedByUserId: context.owner.id, updatedAt: '2026-08-22T00:00:00Z',
      }, tx))).rejects.toBeInstanceOf(ScopedNotFoundError);
      expect({
        roles: await context.prisma.methodologyRoleAssignment.count(),
        values: await context.prisma.methodologyValue.count(),
        evaluations: await context.prisma.methodologyEvaluation.count(),
        stages: await context.prisma.methodologyStageState.count(),
      }).toEqual({ roles: 0, values: 0, evaluations: 0, stages: 0 });
    } finally {
      await context.cleanup();
    }
  });

  it('requires the exact current Matter version and active binding before recording a migration run', async () => {
    const context = await createTestContext();
    try {
      const graph = await seedPublishedGraph(context, `cas-${randomUUID()}`);
      await context.prisma.opportunity.update({ where: { id: graph.matterId }, data: { version: { increment: 1 } } });
      await expect(context.prisma.$transaction((tx: Tx) => createMethodologyMigrationRun(repositoryContext(context), {
        id: `migration-cas-${randomUUID()}`, matterId: graph.matterId, sourceBindingId: graph.bindingId,
        sourcePackId: graph.packId, sourceVersionId: graph.versionId,
        targetPackId: graph.packId, targetVersionId: graph.targetVersionId, matterVersion: 1,
        status: 'planned', dryRunJson: '{}', mappingJson: '{}', conflictsJson: '[]',
        confirmationJson: '{}', executionJson: '{}', rollbackJson: '{}',
        confirmedByUserId: null, confirmedAt: null, executedByUserId: null, executedAt: null,
        rolledBackByUserId: null, rolledBackAt: null, createdByUserId: context.owner.id,
        createdAt: '2026-08-22T00:00:00Z',
      }, tx))).rejects.toBeInstanceOf(MethodologyDataConflictError);
      expect(await context.prisma.methodologyMigrationRun.count()).toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('serializes role cardinality and refuses assignments beyond the versioned definition', async () => {
    const context = await createTestContext();
    try {
      const graph = await seedPublishedGraph(context, `cardinality-${randomUUID()}`);
      const ctx = repositoryContext(context);
      const assignment = (id: string) => ({
        id,
        matterId: graph.matterId,
        bindingId: graph.bindingId,
        packId: graph.packId,
        versionId: graph.versionId,
        roleKey: 'sponsor',
        personId: graph.personId,
        source: 'manual',
        reviewStatus: 'confirmed' as const,
        evidenceIdsJson: '[]',
        assignedByUserId: context.owner.id,
        assignedAt: '2026-08-22T00:00:00Z',
      });
      await context.prisma.$transaction((tx) => createMethodologyRoleAssignment(
        ctx,
        assignment(`role-first-${randomUUID()}`),
        tx,
      ));

      const secondPersonId = `person-second-${randomUUID()}`;
      await context.prisma.person.create({ data: {
        id: secondPersonId,
        tenantId: context.tenant.id,
        accountId: graph.customerId,
        name: 'Second sponsor',
        title: 'Sponsor',
      } });
      await expect(context.prisma.$transaction((tx) => createMethodologyRoleAssignment(
        ctx,
        {
          ...assignment(`role-second-${randomUUID()}`),
          personId: secondPersonId,
        },
        tx,
      ))).rejects.toBeInstanceOf(MethodologyDataConflictError);
      expect(await context.prisma.methodologyRoleAssignment.count()).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps all methodology-data mutations behind the repository boundary', async () => {
    const root = resolve('src');
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
      }
    };
    await visit(root);
    const dataMutationPattern = /methodology(?:FieldDefinition|StageDefinition|RoleDefinition|RuleDefinition|ActionTemplate|StageState|RoleAssignment|Value|Evaluation|MigrationRun)\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/g;
    const releasedVersionMutationPattern = /methodologyPackVersion\.(?:createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/g;
    const violations: string[] = [];
    for (const file of files) {
      if (file.endsWith(join('methodology', 'repository.ts'))) continue;
      const source = await readFile(file, 'utf8');
      if (dataMutationPattern.test(source) || releasedVersionMutationPattern.test(source)) {
        violations.push(file);
      }
      dataMutationPattern.lastIndex = 0;
      releasedVersionMutationPattern.lastIndex = 0;
    }
    expect(violations).toEqual([]);
  });
});
