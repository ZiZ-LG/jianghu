import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySensitiveAclMigration,
  inspectSensitiveAclSchemaState,
  reportSensitiveAclMigration,
  SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT,
  SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT,
  SENSITIVE_ACL_ONLINE_ROW_LIMIT,
  SENSITIVE_ACL_MIGRATION_MARKER,
  sensitiveAclOnlineVolumeConflicts,
  verifySensitiveAclMigration,
} from '../src/sensitiveAcl/migration.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import {
  candidateDedupeKeyForCreator,
  evidenceCandidateDedupeKey,
  personCandidateDedupeKey,
  relationCandidateDedupeKey,
  reminderCandidateDedupeKey,
} from '../src/candidates/dedupe.js';
import {
  createEvidenceCandidate,
  createFieldCandidate,
  fieldCandidateDedupeKey,
} from '../src/candidates/reviewItems.js';
import {
  applyCandidateMigration,
  candidateIdentityForLegacy,
  canonicalCandidateJson,
  verifyCandidateMigration,
} from '../src/candidates/migration.js';

describe('CORE-204 sensitive ACL migration', () => {
  let test: TestContext;
  const accountId = 'core-204-migration-account';
  const matterId = 'core-204-migration-matter';

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Migration account',
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId, name: 'Migration matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
    } });
    await test.prisma.note.createMany({ data: [
      {
        id: 'legacy-known-note', tenantId: test.tenant.id, accountId, opportunityId: matterId,
        content: 'known body', createdBy: test.owner.id,
        createdByUserId: null, visibility: 'owner_admin_only', aclVersion: 1,
      },
      {
        id: 'legacy-unknown-note', tenantId: test.tenant.id, accountId, opportunityId: matterId,
        content: 'unknown body', createdBy: 'departed-user',
        createdByUserId: null, visibility: 'owner_admin_only', aclVersion: 1,
      },
    ] });
    await test.prisma.transcript.create({ data: {
      id: 'legacy-known-transcript', tenantId: test.tenant.id, accountId, opportunityId: matterId,
      contentEnc: 'ciphertext', createdBy: test.owner.id,
      createdByUserId: null, visibility: 'owner_admin_only', aclVersion: 1,
    } });
  });

  afterEach(async () => test.cleanup());

  it('fails closed before materialization when the approved online migration envelope is exceeded', () => {
    const overLimit = {
      notes: SENSITIVE_ACL_ONLINE_ROW_LIMIT + 1,
      transcripts: 0,
      candidates: SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT + 1,
      sourceArtifacts: 0,
      grants: 0,
      parentRows: SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT + 1,
    };
    expect(sensitiveAclOnlineVolumeConflicts(overLimit)).toEqual([
      `online_candidate_row_limit_exceeded:${SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT + 1}:${SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT}`,
      `online_parent_row_limit_exceeded:${SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT + 1}:${SENSITIVE_ACL_ONLINE_PARENT_ROW_LIMIT}`,
      `online_sensitive_row_limit_exceeded:${SENSITIVE_ACL_ONLINE_ROW_LIMIT
        + SENSITIVE_ACL_ONLINE_CANDIDATE_LIMIT + 2}:${SENSITIVE_ACL_ONLINE_ROW_LIMIT}`,
    ]);
    expect(sensitiveAclOnlineVolumeConflicts(overLimit, true)).toEqual([]);
  });

  it('maps stable same-tenant creators, quarantines unknown creators, and commits marker last', async () => {
    await expect(inspectSensitiveAclSchemaState(test.prisma)).resolves.toBe('expanded');
    await expect(reportSensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: false, notes: 2, transcripts: 1,
      creatorMapped: 2, quarantined: 1,
    });

    const applied = await applySensitiveAclMigration(test.prisma);
    expect(applied).toMatchObject({ ok: true, markerPresent: true });
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'legacy-known-note' } }))
      .resolves.toMatchObject({
        createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
      });
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'legacy-unknown-note' } }))
      .resolves.toMatchObject({
        createdByUserId: null, visibility: 'owner_admin_only', aclVersion: 1,
      });
    await expect(test.prisma.transcript.findUniqueOrThrow({ where: { id: 'legacy-known-transcript' } }))
      .resolves.toMatchObject({
        createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
        idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, conflicts: [],
    });
    await expect(applySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true,
    });
  });

  it('rolls back every row when interrupted before the marker and reruns safely', async () => {
    await expect(applySensitiveAclMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected sensitive ACL migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: SENSITIVE_ACL_MIGRATION_MARKER },
    })).resolves.toBeNull();
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'legacy-known-note' } }))
      .resolves.toMatchObject({ createdByUserId: null, visibility: 'owner_admin_only' });

    await expect(applySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true,
    });
  });

  it('updates high-volume Note ACL rows in bounded tenant-scoped batches', async () => {
    await test.prisma.note.createMany({ data: Array.from({ length: 401 }, (_, index) => ({
      id: `core-204-batch-note-${index}`,
      tenantId: test.tenant.id,
      accountId,
      opportunityId: matterId,
      content: `batch body ${index}`,
      createdBy: test.owner.id,
      createdByUserId: null,
      visibility: 'owner_admin_only',
      aclVersion: 1,
    })) });

    const applied = await applySensitiveAclMigration(test.prisma);
    // 402 creator Note rows => two batches, one Transcript batch, and one marker write.
    expect(applied.writes).toBe(4);
    await expect(test.prisma.note.count({ where: {
      tenantId: test.tenant.id,
      createdByUserId: test.owner.id,
      visibility: 'private',
    } })).resolves.toBe(402);
  });

  it('fails closed on parent drift, marker checksum drift, and post-marker ACL semantic conflict', async () => {
    await test.prisma.note.create({ data: {
      id: 'invalid-parent-note', tenantId: test.tenant.id, accountId,
      opportunityId: 'missing-matter', content: 'must not migrate', createdBy: test.owner.id,
    } });
    await expect(reportSensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false, conflicts: expect.arrayContaining(['note:invalid-parent-note:matter_invalid']),
    });
    await expect(applySensitiveAclMigration(test.prisma)).rejects.toThrow('matter_invalid');
    await test.prisma.note.delete({ where: { id: 'invalid-parent-note' } });

    await applySensitiveAclMigration(test.prisma);
    const marker = await test.prisma.dataMigrationState.findUniqueOrThrow({
      where: { key: SENSITIVE_ACL_MIGRATION_MARKER },
    });
    await test.prisma.dataMigrationState.update({
      where: { key: marker.key },
      data: { details: JSON.stringify({ markerChecksum: 'tampered' }) },
    });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false, conflicts: expect.arrayContaining(['marker_invalid']),
    });

    await test.prisma.dataMigrationState.update({ where: { key: marker.key }, data: { details: marker.details } });
    await test.prisma.note.update({
      where: { id: 'legacy-known-note' },
      data: { visibility: 'owner_admin_only' },
    });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining(['note:legacy-known-note:creator_visibility_invalid']),
    });
  });

  it('rejects SourceArtifact parent drift before the marker is written', async () => {
    await test.prisma.sourceArtifact.create({ data: {
      id: 'artifact-invalid-parents',
      tenantId: test.tenant.id,
      accountId: 'missing-account',
      matterId: 'missing-matter',
      personId: 'missing-person',
      backingKind: 'transcript',
      backingId: 'missing-backing-row',
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });

    await expect(reportSensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        'source_artifact:artifact-invalid-parents:account_invalid',
        'source_artifact:artifact-invalid-parents:matter_invalid',
        'source_artifact:artifact-invalid-parents:person_invalid',
      ]),
    });
    await expect(applySensitiveAclMigration(test.prisma)).rejects.toThrow('source_artifact');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: SENSITIVE_ACL_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('binds the marker receipt and counts to an integrity checksum', async () => {
    await applySensitiveAclMigration(test.prisma);
    const marker = await test.prisma.dataMigrationState.findUniqueOrThrow({
      where: { key: SENSITIVE_ACL_MIGRATION_MARKER },
    });
    const details = JSON.parse(marker.details) as Record<string, unknown>;
    await test.prisma.dataMigrationState.update({
      where: { key: marker.key },
      data: { details: JSON.stringify({ ...details, receiptChecksum: '0'.repeat(64) }) },
    });

    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining(['marker_invalid']),
    });
  });

  it('reconciles post-marker legacy writes and rejects cross-tenant creator drift', async () => {
    await applySensitiveAclMigration(test.prisma);
    await test.prisma.note.create({ data: {
      id: 'post-marker-legacy-note',
      tenantId: test.tenant.id,
      accountId,
      opportunityId: matterId,
      content: 'written by a still-running legacy process',
      createdBy: test.owner.id,
    } });

    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining(['note:post-marker-legacy-note:creator_mapping_drift']),
    });
    await expect(applySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
    });
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'post-marker-legacy-note' } }))
      .resolves.toMatchObject({
        createdByUserId: test.owner.id,
        visibility: 'private',
        aclVersion: 1,
      });

    await test.prisma.note.update({
      where: { id: 'legacy-known-note' },
      data: { createdByUserId: 'foreign-or-missing-user', visibility: 'private' },
    });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining(['note:legacy-known-note:creator_mapping_drift']),
    });
  });

  it('moves pending private Candidate semantic keys into an immutable creator domain', async () => {
    const semanticKey = 'person-pending-v1:core-204-migration-account:同名候选';
    await test.prisma.candidate.create({ data: {
      id: 'core-204-legacy-private-dedupe',
      tenantId: test.tenant.id,
      kind: 'person_create',
      status: 'pending',
      accountId,
      matterId,
      targetKind: 'person',
      source: 'mcp',
      sourceRef: 'mcp:legacy-private-dedupe',
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
      dedupeKey: semanticKey,
    } });

    await expect(applySensitiveAclMigration(test.prisma)).resolves.toMatchObject({ ok: true });
    await expect(test.prisma.candidate.findUniqueOrThrow({
      where: { id: 'core-204-legacy-private-dedupe' },
    })).resolves.toMatchObject({
      dedupeKey: candidateDedupeKeyForCreator(semanticKey, test.owner.id),
    });

    await test.prisma.candidate.update({
      where: { id: 'core-204-legacy-private-dedupe' },
      data: { dedupeKey: semanticKey },
    });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        'candidate:core-204-legacy-private-dedupe:dedupe_domain_drift',
      ]),
    });
  });

  it('migrates a pending private field projection and Candidate payload as one dedupe domain', async () => {
    const person = await test.prisma.person.create({ data: {
      id: 'core-204-migration-field-person', tenantId: test.tenant.id, accountId,
      name: '迁移字段目标', title: '负责人',
    } });
    const created = await createFieldCandidate(test.prisma, {
      id: 'core-204-migration-field', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: person.id, fieldKey: 'title',
      oldValue: '负责人', newValue: '决策人', source: 'mcp',
      sourceRef: 'mcp:core-204-migration-field', evidence: '字段迁移依据',
      confidence: 0.8, createdByUserId: test.owner.id,
    });
    const semanticKey = fieldCandidateDedupeKey({
      tenantId: test.tenant.id,
      accountId,
      targetKind: 'person',
      targetId: person.id,
      fieldKey: 'title',
    });
    const identity = candidateIdentityForLegacy(
      test.tenant.id, 'ChangeProposal', created.row.id,
    );
    await test.prisma.$transaction([
      test.prisma.changeProposal.update({
        where: { id: created.row.id },
        data: { dedupeKey: identity.dedupeKey },
      }),
      test.prisma.candidate.update({
        where: { id: created.candidateId },
        data: {
          sourceRef: identity.sourceRef,
          dedupeKey: identity.dedupeKey,
          payload: canonicalCandidateJson({
            legacyDedupeKey: identity.dedupeKey,
            legacyStatus: 'pending',
          }),
        },
      }),
    ]);

    const expected = candidateDedupeKeyForCreator(semanticKey, test.owner.id);
    await expect(applySensitiveAclMigration(test.prisma)).resolves.toMatchObject({ ok: true });
    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ dedupeKey: expected });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({
        dedupeKey: expected,
        payload: canonicalCandidateJson({ legacyDedupeKey: expected, legacyStatus: 'pending' }),
      });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true, conflicts: [],
    });
  });

  it('reconstructs producer semantic keys from real CORE-203 identity projections', async () => {
    const [sourcePerson, targetPerson] = await Promise.all([
      test.prisma.person.create({ data: {
        id: 'core-204-semantic-source', tenantId: test.tenant.id, accountId,
        name: '语义源', title: '发起人',
      } }),
      test.prisma.person.create({ data: {
        id: 'core-204-semantic-target', tenantId: test.tenant.id, accountId,
        name: '语义目标', title: '决策人',
      } }),
    ]);
    await test.prisma.personSuggestion.create({ data: {
      id: 'core-204-semantic-person', tenantId: test.tenant.id, accountId,
      opportunityId: matterId, name: '  同名候选  ', proposedBy: test.owner.id,
      evidence: 'person evidence', status: 'pending',
    } });
    await test.prisma.relSuggestion.create({ data: {
      id: 'core-204-semantic-relation', tenantId: test.tenant.id, opportunityId: matterId,
      sourcePersonId: sourcePerson.id, targetPersonId: targetPerson.id,
      sourceKind: 'person', targetKind: 'person', layer: 'L2', label: '语义关系',
      evidence: 'relation evidence', status: 'pending',
    } });
    await test.prisma.changeProposal.create({ data: {
      id: 'core-204-semantic-field', tenantId: test.tenant.id, accountId,
      opportunityId: matterId, entityKind: 'opportunity', entityId: matterId,
      field: 'name', oldValue: 'Migration matter', newValue: '语义字段',
      origin: 'voice', evidence: 'field evidence', status: 'pending',
      dedupeKey: 'legacy-field-producer-key', proposedBy: test.owner.id,
    } });
    await test.prisma.reminder.create({ data: {
      id: 'core-204-semantic-reminder', tenantId: test.tenant.id, accountId,
      accountName: 'Migration account', opportunityId: matterId, oppName: 'Migration matter',
      kind: 'stalled', title: '语义提醒', detail: 'reminder evidence',
      dedupeKey: 'core-204:semantic:reminder', status: 'pending',
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'core-204-semantic-evidence', tenantId: test.tenant.id, accountId,
      opportunityId: matterId, personId: sourcePerson.id, signalKey: 'semantic_signal',
      rawContent: 'evidence body', status: 'pending_review', origin: 'voice',
      createdBy: test.owner.id,
    } });

    await expect(applyCandidateMigration(test.prisma)).resolves.toMatchObject({ ok: true });
    const identities = {
      person: candidateIdentityForLegacy(test.tenant.id, 'PersonSuggestion', 'core-204-semantic-person'),
      relation: candidateIdentityForLegacy(test.tenant.id, 'RelSuggestion', 'core-204-semantic-relation'),
      field: candidateIdentityForLegacy(test.tenant.id, 'ChangeProposal', 'core-204-semantic-field'),
      reminder: candidateIdentityForLegacy(test.tenant.id, 'Reminder', 'core-204-semantic-reminder'),
      evidence: candidateIdentityForLegacy(test.tenant.id, 'EvidenceEvent', 'core-204-semantic-evidence'),
    };
    for (const identity of Object.values(identities)) {
      await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: identity.id } }))
        .resolves.toMatchObject({ dedupeKey: identity.dedupeKey });
    }

    await expect(applySensitiveAclMigration(test.prisma)).resolves.toMatchObject({ ok: true });
    const expected = {
      person: candidateDedupeKeyForCreator(
        personCandidateDedupeKey(accountId, '  同名候选  '), test.owner.id,
      ),
      relation: relationCandidateDedupeKey(
        matterId,
        { kind: 'person', id: sourcePerson.id },
        { kind: 'person', id: targetPerson.id },
      ),
      field: candidateDedupeKeyForCreator(fieldCandidateDedupeKey({
        tenantId: test.tenant.id, accountId, targetKind: 'opportunity',
        targetId: matterId, fieldKey: 'name',
      }), test.owner.id),
      reminder: reminderCandidateDedupeKey('core-204:semantic:reminder'),
      evidence: candidateDedupeKeyForCreator(
        evidenceCandidateDedupeKey('voice', identities.evidence.sourceRef), test.owner.id,
      ),
    };
    for (const kind of Object.keys(identities) as Array<keyof typeof identities>) {
      await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: identities[kind].id } }))
        .resolves.toMatchObject({ dedupeKey: expected[kind] });
    }
    await expect(test.prisma.changeProposal.findUniqueOrThrow({
      where: { id: 'core-204-semantic-field' },
    })).resolves.toMatchObject({ dedupeKey: expected.field });

    const adoptedEvidence = await createEvidenceCandidate(test.prisma, {
      id: 'core-204-semantic-evidence', tenantId: test.tenant.id, accountId,
      matterId, personId: sourcePerson.id, signalKey: 'semantic_signal',
      direction: 0, tier: 'mid', rawContent: 'evidence body', occurredAt: '',
      source: 'voice', sourceRef: 'voice:external-semantic-evidence', confidence: 0.77,
      createdByUserId: test.owner.id,
    });
    expect(adoptedEvidence).toMatchObject({ created: false, candidateVersion: 1 });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: identities.evidence.id } }))
      .resolves.toMatchObject({
        sourceRef: 'voice:external-semantic-evidence',
        dedupeKey: candidateDedupeKeyForCreator(
          evidenceCandidateDedupeKey('voice', 'voice:external-semantic-evidence'), test.owner.id,
        ),
      });
    await expect(verifyCandidateMigration(test.prisma)).resolves.toMatchObject({
      ok: true, conflicts: [],
    });
    await expect(verifySensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: true, conflicts: [],
    });
  });

  it('rejects malformed revoked reviewer grants', async () => {
    const reviewer = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: 'acl-migration-reviewer@example.test',
      passwordHash: 'unused',
      name: 'ACL migration reviewer',
      role: 'member',
    } });
    await test.prisma.candidate.create({ data: {
      id: 'candidate-with-malformed-revoked-grant',
      tenantId: test.tenant.id,
      kind: 'field',
      accountId,
      matterId,
      targetKind: 'account',
      source: 'test',
      sourceRef: 'test:malformed-revoked-grant',
      createdByUserId: test.owner.id,
      visibility: 'matter_shared',
      aclVersion: 2,
      dedupeKey: 'candidate-with-malformed-revoked-grant',
    } });
    await test.prisma.sensitiveResourceGrant.create({ data: {
      id: 'malformed-revoked-grant',
      tenantId: test.tenant.id,
      resourceKind: 'candidate',
      resourceId: 'candidate-with-malformed-revoked-grant',
      granteeUserId: reviewer.id,
      grantedByUserId: test.owner.id,
      grantKind: 'reviewer',
      resourceAclVersion: 0,
      revokedAt: new Date(),
      revokedByUserId: 'foreign-or-missing-user',
    } });

    await expect(reportSensitiveAclMigration(test.prisma)).resolves.toMatchObject({
      ok: false,
      conflicts: expect.arrayContaining([
        'grant:malformed-revoked-grant:acl_version_invalid',
        'grant:malformed-revoked-grant:revoker_invalid',
      ]),
    });
  });

  it('classifies a missing sensitive ACL index as partial SQLite schema drift', async () => {
    await test.prisma.$executeRawUnsafe(
      'DROP INDEX "SourceArtifact_tenantId_visibility_aclVersion_idx"',
    );
    try {
      await expect(inspectSensitiveAclSchemaState(test.prisma)).resolves.toBe('partial');
    } finally {
      await test.prisma.$executeRawUnsafe(
        'CREATE INDEX "SourceArtifact_tenantId_visibility_aclVersion_idx" '
        + 'ON "SourceArtifact"("tenantId", "visibility", "aclVersion")',
      );
    }
  });
});
