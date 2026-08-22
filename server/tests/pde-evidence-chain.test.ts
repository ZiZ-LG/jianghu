import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { loadSeeds } from '../src/pde/pack.js';

async function seedDeal(context: TestContext, suffix: string) {
  const accountId = `acc-pde-${suffix}`;
  const opportunityId = `opp-pde-${suffix}`;
  const personId = `person-pde-${suffix}`;
  await context.prisma.account.create({
    data: { id: accountId, tenantId: context.tenant.id, name: `PDE ${suffix}`, customerType: 2 },
  });
  await context.prisma.opportunity.create({
    data: {
      id: opportunityId, tenantId: context.tenant.id, accountId, name: `PDE opportunity ${suffix}`,
      customerType: 2, pipelineStage: '推进', engageStage: '预算批复', expectedAmountW: 100,
    },
  });
  await context.prisma.pdeDecisionContext.create({ data: {
    id: `context-pde-${suffix}`,
    tenantId: context.tenant.id,
    opportunityId,
    stageKey: 'budget_approval',
    source: 'legacy_shadow',
  } });
  await context.prisma.person.create({
    data: { id: personId, tenantId: context.tenant.id, accountId, name: `Stakeholder ${suffix}`, title: '决策人' },
  });
  await context.prisma.oppRole.create({
    data: {
      tenantId: context.tenant.id, opportunityId, personId, role: 'A', sentiment: 'neutral',
      confidence: '明确', assessedAt: new Date(), sourceQuality: 1,
    },
  });
  return { accountId, opportunityId, personId };
}

async function getPwin(context: TestContext, opportunityId: string): Promise<number> {
  const response = await context.app.inject({
    method: 'GET', url: `/api/pde/${opportunityId}/ev`, headers: { authorization: `Bearer ${context.token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ pwin: number }>().pwin;
}

async function addEvidence(
  context: TestContext,
  deal: Awaited<ReturnType<typeof seedDeal>>,
  id: string,
  status: 'approved' | 'pending_review' | 'rejected',
  direction: -1 | 0 | 1,
  tenantId = context.tenant.id,
  signalKey = 'intro_referral',
) {
  await context.prisma.evidenceEvent.create({
    data: {
      id, tenantId, accountId: deal.accountId, opportunityId: deal.opportunityId, personId: deal.personId,
      signalKey, direction, tier: 'strong', status,
    },
  });
}

describe('approved Evidence -> PDE -> durable evidence_review snapshot', () => {
  it('reactivates the current industry pack with a tenant-scoped write and read', async () => {
    const context = await createTestContext();
    let activation: { action: string; where: unknown } | undefined;
    try {
      const deal = await seedDeal(context, 'pack-reactivation-scope');
      const seeds = loadSeeds();
      const packId = 'pack-inactive-current';
      await context.prisma.industryPack.create({
        data: {
          id: packId, tenantId: context.tenant.id, packKey: 'digital-energy',
          schemaVersion: String(seeds.scoringSchema.schemaVersion), active: false, payload: JSON.stringify(seeds),
        },
      });
      context.prisma.$use(async (params, next) => {
        if (params.model === 'IndustryPack' && (params.action === 'update' || params.action === 'updateMany')) {
          activation = { action: params.action, where: params.args.where };
        }
        return next(params);
      });

      await getPwin(context, deal.opportunityId);
      expect(activation).toEqual({
        action: 'updateMany',
        where: { id: packId, tenantId: context.tenant.id, active: false },
      });
      await expect(context.prisma.industryPack.findFirstOrThrow({
        where: { id: packId, tenantId: context.tenant.id },
      })).resolves.toMatchObject({ active: true });
    } finally {
      await context.cleanup();
    }
  });

  it('uses only tenant-scoped approved evidence and applies positive/negative alpha', async () => {
    const context = await createTestContext();
    try {
      const deal = await seedDeal(context, 'aggregation');
      const baseline = await getPwin(context, deal.opportunityId);

      await addEvidence(context, deal, 'ev-pending', 'pending_review', 1);
      await addEvidence(context, deal, 'ev-rejected', 'rejected', -1);
      await addEvidence(context, deal, 'ev-other-tenant', 'approved', 1, 'tenant-out-of-scope');
      expect(await getPwin(context, deal.opportunityId)).toBeCloseTo(baseline, 9);

      await addEvidence(context, deal, 'ev-approved-positive', 'approved', 1);
      expect(await getPwin(context, deal.opportunityId)).toBeGreaterThan(baseline);

      await context.prisma.evidenceEvent.delete({ where: { id: 'ev-approved-positive' } });
      await addEvidence(context, deal, 'ev-approved-negative', 'approved', -1);
      expect(await getPwin(context, deal.opportunityId)).toBeLessThan(baseline);
    } finally {
      await context.cleanup();
    }
  });

  it('does not let an obsolete parallel pack authorize evidence for the current pack', async () => {
    const context = await createTestContext();
    try {
      const deal = await seedDeal(context, 'pack-isolation');
      const baseline = await getPwin(context, deal.opportunityId);
      const currentPack = await context.prisma.industryPack.findFirstOrThrow({
        where: { tenantId: context.tenant.id, packKey: 'digital-energy', active: true },
      });
      const obsoletePack = await context.prisma.industryPack.create({
        data: {
          id: 'pack-obsolete-evidence', tenantId: context.tenant.id, packKey: 'digital-energy',
          schemaVersion: `${currentPack.schemaVersion}-obsolete`, active: true, payload: '{}',
        },
      });
      await context.prisma.signalCatalog.create({
        data: {
          id: 'sig-obsolete-evidence', tenantId: context.tenant.id, packId: obsoletePack.id,
          signalKey: 'obsolete_pack_only', label: 'obsolete only', direction: 1, tier: 'strong', behavioral: true,
        },
      });
      await addEvidence(context, deal, 'ev-obsolete-pack', 'approved', 1, context.tenant.id, 'obsolete_pack_only');

      expect(await getPwin(context, deal.opportunityId)).toBeCloseTo(baseline, 9);
    } finally {
      await context.cleanup();
    }
  });

  it('waits for approval snapshot and preserves evidence IDs plus aggregate alpha for replay', async () => {
    const context = await createTestContext();
    try {
      const deal = await seedDeal(context, 'snapshot');
      await getPwin(context, deal.opportunityId); // ensure the tenant industry pack/catalog exists
      const activePack = await context.prisma.industryPack.findFirstOrThrow({
        where: { tenantId: context.tenant.id, packKey: 'digital-energy', active: true },
      });
      await addEvidence(context, deal, 'ev-review-success', 'pending_review', 1);

      const response = await context.app.inject({
        method: 'POST', url: '/api/evidence/ev-review-success/review',
        headers: { authorization: `Bearer ${context.token}` }, payload: { action: 'approve', direction: -1, tier: 'weak' },
      });
      expect(response.statusCode, response.body).toBe(200);

      const snapshot = await context.prisma.eVSnapshot.findFirstOrThrow({
        where: { tenantId: context.tenant.id, opportunityId: deal.opportunityId, trigger: 'evidence_review' },
        orderBy: { createdAt: 'desc' },
      });
      const inputs = JSON.parse(snapshot.inputsJson);
      expect(inputs.evidence.ids).toEqual(['ev-review-success']);
      expect(inputs.evidence.alphaByStakeholder).toEqual({ [deal.personId]: [0, 0, 0.5] });
      expect(inputs.deal.stakeholders[0].evidence_alpha).toEqual([0, 0, 0.5]);
      expect(inputs.metadata).toMatchObject({
        activePackId: activePack.id,
        industryPack: { packKey: 'digital-energy', schemaVersion: expect.any(String) },
        signalCatalog: { schema: 'signal-catalog', version: '1.0' },
      });
    } finally {
      await context.cleanup();
    }
  });

  it('keeps pending evidence invisible until approval and snapshot commit together', async () => {
    const context = await createTestContext();
    const observer = new PrismaClient();
    let releaseSnapshot!: () => void;
    let snapshotStarted!: () => void;
    let pause = true;
    const releaseGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    try {
      const deal = await seedDeal(context, 'atomic-visibility');
      await getPwin(context, deal.opportunityId);
      await addEvidence(context, deal, 'ev-atomic-visibility', 'pending_review', 1);
      context.prisma.$use(async (params, next) => {
        if (pause && params.model === 'EVSnapshot' && params.action === 'create'
          && params.args.data.opportunityId === deal.opportunityId) {
          snapshotStarted();
          await releaseGate;
        }
        return next(params);
      });

      const approval = context.app.inject({
        method: 'POST', url: '/api/evidence/ev-atomic-visibility/review',
        headers: { authorization: `Bearer ${context.token}` }, payload: { action: 'approve' },
      });
      await started;
      try {
        await expect(observer.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-atomic-visibility' } }))
          .resolves.toMatchObject({ status: 'pending_review' });
      } finally {
        pause = false;
        releaseSnapshot();
      }
      const response = await approval;
      expect(response.statusCode, response.body).toBe(200);
      await expect(observer.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-atomic-visibility' } }))
        .resolves.toMatchObject({ status: 'approved' });
    } finally {
      pause = false;
      releaseSnapshot?.();
      await observer.$disconnect();
      await context.cleanup();
    }
  });

  it('returns an explicit failure and restores pending status when the snapshot cannot persist', async () => {
    const context = await createTestContext();
    try {
      const deal = await seedDeal(context, 'snapshot-failure');
      await getPwin(context, deal.opportunityId);
      await addEvidence(context, deal, 'ev-review-failure', 'pending_review', 1);
      let failSnapshot = true;
      context.prisma.$use(async (params, next) => {
        if (failSnapshot && params.model === 'EVSnapshot' && params.action === 'create'
          && params.args.data.opportunityId === deal.opportunityId) {
          throw new Error('snapshot unavailable');
        }
        return next(params);
      });
      try {
        const response = await context.app.inject({
          method: 'POST', url: '/api/evidence/ev-review-failure/review',
          headers: { authorization: `Bearer ${context.token}` }, payload: { action: 'approve', direction: -1, tier: 'weak' },
        });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.json()).toEqual({ error: '证据快照未落库，审核未生效，请重试' });
        await expect(context.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-review-failure' } }))
          .resolves.toMatchObject({
            status: 'pending_review', direction: 1, tier: 'strong', reviewedBy: '', reviewedAt: '',
          });
        await expect(context.prisma.eVSnapshot.count({
          where: { tenantId: context.tenant.id, opportunityId: deal.opportunityId, trigger: 'evidence_review' },
        })).resolves.toBe(0);
      } finally {
        failSnapshot = false;
      }
    } finally {
      await context.cleanup();
    }
  });
});
