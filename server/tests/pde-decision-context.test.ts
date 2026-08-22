import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';
import {
  PDE_DECISION_CONTEXT_MIGRATION_KEY,
  backfillPdeDecisionContexts,
  inspectPdeDecisionContextMigration,
  mapLegacyEngageStageToPdeStage,
} from '../src/pde/decisionContextMigration.js';

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
    } finally {
      await context.cleanup();
    }
  });
});
