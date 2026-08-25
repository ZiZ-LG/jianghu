import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { createFieldCandidate } from '../src/candidates/reviewItems.js';
import { pullAndSave } from '../src/recording.js';
import { enc } from '../src/ai.js';
import { hashIdempotencyKey } from '../src/idempotency.js';
import { setSensitiveResourceVisibility } from '../src/sensitiveAcl/service.js';
import { transcriptIdempotencyDomainForCreator } from '../src/transcriptDedupe.js';

const feishu = vi.hoisted(() => ({
  searchMinutes: vi.fn(),
  getMinute: vi.fn(),
}));
vi.mock('../src/feishu.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/feishu.js')>(),
  searchFeishuMinutes: feishu.searchMinutes,
  getFeishuMinute: feishu.getMinute,
}));

const internalPolicy = assembleProductAccess({ edition: 'internal' }).policy;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

const requestHash = (payload: unknown) => createHash('sha256')
  .update(JSON.stringify(canonicalize(payload)))
  .digest('hex');

describe('CORE-204 sensitive route enforcement', () => {
  let test: TestContext;
  const accountId = 'core-204-route-account';
  const matterId = 'core-204-route-matter';

  beforeEach(async () => {
    vi.clearAllMocks();
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Route account', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId, name: 'Route matter',
      customerType: 1,
      pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test.owner.id,
    } });
  });

  afterEach(async () => test.cleanup());

  async function memberToken(label: string, role = 'member') {
    const user = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: `${label}-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: label, role,
    } });
    return {
      user,
      token: test.app.jwt.sign({ userId: user.id, tenantId: test.tenant.id, role }),
    };
  }

  const auth = (token = test.token) => ({ authorization: `Bearer ${token}` });

  it('returns only readable Note bodies from state and applies revocation on the next request', async () => {
    const reader = await memberToken('reader');
    await test.prisma.note.createMany({ data: [
      {
        id: 'private-note', tenantId: test.tenant.id, accountId, opportunityId: matterId,
        content: 'private body', createdBy: test.owner.id, createdByUserId: test.owner.id,
        visibility: 'private', aclVersion: 1,
      },
      {
        id: 'shared-note', tenantId: test.tenant.id, accountId, opportunityId: matterId,
        content: 'shared body', createdBy: test.owner.id, createdByUserId: test.owner.id,
        visibility: 'matter_shared', aclVersion: 1,
      },
    ] });

    const visible = await test.app.inject({ method: 'GET', url: '/api/state', headers: auth(reader.token) });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.body).toContain('shared body');
    expect(visible.body).not.toContain('private body');

    await test.prisma.note.update({ where: { id: 'shared-note' }, data: { visibility: 'private', aclVersion: 2 } });
    const revoked = await test.app.inject({ method: 'GET', url: '/api/state', headers: auth(reader.token) });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.body).not.toContain('shared body');
  });

  it('filters Transcript metadata and blocks shared readers from redact/delete', async () => {
    const reader = await memberToken('reader');
    await test.prisma.transcript.createMany({ data: [
      {
        id: 'private-transcript', tenantId: test.tenant.id, accountId, opportunityId: matterId,
        title: 'private title', contentEnc: 'cipher-private', createdBy: test.owner.id,
        createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
      },
      {
        id: 'shared-transcript', tenantId: test.tenant.id, accountId, opportunityId: matterId,
        title: 'shared title', contentEnc: 'cipher-shared', createdBy: test.owner.id,
        createdByUserId: test.owner.id, visibility: 'matter_shared', aclVersion: 1,
      },
    ] });

    const listed = await test.app.inject({ method: 'GET', url: '/api/recording/transcripts', headers: auth(reader.token) });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain('shared title');
    expect(listed.body).not.toContain('private title');
    expect(listed.body).not.toContain('cipher-');

    for (const request of [
      { method: 'POST' as const, url: '/api/recording/redact', payload: { transcriptId: 'shared-transcript' } },
      { method: 'DELETE' as const, url: '/api/recording/transcripts/shared-transcript' },
    ]) {
      const response = await test.app.inject({ ...request, headers: auth(reader.token) });
      expect(response.statusCode).toBe(404);
    }
  });

  it('does not let newer private Transcript rows starve an older readable shared row', async () => {
    const reader = await memberToken('transcript-window-reader');
    const outsider = await memberToken('transcript-window-outsider');
    await test.prisma.transcript.create({ data: {
      id: 'older-shared-transcript',
      tenantId: test.tenant.id,
      accountId,
      opportunityId: matterId,
      title: 'older shared title',
      contentEnc: 'cipher-shared',
      createdBy: test.owner.id,
      createdByUserId: test.owner.id,
      visibility: 'matter_shared',
      aclVersion: 1,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    } });
    await test.prisma.transcript.createMany({ data: Array.from({ length: 200 }, (_, index) => ({
      id: `newer-private-transcript-${index}`,
      tenantId: test.tenant.id,
      accountId,
      opportunityId: matterId,
      title: `newer private title ${index}`,
      contentEnc: 'cipher-private',
      createdBy: outsider.user.id,
      createdByUserId: outsider.user.id,
      visibility: 'private',
      aclVersion: 1,
      createdAt: new Date(`2021-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`),
    })) });

    const listed = await test.app.inject({
      method: 'GET',
      url: '/api/recording/transcripts',
      headers: auth(reader.token),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain('older shared title');
    expect(listed.body).not.toContain('newer private title');
  });

  it('writes explicit creator-private ACL defaults for Note and Transcript producers', async () => {
    const addNote = await test.app.inject({
      method: 'POST', url: '/api/mutate', headers: auth(),
      payload: { action: {
        type: 'ADD_NOTE', accId: accountId, note: {
          id: 'producer-note', opportunityId: matterId,
          content: 'producer private', source: 'manual', tags: [],
        },
      } },
    });
    expect(addNote.statusCode, addNote.body).toBe(200);
    await expect(test.prisma.note.findUnique({ where: { id: 'producer-note' } })).resolves.toMatchObject({
      createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    });
    await expect(test.prisma.sourceArtifact.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, backingKind: 'note', backingId: 'producer-note',
    } })).resolves.toMatchObject({
      artifactKind: 'note', source: 'manual', retentionState: 'available',
      fingerprintKind: 'content_sha256_v1', createdByUserId: test.owner.id,
      visibility: 'private', aclVersion: 1,
    });
  });

  it('projects an uploaded file once using a stable creator-domain content reference', async () => {
    const boundary = '----jianghu-saas-201-upload';
    const multipart = Buffer.from([
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="customer-meeting.txt"\r\n',
      'Content-Type: text/plain\r\n\r\n',
      'private uploaded meeting body\r\n',
      `--${boundary}--\r\n`,
    ].join(''));
    const upload = () => test.app.inject({
      method: 'POST',
      url: `/api/recording/upload?accountId=${accountId}&opportunityId=${matterId}`,
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });

    const first = await upload();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ source: 'upload', saved: 1, skipped: 0 });
    const transcript = await test.prisma.transcript.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, source: 'upload', createdByUserId: test.owner.id,
    } });
    expect(transcript.externalRef).toMatch(/^upload:[a-f0-9]{64}$/);
    await expect(test.prisma.sourceArtifact.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, backingKind: 'transcript', backingId: transcript.id,
    } })).resolves.toMatchObject({
      artifactKind: 'uploaded_file', source: 'upload', externalRef: transcript.externalRef,
      idempotencyDomain: transcript.idempotencyDomain, retentionState: 'available',
      fingerprintKind: 'content_sha256_v1', createdByUserId: test.owner.id,
      visibility: 'private', aclVersion: 1,
    });

    const replay = await upload();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ source: 'upload', saved: 0, skipped: 1 });
    await expect(test.prisma.sourceArtifact.count({ where: {
      tenantId: test.tenant.id, source: 'upload', externalRef: transcript.externalRef,
    } })).resolves.toBe(1);
  });

  it('checks both sides of a Note rebind and advances the ACL generation', async () => {
    const member = await memberToken('note-rebinder');
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    await test.prisma.opportunity.update({
      where: { id: matterId }, data: { primaryOwnerUserId: test.owner.id },
    });
    const currentMatterId = 'core-204-current-matter';
    const allowedMatterId = 'core-204-allowed-matter';
    await test.prisma.opportunity.createMany({ data: [
      {
        id: currentMatterId, tenantId: test.tenant.id, accountId, name: 'Current matter',
        customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        primaryOwnerUserId: member.user.id,
      },
      {
        id: allowedMatterId, tenantId: test.tenant.id, accountId, name: 'Allowed matter',
        customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        primaryOwnerUserId: member.user.id,
      },
    ] });
    const createOutsideScope = await test.app.inject({
      method: 'POST', url: '/api/mutate', headers: auth(member.token),
      payload: { action: {
        type: 'ADD_NOTE', accId: accountId,
        note: { id: 'out-of-scope-note', opportunityId: matterId, content: 'must not persist' },
      } },
    });
    expect(createOutsideScope.statusCode, createOutsideScope.body).toBe(404);
    await expect(test.prisma.note.findUnique({ where: { id: 'out-of-scope-note' } })).resolves.toBeNull();
    await test.prisma.note.create({ data: {
      id: 'member-note', tenantId: test.tenant.id, accountId, opportunityId: currentMatterId,
      content: 'member private body', createdBy: member.user.id,
      createdByUserId: member.user.id, visibility: 'private', aclVersion: 1,
    } });

    const allowed = await test.app.inject({
      method: 'POST', url: '/api/mutate', headers: auth(member.token),
      payload: { action: {
        type: 'UPDATE_NOTE', accId: accountId, noteId: 'member-note',
        patch: { opportunityId: allowedMatterId },
      } },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'member-note' } }))
      .resolves.toMatchObject({ opportunityId: allowedMatterId, aclVersion: 2 });

    const denied = await test.app.inject({
      method: 'POST', url: '/api/mutate', headers: auth(member.token),
      payload: { action: {
        type: 'UPDATE_NOTE', accId: accountId, noteId: 'member-note',
        patch: { opportunityId: matterId },
      } },
    });
    expect(denied.statusCode, denied.body).toBe(404);
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'member-note' } }))
      .resolves.toMatchObject({ opportunityId: allowedMatterId, aclVersion: 2 });
  });

  it('fails closed when repair would rebind a creator Note outside current Matter scope', async () => {
    const member = await memberToken('repair-rebinder');
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    const currentMatterId = 'core-204-repair-current';
    await test.prisma.opportunity.create({ data: {
      id: currentMatterId, tenantId: test.tenant.id, accountId, name: 'Repair current matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: member.user.id,
    } });
    await test.prisma.note.create({ data: {
      id: 'repair-member-note', tenantId: test.tenant.id, accountId,
      opportunityId: currentMatterId, content: 'repair private body', createdBy: member.user.id,
      createdByUserId: member.user.id, visibility: 'private', aclVersion: 1,
    } });

    const denied = await test.app.inject({
      method: 'POST', url: '/api/repair/rebind', headers: auth(member.token),
      payload: { kind: 'note', id: 'repair-member-note', accountId, opportunityId: matterId },
    });
    expect(denied.statusCode, denied.body).toBe(404);
    await expect(test.prisma.note.findUniqueOrThrow({ where: { id: 'repair-member-note' } }))
      .resolves.toMatchObject({ opportunityId: currentMatterId, aclVersion: 1 });
  });

  it('returns the same 404 shape for missing and creator-private Candidate review attempts', async () => {
    const outsider = await memberToken('candidate-outsider');
    const created = await createFieldCandidate(test.prisma, {
      id: 'private-route-proposal', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'opportunity', targetId: matterId, fieldKey: 'name',
      oldValue: 'Route matter', newValue: 'Must stay private',
      source: 'voice', sourceRef: 'voice:core-204:private-route',
      evidence: 'private proposal evidence', confidence: 0.8,
      createdByUserId: test.owner.id,
    });

    for (const action of ['accept', 'reject'] as const) {
      const denied = await test.app.inject({
        method: 'POST',
        url: `/api/proposals/${created.row.id}/${action}`,
        headers: auth(outsider.token),
      });
      const missing = await test.app.inject({
        method: 'POST',
        url: `/api/proposals/missing-private-proposal/${action}`,
        headers: auth(outsider.token),
      });
      expect(denied.statusCode, denied.body).toBe(404);
      expect({ statusCode: denied.statusCode, body: denied.body }).toEqual({
        statusCode: missing.statusCode,
        body: missing.body,
      });
    }
    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ status: 'pending' });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ status: 'pending', createdByUserId: test.owner.id, visibility: 'private' });
  });

  it('isolates Transcript idempotency per creator and keeps the domain immutable when shared', async () => {
    const first = await memberToken('transcript-first');
    const second = await memberToken('transcript-second');
    await expect(pullAndSave(
      test.tenant.id, first.user.id, 'mock', { accountId, opportunityId: matterId },
    )).resolves.toMatchObject({ saved: 2, skipped: 0 });

    await expect(pullAndSave(
      test.tenant.id, second.user.id, 'mock', { accountId, opportunityId: matterId },
    )).resolves.toMatchObject({ saved: 2, skipped: 0 });
    await expect(pullAndSave(
      test.tenant.id, first.user.id, 'mock', { accountId, opportunityId: matterId },
    )).resolves.toMatchObject({ saved: 0, skipped: 2 });
    const rows = await test.prisma.transcript.findMany({
      where: { tenantId: test.tenant.id },
      orderBy: [{ createdByUserId: 'asc' }, { externalRef: 'asc' }],
      select: {
        id: true, createdByUserId: true, visibility: true, aclVersion: true,
        idempotencyDomain: true,
      },
    });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.idempotencyDomain)).size).toBe(2);
    expect(rows.filter((row) => row.createdByUserId === first.user.id)).toHaveLength(2);
    expect(rows.filter((row) => row.createdByUserId === second.user.id)).toHaveLength(2);
    await expect(test.prisma.sourceArtifact.count({ where: {
      tenantId: test.tenant.id, backingKind: 'transcript', artifactKind: 'transcript',
      retentionState: 'available',
    } })).resolves.toBe(4);

    const firstRow = rows.find((row) => row.createdByUserId === first.user.id)!;
    const domainBeforeShare = firstRow.idempotencyDomain;
    await setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: first.user.id,
      actorRole: 'member',
      kind: 'transcript',
      resourceId: firstRow.id,
      visibility: 'matter_shared',
      expectedAclVersion: 1,
    }, internalPolicy);
    await expect(test.prisma.transcript.findUniqueOrThrow({ where: { id: firstRow.id } }))
      .resolves.toMatchObject({ idempotencyDomain: domainBeforeShare, aclVersion: 2 });
    await expect(test.prisma.sourceArtifact.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, backingKind: 'transcript', backingId: firstRow.id,
    } })).resolves.toMatchObject({
      idempotencyDomain: domainBeforeShare, visibility: 'matter_shared', aclVersion: 2,
    });
  });

  it('converges concurrent Transcript imports inside one creator domain', async () => {
    const member = await memberToken('transcript-concurrent');
    const results = await Promise.all([
      pullAndSave(test.tenant.id, member.user.id, 'mock', { accountId, opportunityId: matterId }),
      pullAndSave(test.tenant.id, member.user.id, 'mock', { accountId, opportunityId: matterId }),
    ]);
    expect(results.reduce((total, result) => total + result.saved, 0)).toBe(2);
    expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(2);
    await expect(test.prisma.transcript.count({ where: {
      tenantId: test.tenant.id,
      createdByUserId: member.user.id,
    } })).resolves.toBe(2);
  });

  it('enforces the viewer write ban at the Transcript producer service boundary', async () => {
    const viewer = await memberToken('transcript-viewer', 'viewer');
    await test.prisma.account.update({
      where: { id: accountId },
      data: { primaryOwnerUserId: viewer.user.id },
    });
    await test.prisma.opportunity.update({
      where: { id: matterId },
      data: { primaryOwnerUserId: viewer.user.id },
    });

    await expect(pullAndSave(
      test.tenant.id, viewer.user.id, 'mock', { accountId, opportunityId: matterId },
    )).rejects.toThrow('挂载对象不存在或无权访问');
    await expect(test.prisma.transcript.count({ where: { tenantId: test.tenant.id } }))
      .resolves.toBe(0);
  });

  it('deduplicates Feishu auto-pull within the current creator domain only', async () => {
    const member = await memberToken('feishu-private-creator');
    const minuteToken = 'same-private-minute';
    const externalRef = `feishu:${minuteToken}`;
    await test.prisma.recordingCredential.create({ data: {
      id: 'core-204-feishu-private-credential', tenantId: test.tenant.id,
      userId: member.user.id, source: 'feishu', accessTokenEnc: enc('member-access-token'),
      refreshTokenEnc: enc(''), expiresAt: new Date(Date.now() + 3_600_000), status: 'active',
    } });
    await test.prisma.transcript.create({ data: {
      id: 'core-204-other-private-transcript', tenantId: test.tenant.id,
      accountId, opportunityId: matterId, source: 'feishu', externalRef,
      idempotencyDomain: transcriptIdempotencyDomainForCreator(test.owner.id),
      title: 'other creator private title', contentEnc: enc('other creator private body'),
      createdBy: test.owner.id, createdByUserId: test.owner.id,
      visibility: 'private', aclVersion: 1,
    } });
    feishu.searchMinutes.mockResolvedValue({
      briefs: [{ token: minuteToken, title: '【拜访】当前创建者可导入', createTime: 1 }],
      debug: 'test',
    });
    feishu.getMinute.mockResolvedValue({
      title: '【拜访】当前创建者可导入', durationSec: 60, transcript: 'current creator body',
    });

    const response = await test.app.inject({
      method: 'POST', url: '/api/recording/feishu/sync',
      headers: auth(member.token), payload: { accountId, opportunityId: matterId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ source: 'feishu', saved: 1, skipped: 0, scanned: 1 });
    expect(feishu.getMinute).toHaveBeenCalledWith('member-access-token', minuteToken);
    const rows = await test.prisma.transcript.findMany({
      where: { tenantId: test.tenant.id, source: 'feishu', externalRef },
      orderBy: { createdByUserId: 'asc' },
      select: { createdByUserId: true, idempotencyDomain: true, title: true },
    });
    expect(rows).toEqual(expect.arrayContaining([
      {
        createdByUserId: test.owner.id,
        idempotencyDomain: transcriptIdempotencyDomainForCreator(test.owner.id),
        title: 'other creator private title',
      },
      {
        createdByUserId: member.user.id,
        idempotencyDomain: transcriptIdempotencyDomainForCreator(member.user.id),
        title: '【拜访】当前创建者可导入',
      },
    ]));
  });

  it('returns the same 404 before source or file work for hidden and missing Transcript mounts', async () => {
    const member = await memberToken('hidden-mount-member');
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    const requests = [
      {
        method: 'POST' as const,
        url: '/api/recording/pull',
        payload: { source: 'mock', accountId, opportunityId: matterId },
      },
      {
        method: 'POST' as const,
        url: `/api/recording/upload?accountId=${accountId}&opportunityId=${matterId}`,
      },
      {
        method: 'POST' as const,
        url: '/api/recording/feishu/sync',
        payload: { accountId, opportunityId: matterId },
      },
      {
        method: 'POST' as const,
        url: '/api/recording/feishu/pull',
        payload: { url: 'https://example.test/minutes/token', accountId, opportunityId: matterId },
      },
    ];
    for (const request of requests) {
      const hidden = await test.app.inject({ ...request, headers: auth(member.token) });
      const missingPayload = request.payload && 'accountId' in request.payload
        ? { ...request.payload, accountId: 'missing-account', opportunityId: 'missing-matter' }
        : request.payload;
      const missingUrl = request.url.includes('accountId=')
        ? '/api/recording/upload?accountId=missing-account&opportunityId=missing-matter'
        : request.url;
      const missing = await test.app.inject({
        ...request,
        url: missingUrl,
        payload: missingPayload,
        headers: auth(member.token),
      });
      expect(hidden.statusCode, `${request.url}: ${hidden.body}`).toBe(404);
      expect({ statusCode: hidden.statusCode, body: hidden.body }).toEqual({
        statusCode: missing.statusCode,
        body: missing.body,
      });
    }
    await expect(test.prisma.transcript.count({ where: { tenantId: test.tenant.id } }))
      .resolves.toBe(0);
  });

  it('revalidates current Transcript scope before returning a completed extract replay', async () => {
    const member = await memberToken('extract-replay-member');
    const replayMatterId = 'core-204-extract-replay-matter';
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    await test.prisma.opportunity.create({ data: {
      id: replayMatterId, tenantId: test.tenant.id, accountId, name: 'Replay matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: member.user.id,
    } });
    await test.prisma.transcript.create({ data: {
      id: 'extract-replay-transcript', tenantId: test.tenant.id, accountId,
      opportunityId: replayMatterId, title: 'private replay title', contentEnc: 'private-cipher',
      createdBy: member.user.id, createdByUserId: member.user.id,
      visibility: 'private', aclVersion: 1,
    } });
    const payload = { transcriptId: 'extract-replay-transcript' };
    const key = 'core-204-extract-replay-key';
    await test.prisma.commandRun.create({ data: {
      tenantId: test.tenant.id,
      actorId: member.user.id,
      kind: 'recording-ingest',
      idempotencyKey: hashIdempotencyKey(key),
      requestHash: requestHash(payload),
      status: 'completed',
      resultSummary: JSON.stringify({ receipt: { privateReceipt: 'must-not-replay' } }),
    } });
    await test.prisma.opportunity.update({
      where: { id: replayMatterId }, data: { primaryOwnerUserId: test.owner.id },
    });

    const response = await test.app.inject({
      method: 'POST', url: '/api/recording/extract',
      headers: { ...auth(member.token), 'idempotency-key': key },
      payload,
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.body).not.toContain('must-not-replay');
  });

  it('revalidates every Candidate before returning a completed inbox batch replay', async () => {
    const member = await memberToken('batch-replay-member');
    const replayMatterId = 'core-204-batch-replay-matter';
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    await test.prisma.opportunity.create({ data: {
      id: replayMatterId, tenantId: test.tenant.id, accountId, name: 'Batch replay matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: member.user.id,
    } });
    const proposal = await createFieldCandidate(test.prisma, {
      id: 'batch-replay-proposal', tenantId: test.tenant.id, accountId, matterId: replayMatterId,
      targetKind: 'opportunity', targetId: replayMatterId, fieldKey: 'name',
      oldValue: 'Batch replay matter', newValue: 'Sensitive batch value',
      source: 'voice', sourceRef: 'voice:core-204:batch-replay',
      evidence: 'private batch evidence', confidence: 0.8,
      createdByUserId: member.user.id,
    });
    const payload = { items: [{ kind: 'proposal', id: proposal.row.id, decision: 'reject' }] };
    const key = 'core-204-inbox-replay-key';
    await test.prisma.commandRun.create({ data: {
      tenantId: test.tenant.id,
      actorId: member.user.id,
      kind: 'inbox-batch',
      idempotencyKey: hashIdempotencyKey(key),
      requestHash: requestHash(payload),
      status: 'completed',
      resultSummary: JSON.stringify({
        items: [{ kind: 'proposal', id: proposal.row.id, status: 'ok' }],
      }),
    } });
    await test.prisma.opportunity.update({
      where: { id: replayMatterId }, data: { primaryOwnerUserId: test.owner.id },
    });

    const response = await test.app.inject({
      method: 'POST', url: '/api/commands/inbox-batch',
      headers: { ...auth(member.token), 'idempotency-key': key },
      payload,
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.body).not.toContain(proposal.row.id);
  });
});
