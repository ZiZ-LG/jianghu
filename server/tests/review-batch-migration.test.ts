import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyReviewBatchMigration,
  inspectReviewBatchSchemaState,
  reportReviewBatchMigration,
  REVIEW_BATCH_MIGRATION_MARKER,
  verifyReviewBatchMigration,
} from '../src/reviewBatches/migration.js';
import { createPersonCandidate } from '../src/candidates/personRelation.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('CORE-205 ReviewBatch and Interaction migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('marks the exact empty expansion without changing formal CRM facts or adding body columns', async () => {
    const formalBefore = await Promise.all([
      test.prisma.candidate.count(), test.prisma.person.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ]);

    await expect(inspectReviewBatchSchemaState(test.prisma)).resolves.toBe('expanded');
    await expect(reportReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, reviewBatches: 0, interactions: 0, attachedCandidates: 0,
      conflicts: [],
    });
    await expect(applyReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, writes: 1,
    });
    await expect(verifyReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, conflicts: [],
    });
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: REVIEW_BATCH_MIGRATION_MARKER },
    })).resolves.toMatchObject({ key: REVIEW_BATCH_MIGRATION_MARKER });
    expect(await Promise.all([
      test.prisma.candidate.count(), test.prisma.person.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ])).toEqual(formalBefore);

    for (const table of ['ReviewBatch', 'Interaction']) {
      const columns = await test.prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
      expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
        'body', 'content', 'contentEnc', 'evidence', 'payload', 'rawContent',
      ]));
    }
  });

  it('rolls the marker back when apply is interrupted', async () => {
    await expect(applyReviewBatchMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected ReviewBatch migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: REVIEW_BATCH_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('accepts a valid pending source-anchored Candidate before it is assigned to a batch', async () => {
    const accountId = 'core-205-source-only-account';
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Source-only account',
      primaryOwnerUserId: test.owner.id,
    } });
    const sourceResponse = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'core-205-source-only-artifact',
      },
      payload: {
        source: 'migration-test', externalRef: 'source-only-artifact',
        title: 'Source-only artifact', accountId,
      },
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(200);
    const source = sourceResponse.json<{ id: string }>();
    const candidate = await createPersonCandidate(test.prisma, {
      id: 'core-205-source-only-person', tenantId: test.tenant.id, accountId,
      name: 'Pending source-only person', source: 'migration-test',
      sourceRef: 'source-only-artifact:person', evidence: 'pending evidence', confidence: 0.7,
      createdByUserId: test.owner.id, dedupeKey: 'core-205-source-only-person',
    });
    await test.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { sourceArtifactId: source.id },
    });

    await expect(reportReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, reviewBatches: 0, interactions: 0,
      attachedCandidates: 1, conflicts: [],
    });
    await expect(applyReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, attachedCandidates: 1,
    });
    await expect(verifyReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, conflicts: [],
    });
  });

  it('fails closed on an orphaned pre-batch Candidate attachment and never blesses it with a marker', async () => {
    await test.prisma.account.create({ data: {
      id: 'core-205-migration-account', tenantId: test.tenant.id, name: 'Migration account',
    } });
    await test.prisma.candidate.create({ data: {
      id: 'core-205-orphan-candidate', tenantId: test.tenant.id, kind: 'person_create',
      accountId: 'core-205-migration-account', targetKind: 'person', payload: '{}',
      source: 'test', sourceRef: 'test:orphan', evidence: 'candidate excerpt', confidence: 0.7,
      sourceArtifactId: 'missing-artifact', reviewBatchId: 'missing-batch',
      createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
      dedupeKey: 'core-205-orphan', version: 0,
    } });

    const report = await reportReviewBatchMigration(test.prisma);
    expect(report.ok).toBe(false);
    expect(report.conflicts).toContain(
      `${test.tenant.id}:candidate:core-205-orphan-candidate:source_authority_mismatch`,
    );
    await expect(applyReviewBatchMigration(test.prisma)).rejects.toThrow('source_authority_mismatch');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: REVIEW_BATCH_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('rejects an Interaction that has no ReviewBatch trace', async () => {
    const accountId = 'core-205-orphan-interaction-account';
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Orphan interaction account',
      primaryOwnerUserId: test.owner.id,
    } });
    const sourceResponse = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'core-205-orphan-interaction-source',
      },
      payload: {
        source: 'migration-test', externalRef: 'orphan-interaction-source',
        title: 'Orphan interaction source', accountId,
      },
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(200);
    const source = sourceResponse.json<{ id: string }>();
    await test.prisma.interaction.create({ data: {
      id: 'core-205-orphan-interaction', tenantId: test.tenant.id, accountId,
      sourceArtifactId: source.id, activityKind: 'meeting',
      occurredAt: new Date('2026-08-25T18:00:00.000Z'),
      createdByUserId: test.owner.id, confirmedByUserId: test.owner.id,
    } });

    const report = await reportReviewBatchMigration(test.prisma);
    expect(report.ok).toBe(false);
    expect(report.conflicts).toContain(
      `${test.tenant.id}:interaction:core-205-orphan-interaction:review_batch_missing`,
    );
    await expect(applyReviewBatchMigration(test.prisma)).rejects.toThrow('review_batch_missing');
  });
});
