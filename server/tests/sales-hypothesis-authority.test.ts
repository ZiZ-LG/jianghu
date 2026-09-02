import { describe, expect, it } from 'vitest';
import type { Action, CommandContext } from '@jianghu/domain-contracts';
import { applyAction } from '../src/mutate.js';
import { createTestContext } from './helpers/testApp.js';

describe('SAAS-207 SalesHypothesis authority cutover', () => {
  it('freezes every legacy assumption write while preserving StrategyRisk risk behavior', async () => {
    const test = await createTestContext();
    try {
      const customerId = 'customer-207-authority';
      const matterId = 'matter-207-authority';
      await test.prisma.account.create({ data: {
        id: customerId, tenantId: test.tenant.id, name: '假设权威客户',
      } });
      await test.prisma.opportunity.create({ data: {
        id: matterId, tenantId: test.tenant.id, accountId: customerId,
        name: '假设权威事项', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      } });
      await test.prisma.strategyRisk.create({ data: {
        id: 'legacy-assumption-207-authority', tenantId: test.tenant.id,
        accountId: customerId, opportunityId: matterId, kind: 'assumption',
        text: '迁移后的旧假设不可再写', origin: 'manual',
      } });
      const ctx: CommandContext = {
        tenantId: test.tenant.id,
        actorId: test.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'saas-207-authority',
        assertionMode: 'user_asserted',
      };

      const frozenWrites = [
        {
          type: 'ADD_STRATEGY_RISK' as const, accId: customerId, oppId: matterId,
          risk: { id: 'new-legacy-assumption', kind: 'assumption', text: '不得新增旧假设' },
        },
        {
          type: 'UPDATE_STRATEGY_RISK' as const, accId: customerId,
          riskId: 'legacy-assumption-207-authority', patch: { text: '不得修改旧假设' },
        },
        {
          type: 'UPDATE_STRATEGY_RISK' as const, accId: customerId,
          riskId: 'legacy-assumption-207-authority', patch: { kind: 'risk' },
        },
        {
          type: 'DELETE_STRATEGY_RISK' as const, accId: customerId,
          riskId: 'legacy-assumption-207-authority',
        },
      ] satisfies Action[];
      for (const action of frozenWrites) {
        await expect(applyAction(ctx, action, test.prisma)).rejects.toMatchObject({
          code: 'legacy_assumption_frozen',
        });
      }

      await applyAction(ctx, {
        type: 'ADD_STRATEGY_RISK', accId: customerId, oppId: matterId,
        risk: { id: 'risk-207-authority', kind: 'risk', text: '风险仍可新增' },
      }, test.prisma);
      await expect(applyAction(ctx, {
        type: 'UPDATE_STRATEGY_RISK', accId: customerId, riskId: 'risk-207-authority',
        patch: { kind: 'assumption' },
      }, test.prisma)).rejects.toMatchObject({ code: 'legacy_assumption_frozen' });
      await applyAction(ctx, {
        type: 'UPDATE_STRATEGY_RISK', accId: customerId, riskId: 'risk-207-authority',
        patch: { text: '风险仍可修改' },
      }, test.prisma);
      await expect(test.prisma.strategyRisk.findUniqueOrThrow({ where: { id: 'risk-207-authority' } }))
        .resolves.toMatchObject({ kind: 'risk', text: '风险仍可修改' });
      await applyAction(ctx, {
        type: 'DELETE_STRATEGY_RISK', accId: customerId, riskId: 'risk-207-authority',
      }, test.prisma);
      await expect(test.prisma.strategyRisk.findUnique({ where: { id: 'risk-207-authority' } }))
        .resolves.toBeNull();
      await expect(test.prisma.strategyRisk.findUniqueOrThrow({
        where: { id: 'legacy-assumption-207-authority' },
      })).resolves.toMatchObject({ kind: 'assumption', text: '迁移后的旧假设不可再写' });
      await expect(test.prisma.strategyRisk.findUnique({ where: { id: 'new-legacy-assumption' } }))
        .resolves.toBeNull();
    } finally {
      await test.cleanup();
    }
  });

  it('keeps approved EvidenceEvent rows immutable once a hypothesis revision links them', async () => {
    const test = await createTestContext();
    try {
      const customerId = 'customer-207-evidence-authority';
      const matterId = 'matter-207-evidence-authority';
      const evidenceId = 'evidence-207-authority';
      await test.prisma.account.create({ data: {
        id: customerId, tenantId: test.tenant.id, name: '证据权威客户',
      } });
      await test.prisma.opportunity.create({ data: {
        id: matterId, tenantId: test.tenant.id, accountId: customerId,
        name: '证据权威事项', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      } });
      await test.prisma.person.create({ data: {
        id: 'person-207-evidence-authority', tenantId: test.tenant.id,
        accountId: customerId, name: '证据联系人', title: '财务负责人',
      } });
      await test.prisma.evidenceEvent.create({ data: {
        id: evidenceId, tenantId: test.tenant.id, accountId: customerId,
        opportunityId: matterId, personId: 'person-207-evidence-authority',
        signalKey: 'budget_signal', direction: 1,
        status: 'approved', rawContent: '已批准的预算证据', createdBy: test.owner.id,
      } });
      await test.prisma.salesHypothesis.create({ data: {
        id: 'hypothesis-207-evidence-authority', tenantId: test.tenant.id,
        customerId, matterId, status: 'testing', ownerUserId: test.owner.id,
        nextReviewAt: new Date('2099-09-15T00:00:00.000Z'),
        currentRevisionId: 'revision-207-evidence-authority', createdByUserId: test.owner.id,
      } });
      await test.prisma.salesHypothesisRevision.create({ data: {
        id: 'revision-207-evidence-authority', tenantId: test.tenant.id,
        hypothesisId: 'hypothesis-207-evidence-authority', revisionNumber: 1,
        claim: '预算将获批准', reason: '已经进入评审',
        expectedSignals: '["收到预算批文"]',
        falsificationConditions: '["评审驳回"]',
        createdByUserId: test.owner.id,
      } });
      await test.prisma.hypothesisEvidenceLink.create({ data: {
        id: 'hypothesis-link-207-authority', tenantId: test.tenant.id,
        hypothesisId: 'hypothesis-207-evidence-authority',
        hypothesisRevisionId: 'revision-207-evidence-authority', evidenceId,
        evidenceVersion: 0, direction: 'supporting', linkedByUserId: test.owner.id,
      } });
      const ctx: CommandContext = {
        tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner',
        channel: 'web', requestId: 'saas-207-evidence-authority', assertionMode: 'user_asserted',
      };

      await expect(applyAction(ctx, {
        type: 'DELETE_EVIDENCE', accId: customerId, oppId: matterId, evidenceId,
      }, test.prisma)).rejects.toMatchObject({ candidateConflict: true });
      await expect(test.prisma.evidenceEvent.findUnique({ where: { id: evidenceId } }))
        .resolves.not.toBeNull();
      await expect(test.prisma.hypothesisEvidenceLink.findUnique({
        where: { id: 'hypothesis-link-207-authority' },
      })).resolves.not.toBeNull();
    } finally {
      await test.cleanup();
    }
  });
});
