import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RESEARCH_BRIEF_MIGRATION_MARKER,
  applyResearchBriefMigration,
  inspectResearchBriefSchemaState,
  reportResearchBriefMigration,
  verifyResearchBriefMigration,
} from '../src/researchBriefs/migration.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-204 ResearchBriefSnapshot migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('marks the exact empty expansion without backfilling a snapshot or formal CRM row', async () => {
    await expect(inspectResearchBriefSchemaState(test.prisma)).resolves.toBe('expanded');
    const formalCountsBefore = await Promise.all([
      test.prisma.account.count(),
      test.prisma.opportunity.count(),
      test.prisma.person.count(),
      test.prisma.edge.count(),
      test.prisma.planAction.count(),
      test.prisma.candidate.count(),
      test.prisma.reviewBatch.count(),
      test.prisma.agentRun.count(),
    ]);
    await expect(reportResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: false,
      snapshots: 0,
      conflicts: [],
    });
    await expect(applyResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
      snapshots: 0,
      writes: 1,
    });
    await expect(verifyResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
      conflicts: [],
    });
    await expect(test.prisma.researchBriefSnapshot.count()).resolves.toBe(0);
    await expect(Promise.all([
      test.prisma.account.count(),
      test.prisma.opportunity.count(),
      test.prisma.person.count(),
      test.prisma.edge.count(),
      test.prisma.planAction.count(),
      test.prisma.candidate.count(),
      test.prisma.reviewBatch.count(),
      test.prisma.agentRun.count(),
    ])).resolves.toEqual(formalCountsBefore);
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: RESEARCH_BRIEF_MIGRATION_MARKER },
    })).resolves.toMatchObject({ key: RESEARCH_BRIEF_MIGRATION_MARKER });
  });

  it('treats the table as uninitialized until the AgentRun dependency exists', async () => {
    const dependencyMissing = {
      $queryRawUnsafe: async () => [
        { name: 'Tenant' },
        { name: 'DataMigrationState' },
        { name: 'ResearchBriefSnapshot' },
      ],
    };
    await expect(inspectResearchBriefSchemaState(
      dependencyMissing as unknown as Parameters<typeof inspectResearchBriefSchemaState>[0],
    )).resolves.toBe('uninitialized');
  });

  it('fails report closed when the snapshot table is missing behind a marker', async () => {
    const missingTable = Object.assign(new Error('no such table: ResearchBriefSnapshot'), { code: 'P2021' });
    const partial = {
      dataMigrationState: { findUnique: async () => ({ details: '{}' }) },
      researchBriefSnapshot: { findMany: async () => { throw missingTable; } },
    };
    await expect(reportResearchBriefMigration(
      partial as unknown as Parameters<typeof reportResearchBriefMigration>[0],
    )).resolves.toMatchObject({
      ok: false,
      snapshots: 0,
      conflicts: expect.arrayContaining([
        'research_brief_marker_invalid',
        'research_brief_marker_without_schema',
      ]),
    });
  });

  it('rolls the marker back when apply is interrupted', async () => {
    await expect(applyResearchBriefMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected ResearchBrief migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: RESEARCH_BRIEF_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('accepts bounded encrypted metadata and rejects semantic or marker drift', async () => {
    await test.prisma.account.create({ data: {
      id: 'research-brief-account',
      tenantId: test.tenant.id,
      name: 'Research brief account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.researchBriefSnapshot.create({ data: {
      id: 'research-brief-valid',
      tenantId: test.tenant.id,
      customerId: 'research-brief-account',
      matterId: null,
      createdByUserId: test.owner.id,
      generationKey: 'c'.repeat(64),
      status: 'ready',
      subjectStatus: 'matched',
      payloadEnc: 'iv.tag.ciphertext',
      payloadFingerprint: 'a'.repeat(64),
      sourceSetHash: 'b'.repeat(64),
      sourceCount: 1,
      sectionCount: 1,
      unknownCount: 0,
      failureCount: 0,
      version: 1,
      basedOnAt: new Date('2026-08-26T10:00:00.000Z'),
      freshUntil: new Date('2026-08-27T10:00:00.000Z'),
      generatedAt: new Date('2026-08-26T11:00:00.000Z'),
    } });
    await expect(reportResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      snapshots: 1,
      conflicts: [],
    });
    await expect(applyResearchBriefMigration(test.prisma)).resolves.toMatchObject({ ok: true });

    await test.prisma.researchBriefSnapshot.update({
      where: { id: 'research-brief-valid' }, data: { sourceCount: 21 },
    });
    await expect(verifyResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: [`${test.tenant.id}:research_brief:research-brief-valid:metadata_invalid`],
    });
    await test.prisma.researchBriefSnapshot.update({
      where: { id: 'research-brief-valid' }, data: { sourceCount: 1 },
    });
    await test.prisma.researchBriefSnapshot.update({
      where: { id: 'research-brief-valid' }, data: { generationKey: 'g'.repeat(64) },
    });
    await expect(verifyResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: [`${test.tenant.id}:research_brief:research-brief-valid:metadata_invalid`],
    });
    await test.prisma.researchBriefSnapshot.update({
      where: { id: 'research-brief-valid' }, data: { generationKey: 'c'.repeat(64), sectionCount: 0 },
    });
    await expect(verifyResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: [`${test.tenant.id}:research_brief:research-brief-valid:status_invalid`],
    });
    await test.prisma.researchBriefSnapshot.update({
      where: { id: 'research-brief-valid' }, data: { sectionCount: 1 },
    });
    await test.prisma.dataMigrationState.update({
      where: { key: RESEARCH_BRIEF_MIGRATION_MARKER }, data: { details: '{}' },
    });
    await expect(verifyResearchBriefMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: ['research_brief_marker_invalid'],
    });
  });
});
