import { describe, expect, it } from 'vitest';
import { assembleDeal } from '../src/pde/assemble.js';
import { createPdeDecisionContext } from '../src/pde/context.js';
import { createTestContext } from './helpers/testApp.js';

describe('PDE P4 selection compatibility', () => {
  it('assigns KEY_INFLUENCER only to the stable legal non-A/D keeper', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'account-pde-p4';
      const opportunityId = 'opportunity-pde-p4';
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: '虚构 PDE 客户', customerType: 1 },
      });
      await context.prisma.opportunity.create({
        data: {
          id: opportunityId, tenantId: context.tenant.id, accountId, name: '虚构 PDE 商机', customerType: 1,
          pipelineStage: '线索', engageStage: '需求调研立项',
        },
      });
      const decisionContext = await createPdeDecisionContext(context.prisma, {
        tenantId: context.tenant.id,
        opportunityId,
      });
      await context.prisma.person.createMany({
        data: ['d-illegal', 'z-legal', 'a-legal'].map((id) => ({
          id, tenantId: context.tenant.id, accountId, name: id, title: '虚构岗位',
        })),
      });
      await context.prisma.oppRole.createMany({
        data: [
          { tenantId: context.tenant.id, opportunityId, personId: 'd-illegal', role: 'D', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
          { tenantId: context.tenant.id, opportunityId, personId: 'z-legal', role: 'R', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
          { tenantId: context.tenant.id, opportunityId, personId: 'a-legal', role: 'C', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
        ],
      });

      const assembled = await assembleDeal(context.tenant.id, opportunityId, {
        scoringSchema: { items: [] }, signalCatalog: { deltaAlphaMap: {} },
      }, 'test-pack', decisionContext, context.prisma);
      const slots = new Map(assembled?.deal.stakeholders.map((stakeholder) => [stakeholder.id, stakeholder.slots]));

      expect(slots.get('a-legal')).toContain('KEY_INFLUENCER');
      expect(slots.get('z-legal')).not.toContain('KEY_INFLUENCER');
      expect(slots.get('d-illegal')).not.toContain('KEY_INFLUENCER');
    } finally {
      await context.cleanup();
    }
  });
});
