import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { evaluate } from 'pde-kernel';
import { createTestContext } from './helpers/testApp.js';
import { applyAction } from '../src/mutate.js';
import { loadSeeds } from '../src/pde/pack.js';
import {
  PDE_DECISION_CONTEXT_MIGRATION_KEY,
  backfillPdeDecisionContexts,
  inspectPdeDecisionContextMigration,
  mapLegacyEngageStageToPdeStage,
  verifyPdeDecisionContextIntegrity,
} from '../src/pde/decisionContextMigration.js';

async function seedRuntimeMatter(
  context: Awaited<ReturnType<typeof createTestContext>>,
  suffix: string,
  options: { withContext?: boolean; engageStage?: string; stageKey?: string } = {},
) {
  const accountId = `pde-runtime-account-${suffix}`;
  const opportunityId = `pde-runtime-opportunity-${suffix}`;
  await context.prisma.account.create({
    data: { id: accountId, tenantId: context.tenant.id, name: `PDE runtime ${suffix}`, customerType: 1 },
  });
  await context.prisma.opportunity.create({ data: {
    id: opportunityId,
    tenantId: context.tenant.id,
    accountId,
    name: `PDE runtime ${suffix}`,
    customerType: 1,
    pipelineStage: '线索',
    engageStage: options.engageStage ?? '招采执行',
    expectedAmountW: 100,
  } });
  if (options.withContext) {
    await context.prisma.pdeDecisionContext.create({ data: {
      id: `pde-runtime-context-${suffix}`,
      tenantId: context.tenant.id,
      opportunityId,
      stageKey: options.stageKey ?? 'budget_approval',
      source: 'legacy_shadow',
    } });
  }
  return { accountId, opportunityId };
}

describe('CORE-113 PDE decision context migration', () => {
  it('preserves every legacy stage mapping including the old unknown fallback', () => {
    expect([
      '需求调研立项',
      '方案可研',
      '预算批复',
      '招标论证',
      '招采执行',
      'discover',
    ].map(mapLegacyEngageStageToPdeStage)).toEqual([
      'initiation',
      'feasibility',
      'budget_approval',
      'tender_design',
      'tender_execution',
      'initiation',
    ]);
  });

  it('backfills tenant-scoped shadows atomically without borrowing a foreign profile', async () => {
    const context = await createTestContext();
    try {
      const tenantId = context.tenant.id;
      await context.prisma.account.create({
        data: { id: 'pde-context-account', tenantId, name: 'PDE context', customerType: 1 },
      });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: 'pde-context-known', tenantId, accountId: 'pde-context-account', name: 'Known',
          customerType: 1, pipelineStage: '线索', engageStage: '预算批复',
        },
        {
          id: 'pde-context-unknown', tenantId, accountId: 'pde-context-account', name: 'Unknown legacy',
          customerType: 1, pipelineStage: 'legacy', engageStage: 'discover',
        },
      ] });
      const localPack = await context.prisma.industryPack.create({ data: {
        id: 'pde-context-local-pack', tenantId, packKey: 'digital-energy', schemaVersion: '1.1',
        payload: '{}', active: true,
      } });

      const foreignTenant = await context.prisma.tenant.create({
        data: { id: `pde-context-foreign-${randomUUID()}`, name: 'Foreign PDE context' },
      });
      await context.prisma.account.create({ data: {
        id: 'pde-context-foreign-account', tenantId: foreignTenant.id, name: 'Foreign', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'pde-context-foreign-matter', tenantId: foreignTenant.id,
        accountId: 'pde-context-foreign-account', name: 'Foreign', customerType: 1,
        pipelineStage: '线索', engageStage: '招采执行',
      } });

      const report = await inspectPdeDecisionContextMigration(context.prisma);
      expect(report).toMatchObject({
        sourceRows: 3,
        candidateRows: 3,
        missingDecisionProfileRows: 1,
        parityConflicts: [],
      });

      const first = await backfillPdeDecisionContexts(context.prisma);
      const second = await backfillPdeDecisionContexts(context.prisma);
      expect(first).toMatchObject({ candidateRows: 3, createdRows: 3, existingRows: 0 });
      expect(second).toMatchObject({ candidateRows: 3, createdRows: 0, existingRows: 3 });

      await expect(context.prisma.pdeDecisionContext.findMany({
        orderBy: { opportunityId: 'asc' },
        select: { opportunityId: true, stageKey: true, decisionProfileRef: true, source: true },
      })).resolves.toEqual([
        {
          opportunityId: 'pde-context-foreign-matter', stageKey: 'tender_execution',
          decisionProfileRef: null, source: 'legacy_shadow',
        },
        {
          opportunityId: 'pde-context-known', stageKey: 'budget_approval',
          decisionProfileRef: localPack.id, source: 'legacy_shadow',
        },
        {
          opportunityId: 'pde-context-unknown', stageKey: 'initiation',
          decisionProfileRef: localPack.id, source: 'legacy_shadow',
        },
      ]);
      await expect(context.prisma.dataMigrationState.findUnique({
        where: { key: PDE_DECISION_CONTEXT_MIGRATION_KEY },
      })).resolves.toMatchObject({ key: PDE_DECISION_CONTEXT_MIGRATION_KEY });
      await expect(verifyPdeDecisionContextIntegrity(context.prisma)).resolves.toMatchObject({
        markerPresent: true,
        missingContexts: 0,
      });

      await context.prisma.opportunity.create({ data: {
        id: 'pde-context-created-after-cutover',
        tenantId,
        accountId: 'pde-context-account',
        name: 'Created after cutover',
        customerType: 1,
        pipelineStage: '线索',
        engageStage: '需求调研立项',
      } });
      await expect(backfillPdeDecisionContexts(context.prisma))
        .rejects.toThrow('legacy PDE decision context backfill is disabled after cutover');
      await expect(verifyPdeDecisionContextIntegrity(context.prisma))
        .rejects.toThrow('"missingContexts":1');
    } finally {
      await context.cleanup();
    }
  });
});

describe('CORE-113 PDE decision context runtime authority', () => {
  it('fails closed when a visible Matter has no PDE decision context', async () => {
    const context = await createTestContext();
    try {
      const { opportunityId } = await seedRuntimeMatter(context, 'missing');
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/pde/${opportunityId}/ev`,
        headers: { authorization: `Bearer ${context.token}` },
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'pde_context_uninitialized' });
    } finally {
      await context.cleanup();
    }
  });

  it('reads the independent stageKey and never changes PDE stage when engageStage changes', async () => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedRuntimeMatter(context, 'authority', {
        withContext: true,
        engageStage: '招采执行',
        stageKey: 'budget_approval',
      });
      const getStage = async () => {
        const response = await context.app.inject({
          method: 'GET',
          url: `/api/pde/${opportunityId}/ev`,
          headers: { authorization: `Bearer ${context.token}` },
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ stage: string }>().stage;
      };

      await expect(getStage()).resolves.toBe('budget_approval');
      const commandContext: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'pde-authority-test',
        assertionMode: 'user_asserted',
      };
      const effect = await context.prisma.$transaction((tx) => applyAction(commandContext, {
        type: 'UPDATE_OPP',
        accId: accountId,
        oppId: opportunityId,
        patch: { engageStage: '需求调研立项' },
      }, tx));

      expect(effect).toBeUndefined();
      await expect(getStage()).resolves.toBe('budget_approval');
      await expect(context.prisma.eVSnapshot.count({
        where: { tenantId: context.tenant.id, opportunityId, trigger: 'stage_gate' },
      })).resolves.toBe(0);

      const assembler = await readFile(new URL('../src/pde/assemble.ts', import.meta.url), 'utf8');
      expect(assembler).not.toContain('engageStage');
      expect(assembler).not.toContain('STAGE_MAP');
    } finally {
      await context.cleanup();
    }
  });

  it('updates context through an idempotent human CAS command and snapshots the exact authority', async () => {
    const context = await createTestContext();
    try {
      const { opportunityId } = await seedRuntimeMatter(context, 'command', {
        withContext: true,
        stageKey: 'initiation',
      });
      const request = () => context.app.inject({
        method: 'PUT',
        url: `/api/pde/${opportunityId}/context`,
        headers: {
          authorization: `Bearer ${context.token}`,
          'idempotency-key': 'pde-context-command-001',
        },
        payload: {
          stageKey: 'feasibility',
          decisionProfileRef: null,
          baseVersion: 0,
        },
      });

      const first = await request();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        stageKey: 'feasibility',
        decisionProfileRef: null,
        version: 1,
        changed: true,
        replayed: false,
        snapshotId: expect.any(String),
      });
      const replay = await request();
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ version: 1, replayed: true });

      await expect(context.prisma.pdeDecisionContext.findFirstOrThrow({
        where: { tenantId: context.tenant.id, opportunityId },
      })).resolves.toMatchObject({
        stageKey: 'feasibility', decisionProfileRef: null, source: 'manual', version: 1,
      });
      const snapshot = await context.prisma.eVSnapshot.findFirstOrThrow({
        where: { tenantId: context.tenant.id, opportunityId, trigger: 'pde_context_changed' },
      });
      const snapshotInputs = JSON.parse(snapshot.inputsJson);
      expect(snapshotInputs.metadata.pdeDecisionContext).toMatchObject({
        stageKey: 'feasibility', decisionProfileRef: null, version: 1,
      });
      const replayedEvaluation = evaluate(snapshotInputs.deal);
      const snapshotResult = JSON.parse(snapshot.resultJson);
      expect(JSON.parse(JSON.stringify(replayedEvaluation))).toEqual(snapshotResult.eval);
      await expect(context.prisma.auditEvent.findFirst({
        where: { tenantId: context.tenant.id, entityId: opportunityId, action: 'pde_context_updated' },
      })).resolves.toMatchObject({ entityKind: 'pde_decision_context' });

      const stale = await context.app.inject({
        method: 'PUT',
        url: `/api/pde/${opportunityId}/context`,
        headers: {
          authorization: `Bearer ${context.token}`,
          'idempotency-key': 'pde-context-command-002',
        },
        payload: { stageKey: 'tender_design', decisionProfileRef: null, baseVersion: 0 },
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'pde_context_version_conflict' });
    } finally {
      await context.cleanup();
    }
  });

  it('revalidates the current actor role and never accepts a foreign or invalid decision profile', async () => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedRuntimeMatter(context, 'authorization', {
        withContext: true,
        stageKey: 'initiation',
      });
      await context.prisma.account.update({
        where: { id: accountId },
        data: { primaryOwnerUserId: context.owner.id },
      });
      await context.prisma.user.update({
        where: { id: context.owner.id },
        data: { role: 'viewer' },
      });
      const staleOwnerToken = await context.app.inject({
        method: 'PUT',
        url: `/api/pde/${opportunityId}/context`,
        headers: {
          authorization: `Bearer ${context.token}`,
          'idempotency-key': 'pde-context-role-recheck',
        },
        payload: { stageKey: 'feasibility', decisionProfileRef: null, baseVersion: 0 },
      });
      expect(staleOwnerToken.statusCode, staleOwnerToken.body).toBe(403);
      expect(staleOwnerToken.json()).toMatchObject({ code: 'pde_context_write_forbidden' });
      await context.prisma.user.update({ where: { id: context.owner.id }, data: { role: 'owner' } });

      const foreignTenant = await context.prisma.tenant.create({
        data: { id: `pde-profile-foreign-${randomUUID()}`, name: 'Foreign PDE profile tenant' },
      });
      const foreignPack = await context.prisma.industryPack.create({ data: {
        id: 'pde-profile-foreign-pack',
        tenantId: foreignTenant.id,
        packKey: 'digital-energy',
        schemaVersion: '1.1',
        payload: JSON.stringify(loadSeeds()),
        active: true,
      } });
      const foreignAttempt = await context.app.inject({
        method: 'PUT',
        url: `/api/pde/${opportunityId}/context`,
        headers: {
          authorization: `Bearer ${context.token}`,
          'idempotency-key': 'pde-context-foreign-profile',
        },
        payload: { stageKey: 'feasibility', decisionProfileRef: foreignPack.id, baseVersion: 0 },
      });
      expect(foreignAttempt.statusCode, foreignAttempt.body).toBe(409);
      expect(foreignAttempt.json()).toMatchObject({ code: 'pde_decision_profile_unavailable' });

      const invalidPack = await context.prisma.industryPack.create({ data: {
        id: 'pde-profile-invalid-pack',
        tenantId: context.tenant.id,
        packKey: 'invalid-profile',
        schemaVersion: '1.0',
        payload: '{}',
        active: true,
      } });
      const invalidAttempt = await context.app.inject({
        method: 'PUT',
        url: `/api/pde/${opportunityId}/context`,
        headers: {
          authorization: `Bearer ${context.token}`,
          'idempotency-key': 'pde-context-invalid-profile',
        },
        payload: { stageKey: 'feasibility', decisionProfileRef: invalidPack.id, baseVersion: 0 },
      });
      expect(invalidAttempt.statusCode, invalidAttempt.body).toBe(409);
      expect(invalidAttempt.json()).toMatchObject({ code: 'pde_decision_profile_unavailable' });
      await expect(context.prisma.pdeDecisionContext.findFirstOrThrow({
        where: { tenantId: context.tenant.id, opportunityId },
      })).resolves.toMatchObject({ stageKey: 'initiation', decisionProfileRef: null, version: 0 });
      await expect(context.prisma.eVSnapshot.count({ where: { tenantId: context.tenant.id, opportunityId } }))
        .resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('uses an explicit tenant profile without any Methodology binding', async () => {
    const context = await createTestContext();
    try {
      const { opportunityId } = await seedRuntimeMatter(context, 'explicit-profile', {
        withContext: true,
        stageKey: 'tender_design',
      });
      const profile = await context.prisma.industryPack.create({ data: {
        id: 'pde-explicit-profile',
        tenantId: context.tenant.id,
        packKey: 'tenant-energy-profile',
        schemaVersion: 'tenant-1',
        payload: JSON.stringify(loadSeeds()),
        active: true,
      } });
      await context.prisma.pdeDecisionContext.updateMany({
        where: { tenantId: context.tenant.id, opportunityId },
        data: { decisionProfileRef: profile.id },
      });

      const evaluation = await context.app.inject({
        method: 'GET',
        url: `/api/pde/${opportunityId}/ev`,
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(evaluation.statusCode, evaluation.body).toBe(200);
      expect(evaluation.json()).toMatchObject({ stage: 'tender_design' });
      await expect(context.prisma.actionCatalog.count({
        where: { tenantId: context.tenant.id, packId: profile.id },
      })).resolves.toBeGreaterThan(0);
      await expect(context.prisma.methodologyBinding.count({
        where: { tenantId: context.tenant.id, opportunityId },
      })).resolves.toBe(0);

      const snapshotResponse = await context.app.inject({
        method: 'POST',
        url: `/api/pde/${opportunityId}/snapshot`,
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(snapshotResponse.statusCode, snapshotResponse.body).toBe(200);
      const snapshot = await context.prisma.eVSnapshot.findUniqueOrThrow({
        where: { id: snapshotResponse.json<{ id: string }>().id },
      });
      expect(JSON.parse(snapshot.inputsJson).metadata).toMatchObject({
        activePackId: profile.id,
        industryPack: { packKey: 'tenant-energy-profile', schemaVersion: 'tenant-1' },
        pdeDecisionContext: { decisionProfileRef: profile.id, stageKey: 'tender_design' },
      });
    } finally {
      await context.cleanup();
    }
  });

  it('creates a system-default independent context with every new Matter', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.create({ data: {
        id: 'pde-new-account', tenantId: context.tenant.id, name: 'New PDE account', customerType: 1,
      } });
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: { authorization: `Bearer ${context.token}` },
        payload: { action: {
          type: 'ADD_OPP',
          accId: 'pde-new-account',
          opp: {
            id: 'pde-new-opportunity',
            name: 'New PDE opportunity',
            customerType: 1,
            pipelineStage: '招投标',
            engageStage: '招采执行',
          },
        } },
      });

      expect(response.statusCode, response.body).toBe(200);
      await expect(context.prisma.pdeDecisionContext.findFirst({
        where: { tenantId: context.tenant.id, opportunityId: 'pde-new-opportunity' },
      })).resolves.toMatchObject({
        stageKey: 'initiation', decisionProfileRef: null, source: 'system_default', version: 0,
      });
      for (const path of [
        '../src/mutate.ts',
        '../src/opp.ts',
        '../src/mcp/syncBundle.ts',
        '../src/seed-demo.ts',
      ]) {
        const source = await readFile(new URL(path, import.meta.url), 'utf8');
        expect(source, path).toContain('createPdeDecisionContext');
      }
    } finally {
      await context.cleanup();
    }
  });
});
