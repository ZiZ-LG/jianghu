import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enc } from '../src/ai.js';
import {
  applySourceArtifactMigration,
  reportSourceArtifactMigration,
  SOURCE_ARTIFACT_MIGRATION_MARKER,
  verifySourceArtifactMigration,
} from '../src/sourceArtifacts/migration.js';
import { artifactIdForExternalReference } from '../src/sourceArtifacts/model.js';
import { ensureSourceArtifactForTranscript } from '../src/sourceArtifacts/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-201 SourceArtifact deterministic migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('backfills each live body authority once, writes marker last and changes no formal CRM facts', async () => {
    await test.prisma.note.create({ data: {
      id: 'saas-201-note', tenantId: test.tenant.id, content: 'note body', source: 'manual',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await test.prisma.transcript.create({ data: {
      id: 'saas-201-transcript', tenantId: test.tenant.id, source: 'manual',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      title: 'meeting', contentEnc: enc('transcript body'), status: 'active',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    const formalBefore = await Promise.all([
      test.prisma.candidate.count(), test.prisma.person.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ]);

    await expect(reportSourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, notes: 1, transcripts: 1, missing: 2, conflicts: [],
    });
    await expect(applySourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, sourceArtifacts: 2, missing: 0,
    });
    await expect(verifySourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, sourceArtifacts: 2, missing: 0, conflicts: [],
    });
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: SOURCE_ARTIFACT_MIGRATION_MARKER },
    })).resolves.toMatchObject({ key: SOURCE_ARTIFACT_MIGRATION_MARKER });
    expect(await Promise.all([
      test.prisma.candidate.count(), test.prisma.person.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ])).toEqual(formalBefore);

    const columns = await test.prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("SourceArtifact")');
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['content', 'contentEnc', 'body', 'payload']));
  });

  it('rolls the artifacts and marker back together when apply is interrupted', async () => {
    await test.prisma.note.create({ data: {
      id: 'saas-201-rollback-note', tenantId: test.tenant.id, content: 'rollback body',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await expect(applySourceArtifactMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected SourceArtifact migration failure');
    await expect(test.prisma.sourceArtifact.count()).resolves.toBe(0);
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: SOURCE_ARTIFACT_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('accepts a creator-domain external identity adopted by its Transcript without changing artifact id', async () => {
    const domain = `creator-private-v1:${JSON.stringify(test.owner.id)}`;
    const artifactId = artifactIdForExternalReference(
      test.tenant.id, domain, 'feishu', 'saas-201-adopted-minute',
    );
    const now = new Date('2026-08-25T02:00:00.000Z');
    await test.prisma.sourceArtifact.create({ data: {
      id: artifactId, tenantId: test.tenant.id,
      backingKind: 'external_reference', backingId: artifactId,
      artifactKind: 'external_reference', source: 'feishu', externalRef: 'saas-201-adopted-minute',
      idempotencyDomain: domain, title: 'Adopted minute', occurredAt: null,
      fingerprintKind: 'reference_sha256_v1', sourceFingerprint: 'a'.repeat(64),
      retentionState: 'reference_only', retentionUpdatedAt: now,
      createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1, createdAt: now,
    } });
    await test.prisma.transcript.create({ data: {
      id: 'saas-201-adopted-transcript', tenantId: test.tenant.id, source: 'feishu',
      externalRef: 'saas-201-adopted-minute', idempotencyDomain: domain,
      title: 'Adopted minute', contentEnc: enc('adopted body'), status: 'active',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
      createdAt: now,
    } });

    await expect(ensureSourceArtifactForTranscript(
      test.prisma, test.tenant.id, 'saas-201-adopted-transcript',
    )).resolves.toMatchObject({
      id: artifactId, backingKind: 'transcript', backingId: 'saas-201-adopted-transcript',
      retentionState: 'available',
    });
    await expect(reportSourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, missing: 0, stale: 0, conflicts: [],
    });
    await expect(applySourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, missing: 0, stale: 0,
    });
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: artifactId } }))
      .resolves.toMatchObject({ backingKind: 'transcript', backingId: 'saas-201-adopted-transcript' });
  });

  it('preserves the last content fingerprint when migration reconciles a degraded Transcript', async () => {
    await test.prisma.transcript.create({ data: {
      id: 'saas-201-degraded-migration', tenantId: test.tenant.id, source: 'manual',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      title: 'Degraded migration', contentEnc: enc('last retained authority'), status: 'active',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    const projected = await ensureSourceArtifactForTranscript(
      test.prisma, test.tenant.id, 'saas-201-degraded-migration',
    );
    expect(projected).toMatchObject({ fingerprintKind: 'content_sha256_v1', retentionState: 'available' });
    await test.prisma.transcript.update({
      where: { id: 'saas-201-degraded-migration' },
      data: { contentEnc: '', status: 'redacted' },
    });

    await expect(reportSourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, missing: 0, stale: 1, conflicts: [],
    });
    await expect(applySourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, missing: 0, stale: 0,
    });
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: projected.id } }))
      .resolves.toMatchObject({
        fingerprintKind: 'content_sha256_v1', sourceFingerprint: projected.sourceFingerprint,
        retentionState: 'degraded',
      });
    await expect(verifySourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, missing: 0, stale: 0, conflicts: [],
    });
  });

  it('fails closed before writes when a backing authority crosses its tenant parent tree', async () => {
    const foreignTenant = await test.prisma.tenant.create({ data: {
      id: 'saas-201-foreign-tenant', name: 'Foreign tenant',
    } });
    await test.prisma.account.create({ data: {
      id: 'saas-201-foreign-account', tenantId: foreignTenant.id, name: 'Foreign account',
    } });
    await test.prisma.note.create({ data: {
      id: 'saas-201-cross-tenant-note', tenantId: test.tenant.id,
      accountId: 'saas-201-foreign-account', content: 'must not be projected', source: 'manual',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });

    const report = await reportSourceArtifactMigration(test.prisma);
    expect(report.ok).toBe(false);
    expect(report.conflicts).toContain(
      `${test.tenant.id}:note:saas-201-cross-tenant-note:authority_account_invalid`,
    );
    await expect(applySourceArtifactMigration(test.prisma)).rejects.toThrow('authority_account_invalid');
    await expect(test.prisma.sourceArtifact.count()).resolves.toBe(0);
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: SOURCE_ARTIFACT_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('does not silently repair fingerprint drift after the migration marker exists', async () => {
    await test.prisma.note.create({ data: {
      id: 'saas-201-post-marker-note', tenantId: test.tenant.id,
      content: 'original authority', source: 'manual',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await applySourceArtifactMigration(test.prisma);
    const before = await test.prisma.sourceArtifact.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, backingKind: 'note', backingId: 'saas-201-post-marker-note',
    } });
    await test.prisma.note.update({
      where: { id: 'saas-201-post-marker-note' }, data: { content: 'unsynchronized authority change' },
    });

    await expect(reportSourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: false, markerPresent: true, stale: 1,
      conflicts: ['post_marker_stale:1'],
    });
    await expect(applySourceArtifactMigration(test.prisma)).rejects.toThrow('post_marker_stale:1');
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: before.id } }))
      .resolves.toMatchObject({ sourceFingerprint: before.sourceFingerprint });
  });
});
