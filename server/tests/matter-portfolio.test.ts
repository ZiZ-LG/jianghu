import { randomUUID } from 'node:crypto';
import {
  MatterPortfolioReadModelSchema,
  TodaySourceViewSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  buildMatterPortfolioReadModel,
  matterPortfolioSourceView,
} from '../src/matterPortfolio/service.js';
import { relationshipRadarTodayItems } from '../src/relationshipRadar/service.js';
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

  it('keeps a sales Matter visible without fabricating invalid stored estimate values', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['sales.workspace'] },
    });
    try {
      await context.prisma.account.create({ data: {
        id: 'portfolio-invalid-estimate-customer',
        tenantId: context.tenant.id,
        name: '异常估算客户',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'portfolio-invalid-estimate-matter',
        tenantId: context.tenant.id,
        accountId: 'portfolio-invalid-estimate-customer',
        name: '异常估算事项',
        kind: 'sales_opportunity',
        lifecycleStatus: 'active',
        customerType: 1,
        pipelineStage: 'legacy',
        engageStage: 'legacy',
        primaryOwnerUserId: context.owner.id,
        expectedAmountW: -1,
        winProbability: 101,
        expectedSignDate: 'not-a-local-date',
      } });

      const response = await context.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const portfolio = MatterPortfolioReadModelSchema.parse(response.json());
      expect(portfolio.entries).toHaveLength(1);
      expect(portfolio.entries[0]!.matter.id).toBe('portfolio-invalid-estimate-matter');
      expect(portfolio.entries[0]!.salesEstimate).toEqual({
        kind: 'sales_estimate_unavailable',
        reason: 'invalid_stored_values',
      });
      expect(response.body).not.toContain('not-a-local-date');
    } finally {
      await context.cleanup();
    }
  });

  it('batch-validates portfolio Intelligence, Focus and Hypothesis candidates without per-row detail reads', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['sales.workspace'] },
    });
    const now = new Date();
    try {
      const tenantId = context.tenant.id;
      const count = 6;
      await context.prisma.account.create({ data: {
        id: 'portfolio-batch-customer', tenantId, name: '批量校验客户',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.createMany({ data: Array.from({ length: count }, (_, index) => ({
        id: `portfolio-batch-matter-${index}`,
        tenantId,
        accountId: 'portfolio-batch-customer',
        name: `批量事项 ${index}`,
        kind: 'general',
        lifecycleStatus: 'active',
        customerType: 1,
        pipelineStage: 'legacy',
        engageStage: 'legacy',
        primaryOwnerUserId: context.owner.id,
      })) });
      await context.prisma.person.createMany({ data: Array.from({ length: count }, (_, index) => ({
        id: `portfolio-batch-person-${index}`,
        tenantId,
        accountId: 'portfolio-batch-customer',
        name: `批量人物 ${index}`,
        title: '负责人',
      })) });
      await context.prisma.matterParticipant.createMany({ data: Array.from({ length: count }, (_, index) => ({
        id: `portfolio-batch-participant-${index}`,
        tenantId,
        accountId: 'portfolio-batch-customer',
        opportunityId: `portfolio-batch-matter-${index}`,
        personId: `portfolio-batch-person-${index}`,
      })) });
      await context.prisma.intelligenceItem.createMany({ data: Array.from({ length: count }, (_, index) => ({
        id: `portfolio-batch-intelligence-${index}`,
        tenantId,
        customerId: 'portfolio-batch-customer',
        matterId: `portfolio-batch-matter-${index}`,
        assertionType: 'reported',
        statement: `人工情报 ${index}`,
        sourceKind: 'manual',
        sourceDescription: '人工确认',
        learnedAt: new Date(now.getTime() - 31 * 86_400_000),
        confidence: 0.8,
        targetRefs: JSON.stringify([{ kind: 'matter', id: `portfolio-batch-matter-${index}` }]),
        createdByUserId: context.owner.id,
      })) });
      await context.prisma.intelligenceItem.create({ data: {
        id: 'portfolio-batch-unreferenced-archived-intelligence',
        tenantId,
        customerId: 'portfolio-batch-customer',
        matterId: 'portfolio-batch-matter-0',
        assertionType: 'reported',
        statement: 'UNREFERENCED_ARCHIVED_INTELLIGENCE_BODY',
        sourceKind: 'manual',
        sourceDescription: 'UNREFERENCED_ARCHIVED_SOURCE_DESCRIPTION',
        learnedAt: new Date(now.getTime() - 32 * 86_400_000),
        confidence: 0.8,
        targetRefs: JSON.stringify([{ kind: 'matter', id: 'portfolio-batch-matter-0' }]),
        createdByUserId: context.owner.id,
        archivedAt: now,
        archivedByUserId: context.owner.id,
        archiveReason: 'historical',
      } });
      await context.prisma.stakeholderFocus.createMany({ data: Array.from({ length: count }, (_, index) => ({
        id: `portfolio-batch-focus-${index}`,
        tenantId,
        customerId: 'portfolio-batch-customer',
        matterId: `portfolio-batch-matter-${index}`,
        personId: `portfolio-batch-person-${index}`,
        desiredChange: '确认下一步',
        rationale: '人工确认的当前聚焦',
        evidenceGap: '需补充证据',
        basisRefs: '[]',
        validUntil: new Date(now.getTime() + 30 * 86_400_000),
        activeMatterKey: `portfolio-batch-matter-${index}`,
        confirmedByUserId: context.owner.id,
        confirmedAt: now,
      })) });
      await context.prisma.salesHypothesis.createMany({ data: Array.from({ length: count }, (_, index) => ({
        id: `portfolio-batch-hypothesis-${index}`,
        tenantId,
        customerId: 'portfolio-batch-customer',
        matterId: `portfolio-batch-matter-${index}`,
        personId: `portfolio-batch-person-${index}`,
        status: 'untested',
        ownerUserId: context.owner.id,
        nextReviewAt: new Date(now.getTime() + 3 * 86_400_000),
        currentRevisionId: `portfolio-batch-revision-${index}`,
        createdByUserId: context.owner.id,
      })) });
      await context.prisma.salesHypothesisRevision.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          id: `portfolio-batch-revision-${index}`,
          tenantId,
          hypothesisId: `portfolio-batch-hypothesis-${index}`,
          revisionNumber: 1,
          claim: `批量假设 ${index}`,
          reason: '人工确认依据',
          expectedSignals: '["signal"]',
          falsificationConditions: '["counter-signal"]',
          origin: 'user',
          createdByUserId: context.owner.id,
        })),
      });
      await context.prisma.evidenceEvent.create({ data: {
        id: 'portfolio-batch-evidence-0',
        tenantId,
        accountId: 'portfolio-batch-customer',
        opportunityId: 'portfolio-batch-matter-0',
        personId: 'portfolio-batch-person-0',
        signalKey: 'intro_referral',
        direction: 1,
        status: 'approved',
        rawContent: 'CURRENT_HYPOTHESIS_EVIDENCE_BODY',
      } });
      await context.prisma.hypothesisEvidenceLink.create({ data: {
        id: 'portfolio-batch-link-0',
        tenantId,
        hypothesisId: 'portfolio-batch-hypothesis-0',
        hypothesisRevisionId: 'portfolio-batch-revision-0',
        evidenceId: 'portfolio-batch-evidence-0',
        evidenceVersion: 0,
        direction: 'supporting',
        linkedByUserId: context.owner.id,
      } });

      const intelligenceDetailReads = vi.spyOn(context.prisma.intelligenceItem, 'findFirst');
      const intelligenceBatchReads = vi.spyOn(context.prisma.intelligenceItem, 'findMany');
      const focusDetailReads = vi.spyOn(context.prisma.stakeholderFocus, 'findFirst');
      const hypothesisDetailReads = vi.spyOn(context.prisma.salesHypothesis, 'findFirst');
      try {
        const commandContext: CommandContext = {
          tenantId,
          actorId: context.owner.id,
          actorRole: 'owner',
          channel: 'web',
          requestId: 'portfolio-batch-query-budget',
          assertionMode: 'user_asserted',
        };
        const policy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };
        const portfolio = await buildMatterPortfolioReadModel(
          context.prisma,
          commandContext,
          policy,
          now,
        );
        expect(portfolio.entries).toHaveLength(count);
        expect(portfolio.entries.every((entry) => entry.attentionItems.some(
          (item) => item.providerKey === 'matter_portfolio.intelligence',
        ))).toBe(true);
        expect(portfolio.entries.every((entry) => entry.attentionItems.some(
          (item) => item.providerKey === 'matter_portfolio.hypothesis',
        ))).toBe(true);
        expect(intelligenceDetailReads).not.toHaveBeenCalled();
        expect(intelligenceBatchReads).toHaveBeenCalledTimes(1);
        expect(intelligenceBatchReads.mock.calls[0]?.[0]).toMatchObject({
          where: { archivedAt: null },
        });
        expect(focusDetailReads).not.toHaveBeenCalled();
        expect(hypothesisDetailReads).not.toHaveBeenCalled();
      } finally {
        intelligenceDetailReads.mockRestore();
        intelligenceBatchReads.mockRestore();
        focusDetailReads.mockRestore();
        hypothesisDetailReads.mockRestore();
      }

      await context.prisma.evidenceEvent.update({
        where: { id: 'portfolio-batch-evidence-0' },
        data: { status: 'pending_review' },
      });
      const invalidLinkClosure = await buildMatterPortfolioReadModel(
        context.prisma,
        {
          tenantId,
          actorId: context.owner.id,
          actorRole: 'owner',
          channel: 'web',
          requestId: 'portfolio-invalid-link-closure',
          assertionMode: 'user_asserted',
        },
        { entitlements: ['sales.workspace'], permissions: [] },
        now,
      );
      const invalidEntry = invalidLinkClosure.entries.find(
        (entry) => entry.matter.id === 'portfolio-batch-matter-0',
      )!;
      expect(invalidEntry.attentionItems.some(
        (item) => item.providerKey === 'matter_portfolio.hypothesis',
      )).toBe(false);
      expect(JSON.stringify(invalidEntry)).not.toContain('CURRENT_HYPOTHESIS_EVIDENCE_BODY');
    } finally {
      await context.cleanup();
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
      await context.prisma.opportunity.create({ data: {
        id: 'portfolio-source-other-matter', tenantId, accountId: 'portfolio-source-customer',
        name: '无关来源事项', kind: 'general', lifecycleStatus: 'active', customerType: 1,
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
      await context.prisma.intelligenceItem.create({ data: {
        id: 'portfolio-source-other-intelligence', tenantId,
        customerId: 'portfolio-source-customer', matterId: 'portfolio-source-other-matter',
        assertionType: 'reported', statement: 'UNRELATED_SENSITIVE_INTELLIGENCE_BODY',
        sourceKind: 'manual', sourceDescription: 'UNRELATED_SENSITIVE_SOURCE_DESCRIPTION',
        learnedAt: new Date(Date.now() - 31 * 86_400_000), confidence: 0.8,
        targetRefs: JSON.stringify([{ kind: 'matter', id: 'portfolio-source-other-matter' }]),
        createdByUserId: context.owner.id,
      } });

      const response = await context.app.inject({
        method: 'GET', url: '/api/matter-portfolio', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const portfolio = MatterPortfolioReadModelSchema.parse(response.json());
      const sourceEntry = portfolio.entries.find(
        (entry) => entry.matter.id === 'portfolio-source-matter',
      )!;
      const sourceItem = sourceEntry.attentionItems.find(
        (item) => item.providerKey === 'matter_portfolio.intelligence',
      )!;
      expect(sourceItem).toBeDefined();
      expect(response.body).not.toContain('SENSITIVE_INTELLIGENCE_BODY');
      expect(response.body).not.toContain('SENSITIVE_SOURCE_DESCRIPTION');
      const sourceRef = sourceItem.sourceRefs.find((ref) => ref.entityKind === 'intelligence_item')!;
      const sourceRequest = {
        providerKey: 'matter_portfolio.intelligence' as const,
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
      expect(exact.body).not.toContain('UNRELATED_SENSITIVE_INTELLIGENCE_BODY');
      expect(exact.body).not.toContain('UNRELATED_SENSITIVE_SOURCE_DESCRIPTION');
      const intelligenceListReads = vi.spyOn(context.prisma.intelligenceItem, 'findMany');
      await matterPortfolioSourceView(context.prisma, {
        tenantId,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'portfolio-source-query-budget',
        assertionMode: 'user_asserted',
      }, {
        entitlements: ['sales.workspace'],
        permissions: [],
      }, sourceRequest, new Date());
      const intelligenceQueryCount = intelligenceListReads.mock.calls.length;
      const intelligenceQuery = intelligenceListReads.mock.calls[0]?.[0];
      intelligenceListReads.mockRestore();
      expect(intelligenceQueryCount).toBe(1);
      expect(intelligenceQuery).toMatchObject({
        where: { matterId: { in: ['portfolio-source-matter'] } },
      });

      const todayItem = sourceEntry.attentionItems.find(
        (item) => item.providerKey === 'core.today',
      )!;
      const todaySourceRef = todayItem.sourceRefs.find((ref) => ref.entityKind === 'matter')!;
      const todaySourceRequest = {
        providerKey: 'core.today' as const,
        customerId: 'portfolio-source-customer',
        matterId: 'portfolio-source-matter',
        sourceRef: todaySourceRef,
      };
      const todayPlanReads = vi.spyOn(context.prisma.planAction, 'findMany');
      await matterPortfolioSourceView(context.prisma, {
        tenantId,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'portfolio-today-source-query-budget',
        assertionMode: 'user_asserted',
      }, {
        entitlements: ['sales.workspace'],
        permissions: [],
      }, todaySourceRequest, new Date());
      const todayPlanQueries = todayPlanReads.mock.calls.map((call) => call[0]);
      todayPlanReads.mockRestore();
      expect(JSON.stringify(todayPlanQueries)).toContain('portfolio-source-matter');
      expect(JSON.stringify(todayPlanQueries)).not.toContain('portfolio-source-other-matter');

      const radarSnapshotReads = vi.spyOn(context.prisma.relationshipRadarSnapshot, 'findMany');
      await relationshipRadarTodayItems(context.prisma, {
        tenantId,
        actorId: context.owner.id,
        actorRole: 'owner',
      }, {
        entitlements: ['sales.workspace'],
        permissions: [],
      }, new Date(), {
        customerId: 'portfolio-source-customer',
        matterId: 'portfolio-source-matter',
      });
      const radarSnapshotQuery = radarSnapshotReads.mock.calls[0]?.[0];
      radarSnapshotReads.mockRestore();
      expect(radarSnapshotQuery).toMatchObject({
        where: {
          customerId: 'portfolio-source-customer',
          matterId: { in: ['portfolio-source-matter'] },
        },
      });

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
