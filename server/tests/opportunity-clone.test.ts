import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

describe('opportunity clone P4 normalization', () => {
  it('copies exactly one stable legal non-A/D P4 keeper inside the scoped source tree', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'account-clone-p4';
      const sourceOpportunityId = 'opportunity-clone-p4-source';
      const personIds = ['d-illegal', 'z-legal', 'a-legal'];
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: '虚构克隆客户', customerType: 1 },
      });
      await context.prisma.account.create({
        data: { id: 'account-clone-p4-outside', tenantId: context.tenant.id, name: '虚构越界客户', customerType: 1 },
      });
      await context.prisma.opportunity.create({
        data: {
          id: sourceOpportunityId, tenantId: context.tenant.id, accountId, name: '虚构源商机', customerType: 1,
          pipelineStage: '线索', engageStage: '需求调研立项',
        },
      });
      await context.prisma.person.createMany({
        data: personIds.map((id) => ({ id, tenantId: context.tenant.id, accountId, name: id, title: '虚构岗位' })),
      });
      await context.prisma.person.create({
        data: {
          id: '0-cross-account', tenantId: context.tenant.id, accountId: 'account-clone-p4-outside',
          name: '虚构越界人物', title: '虚构岗位',
        },
      });
      await context.prisma.oppRole.createMany({
        data: [
          { tenantId: context.tenant.id, opportunityId: sourceOpportunityId, personId: 'd-illegal', role: 'D', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
          { tenantId: context.tenant.id, opportunityId: sourceOpportunityId, personId: 'z-legal', role: 'R', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
          { tenantId: context.tenant.id, opportunityId: sourceOpportunityId, personId: 'a-legal', role: 'C', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
          { tenantId: context.tenant.id, opportunityId: sourceOpportunityId, personId: '0-cross-account', role: 'C', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
        ],
      });

      const response = await context.app.inject({
        method: 'POST', url: '/api/opportunity/clone',
        headers: { authorization: `Bearer ${context.token}` },
        payload: { accountId, name: '虚构克隆商机', fromOppId: sourceOpportunityId, personIds: [...personIds, '0-cross-account'], withEdges: false },
      });

      expect(response.statusCode, response.body).toBe(200);
      const { opportunityId } = response.json<{ opportunityId: string }>();
      const clonedRoles = await context.prisma.oppRole.findMany({
        where: { tenantId: context.tenant.id, opportunityId }, orderBy: { personId: 'asc' },
      });
      expect(clonedRoles.filter((role) => role.isKeyInfluencer).map((role) => role.personId)).toEqual(['a-legal']);
      expect(clonedRoles).toHaveLength(3);
      expect(clonedRoles.map((role) => role.personId)).not.toContain('0-cross-account');
    } finally {
      await context.cleanup();
    }
  });
});
