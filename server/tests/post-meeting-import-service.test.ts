import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleProductAccess, type CommandContext } from '@jianghu/domain-contracts';
import { dec } from '../src/ai.js';
import { commitPostMeetingSource } from '../src/postMeeting/importService.js';
import type { PreparedPostMeetingSource } from '../src/postMeeting/importModel.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const internalPolicy = assembleProductAccess({ edition: 'internal' }).policy;

describe('SAAS-203 post-meeting source import service', () => {
  let test: TestContext;
  const customerId = 'saas-203-customer';
  const matterId = 'saas-203-matter';

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: customerId,
      tenantId: test.tenant.id,
      name: 'Source import customer',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId,
      tenantId: test.tenant.id,
      accountId: customerId,
      name: 'Source import matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
  });

  afterEach(async () => test.cleanup());

  function context(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'saas-203-service',
      assertionMode: 'raw_append',
      ...overrides,
    };
  }

  function prepared(overrides: Partial<PreparedPostMeetingSource> = {}): PreparedPostMeetingSource {
    const text = overrides.text ?? 'The customer needs a governed post-meeting review.';
    return {
      source: 'upload',
      externalRef: `upload:${createHash('sha256').update('fixture bytes').digest('hex')}`,
      title: 'Meeting notes.txt',
      text,
      durationSec: 0,
      recordedAt: new Date('2026-08-26T10:30:00.000Z'),
      contentFingerprint: createHash('sha256').update(text).digest('hex'),
      ...overrides,
    };
  }

  async function addUser(role: 'owner' | 'admin' | 'member' | 'viewer', label: string) {
    return test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: `${label}-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: label,
      role,
    } });
  }

  it('exports one exact encrypted-ingest primitive', async () => {
    const service = await import('../src/postMeeting/importService.js').catch(() => null);

    expect(service).not.toBeNull();
    expect(typeof service?.commitPostMeetingSource).toBe('function');
  });

  it('creates one encrypted Transcript and its exact body-free SourceArtifact receipt', async () => {
    const sourceText = 'Private meeting transcript: budget owner is Chen.';
    const formalBefore = await Promise.all([
      test.prisma.candidate.count(),
      test.prisma.reviewBatch.count(),
      test.prisma.interaction.count(),
      test.prisma.person.count(),
      test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(),
    ]);

    const result = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx,
      context(),
      internalPolicy,
      { customerId, matterId },
      prepared({ text: sourceText, contentFingerprint: createHash('sha256').update(sourceText).digest('hex') }),
    ));

    expect(result).toEqual({
      businessReplayed: false,
      source: {
        id: expect.stringMatching(/^src_[a-f0-9]{32}$/),
        customerId,
        matterId,
        title: 'Meeting notes.txt',
        kind: 'uploaded_file',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        aclVersion: 1,
        version: 1,
        occurredAt: '2026-08-26T10:30:00.000Z',
      },
    });
    const [transcripts, artifacts] = await Promise.all([
      test.prisma.transcript.findMany({ where: { tenantId: test.tenant.id } }),
      test.prisma.sourceArtifact.findMany({ where: { tenantId: test.tenant.id } }),
    ]);
    expect(transcripts).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({
      tenantId: test.tenant.id,
      accountId: customerId,
      opportunityId: matterId,
      personId: null,
      source: 'upload',
      externalRef: prepared().externalRef,
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      title: 'Meeting notes.txt',
      durationSec: 0,
      status: 'active',
      createdBy: test.owner.id,
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
    });
    expect(transcripts[0]!.contentEnc).not.toContain(sourceText);
    expect(dec(transcripts[0]!.contentEnc)).toBe(sourceText);
    expect(artifacts[0]).toMatchObject({
      id: result.source.id,
      backingKind: 'transcript',
      backingId: transcripts[0]!.id,
      artifactKind: 'uploaded_file',
      accountId: customerId,
      matterId,
      retentionState: 'available',
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
      sourceFingerprint: result.source.fingerprint,
    });
    expect(JSON.stringify({ transcripts, artifacts })).not.toContain(sourceText);
    const audits = await test.prisma.auditEvent.findMany({ where: { tenantId: test.tenant.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: test.owner.id,
      action: 'source_artifact.import',
      entityKind: 'source_artifact',
      entityId: result.source.id,
      requestId: 'saas-203-service',
      changedFields: '["create"]',
    });
    expect(JSON.stringify(audits)).not.toContain(sourceText);
    expect(JSON.stringify(audits)).not.toContain(transcripts[0]!.contentEnc);
    expect(await Promise.all([
      test.prisma.candidate.count(),
      test.prisma.reviewBatch.count(),
      test.prisma.interaction.count(),
      test.prisma.person.count(),
      test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(),
    ])).toEqual(formalBefore);
  });

  it('replays the same creator identity only on the exact Customer/Matter mount', async () => {
    const input = prepared();
    const first = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context(), internalPolicy, { customerId, matterId }, input,
    ));
    const replay = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context({ requestId: 'saas-203-service-replay' }), internalPolicy,
      { customerId, matterId }, input,
    ));

    expect(replay).toEqual({ source: first.source, businessReplayed: true });
    expect(await test.prisma.transcript.count({ where: { tenantId: test.tenant.id } })).toBe(1);
    expect(await test.prisma.sourceArtifact.count({ where: { tenantId: test.tenant.id } })).toBe(1);

    await test.prisma.opportunity.create({ data: {
      id: 'saas-203-other-matter',
      tenantId: test.tenant.id,
      accountId: customerId,
      name: 'Other matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context({ requestId: 'saas-203-service-mismatch' }), internalPolicy,
      { customerId, matterId: 'saas-203-other-matter' }, input,
    ))).rejects.toMatchObject({ code: 'post_meeting_import_conflict', statusCode: 409 });
    expect(await test.prisma.transcript.count({ where: { tenantId: test.tenant.id } })).toBe(1);
    expect(await test.prisma.sourceArtifact.count({ where: { tenantId: test.tenant.id } })).toBe(1);
  });

  it('reloads role and EffectiveResourceScope, denying viewers and revoked or archived mounts without writes', async () => {
    const member = await addUser('member', 'Scoped member');
    const memberContext = context({ actorId: member.id, actorRole: 'owner' });
    await test.prisma.tenant.update({
      where: { id: test.tenant.id },
      data: { dataScopePolicy: 'scoped' },
    });

    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, memberContext, internalPolicy, { customerId, matterId }, prepared(),
    ))).rejects.toMatchObject({
      code: 'post_meeting_import_not_found', statusCode: 404, scopedNotFound: true,
    });
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);

    await test.prisma.account.update({
      where: { id: customerId }, data: { primaryOwnerUserId: member.id },
    });
    const imported = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, memberContext, internalPolicy, { customerId, matterId }, prepared(),
    ));
    expect(imported.businessReplayed).toBe(false);

    await test.prisma.user.update({ where: { id: member.id }, data: { role: 'viewer' } });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, memberContext, internalPolicy, { customerId, matterId }, prepared(),
    ))).rejects.toMatchObject({ code: 'viewer_write_denied', statusCode: 403 });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);

    await test.prisma.user.update({ where: { id: member.id }, data: { role: 'member' } });
    await test.prisma.account.update({ where: { id: customerId }, data: { archivedAt: new Date() } });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, memberContext, internalPolicy, { customerId, matterId }, prepared(),
    ))).rejects.toMatchObject({
      code: 'post_meeting_import_not_found', statusCode: 404, scopedNotFound: true,
    });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
  });

  it('isolates the same external identity by immutable creator domain', async () => {
    const member = await addUser('member', 'Private importer');
    await test.prisma.account.create({ data: {
      id: 'saas-203-member-customer',
      tenantId: test.tenant.id,
      name: 'Member customer',
      primaryOwnerUserId: member.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'saas-203-member-matter',
      tenantId: test.tenant.id,
      accountId: 'saas-203-member-customer',
      name: 'Member matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: member.id,
    } });
    const input = prepared();
    const ownerResult = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context(), internalPolicy, { customerId, matterId }, input,
    ));
    const memberResult = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx,
      context({ actorId: member.id, actorRole: 'member', requestId: 'member-import' }),
      internalPolicy,
      { customerId: 'saas-203-member-customer', matterId: 'saas-203-member-matter' },
      input,
    ));

    expect(memberResult.source.id).not.toBe(ownerResult.source.id);
    expect(await test.prisma.transcript.count()).toBe(2);
    expect(await test.prisma.sourceArtifact.count()).toBe(2);
    const domains = await test.prisma.transcript.findMany({
      orderBy: { createdByUserId: 'asc' }, select: { idempotencyDomain: true },
    });
    expect(new Set(domains.map((row) => row.idempotencyDomain))).toEqual(new Set([
      `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      `creator-private-v1:${JSON.stringify(member.id)}`,
    ]));
  });

  it('fails closed on degraded, missing-backing or drifted duplicate state', async () => {
    const input = prepared();
    const imported = await test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context(), internalPolicy, { customerId, matterId }, input,
    ));
    const artifact = await test.prisma.sourceArtifact.findUniqueOrThrow({
      where: { id: imported.source.id },
    });
    await test.prisma.$transaction(async (tx) => {
      await tx.transcript.update({
        where: { id: artifact.backingId }, data: { status: 'redacted', contentEnc: '' },
      });
      await tx.sourceArtifact.update({
        where: { id: artifact.id }, data: { retentionState: 'degraded', retentionUpdatedAt: new Date() },
      });
    });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context({ requestId: 'degraded-replay' }), internalPolicy,
      { customerId, matterId }, input,
    ))).rejects.toMatchObject({ code: 'post_meeting_import_conflict', statusCode: 409 });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);

    await test.prisma.sourceArtifact.update({
      where: { id: artifact.id }, data: { title: 'drifted projection' },
    });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context({ requestId: 'drifted-replay' }), internalPolicy,
      { customerId, matterId }, input,
    ))).rejects.toMatchObject({ code: 'post_meeting_import_conflict', statusCode: 409 });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);

    await test.prisma.transcript.delete({ where: { id: artifact.backingId } });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx, context({ requestId: 'missing-backing-replay' }), internalPolicy,
      { customerId, matterId }, input,
    ))).rejects.toMatchObject({ statusCode: 409 });
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
  });

  it('rolls back both encrypted backing and projection when the surrounding transaction aborts', async () => {
    await expect(test.prisma.$transaction(async (tx) => {
      await commitPostMeetingSource(
        tx, context(), internalPolicy, { customerId, matterId }, prepared(),
      );
      throw new Error('injected_after_import');
    })).rejects.toThrow('injected_after_import');

    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
  });

  it('rejects capability and prepared-payload violations before business writes', async () => {
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx,
      context(),
      { entitlements: ['crm.core'], permissions: [] },
      { customerId, matterId },
      prepared(),
    ))).rejects.toMatchObject({ code: 'capability_denied', statusCode: 403 });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx,
      context({ requestId: 'bad-fingerprint' }),
      internalPolicy,
      { customerId, matterId },
      prepared({ contentFingerprint: '0'.repeat(64) }),
    ))).rejects.toMatchObject({ code: 'post_meeting_import_fingerprint_invalid', statusCode: 400 });
    await expect(test.prisma.$transaction((tx) => commitPostMeetingSource(
      tx,
      context({ requestId: 'bad-identity' }),
      internalPolicy,
      { customerId, matterId },
      prepared({ externalRef: 'upload:not-a-digest' }),
    ))).rejects.toMatchObject({ code: 'post_meeting_import_identity_invalid', statusCode: 400 });
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
  });
});
