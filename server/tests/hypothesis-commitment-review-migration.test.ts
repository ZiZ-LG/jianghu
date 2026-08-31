import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER,
  applyHypothesisCommitmentReviewMigration,
  inspectHypothesisCommitmentReviewSchemaState,
  reportHypothesisCommitmentReviewMigration,
  verifyHypothesisCommitmentReviewMigration,
} from '../src/relationshipWorkspace/migration.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-208 hypothesis Commitment review migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  async function createAuthorityTree(prefix: string) {
    const customerId = `${prefix}-customer`;
    const matterId = `${prefix}-matter`;
    const personId = `${prefix}-person`;
    const hypothesisId = `${prefix}-hypothesis`;
    const revisionId = `${prefix}-revision`;
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: `${prefix} customer`,
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId,
      name: `${prefix} matter`, customerType: 1, pipelineStage: 'lead', engageStage: 'unknown',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId: customerId,
      name: `${prefix} person`, title: '负责人',
    } });
    await test.prisma.salesHypothesis.create({ data: {
      id: hypothesisId, tenantId: test.tenant.id, customerId, matterId, personId,
      status: 'testing', ownerUserId: test.owner.id,
      nextReviewAt: new Date('2026-09-30T00:00:00.000Z'), currentRevisionId: revisionId,
      createdByUserId: test.owner.id, statusConfirmedByUserId: test.owner.id,
      statusConfirmedAt: new Date('2026-08-31T00:00:00.000Z'),
    } });
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: revisionId, tenantId: test.tenant.id, hypothesisId, revisionNumber: 1,
      claim: '若实施风险澄清，客户将安排评审', reason: '实施负责人确认',
      expectedSignals: '["安排技术评审"]', falsificationConditions: '["拒绝技术评审"]',
      origin: 'user', createdByUserId: test.owner.id,
    } });
    return { customerId, matterId, personId, hypothesisId, revisionId };
  }

  it('marks an exact empty expansion without backfill or formal-row mutation', async () => {
    await expect(inspectHypothesisCommitmentReviewSchemaState(test.prisma)).resolves.toBe('expanded');
    const countsBefore = await Promise.all([
      test.prisma.account.count(), test.prisma.opportunity.count(), test.prisma.person.count(),
      test.prisma.edge.count(), test.prisma.planAction.count(), test.prisma.evidenceEvent.count(),
      test.prisma.salesHypothesis.count(), test.prisma.salesHypothesisRevision.count(),
      test.prisma.hypothesisEvidenceLink.count(),
    ]);
    await expect(reportHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, commitments: 0, linkedCommitments: 0,
      linkedEvidence: 0, conflicts: [],
    });
    await expect(applyHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, writes: 1,
    });
    await expect(verifyHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, conflicts: [],
    });
    await expect(Promise.all([
      test.prisma.account.count(), test.prisma.opportunity.count(), test.prisma.person.count(),
      test.prisma.edge.count(), test.prisma.planAction.count(), test.prisma.evidenceEvent.count(),
      test.prisma.salesHypothesis.count(), test.prisma.salesHypothesisRevision.count(),
      test.prisma.hypothesisEvidenceLink.count(),
    ])).resolves.toEqual(countsBefore);
  });

  it('accepts exact same-row result and Evidence linkage without synthesizing a second task', async () => {
    const tree = await createAuthorityTree('valid-208');
    const commitmentId = 'valid-208-commitment';
    await test.prisma.planAction.create({ data: {
      id: commitmentId, tenantId: test.tenant.id, accountId: tree.customerId,
      opportunityId: tree.matterId, personId: tree.personId, title: '确认技术评审',
      ownerId: test.owner.id, ownerUserId: test.owner.id,
      executionStatus: 'completed', confirmationStatus: 'not_required',
      scheduledAtUtc: new Date('2026-09-01T00:00:00.000Z'), isAllDay: false,
      localDate: null, hypothesisId: tree.hypothesisId, hypothesisRevisionId: tree.revisionId,
      completionResult: '客户已确认评审时间',
      completionResultRecordedAtUtc: new Date('2026-09-01T02:00:00.000Z'),
      completionResultRecordedByUserId: test.owner.id,
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'valid-208-evidence', tenantId: test.tenant.id, accountId: tree.customerId,
      opportunityId: tree.matterId, personId: tree.personId, signalKey: 'review_scheduled',
      direction: 1, status: 'approved', rawContent: '客户确认评审时间', createdBy: test.owner.id,
      reviewedBy: test.owner.id, reviewedAt: '2026-09-01',
    } });
    await test.prisma.hypothesisEvidenceLink.create({ data: {
      id: 'valid-208-link', tenantId: test.tenant.id, hypothesisId: tree.hypothesisId,
      hypothesisRevisionId: tree.revisionId, evidenceId: 'valid-208-evidence', evidenceVersion: 0,
      direction: 'supporting', verificationCommitmentId: commitmentId,
      linkedByUserId: test.owner.id,
    } });
    await expect(reportHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: true, commitments: 1, linkedCommitments: 1, linkedEvidence: 1, conflicts: [],
    });
    await expect(applyHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({ ok: true });
  });

  it('fails closed on partial pointer, result metadata, disposition, and Evidence closure drift', async () => {
    const tree = await createAuthorityTree('drift-208');
    await test.prisma.planAction.create({ data: {
      id: 'drift-208-commitment', tenantId: test.tenant.id, accountId: tree.customerId,
      opportunityId: tree.matterId, title: '验证', ownerId: test.owner.id,
      ownerUserId: test.owner.id, executionStatus: 'completed',
      hypothesisId: tree.hypothesisId, hypothesisRevisionId: tree.revisionId,
    } });
    await test.prisma.$executeRawUnsafe(
      'UPDATE "PlanAction" SET "hypothesisRevisionId" = NULL, "completionResult" = ? WHERE id = ?',
      '未记录审计元数据的结果', 'drift-208-commitment',
    );
    await expect(reportHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        `${test.tenant.id}:commitment:drift-208-commitment:hypothesis_pointer_invalid`,
        `${test.tenant.id}:commitment:drift-208-commitment:completion_result_invalid`,
      ]),
    });
    await test.prisma.$executeRawUnsafe(
      'UPDATE "PlanAction" SET "hypothesisRevisionId" = ?, "completionResult" = ?, "verificationReviewDisposition" = ? WHERE id = ?',
      tree.revisionId, '', 'automatic', 'drift-208-commitment',
    );
    await expect(reportHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: [`${test.tenant.id}:commitment:drift-208-commitment:review_metadata_invalid`],
    });
  });

  it('rolls the marker back when apply is interrupted and rejects marker drift', async () => {
    await expect(applyHypothesisCommitmentReviewMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected hypothesis Commitment review migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER },
    })).resolves.toBeNull();
    await applyHypothesisCommitmentReviewMigration(test.prisma);
    await test.prisma.dataMigrationState.update({
      where: { key: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER }, data: { details: '{}' },
    });
    await expect(verifyHypothesisCommitmentReviewMigration(test.prisma)).resolves.toMatchObject({
      ok: false, conflicts: ['hypothesis_commitment_review_marker_invalid'],
    });
  });

  it('detects legacy, partial, and exact SQLite expansion states', async () => {
    const rows = (names: string[]) => names.map((name) => ({ name }));
    const legacy = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('sqlite_master')) return rows([
          'Tenant', 'DataMigrationState', 'PlanAction', 'SalesHypothesis',
          'SalesHypothesisRevision', 'HypothesisEvidenceLink',
        ]);
        return [];
      },
    };
    await expect(inspectHypothesisCommitmentReviewSchemaState(
      legacy as unknown as Parameters<typeof inspectHypothesisCommitmentReviewSchemaState>[0],
    )).resolves.toBe('legacy');
    const partial = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('sqlite_master')) return rows([
          'Tenant', 'DataMigrationState', 'PlanAction', 'SalesHypothesis',
          'SalesHypothesisRevision', 'HypothesisEvidenceLink',
        ]);
        if (sql.includes('table_info("PlanAction")')) return [{
          name: 'hypothesisId', type: 'TEXT', notnull: 0, dflt_value: null,
        }];
        return [];
      },
    };
    await expect(inspectHypothesisCommitmentReviewSchemaState(
      partial as unknown as Parameters<typeof inspectHypothesisCommitmentReviewSchemaState>[0],
    )).resolves.toBe('partial');
  });
});
