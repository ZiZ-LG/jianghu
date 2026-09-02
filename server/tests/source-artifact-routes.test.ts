import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportSourceArtifactMigration } from '../src/sourceArtifacts/migration.js';
import { ensureSourceArtifactForTranscript } from '../src/sourceArtifacts/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-201 SourceArtifact lifecycle routes', () => {
  let test: TestContext;
  const accountId = 'saas-201-account';
  const matterId = 'saas-201-matter';
  const auth = (token = test.token, key?: string) => ({
    authorization: `Bearer ${token}`,
    ...(key ? { 'idempotency-key': key } : {}),
  });

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Artifact account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId, name: 'Artifact matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
  });
  afterEach(async () => test.cleanup());

  it('registers creator-domain external references idempotently and lists metadata without bodies', async () => {
    const formalBefore = await Promise.all([
      test.prisma.candidate.count(), test.prisma.person.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ]);
    const payload = {
      source: 'feishu', externalRef: 'minute-201', title: 'Customer meeting',
      matterId, occurredAt: '2026-08-25T01:00:00.000Z',
    };
    const first = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, 'saas-201-external-create'), payload,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false, retentionState: 'reference_only' });
    const replay = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, 'saas-201-external-create'), payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, id: first.json().id });

    const list = await test.app.inject({ method: 'GET', url: '/api/source-artifacts', headers: auth() });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      id: first.json().id, artifactKind: 'external_reference', source: 'feishu',
      externalRef: 'minute-201', title: 'Customer meeting', contentAvailable: false,
      retentionState: 'reference_only',
    });
    expect(list.body).not.toContain('contentEnc');
    expect(list.body).not.toContain('content\"');
    expect(await Promise.all([
      test.prisma.candidate.count(), test.prisma.person.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ])).toEqual(formalBefore);
  });

  it('does not disclose another creator private identity and rejects viewer writes before side effects', async () => {
    const member = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: `member-${randomUUID()}@example.test`, passwordHash: 'unused',
      name: 'Member', role: 'member',
    } });
    const memberToken = test.app.jwt.sign({ userId: member.id, tenantId: test.tenant.id, role: 'member' });
    const viewer = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: `viewer-${randomUUID()}@example.test`, passwordHash: 'unused',
      name: 'Viewer', role: 'viewer',
    } });
    const viewerToken = test.app.jwt.sign({ userId: viewer.id, tenantId: test.tenant.id, role: 'viewer' });
    const payload = { source: 'external', externalRef: 'same-private-ref' };

    const ownerArtifact = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, 'saas-201-owner-private'), payload,
    });
    const memberArtifact = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(memberToken, 'saas-201-member-private'), payload,
    });
    expect(ownerArtifact.statusCode, ownerArtifact.body).toBe(200);
    expect(memberArtifact.statusCode, memberArtifact.body).toBe(200);
    expect(memberArtifact.json().id).not.toBe(ownerArtifact.json().id);

    const hidden = await test.app.inject({
      method: 'GET', url: `/api/source-artifacts/${ownerArtifact.json().id}`, headers: auth(memberToken),
    });
    expect(hidden.statusCode).toBe(404);

    const beforeHiddenMutations = await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const hiddenWrongVersion = await test.app.inject({
      method: 'PATCH', url: `/api/source-artifacts/${ownerArtifact.json().id}/mount`,
      headers: auth(memberToken, 'saas-201-hidden-wrong-version'),
      payload: { expectedAclVersion: 999 },
    });
    const hiddenCorrectVersion = await test.app.inject({
      method: 'PATCH', url: `/api/source-artifacts/${ownerArtifact.json().id}/mount`,
      headers: auth(memberToken, 'saas-201-hidden-correct-version'),
      payload: { expectedAclVersion: 1 },
    });
    const missing = await test.app.inject({
      method: 'PATCH', url: '/api/source-artifacts/missing-private-artifact/mount',
      headers: auth(memberToken, 'saas-201-missing-private-artifact'),
      payload: { expectedAclVersion: 1 },
    });
    expect(hiddenWrongVersion.statusCode).toBe(404);
    expect(hiddenCorrectVersion.statusCode).toBe(404);
    expect(hiddenWrongVersion.json()).toEqual(missing.json());
    expect(hiddenCorrectVersion.json()).toEqual(missing.json());
    expect(await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).toEqual(beforeHiddenMutations);

    const before = await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const denied = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(viewerToken, 'saas-201-viewer-denied'), payload: { source: 'x', externalRef: 'y' },
    });
    expect(denied.statusCode).toBe(403);
    expect(await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).toEqual(before);
  });

  it('mounts, shares, degrades and tombstones a Transcript with CAS and replay receipts', async () => {
    // Multipart parsing remains covered by recording tests; seed its existing body authority directly.
    await test.prisma.transcript.create({ data: {
      id: 'saas-201-lifecycle-transcript', tenantId: test.tenant.id, source: 'manual',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      title: 'Lifecycle transcript', contentEnc: 'opaque-ciphertext', status: 'active',
      createdBy: test.owner.id, createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    const initialProjection = await ensureSourceArtifactForTranscript(
      test.prisma, test.tenant.id, 'saas-201-lifecycle-transcript',
    );
    const initialFingerprint = initialProjection.sourceFingerprint;

    const registered = await test.app.inject({
      method: 'PATCH', url: `/api/source-artifacts/${initialProjection.id}/mount`,
      headers: auth(test.token, 'saas-201-mount-transcript'),
      payload: { matterId, expectedAclVersion: 1 },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const artifactId = registered.json().id;

    const shared = await test.app.inject({
      method: 'PUT', url: `/api/source-artifacts/${artifactId}/visibility`,
      headers: auth(test.token, 'saas-201-share-transcript'),
      payload: { visibility: 'matter_shared', expectedAclVersion: 2 },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json()).toMatchObject({ aclVersion: 3, visibility: 'matter_shared' });

    const degraded = await test.app.inject({
      method: 'POST', url: `/api/source-artifacts/${artifactId}/degrade`,
      headers: auth(test.token, 'saas-201-degrade-transcript'),
      payload: { expectedAclVersion: 3 },
    });
    expect(degraded.statusCode, degraded.body).toBe(200);
    expect(degraded.json()).toMatchObject({ retentionState: 'degraded', contentAvailable: false });
    await expect(test.prisma.transcript.findUniqueOrThrow({ where: { id: 'saas-201-lifecycle-transcript' } }))
      .resolves.toMatchObject({ contentEnc: '', status: 'redacted' });
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: artifactId } }))
      .resolves.toMatchObject({
        fingerprintKind: 'content_sha256_v1', sourceFingerprint: initialFingerprint,
        retentionState: 'degraded',
      });

    const repeatedDegrade = await test.app.inject({
      method: 'POST', url: `/api/source-artifacts/${artifactId}/degrade`,
      headers: auth(test.token, 'saas-201-degrade-transcript-again'),
      payload: { expectedAclVersion: 3 },
    });
    expect(repeatedDegrade.statusCode, repeatedDegrade.body).toBe(200);
    expect(repeatedDegrade.json()).toMatchObject({ retentionState: 'degraded', contentAvailable: false });
    await expect(ensureSourceArtifactForTranscript(
      test.prisma, test.tenant.id, 'saas-201-lifecycle-transcript',
    )).resolves.toMatchObject({
      fingerprintKind: 'content_sha256_v1', sourceFingerprint: initialFingerprint,
      retentionState: 'degraded',
    });
    await expect(reportSourceArtifactMigration(test.prisma)).resolves.toMatchObject({
      ok: true, missing: 0, stale: 0, conflicts: [],
    });

    const deleted = await test.app.inject({
      method: 'DELETE', url: `/api/source-artifacts/${artifactId}`,
      headers: auth(test.token, 'saas-201-delete-transcript'),
      payload: { expectedAclVersion: 3 },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ retentionState: 'deleted', contentAvailable: false });
    await expect(test.prisma.transcript.findUnique({ where: { id: 'saas-201-lifecycle-transcript' } }))
      .resolves.toBeNull();
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: artifactId } }))
      .resolves.toMatchObject({ retentionState: 'deleted' });
  });

  it('paginates readable metadata without gaps or duplicates at the requested limit', async () => {
    const expectedIds: string[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const created = await test.app.inject({
        method: 'POST', url: '/api/source-artifacts/external',
        headers: auth(test.token, `saas-201-page-create-${suffix}`),
        payload: { source: 'pagination', externalRef: `page-${suffix}` },
      });
      expect(created.statusCode, created.body).toBe(200);
      expectedIds.push(created.json().id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const response: { statusCode: number; body: string; json: () => unknown } = await test.app.inject({
        method: 'GET',
        url: `/api/source-artifacts?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers: auth(),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(body.items).toHaveLength(1);
      seen.push(body.items[0]!.id);
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual([...expectedIds].sort());
    expect(cursor).toBeNull();
  });

  it('rechecks current target scope before replaying an external registration command', async () => {
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    const first = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: `first-${randomUUID()}@example.test`, passwordHash: 'unused',
      name: 'First scoped member', role: 'member',
    } });
    const second = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: `second-${randomUUID()}@example.test`, passwordHash: 'unused',
      name: 'Second scoped member', role: 'member',
    } });
    const firstToken = test.app.jwt.sign({ userId: first.id, tenantId: test.tenant.id, role: 'member' });
    const scopedAccountId = 'saas-201-replay-scope-account';
    const scopedMatterId = 'saas-201-replay-scope-matter';
    await test.prisma.account.create({ data: {
      id: scopedAccountId, tenantId: test.tenant.id, name: 'Replay scope account',
      primaryOwnerUserId: first.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: scopedMatterId, tenantId: test.tenant.id, accountId: scopedAccountId,
      name: 'Replay scope matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: first.id,
    } });
    const payload = { source: 'scoped-replay', externalRef: 'scoped-replay-ref', matterId: scopedMatterId };
    const commandKey = 'saas-201-scoped-registration-replay';
    const created = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(firstToken, commandKey), payload,
    });
    expect(created.statusCode, created.body).toBe(200);

    await test.prisma.account.update({
      where: { id: scopedAccountId }, data: { primaryOwnerUserId: second.id },
    });
    await test.prisma.opportunity.update({
      where: { id: scopedMatterId }, data: { primaryOwnerUserId: second.id },
    });
    const before = await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const replay = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(firstToken, commandKey), payload,
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.json()).toEqual({ error: '来源资料不存在', code: 'source_artifact_not_found' });
    expect(await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).toEqual(before);
  });

  it('hides malformed projection metadata and refuses mutations without command or audit writes', async () => {
    const created = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, 'saas-201-malformed-create'),
      payload: { source: 'malformed', externalRef: 'malformed-ref' },
    });
    expect(created.statusCode, created.body).toBe(200);
    await test.prisma.sourceArtifact.update({
      where: { id: created.json().id }, data: { sourceFingerprint: 'not-a-valid-fingerprint' },
    });

    const detail = await test.app.inject({
      method: 'GET', url: `/api/source-artifacts/${created.json().id}`, headers: auth(),
    });
    expect(detail.statusCode).toBe(404);
    const list = await test.app.inject({ method: 'GET', url: '/api/source-artifacts', headers: auth() });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([]);

    const before = await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const mutation = await test.app.inject({
      method: 'PATCH', url: `/api/source-artifacts/${created.json().id}/mount`,
      headers: auth(test.token, 'saas-201-malformed-mutation'),
      payload: { expectedAclVersion: 1 },
    });
    expect(mutation.statusCode).toBe(404);
    expect(await Promise.all([
      test.prisma.sourceArtifact.count(), test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).toEqual(before);
  });

  it('adopts a shared external upload identity without changing its mount, ACL generation or artifact id', async () => {
    const fileBody = Buffer.from('shared adopted upload body');
    const externalRef = `upload:${createHash('sha256').update(fileBody).digest('hex')}`;
    const registered = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, 'saas-201-adopt-upload-register'),
      payload: { source: 'upload', externalRef, matterId, title: 'adopted-upload.txt' },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const shared = await test.app.inject({
      method: 'PUT', url: `/api/source-artifacts/${registered.json().id}/visibility`,
      headers: auth(test.token, 'saas-201-adopt-upload-share'),
      payload: { visibility: 'matter_shared', expectedAclVersion: 1 },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json()).toMatchObject({ visibility: 'matter_shared', aclVersion: 2 });

    const boundary = '----jianghu-saas-201-adopt-upload';
    const multipart = Buffer.concat([
      Buffer.from([
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="file"; filename="adopted-upload.txt"\r\n',
        'Content-Type: text/plain\r\n\r\n',
      ].join('')),
      fileBody,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await test.app.inject({
      method: 'POST', url: `/api/recording/upload?opportunityId=${matterId}`,
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    expect(upload.json()).toMatchObject({ source: 'upload', saved: 1, skipped: 0 });

    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({
      where: { id: registered.json().id },
    })).resolves.toMatchObject({
      id: registered.json().id, backingKind: 'transcript', artifactKind: 'uploaded_file',
      accountId, matterId, visibility: 'matter_shared', aclVersion: 2,
      retentionState: 'available', externalRef,
    });
    await expect(test.prisma.transcript.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, source: 'upload', externalRef,
    } })).resolves.toMatchObject({
      accountId, opportunityId: matterId, visibility: 'matter_shared', aclVersion: 2,
    });
  });
});
