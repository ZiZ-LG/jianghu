import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RELATIONSHIP_RADAR_RULE_VERSION,
  type RelationshipRadarSnapshotPayload,
} from '@jianghu/domain-contracts';
import {
  RELATIONSHIP_RADAR_MIGRATION_MARKER,
  applyRelationshipRadarMigration,
  canonicalRelationshipRadarPayload,
  inspectRelationshipRadarSchemaState,
  relationshipRadarMigrationSchemaFingerprint,
  reportRelationshipRadarMigration,
  verifyRelationshipRadarMigration,
} from '../src/relationshipRadar/migration.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const generatedAtUtc = '2026-09-01T08:30:00.000Z';
const expiresAtUtc = '2026-09-02T08:30:00.000Z';
const matterRef = { entityKind: 'matter', entityId: 'radar-matter', version: 0, scheduleVersion: null };

function payload(): RelationshipRadarSnapshotPayload {
  const dimensions = [
    'interaction_freshness', 'single_threaded_contact', 'role_coverage',
    'visible_warm_paths', 'evidence_freshness', 'next_step_completeness',
  ] as const;
  return {
    customerId: 'radar-account',
    matterId: 'radar-matter',
    generatedAtUtc,
    expiresAtUtc,
    ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
    signals: dimensions.map((dimension) => ({
      id: `rrsig_${dimension}`,
      dimension,
      status: 'healthy' as const,
      severity: 'info' as const,
      reasonCode: `${dimension}.healthy`,
      explanation: '仅基于当前可见的正式 CRM 元数据生成。',
      sourceRefs: [matterRef],
      observedAtUtc: generatedAtUtc,
      ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
      expiresAtUtc,
      suggestedAction: { kind: 'view_relationship_source', label: '查看依据', commandType: null },
    })) as RelationshipRadarSnapshotPayload['signals'],
    interventions: [],
    drafts: [],
  };
}

describe('SAAS-212 RelationshipRadarSnapshot migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('marks the exact empty expansion without backfilling any CRM or Agent row', async () => {
    await expect(inspectRelationshipRadarSchemaState(test.prisma)).resolves.toBe('expanded');
    await expect(reportRelationshipRadarMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, snapshots: 0, conflicts: [],
    });
    await expect(applyRelationshipRadarMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, snapshots: 0, writes: 1,
    });
    await expect(verifyRelationshipRadarMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, snapshots: 0, conflicts: [],
    });
    await expect(test.prisma.relationshipRadarSnapshot.count()).resolves.toBe(0);
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: RELATIONSHIP_RADAR_MIGRATION_MARKER },
    })).resolves.toMatchObject({ key: RELATIONSHIP_RADAR_MIGRATION_MARKER });
    expect(relationshipRadarMigrationSchemaFingerprint()).toMatch(/^[a-f0-9]{64}$/);

    const columns = await test.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("RelationshipRadarSnapshot")',
    );
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'body', 'content', 'prompt', 'response', 'rawResponse', 'token', 'secret', 'totalScore',
    ]));
  });

  it('treats a fully missing snapshot table as legacy while partial shape stays a schema-state failure', async () => {
    const dependencyOnly = {
      $queryRawUnsafe: async () => [
        { name: 'Tenant' }, { name: 'DataMigrationState' }, { name: 'AgentRun' },
      ],
    };
    await expect(inspectRelationshipRadarSchemaState(
      dependencyOnly as unknown as Parameters<typeof inspectRelationshipRadarSchemaState>[0],
    )).resolves.toBe('legacy');

    const missingTable = Object.assign(new Error('no such table: RelationshipRadarSnapshot'), { code: 'P2021' });
    const partial = {
      dataMigrationState: { findUnique: async () => null },
      relationshipRadarSnapshot: { findMany: async () => { throw missingTable; } },
    };
    await expect(reportRelationshipRadarMigration(
      partial as unknown as Parameters<typeof reportRelationshipRadarMigration>[0],
    )).resolves.toMatchObject({ ok: true, snapshots: 0, conflicts: [] });
  });

  it('rolls marker-last apply back when interrupted', async () => {
    await expect(applyRelationshipRadarMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected Relationship Radar migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: RELATIONSHIP_RADAR_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('canonicalizes body-free payloads and rejects malformed stored snapshots', async () => {
    const canonical = canonicalRelationshipRadarPayload(payload());
    expect(canonical).toBe(canonicalRelationshipRadarPayload(JSON.parse(canonical)));
    expect(canonical).not.toContain('totalScore');
    expect(canonical).not.toContain('sourceBody');

    await test.prisma.relationshipRadarSnapshot.create({ data: {
      id: 'rrs-invalid',
      tenantId: test.tenant.id,
      customerId: 'radar-account',
      matterId: 'radar-matter',
      createdByUserId: test.owner.id,
      agentRunId: 'missing-agent-run',
      generationKey: 'a'.repeat(64),
      payloadJson: canonical,
      payloadFingerprint: 'b'.repeat(64),
      sourceSetHash: 'c'.repeat(64),
      signalCount: 6,
      interventionCount: 0,
      draftCount: 0,
      ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
      generatedAt: new Date(generatedAtUtc),
      expiresAt: new Date(expiresAtUtc),
    } });
    const report = await reportRelationshipRadarMigration(test.prisma);
    expect(report.ok).toBe(false);
    expect(report.conflicts).toContain(`${test.tenant.id}:relationship_radar:rrs-invalid:payload_fingerprint_invalid`);
    expect(report.conflicts).toContain(`${test.tenant.id}:relationship_radar:rrs-invalid:agent_run_invalid`);
  });
});
