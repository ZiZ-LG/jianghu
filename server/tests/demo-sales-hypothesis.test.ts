import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

describe('SAAS-207 demo SalesHypothesis seed', () => {
  it('seeds complete canonical hypotheses and keeps StrategyRisk risk-only', async () => {
    const test = await createTestContext();
    try {
      const response = await test.app.inject({
        method: 'POST', url: '/api/demo',
        headers: { authorization: `Bearer ${test.token}` },
      });
      expect(response.statusCode, response.body).toBe(200);

      const [risks, hypotheses, revisions] = await Promise.all([
        test.prisma.strategyRisk.findMany({
          where: { tenantId: test.tenant.id }, orderBy: { id: 'asc' },
        }),
        test.prisma.salesHypothesis.findMany({
          where: { tenantId: test.tenant.id }, orderBy: { id: 'asc' },
        }),
        test.prisma.salesHypothesisRevision.findMany({
          where: { tenantId: test.tenant.id }, orderBy: { id: 'asc' },
        }),
      ]);
      expect(risks).toHaveLength(2);
      expect(risks.every((risk) => risk.kind === 'risk')).toBe(true);
      expect(hypotheses).toHaveLength(2);
      expect(revisions).toHaveLength(2);
      const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
      for (const item of hypotheses) {
        expect(item).toMatchObject({
          status: 'untested', ownerUserId: test.owner.id,
          legacyStrategyRiskId: null, createdByUserId: test.owner.id,
          statusConfirmedByUserId: null, statusConfirmedAt: null, version: 0,
        });
        expect(item.nextReviewAt?.getTime()).toBeGreaterThan(Date.now());
        const revision = revisionById.get(item.currentRevisionId);
        expect(revision).toMatchObject({
          hypothesisId: item.id, revisionNumber: 1, origin: 'user',
          createdByUserId: test.owner.id,
        });
        expect(revision?.claim.trim()).not.toBe('');
        expect(revision?.reason.trim()).not.toBe('');
        expect(JSON.parse(revision?.expectedSignals ?? '[]')).not.toHaveLength(0);
        expect(JSON.parse(revision?.falsificationConditions ?? '[]')).not.toHaveLength(0);
      }
    } finally {
      await test.cleanup();
    }
  });
});
