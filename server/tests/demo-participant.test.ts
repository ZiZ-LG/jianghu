import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

describe('demo matter participants', () => {
  it('materializes every demo methodology role as a generic MatterParticipant', async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/demo',
        headers: { authorization: `Bearer ${context.token}` },
      });

      expect(response.statusCode, response.body).toBe(200);
      const opportunity = await context.prisma.opportunity.findFirstOrThrow({
        where: { tenantId: context.tenant.id },
      });
      const [roles, participants] = await Promise.all([
        context.prisma.oppRole.findMany({
          where: { tenantId: context.tenant.id, opportunityId: opportunity.id },
          select: { personId: true },
          orderBy: { personId: 'asc' },
        }),
        context.prisma.matterParticipant.findMany({
          where: { tenantId: context.tenant.id, opportunityId: opportunity.id },
          select: { personId: true, accountId: true },
          orderBy: { personId: 'asc' },
        }),
      ]);

      expect(participants).toHaveLength(roles.length);
      expect(participants.map(({ personId }) => personId)).toEqual(roles.map(({ personId }) => personId));
      expect(participants.every(({ accountId }) => accountId === opportunity.accountId)).toBe(true);
    } finally {
      await context.cleanup();
    }
  });
});
