import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

describe('PersonSuggestion role revalidation', () => {
  it.each(['TB', 'root'])('keeps a historical %s candidate pending instead of writing an invalid formal role', async (suggestedRole) => {
    const context = await createTestContext();
    try {
      const accountId = `account-suggested-role-${suggestedRole}`;
      const opportunityId = `opportunity-suggested-role-${suggestedRole}`;
      const suggestionId = `suggestion-role-${suggestedRole}`;
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: '虚构客户', customerType: 1 },
      });
      await context.prisma.opportunity.create({
        data: {
          id: opportunityId, tenantId: context.tenant.id, accountId, name: '虚构商机', customerType: 1,
          pipelineStage: '线索', engageStage: '需求调研立项',
        },
      });
      await context.prisma.personSuggestion.create({
        data: {
          id: suggestionId, tenantId: context.tenant.id, accountId, opportunityId,
          name: '虚构候选人', title: '虚构岗位', suggestedRole, status: 'pending',
        },
      });

      const response = await context.app.inject({
        method: 'POST', url: `/api/suggest/persons/${suggestionId}/accept`,
        headers: { authorization: `Bearer ${context.token}` }, payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('重新分类');
      await expect(context.prisma.personSuggestion.findUniqueOrThrow({ where: { id: suggestionId } }))
        .resolves.toMatchObject({ status: 'pending', resolvedPersonId: null });
      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id, accountId } })).resolves.toBe(0);
      await expect(context.prisma.oppRole.count({ where: { tenantId: context.tenant.id, opportunityId } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
