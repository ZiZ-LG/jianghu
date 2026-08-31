import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SALES_HYPOTHESIS_MIGRATION_MARKER,
  applySalesHypothesisMigration,
  hypothesisIdentityForLegacy,
  inspectSalesHypothesisSchemaState,
  reportSalesHypothesisMigration,
  verifySalesHypothesisMigration,
} from '../src/hypotheses/migration.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-207 SalesHypothesis migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  async function createParent(prefix: string) {
    const customerId = `${prefix}-customer`;
    const matterId = `${prefix}-matter`;
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: `${prefix} customer`,
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId,
      name: `${prefix} matter`, customerType: 1, pipelineStage: 'lead', engageStage: 'unknown',
      primaryOwnerUserId: test.owner.id,
    } });
    return { customerId, matterId };
  }

  it('backfills manual assumptions conservatively with deterministic immutable revision one', async () => {
    const { customerId, matterId } = await createParent('legacy-hypothesis');
    const createdAt = new Date('2026-08-01T08:00:00.000Z');
    await test.prisma.strategyRisk.create({ data: {
      id: 'legacy-assumption-207', tenantId: test.tenant.id,
      accountId: customerId, opportunityId: matterId, kind: 'assumption',
      text: '预算会在十二月如期批复', severity: 'mid', mitigation: '观察预算会时间',
      status: 'open', origin: 'manual', createdAt,
    } });
    await test.prisma.strategyRisk.create({ data: {
      id: 'legacy-risk-207', tenantId: test.tenant.id,
      accountId: customerId, opportunityId: matterId, kind: 'risk',
      text: '交付周期过短', severity: 'high', mitigation: '拆分里程碑',
      status: 'open', origin: 'manual', createdAt,
    } });
    const identity = hypothesisIdentityForLegacy(test.tenant.id, 'legacy-assumption-207');
    const formalBefore = await Promise.all([
      test.prisma.evidenceEvent.count(), test.prisma.edge.count(),
      test.prisma.planAction.count(), test.prisma.stakeholderFocus.count(),
    ]);

    await expect(reportSalesHypothesisMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, sourceRows: 1, projectedRows: 1, conflicts: [],
    });
    await expect(applySalesHypothesisMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, sourceRows: 1, projectedRows: 1, writes: 3,
    });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: identity.hypothesisId } }))
      .resolves.toMatchObject({
        tenantId: test.tenant.id, customerId, matterId, personId: null,
        status: 'untested', ownerUserId: null, nextReviewAt: null,
        currentRevisionId: identity.revisionId,
        legacyStrategyRiskId: 'legacy-assumption-207', createdByUserId: null,
        statusConfirmedByUserId: null, statusConfirmedAt: null, version: 0,
      });
    await expect(test.prisma.salesHypothesisRevision.findUniqueOrThrow({ where: { id: identity.revisionId } }))
      .resolves.toMatchObject({
        tenantId: test.tenant.id, hypothesisId: identity.hypothesisId, revisionNumber: 1,
        claim: '预算会在十二月如期批复', reason: '观察预算会时间',
        expectedSignals: '[]', falsificationConditions: '[]',
        origin: 'legacy_assumption', createdByUserId: null, createdAt,
      });
    await expect(test.prisma.strategyRisk.findUniqueOrThrow({ where: { id: 'legacy-assumption-207' } }))
      .resolves.toMatchObject({ text: '预算会在十二月如期批复', status: 'open', origin: 'manual' });
    await expect(test.prisma.salesHypothesis.findFirst({ where: { legacyStrategyRiskId: 'legacy-risk-207' } }))
      .resolves.toBeNull();
    await expect(Promise.all([
      test.prisma.evidenceEvent.count(), test.prisma.edge.count(),
      test.prisma.planAction.count(), test.prisma.stakeholderFocus.count(),
    ])).resolves.toEqual(formalBefore);
    await expect(verifySalesHypothesisMigration(test.prisma)).resolves.toMatchObject({ ok: true });
  });

  it('maps closed predecessor states only to retired and never infers truth', async () => {
    const { customerId, matterId } = await createParent('closed-hypothesis');
    for (const [index, status] of ['resolved', 'dismissed'].entries()) {
      await test.prisma.strategyRisk.create({ data: {
        id: `closed-assumption-${index}`, tenantId: test.tenant.id,
        accountId: customerId, opportunityId: matterId, kind: 'assumption',
        text: `历史关闭判断 ${index}`, status, origin: 'manual',
      } });
    }
    await applySalesHypothesisMigration(test.prisma);
    const rows = await test.prisma.salesHypothesis.findMany({
      where: { tenantId: test.tenant.id }, orderBy: { legacyStrategyRiskId: 'asc' },
    });
    expect(rows.map((row) => row.status)).toEqual(['retired', 'retired']);
    expect(rows.map((row) => row.status)).not.toContain('supported');
    expect(rows.map((row) => row.status)).not.toContain('contradicted');
  });

  it('fails closed on machine-origin, invalid value, orphan and successor identity conflicts', async () => {
    const { customerId, matterId } = await createParent('invalid-hypothesis');
    await test.prisma.strategyRisk.create({ data: {
      id: 'ai-assumption-207', tenantId: test.tenant.id,
      accountId: customerId, opportunityId: matterId, kind: 'assumption',
      text: '机器历史判断', status: 'open', origin: 'ai',
    } });
    await expect(reportSalesHypothesisMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        `${test.tenant.id}:StrategyRisk:ai-assumption-207:origin_not_user_confirmed`,
      ]),
    });
    await expect(applySalesHypothesisMigration(test.prisma)).rejects.toThrow('origin_not_user_confirmed');
    await test.prisma.strategyRisk.update({ where: { id: 'ai-assumption-207' }, data: { origin: 'manual' } });
    const identity = hypothesisIdentityForLegacy(test.tenant.id, 'ai-assumption-207');
    await test.prisma.salesHypothesis.create({ data: {
      id: identity.hypothesisId, tenantId: test.tenant.id, customerId, matterId,
      status: 'untested', currentRevisionId: 'conflicting-revision',
      legacyStrategyRiskId: 'different-source',
    } });
    await expect(reportSalesHypothesisMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        `${test.tenant.id}:StrategyRisk:ai-assumption-207:successor_identity_conflict`,
      ]),
    });
  });

  it('rolls back every backfill row and marker when interrupted', async () => {
    const { customerId, matterId } = await createParent('interrupt-hypothesis');
    await test.prisma.strategyRisk.create({ data: {
      id: 'interrupt-assumption-207', tenantId: test.tenant.id,
      accountId: customerId, opportunityId: matterId, kind: 'assumption',
      text: '中断测试判断', status: 'open', origin: 'manual',
    } });
    await expect(applySalesHypothesisMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected SalesHypothesis migration failure');
    await expect(test.prisma.salesHypothesis.count()).resolves.toBe(0);
    await expect(test.prisma.salesHypothesisRevision.count()).resolves.toBe(0);
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: SALES_HYPOTHESIS_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('keeps marker/source revision parity after later user revisions and rejects drift', async () => {
    const { customerId, matterId } = await createParent('parity-hypothesis');
    await test.prisma.strategyRisk.create({ data: {
      id: 'parity-assumption-207', tenantId: test.tenant.id,
      accountId: customerId, opportunityId: matterId, kind: 'assumption',
      text: '最初判断', status: 'open', origin: 'manual',
    } });
    await applySalesHypothesisMigration(test.prisma);
    const identity = hypothesisIdentityForLegacy(test.tenant.id, 'parity-assumption-207');
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: 'user-revision-207', tenantId: test.tenant.id, hypothesisId: identity.hypothesisId,
      revisionNumber: 2, claim: '修订判断', reason: '获得新事实',
      expectedSignals: '["出现支持信号"]', falsificationConditions: '["出现反证信号"]',
      origin: 'user', createdByUserId: test.owner.id,
    } });
    await test.prisma.salesHypothesis.update({
      where: { id: identity.hypothesisId },
      data: {
        currentRevisionId: 'user-revision-207', status: 'testing', ownerUserId: test.owner.id,
        nextReviewAt: new Date('2026-09-20T00:00:00.000Z'),
        statusConfirmedByUserId: test.owner.id, statusConfirmedAt: new Date(), version: 1,
      },
    });
    await expect(verifySalesHypothesisMigration(test.prisma)).resolves.toMatchObject({ ok: true });

    await test.prisma.salesHypothesisRevision.update({
      where: { id: identity.revisionId }, data: { claim: '被篡改的最初判断' },
    });
    await expect(verifySalesHypothesisMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        `${test.tenant.id}:StrategyRisk:parity-assumption-207:revision_semantic_conflict`,
      ]),
    });
  });

  it('detects exact expanded and partial SQLite schema states', async () => {
    await expect(inspectSalesHypothesisSchemaState(test.prisma)).resolves.toBe('expanded');
    const onlyOneTable = {
      $queryRawUnsafe: async () => [
        { name: 'Tenant' }, { name: 'DataMigrationState' },
        { name: 'IntelligenceItem' }, { name: 'StakeholderFocus' },
        { name: 'SalesHypothesis' },
      ],
    };
    await expect(inspectSalesHypothesisSchemaState(
      onlyOneTable as unknown as Parameters<typeof inspectSalesHypothesisSchemaState>[0],
    )).resolves.toBe('partial');
  });
});
