import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { dec } from '../src/ai.js';
import { createPostMeetingHandler, postMeetingReviewBatchId } from '../src/postMeeting/handler.js';
import { prisma } from '../src/prisma.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const internalPolicy = assembleProductAccess({ edition: 'internal' }).policy;
const importedModelResponse = JSON.stringify({
  items: [{
    kind: 'person',
    ref: 'li',
    quote: '李经理负责技术评估。',
    confidence: 0.9,
    name: '李经理',
    title: '技术负责人',
  }],
});

function multipartFile(input: {
  boundary: string;
  filename: string;
  mimetype: string;
  body: Buffer | string;
}): Buffer {
  return Buffer.concat([
    Buffer.from([
      `--${input.boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${input.filename}"\r\n`,
      `Content-Type: ${input.mimetype}\r\n\r\n`,
    ].join('')),
    Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body),
    Buffer.from(`\r\n--${input.boundary}--\r\n`),
  ]);
}

describe('SAAS-203 exact post-meeting upload route', () => {
  let test: TestContext;
  const customerId = 'saas-203-route-customer';
  const matterId = 'saas-203-route-matter';
  const boundary = '----jianghu-saas-203-upload';

  beforeEach(async () => {
    const handler = createPostMeetingHandler({
      db: prisma,
      policy: internalPolicy,
      loadAiConfig: async () => ({
        provider: 'openai-compatible',
        baseUrl: 'https://model.example.test/v1',
        model: 'tenant-model',
        apiKey: 'TEST_MODEL_KEY_NOT_PERSISTED',
      }),
      callLLM: async () => importedModelResponse,
    });
    test = await createTestContext({
      agentHandlers: { 'post_meeting_extract@core-206.v1': handler },
    });
    await test.prisma.account.create({ data: {
      id: customerId,
      tenantId: test.tenant.id,
      name: 'Upload route customer',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId,
      tenantId: test.tenant.id,
      accountId: customerId,
      name: 'Upload route matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
  });

  afterEach(async () => test.cleanup());

  function request(overrides: {
    token?: string;
    key?: string;
    query?: string;
    filename?: string;
    mimetype?: string;
    body?: Buffer | string;
  } = {}) {
    return test.app.inject({
      method: 'POST',
      url: `/api/post-meeting/import/upload?${overrides.query ?? `customerId=${customerId}&matterId=${matterId}&occurredAt=2026-08-26T13%3A00%3A00.000Z`}`,
      headers: {
        authorization: `Bearer ${overrides.token ?? test.token}`,
        'idempotency-key': overrides.key ?? 'saas-203-upload-route',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartFile({
        boundary,
        filename: overrides.filename ?? 'meeting.txt',
        mimetype: overrides.mimetype ?? 'text/plain',
        body: overrides.body ?? 'Private upload route body',
      }),
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

  it('returns the exact typed source receipt and replays without duplicate business rows', async () => {
    const formalBefore = await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(), test.prisma.candidate.count(),
      test.prisma.reviewBatch.count(),
    ]);

    const first = await request();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      source: {
        id: expect.stringMatching(/^src_[a-f0-9]{32}$/),
        customerId,
        matterId,
        title: 'meeting.txt',
        kind: 'uploaded_file',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        aclVersion: 1,
        version: 1,
        occurredAt: '2026-08-26T13:00:00.000Z',
      },
      replayed: false,
    });
    expect(first.body).not.toContain('Private upload route body');
    expect(first.body).not.toContain('contentEnc');

    const replay = await request();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ source: first.json().source, replayed: true });
    const [transcripts, artifacts, commands, audits] = await Promise.all([
      test.prisma.transcript.findMany(),
      test.prisma.sourceArtifact.findMany(),
      test.prisma.commandRun.findMany(),
      test.prisma.auditEvent.findMany(),
    ]);
    expect(transcripts).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(dec(transcripts[0]!.contentEnc)).toBe('Private upload route body');
    expect(JSON.stringify({ transcripts, artifacts, commands, audits })).not.toContain('Private upload route body');
    expect(await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(), test.prisma.candidate.count(),
      test.prisma.reviewBatch.count(),
    ])).toEqual(formalBefore);
  });

  it('requires authentication, a current non-viewer role and a sales.workspace capability before writes', async () => {
    const unauthorized = await test.app.inject({
      method: 'POST',
      url: `/api/post-meeting/import/upload?customerId=${customerId}&matterId=${matterId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartFile({ boundary, filename: 'meeting.txt', mimetype: 'text/plain', body: 'body' }),
    });
    expect(unauthorized.statusCode).toBe(401);

    const viewer = await addUser('viewer', 'Upload viewer');
    const viewerResponse = await request({ token: viewer.token, key: 'viewer-upload-key' });
    expect(viewerResponse.statusCode).toBe(403);
    expect(viewerResponse.json()).toMatchObject({ code: 'viewer_write_denied' });
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
    expect(await test.prisma.commandRun.count()).toBe(0);
  });

  it('fails closed on invalid metadata, missing idempotency and malformed files with no business rows', async () => {
    const invalidCases = [
      await request({ key: 'short' }),
      await request({ key: 'missing-matter-key', query: `customerId=${customerId}` }),
      await request({ key: 'unknown-query-key', query: `customerId=${customerId}&matterId=${matterId}&extra=1` }),
      await request({ key: 'mime-mismatch-key', filename: 'meeting.pdf', mimetype: 'text/plain' }),
      await request({ key: 'invalid-utf8-key', body: Buffer.from([0xc3, 0x28]) }),
    ];
    expect(invalidCases.map((response) => response.statusCode)).toEqual([400, 400, 400, 400, 400]);
    expect(invalidCases.map((response) => response.json().code)).toEqual([
      'idempotency_key_required',
      'post_meeting_upload_metadata_invalid',
      'post_meeting_upload_metadata_invalid',
      'post_meeting_upload_mime_invalid',
      'post_meeting_upload_encoding_invalid',
    ]);
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
    expect(await test.prisma.commandRun.count()).toBe(0);
  });

  it('rejects changed command payloads and changed business metadata without duplicating a source', async () => {
    const first = await request({ key: 'stable-upload-command' });
    expect(first.statusCode, first.body).toBe(200);

    const changedPayload = await request({
      key: 'stable-upload-command', body: 'different upload bytes and content',
    });
    expect(changedPayload.statusCode, changedPayload.body).toBe(409);
    expect(changedPayload.json()).toMatchObject({ code: 'idempotency_key_reused' });

    const sameBytesDifferentTitle = await request({
      key: 'different-command-same-content', filename: 'renamed.txt',
    });
    expect(sameBytesDifferentTitle.statusCode, sameBytesDifferentTitle.body).toBe(409);
    expect(sameBytesDifferentTitle.json()).toMatchObject({ code: 'post_meeting_import_conflict' });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
  });

  it('returns the same exact source as a business replay under a new transport key', async () => {
    const first = await request({ key: 'first-upload-command' });
    const replay = await request({ key: 'second-upload-command' });

    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ source: first.json().source, replayed: true });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
    expect(await test.prisma.commandRun.count()).toBe(2);
  });

  it('cancels a scoped-miss reservation and does not reveal an inaccessible parent', async () => {
    const member = await addUser('member', 'Unscoped uploader');
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });
    const hidden = await request({
      token: member.token,
      key: 'hidden-parent-upload',
      filename: 'must-not-be-parsed.pdf',
      mimetype: 'application/pdf',
      body: 'SECRET-HIDDEN-PARSER-MARKER',
    });
    const missing = await request({
      token: member.token,
      key: 'missing-parent-upload',
      query: 'customerId=missing-customer&matterId=missing-matter',
    });

    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());
    expect(hidden.body).not.toContain('SECRET-HIDDEN-PARSER-MARKER');
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
    expect(await test.prisma.commandRun.count()).toBe(0);
  });

  it('reauthorizes a completed replay against the current database role', async () => {
    const first = await request();
    expect(first.statusCode, first.body).toBe(200);
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });

    const replay = await request();
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).toMatchObject({ code: 'viewer_write_denied' });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
    expect(await test.prisma.commandRun.count()).toBe(1);
  });

  it('rejects multiple multipart files and raw PDF parser failures without leaking diagnostics', async () => {
    const multiBoundary = '----jianghu-saas-203-multiple';
    const multiPayload = Buffer.from([
      `--${multiBoundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="one.txt"\r\n',
      'Content-Type: text/plain\r\n\r\none\r\n',
      `--${multiBoundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="two.txt"\r\n',
      'Content-Type: text/plain\r\n\r\ntwo\r\n',
      `--${multiBoundary}--\r\n`,
    ].join(''));
    const multiple = await test.app.inject({
      method: 'POST',
      url: `/api/post-meeting/import/upload?customerId=${customerId}&matterId=${matterId}`,
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'multiple-file-upload',
        'content-type': `multipart/form-data; boundary=${multiBoundary}`,
      },
      payload: multiPayload,
    });
    const parserMarker = 'SECRET-PDF-PARSER-MARKER';
    const brokenPdf = await request({
      key: 'broken-pdf-upload',
      filename: 'broken.pdf',
      mimetype: 'application/pdf',
      body: parserMarker,
    });

    expect(multiple.statusCode).toBe(400);
    expect(multiple.json()).toMatchObject({ code: 'post_meeting_upload_parts_invalid' });
    expect(brokenPdf.statusCode).toBe(400);
    expect(brokenPdf.json()).toMatchObject({ code: 'post_meeting_upload_parse_failed' });
    expect(brokenPdf.body).not.toContain(parserMarker);
    expect(await test.prisma.transcript.count()).toBe(0);
    expect(await test.prisma.sourceArtifact.count()).toBe(0);
  });

  it('keeps an imported source reusable when the Job is disabled and retries after enablement', async () => {
    const imported = await request({
      key: 'saas-203-disabled-job-import',
      body: '会后记录：李经理负责技术评估。',
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const source = imported.json().source;
    const payload = {
      jobVersion: 'core-206.v1', customerId, matterId, sourceArtifactId: source.id,
      inputRefs: [
        { kind: 'customer', id: customerId, version: 0 },
        { kind: 'matter', id: matterId, version: 0 },
        { kind: 'source_artifact', id: source.id, version: source.version },
      ],
    };
    const disabled = await test.app.inject({
      method: 'POST', url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-disabled-job-retry',
      },
      payload,
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: 'agent_job_disabled' });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
    expect(await test.prisma.reviewBatch.count()).toBe(0);

    const enabled = await test.app.inject({
      method: 'PUT', url: '/api/agent-jobs/post_meeting_extract/control',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-disabled-job-enable',
      },
      payload: { jobVersion: 'core-206.v1', enabled: true, expectedVersion: 0 },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const retried = await test.app.inject({
      method: 'POST', url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-disabled-job-retry',
      },
      payload,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ run: { status: 'succeeded' } });
    expect(await test.prisma.transcript.count()).toBe(1);
    expect(await test.prisma.sourceArtifact.count()).toBe(1);
    expect(await test.prisma.reviewBatch.count()).toBe(1);
  });

  it('bridges an imported upload through the existing controlled Job to one ReviewBatch with zero formal writes', async () => {
    const enabled = await test.app.inject({
      method: 'PUT',
      url: '/api/agent-jobs/post_meeting_extract/control',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-upload-job-control',
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
    const imported = await request({
      key: 'saas-203-upload-e2e-import',
      body: '会后记录：李经理负责技术评估。所有机器结论必须等待人工确认。',
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const source = imported.json().source;

    const run = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-upload-e2e-run',
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
      replayed: false,
      run: {
        status: 'succeeded',
        outputRefs: [{ kind: 'review_batch', id: batchId, version: 0 }],
      },
    });
    expect(run.body).not.toContain('李经理负责技术评估。');
    await expect(test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } }))
      .resolves.toMatchObject({
        sourceArtifactId: source.id,
        accountId: customerId,
        matterId,
        status: 'pending',
        aclVersion: source.aclVersion,
        version: 0,
      });
    await expect(test.prisma.candidate.findMany()).resolves.toMatchObject([{
      kind: 'person_create',
      status: 'pending',
      sourceArtifactId: source.id,
      reviewBatchId: batchId,
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: source.aclVersion,
    }]);
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
    expect(persisted).not.toContain('李经理负责技术评估。');
    expect(persisted).not.toContain('TEST_MODEL_KEY_NOT_PERSISTED');

    const remount = await test.app.inject({
      method: 'PATCH',
      url: `/api/source-artifacts/${source.id}/mount`,
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-anchored-remount',
      },
      payload: { accountId: customerId, matterId: null, expectedAclVersion: source.aclVersion },
    });
    const reshare = await test.app.inject({
      method: 'PUT',
      url: `/api/source-artifacts/${source.id}/visibility`,
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-anchored-visibility',
      },
      payload: { visibility: 'matter_shared', expectedAclVersion: source.aclVersion },
    });
    expect(remount.statusCode).toBe(409);
    expect(reshare.statusCode).toBe(409);
    expect(remount.json()).toMatchObject({ code: 'source_artifact_review_batch_locked' });
    expect(reshare.json()).toMatchObject({ code: 'source_artifact_review_batch_locked' });

    const degraded = await test.app.inject({
      method: 'POST',
      url: `/api/source-artifacts/${source.id}/degrade`,
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-anchored-degrade',
      },
      payload: { expectedAclVersion: source.aclVersion },
    });
    expect(degraded.statusCode, degraded.body).toBe(200);
    expect(degraded.json()).toMatchObject({
      retentionState: 'degraded', contentAvailable: false, backingPresent: true,
    });
    const retryUnavailable = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-upload-e2e-run-after-degrade',
      },
      payload: {
        jobVersion: 'core-206.v1', customerId, matterId, sourceArtifactId: source.id,
        inputRefs: [
          { kind: 'customer', id: customerId, version: formalBefore.customer.version },
          { kind: 'matter', id: matterId, version: formalBefore.matter.version },
          { kind: 'source_artifact', id: source.id, version: source.version },
        ],
      },
    });
    expect(retryUnavailable.statusCode, retryUnavailable.body).toBe(200);
    expect(retryUnavailable.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'post_meeting_source_unavailable' },
    });
    expect(await test.prisma.reviewBatch.count()).toBe(1);
    expect(await test.prisma.candidate.count()).toBe(1);

    const deleted = await test.app.inject({
      method: 'DELETE',
      url: `/api/source-artifacts/${source.id}`,
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'saas-203-anchored-delete',
      },
      payload: { expectedAclVersion: source.aclVersion },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({
      retentionState: 'deleted', contentAvailable: false, backingPresent: false,
    });
    expect(await test.prisma.transcript.count()).toBe(0);
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: source.id } }))
      .resolves.toMatchObject({ retentionState: 'deleted' });
    await expect(test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } }))
      .resolves.toMatchObject({ sourceArtifactId: source.id, status: 'pending' });
    await expect(test.prisma.candidate.findFirstOrThrow())
      .resolves.toMatchObject({ sourceArtifactId: source.id, reviewBatchId: batchId });
  });
});

describe('SAAS-203 lightweight import boundary', () => {
  it('contains no legacy extract/search path or formal CRM writer in the new flow', () => {
    const sources = [
      '../src/postMeeting/importRoutes.ts',
      '../src/postMeeting/importService.ts',
      '../src/postMeeting/upload.ts',
      '../src/postMeeting/feishuImport.ts',
      '../../app/src/lib/postMeetingImport.ts',
      '../../app/src/components/PostMeetingSourceImport.tsx',
      '../../app/src/components/PostMeetingReviewPanel.tsx',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
    const apiSource = readFileSync(new URL('../../app/src/api.ts', import.meta.url), 'utf8');
    const importApiStart = apiSource.indexOf('postMeetingImportUpload:');
    const importApiEnd = apiSource.indexOf('postMeetingReview:', importApiStart);
    expect(importApiStart).toBeGreaterThan(0);
    expect(importApiEnd).toBeGreaterThan(importApiStart);
    sources.push(apiSource.slice(importApiStart, importApiEnd));

    const productionFlow = sources.join('\n');
    for (const forbidden of [
      '/api/recording/extract',
      'extractTranscript',
      'prepareVoiceIngest',
      'searchFeishuMinutes',
      'prisma.account.create',
      'prisma.account.update',
      'prisma.opportunity.update',
      'prisma.person.create',
      'prisma.edge.create',
      'prisma.evidenceEvent.create',
      'prisma.planAction.create',
      'prisma.interaction.create',
    ]) {
      expect(productionFlow).not.toContain(forbidden);
    }
  });
});
