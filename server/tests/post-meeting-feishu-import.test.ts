import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import {
  FeishuImportError,
  parseFeishuMinuteToken,
  prepareFeishuPostMeetingSource,
  type FeishuImportProvider,
} from '../src/postMeeting/feishuImport.js';
import { saveRecordingCredential } from '../src/recordingCredentials.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { createPostMeetingHandler, postMeetingReviewBatchId } from '../src/postMeeting/handler.js';
import { prisma } from '../src/prisma.js';

const internalPolicy = assembleProductAccess({ edition: 'internal' }).policy;
const feishuModelResponse = JSON.stringify({
  items: [{
    kind: 'person', ref: 'li', quote: '李经理负责技术评估。', confidence: 0.9,
    name: '李经理', title: '技术负责人',
  }],
});

describe('SAAS-203 exact Feishu Minutes import', () => {
  it('exports one injectable exact-minute provider boundary', async () => {
    const module = await import('../src/postMeeting/feishuImport.js').catch(() => null);

    expect(module).not.toBeNull();
    expect(module?.productionFeishuImportProvider).toBeDefined();
    expect(typeof module?.parseFeishuMinuteToken).toBe('function');
    expect(typeof module?.prepareFeishuPostMeetingSource).toBe('function');
  });

  it.each([
    ['obcn_12345678', 'obcn_12345678'],
    ['https://acme.feishu.cn/minutes/obcn_12345678', 'obcn_12345678'],
    ['https://feishu.cn/minutes/obcn_12345678/?from=copy', 'obcn_12345678'],
  ])('parses one strict user-supplied Minutes identity', (input, expected) => {
    expect(parseFeishuMinuteToken(input)).toBe(expected);
  });

  it.each([
    '',
    'short',
    'https://evil.example/minutes/obcn_12345678',
    'http://acme.feishu.cn/minutes/obcn_12345678',
    'https://acme.feishu.cn/wiki/obcn_12345678',
    'https://fakefeishu.cn/minutes/obcn_12345678',
    'https://acme.feishu.cn/minutes/obcn_12345678/extra',
  ])('rejects non-exact Feishu Minutes input %#', (input) => {
    expect(() => parseFeishuMinuteToken(input)).toThrowError(FeishuImportError);
  });

  it('fetches exactly one minute and prepares a body-bound source without list/search', async () => {
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(async () => ({
        title: '  Customer review  ',
        transcript: '  Private exact minute transcript.  ',
        durationSec: 121.4,
        recordedAt: new Date('2026-08-26T14:00:00.000Z'),
      })),
    };

    const result = await prepareFeishuPostMeetingSource({
      input: 'https://acme.feishu.cn/minutes/obcn_12345678',
      accessToken: 'secret-user-access-token',
      provider,
    });

    expect(provider.fetchMinute).toHaveBeenCalledTimes(1);
    expect(provider.fetchMinute).toHaveBeenCalledWith('secret-user-access-token', 'obcn_12345678');
    expect(provider.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(provider.refreshAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      source: 'feishu',
      externalRef: 'feishu:obcn_12345678',
      title: 'Customer review',
      text: 'Private exact minute transcript.',
      durationSec: 121,
      recordedAt: new Date('2026-08-26T14:00:00.000Z'),
      contentFingerprint: createHash('sha256')
        .update('Private exact minute transcript.')
        .digest('hex'),
    });
    expect(JSON.stringify(result)).not.toContain('secret-user-access-token');
  });

  it.each([
    [{ title: 'Meeting', transcript: '   ', durationSec: 0, recordedAt: null }, 'post_meeting_feishu_empty'],
    [{ title: 'Meeting', transcript: 'x'.repeat(500_001), durationSec: 0, recordedAt: null }, 'post_meeting_feishu_too_large'],
    [{ title: 'Meeting', transcript: 'body', durationSec: -1, recordedAt: null }, 'post_meeting_feishu_metadata_invalid'],
    [{ title: 'Meeting', transcript: 'body', durationSec: 0, recordedAt: new Date('invalid') }, 'post_meeting_feishu_metadata_invalid'],
  ])('fails closed on invalid exact-minute content %#', async (minute, code) => {
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(async () => minute),
    };
    await expect(prepareFeishuPostMeetingSource({
      input: 'obcn_12345678', accessToken: 'token', provider,
    })).rejects.toMatchObject({ code, statusCode: 400 });
  });

  it('maps provider diagnostics to a stable retryable error', async () => {
    const rawMarker = 'RAW_PROVIDER_SECRET_RESPONSE';
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(async () => { throw new Error(rawMarker); }),
    };
    const failure = await prepareFeishuPostMeetingSource({
      input: 'obcn_12345678', accessToken: 'token', provider,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'post_meeting_feishu_provider_failed', statusCode: 502, retryable: true,
    });
    expect(String(failure)).not.toContain(rawMarker);
  });

  it('maps a malformed provider payload to a stable body-free error', async () => {
    const rawMarker = 'RAW_MALFORMED_PROVIDER_PAYLOAD';
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(async () => ({
        title: { rawMarker }, transcript: null, durationSec: 0, recordedAt: null,
      } as never)),
    };
    const failure = await prepareFeishuPostMeetingSource({
      input: 'obcn_12345678', accessToken: 'token', provider,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'post_meeting_feishu_provider_invalid', statusCode: 502, retryable: true,
    });
    expect(String(failure)).not.toContain(rawMarker);
  });
});

describe('SAAS-203 exact Feishu Minutes import route', () => {
  let test: TestContext;
  let provider: FeishuImportProvider;
  const customerId = 'saas-203-feishu-customer';
  const matterId = 'saas-203-feishu-matter';

  beforeEach(async () => {
    provider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(async () => ({
        title: 'Feishu customer review',
        transcript: 'Private Feishu minute transcript. 李经理负责技术评估。',
        durationSec: 180,
        recordedAt: new Date('2026-08-26T14:30:00.000Z'),
      })),
    };
    const handler = createPostMeetingHandler({
      db: prisma,
      policy: internalPolicy,
      loadAiConfig: async () => ({
        provider: 'openai-compatible', baseUrl: 'https://model.example.test/v1',
        model: 'tenant-model', apiKey: 'TEST_FEISHU_MODEL_KEY_NOT_PERSISTED',
      }),
      callLLM: async () => feishuModelResponse,
    });
    test = await createTestContext({
      feishuImportProvider: provider,
      publicBaseUrl: 'http://localhost:3001',
      agentHandlers: { 'post_meeting_extract@core-206.v1': handler },
    });
    await test.prisma.account.create({ data: {
      id: customerId,
      tenantId: test.tenant.id,
      name: 'Feishu customer',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId,
      tenantId: test.tenant.id,
      accountId: customerId,
      name: 'Feishu matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    await saveRecordingCredential(test.prisma, test.tenant.id, test.owner.id, 'feishu', {
      accessToken: 'private-feishu-access-token',
      refreshToken: 'private-feishu-refresh-token',
      expiresAt: null,
    });
  });

  afterEach(async () => test.cleanup());

  function request(key = 'saas-203-feishu-import') {
    return test.app.inject({
      method: 'POST',
      url: '/api/post-meeting/import/feishu',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': key,
      },
      payload: {
        url: 'https://acme.feishu.cn/minutes/obcn_12345678',
        customerId,
        matterId,
      },
    });
  }

  async function addUser(role: 'member' | 'viewer', label: string) {
    const user = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: `${label}-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: label,
      role,
    } });
    return {
      user,
      token: test.app.jwt.sign({ userId: user.id, tenantId: test.tenant.id, role }),
    };
  }

  it('reserves transport idempotency before exact provider fetch and returns one body-free source', async () => {
    const first = await request();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      source: {
        id: expect.stringMatching(/^src_[a-f0-9]{32}$/),
        customerId,
        matterId,
        title: 'Feishu customer review',
        kind: 'transcript',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        aclVersion: 1,
        version: 1,
        occurredAt: '2026-08-26T14:30:00.000Z',
      },
      replayed: false,
    });
    expect(provider.fetchMinute).toHaveBeenCalledTimes(1);
    expect(provider.fetchMinute).toHaveBeenCalledWith(
      'private-feishu-access-token', 'obcn_12345678',
    );

    const replay = await request();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ source: first.json().source, replayed: true });
    expect(provider.fetchMinute).toHaveBeenCalledTimes(1);
    const [transcripts, artifacts, commands, audits] = await Promise.all([
      test.prisma.transcript.findMany(),
      test.prisma.sourceArtifact.findMany(),
      test.prisma.commandRun.findMany(),
      test.prisma.auditEvent.findMany(),
    ]);
    expect(transcripts).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(audits).toHaveLength(1);
    const persisted = JSON.stringify({ transcripts, artifacts, commands, audits });
    expect(persisted).not.toContain('Private Feishu minute transcript. 李经理负责技术评估。');
    expect(persisted).not.toContain('private-feishu-access-token');
    expect(persisted).not.toContain('private-feishu-refresh-token');
  });

  it('fails provider work safely and retries the same reservation without duplicate business rows', async () => {
    const rawMarker = 'RAW-FEISHU-PROVIDER-SECRET-RESPONSE';
    vi.mocked(provider.fetchMinute)
      .mockRejectedValueOnce(new Error(rawMarker));

    const failure = await request('retryable-feishu-import');
    expect(failure.statusCode, failure.body).toBe(502);
    expect(failure.json()).toMatchObject({ code: 'post_meeting_feishu_provider_failed' });
    expect(failure.body).not.toContain(rawMarker);
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
    const failedCommand = await test.prisma.commandRun.findFirstOrThrow();
    expect(failedCommand).toMatchObject({
      status: 'failed', errorCode: 'post_meeting_feishu_provider_failed',
    });
    expect(JSON.stringify(failedCommand)).not.toContain(rawMarker);

    const retry = await request('retryable-feishu-import');
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: false });
    expect(provider.fetchMinute).toHaveBeenCalledTimes(2);
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
    expect(await test.prisma.commandRun.count()).toBe(1);
  });

  it('checks current role and scope before credential or provider access', async () => {
    const member = await addUser('member', 'Hidden Feishu importer');
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    const hidden = await test.app.inject({
      method: 'POST',
      url: '/api/post-meeting/import/feishu',
      headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': 'hidden-feishu-import' },
      payload: {
        url: 'obcn_12345678', customerId, matterId,
      },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'post_meeting_import_not_found' });
    expect(provider.fetchMinute).not.toHaveBeenCalled();
    expect(await test.prisma.commandRun.count()).toBe(0);

    const viewer = await addUser('viewer', 'Feishu import viewer');
    const viewerResponse = await test.app.inject({
      method: 'POST',
      url: '/api/post-meeting/import/feishu',
      headers: { authorization: `Bearer ${viewer.token}`, 'idempotency-key': 'viewer-feishu-import' },
      payload: { url: 'obcn_12345678', customerId, matterId },
    });
    expect(viewerResponse.statusCode).toBe(403);
    expect(viewerResponse.json()).toMatchObject({ code: 'viewer_write_denied' });
    expect(provider.fetchMinute).not.toHaveBeenCalled();
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
  });

  it('rejects a reused transport key with changed exact mount before another provider call', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'saas-203-feishu-other-matter',
      tenantId: test.tenant.id,
      accountId: customerId,
      name: 'Other Feishu matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    const first = await request('fixed-feishu-command');
    expect(first.statusCode, first.body).toBe(200);
    const changed = await test.app.inject({
      method: 'POST',
      url: '/api/post-meeting/import/feishu',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'fixed-feishu-command',
      },
      payload: {
        url: 'obcn_12345678',
        customerId,
        matterId: 'saas-203-feishu-other-matter',
      },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(provider.fetchMinute).toHaveBeenCalledTimes(1);
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
  });

  it('bridges one injected exact minute through the existing Job to a pending ReviewBatch only', async () => {
    const enabled = await test.app.inject({
      method: 'PUT',
      url: '/api/agent-jobs/post_meeting_extract/control',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-feishu-job-control',
      },
      payload: { jobVersion: 'core-206.v1', enabled: true, expectedVersion: 0 },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const formalBefore = {
      customer: await test.prisma.account.findUniqueOrThrow({ where: { id: customerId } }),
      matter: await test.prisma.opportunity.findUniqueOrThrow({ where: { id: matterId } }),
      counts: await Promise.all([
        test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
        test.prisma.planAction.count(), test.prisma.interaction.count(),
      ]),
    };
    const imported = await request('saas-203-feishu-e2e-import');
    expect(imported.statusCode, imported.body).toBe(200);
    const source = imported.json().source;
    const run = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-feishu-e2e-run',
      },
      payload: {
        jobVersion: 'core-206.v1',
        customerId,
        matterId,
        sourceArtifactId: source.id,
        inputRefs: [
          { kind: 'customer', id: customerId, version: formalBefore.customer.version },
          { kind: 'matter', id: matterId, version: formalBefore.matter.version },
          { kind: 'source_artifact', id: source.id, version: source.version },
        ],
      },
    });
    expect(run.statusCode, run.body).toBe(200);
    const runView = run.json().run;
    const batchId = postMeetingReviewBatchId(test.tenant.id, runView.id);
    expect(run.json()).toMatchObject({
      run: {
        status: 'succeeded',
        outputRefs: [{ kind: 'review_batch', id: batchId, version: 0 }],
      },
    });
    await expect(test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } }))
      .resolves.toMatchObject({
        sourceArtifactId: source.id,
        accountId: customerId,
        matterId,
        status: 'pending',
        aclVersion: source.aclVersion,
      });
    await expect(test.prisma.candidate.count()).resolves.toBe(1);
    expect(await test.prisma.account.findUniqueOrThrow({ where: { id: customerId } }))
      .toEqual(formalBefore.customer);
    expect(await test.prisma.opportunity.findUniqueOrThrow({ where: { id: matterId } }))
      .toEqual(formalBefore.matter);
    expect(await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(),
    ])).toEqual(formalBefore.counts);
    const persisted = JSON.stringify({
      runs: await test.prisma.agentRun.findMany(),
      commands: await test.prisma.commandRun.findMany(),
      audits: await test.prisma.auditEvent.findMany(),
    });
    expect(persisted).not.toContain('Private Feishu minute transcript.');
    expect(persisted).not.toContain('TEST_FEISHU_MODEL_KEY_NOT_PERSISTED');
  });
});
