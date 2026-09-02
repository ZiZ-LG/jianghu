import { randomUUID } from 'node:crypto';
import {
  MatterPortfolioReadModelSchema,
  TodaySourceViewSchema,
} from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function addUser(context: TestContext, role: 'member' | 'viewer') {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: `${role} user`,
    role,
  } });
  return {
    user,
    token: context.app.jwt.sign({
      tenantId: context.tenant.id,
      userId: user.id,
      role: 'owner',
    }),
  };
}

async function readCounts(context: TestContext) {
  return Promise.all([
    context.prisma.account.count(),
    context.prisma.opportunity.count(),
    context.prisma.edge.count(),
    context.prisma.planAction.count(),
    context.prisma.intelligenceItem.count(),
    context.prisma.stakeholderFocus.count(),
    context.prisma.salesHypothesis.count(),
    context.prisma.methodologyStageState.count(),
    context.prisma.agentRun.count(),
    context.prisma.commandRun.count(),
    context.prisma.auditEvent.count(),
  ]);
}

describe('SAAS-209 Matter portfolio read boundary', () => {
  it('requires authentication and sales.workspace and emits a strict no-store empty response', async () => {
    const enabled = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['sales.workspace'] },
    });
    try {
      const unauthenticated = await enabled.app.inject({ method: 'GET', url: '/api/matter-portfolio' });
      expect(unauthenticated.statusCode).toBe(401);

      const response = await enabled.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(enabled.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(MatterPortfolioReadModelSchema.parse(response.json()).entries).toEqual([]);
    } finally {
      await enabled.cleanup();
    }

    const free = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const denied = await free.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(free.token),
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toEqual({ error: '能力未启用', code: 'capability_denied' });
    } finally {
      await free.cleanup();
    }
  });

  it('projects six active Matters, exact active methodology stage and sales-only inputs with zero writes', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['sales.workspace'] },
    });
    try {
      const tenantId = context.tenant.id;
      for (let index = 1; index <= 7; index += 1) {
        await context.prisma.account.create({ data: {
          id: `portfolio-customer-${index}`,
          tenantId,
          name: `组合客户 ${index}`,
          categoryKey: index === 1 ? 'strategic' : null,
          customerType: index,
          primaryOwnerUserId: context.owner.id,
          profile: JSON.stringify({ secret: `PROFILE_POISON_${index}` }),
        } });
        await context.prisma.opportunity.create({ data: {
          id: `portfolio-matter-${index}`,
          tenantId,
          accountId: `portfolio-customer-${index}`,
          name: `组合事项 ${index}`,
          kind: index === 1 ? 'sales_opportunity' : 'general',
          lifecycleStatus: index === 7 ? 'paused' : 'active',
          priority: index === 2 ? 'high' : null,
          customerType: index,
          pipelineStage: `PIPELINE_POISON_${index}`,
          engageStage: `ENGAGE_POISON_${index}`,
          primaryDPersonId: `PRIMARY_D_POISON_${index}`,
          primaryOwnerUserId: context.owner.id,
          expectedAmountW: index === 1 ? 320 : 999,
          winProbability: index === 1 ? 55 : 99,
          expectedSignDate: index === 1 ? '2026-10-31' : '2026-12-31',
          meta: JSON.stringify({ ADURC: `ADURC_POISON_${index}`, score: 100 }),
        } });
      }
      await context.prisma.tenant.create({ data: {
        id: 'portfolio-foreign-tenant', name: 'FOREIGN_TENANT',
      } });
      await context.prisma.account.create({ data: {
        id: 'portfolio-foreign-customer', tenantId: 'portfolio-foreign-tenant',
        name: 'FOREIGN_CUSTOMER', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'portfolio-foreign-matter', tenantId: 'portfolio-foreign-tenant',
        accountId: 'portfolio-foreign-customer', name: 'FOREIGN_MATTER',
        kind: 'sales_opportunity', lifecycleStatus: 'active', customerType: 1,
        pipelineStage: 'FOREIGN_PIPELINE', engageStage: 'FOREIGN_ENGAGE',
      } });

      await context.prisma.methodologyPack.create({ data: {
        id: 'portfolio-pack', tenantId, key: 'portfolio.pack', name: '组合方法论',
        createdByUserId: context.owner.id,
      } });
      await context.prisma.methodologyPackVersion.createMany({ data: [{
        id: 'portfolio-version-current', tenantId, packId: 'portfolio-pack', versionKey: '1.0.0',
        status: 'published', engineRef: 'none:1', contentHash: 'a'.repeat(64),
        createdByUserId: context.owner.id, publishedByUserId: context.owner.id,
        publishedAt: new Date('2026-08-01T00:00:00Z'),
      }, {
        id: 'portfolio-version-stale', tenantId, packId: 'portfolio-pack', versionKey: '0.9.0',
        status: 'deprecated', engineRef: 'none:0', contentHash: 'b'.repeat(64),
        createdByUserId: context.owner.id, publishedByUserId: context.owner.id,
        publishedAt: new Date('2026-07-01T00:00:00Z'),
      }] });
      await context.prisma.methodologyStageDefinition.createMany({ data: [{
        id: 'portfolio-stage-current', tenantId, packId: 'portfolio-pack',
        versionId: 'portfolio-version-current', key: 'discovery', name: '需求澄清',
      }, {
        id: 'portfolio-stage-stale', tenantId, packId: 'portfolio-pack',
        versionId: 'portfolio-version-stale', key: 'legacy', name: 'STALE_STAGE_SECRET',
      }] });
      await context.prisma.methodologyBinding.createMany({ data: [{
        id: 'portfolio-binding-current', tenantId, opportunityId: 'portfolio-matter-1',
        packId: 'portfolio-pack', versionId: 'portfolio-version-current',
        createdByUserId: context.owner.id,
      }, {
        id: 'portfolio-binding-stale', tenantId, opportunityId: 'portfolio-matter-1',
        packId: 'portfolio-pack', versionId: 'portfolio-version-stale',
        createdByUserId: context.owner.id,
      }] });
      await context.prisma.methodologyStageState.createMany({ data: [{
        id: 'portfolio-stage-state-current', tenantId, opportunityId: 'portfolio-matter-1',
        bindingId: 'portfolio-binding-current', packId: 'portfolio-pack',
        versionId: 'portfolio-version-current', stageKey: 'discovery',
        updatedByUserId: context.owner.id,
      }, {
        id: 'portfolio-stage-state-stale', tenantId, opportunityId: 'portfolio-matter-1',
        bindingId: 'portfolio-binding-stale', packId: 'portfolio-pack',
        versionId: 'portfolio-version-stale', stageKey: 'legacy',
        updatedByUserId: context.owner.id,
      }] });
      await context.prisma.opportunity.update({
        where: { id: 'portfolio-matter-1' },
        data: { activeMethodologyBindingId: 'portfolio-binding-current' },
      });

      const before = await readCounts(context);
      const response = await context.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const portfolio = MatterPortfolioReadModelSchema.parse(response.json());
      expect(portfolio.entries).toHaveLength(6);
      expect(portfolio.entries.some((entry) => entry.matter.id === 'portfolio-matter-7')).toBe(false);
      const sales = portfolio.entries.find((entry) => entry.matter.id === 'portfolio-matter-1')!;
      expect(sales.methodologyStage).toMatchObject({
        bindingId: 'portfolio-binding-current', stageKey: 'discovery', stageName: '需求澄清',
      });
      expect(sales.salesEstimate).toEqual({
        kind: 'sales_entered_estimate', expectedAmountW: 320,
        winProbability: 55, expectedSignDate: '2026-10-31',
      });
      expect(portfolio.entries.filter((entry) => entry.matter.kind !== 'sales_opportunity')
        .every((entry) => entry.salesEstimate === null)).toBe(true);
      expect(await readCounts(context)).toEqual(before);
      expect(response.body).not.toContain('STALE_STAGE_SECRET');
      for (const forbidden of [
        'pipelineStage', 'engageStage', 'primaryDPersonId', 'PIPELINE_POISON',
        'ENGAGE_POISON', 'PRIMARY_D_POISON', 'ADURC_POISON', 'PROFILE_POISON', 'aggregateScore',
        'FOREIGN_TENANT', 'FOREIGN_CUSTOMER', 'FOREIGN_MATTER',
      ]) expect(response.body).not.toContain(forbidden);
    } finally {
      await context.cleanup();
    }
  });

  it('rechecks viewer ownership and current role and never returns viewer draft controls', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['sales.workspace'] },
    });
    try {
      const viewer = await addUser(context, 'viewer');
      await context.prisma.tenant.update({
        where: { id: context.tenant.id }, data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.createMany({ data: [{
        id: 'portfolio-viewer-customer', tenantId: context.tenant.id, name: 'Viewer 客户',
        primaryOwnerUserId: viewer.user.id,
      }, {
        id: 'portfolio-hidden-customer', tenantId: context.tenant.id, name: 'HIDDEN_CUSTOMER',
        primaryOwnerUserId: context.owner.id,
      }] });
      await context.prisma.opportunity.createMany({ data: [{
        id: 'portfolio-viewer-matter', tenantId: context.tenant.id,
        accountId: 'portfolio-viewer-customer', name: 'Viewer 事项',
        kind: 'general', lifecycleStatus: 'active', customerType: 1,
        pipelineStage: 'hidden', engageStage: 'hidden',
      }, {
        id: 'portfolio-hidden-matter', tenantId: context.tenant.id,
        accountId: 'portfolio-hidden-customer', name: 'HIDDEN_MATTER',
        kind: 'general', lifecycleStatus: 'active', customerType: 1,
        pipelineStage: 'hidden', engageStage: 'hidden',
      }] });

      const response = await context.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(viewer.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const portfolio = MatterPortfolioReadModelSchema.parse(response.json());
      expect(portfolio.entries.map((entry) => entry.matter.id)).toEqual(['portfolio-viewer-matter']);
      expect(portfolio.entries[0]!.actionDraft).toBeNull();
      expect(response.body).not.toContain('HIDDEN_CUSTOMER');
      expect(response.body).not.toContain('HIDDEN_MATTER');

      await context.prisma.account.update({
        where: { id: 'portfolio-viewer-customer' }, data: { primaryOwnerUserId: context.owner.id },
      });
      const revoked = await context.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(viewer.token),
      });
      expect(MatterPortfolioReadModelSchema.parse(revoked.json()).entries).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });

  it('exposes only current body-free source metadata and fails closed after source revision drift', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['sales.workspace'] },
    });
    try {
      const tenantId = context.tenant.id;
      await context.prisma.account.create({ data: {
        id: 'portfolio-source-customer', tenantId, name: '来源客户',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'portfolio-source-matter', tenantId, accountId: 'portfolio-source-customer',
        name: '来源事项', kind: 'general', lifecycleStatus: 'active', customerType: 1,
        pipelineStage: 'POISONED_PIPELINE', engageStage: 'POISONED_ENGAGE',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.intelligenceItem.create({ data: {
        id: 'portfolio-source-intelligence', tenantId,
        customerId: 'portfolio-source-customer', matterId: 'portfolio-source-matter',
        assertionType: 'reported', statement: 'SENSITIVE_INTELLIGENCE_BODY',
        sourceKind: 'manual', sourceDescription: 'SENSITIVE_SOURCE_DESCRIPTION',
        learnedAt: new Date(Date.now() - 31 * 86_400_000), confidence: 0.8,
        targetRefs: JSON.stringify([{ kind: 'matter', id: 'portfolio-source-matter' }]),
        createdByUserId: context.owner.id,
      } });

      const response = await context.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const portfolio = MatterPortfolioReadModelSchema.parse(response.json());
      const sourceItem = portfolio.entries[0]!.attentionItems.find(
        (item) => item.providerKey === 'matter_portfolio.intelligence',
      )!;
      expect(sourceItem).toBeDefined();
      expect(response.body).not.toContain('SENSITIVE_INTELLIGENCE_BODY');
      expect(response.body).not.toContain('SENSITIVE_SOURCE_DESCRIPTION');
      const sourceRef = sourceItem.sourceRefs.find((ref) => ref.entityKind === 'intelligence_item')!;
      const sourceRequest = {
        providerKey: sourceItem.providerKey,
        customerId: 'portfolio-source-customer',
        matterId: 'portfolio-source-matter',
        sourceRef,
      };
      const exact = await context.app.inject({
        method: 'POST', url: '/api/matter-portfolio/source', headers: auth(context.token),
        payload: sourceRequest,
      });
      expect(exact.statusCode, exact.body).toBe(200);
      expect(exact.headers['cache-control']).toBe('private, no-store');
      expect(TodaySourceViewSchema.parse(exact.json())).toMatchObject({
        sourceRef, customerId: 'portfolio-source-customer', matterId: 'portfolio-source-matter',
      });
      expect(exact.body).not.toContain('SENSITIVE_INTELLIGENCE_BODY');
      expect(exact.body).not.toContain('SENSITIVE_SOURCE_DESCRIPTION');

      await context.prisma.intelligenceItem.update({
        where: { id: 'portfolio-source-intelligence' }, data: { version: { increment: 1 } },
      });
      const stale = await context.app.inject({
        method: 'POST', url: '/api/matter-portfolio/source', headers: auth(context.token),
        payload: sourceRequest,
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.body).not.toContain('SENSITIVE_INTELLIGENCE_BODY');
      expect(stale.body).not.toContain('SENSITIVE_SOURCE_DESCRIPTION');
    } finally {
      await context.cleanup();
    }
  });
});
