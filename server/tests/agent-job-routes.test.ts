import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import {
  AgentPreparationError,
  type AgentCandidateCommitAdapter,
  type AgentJobHandler,
} from '../src/agents/model.js';
import { reportAgentJobMigration } from '../src/agents/migration.js';
import { createPersonCandidate } from '../src/candidates/personRelation.js';
import { createReviewBatch } from '../src/reviewBatches/service.js';
import { ensureSourceArtifactForTranscript } from '../src/sourceArtifacts/service.js';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const jobKey = 'pre_meeting_brief';
const jobVersion = 'core-206.v1';
const handlerKey = `${jobKey}@${jobVersion}`;

describe('CORE-206 controlled Agent Job routes', () => {
  let test: TestContext | null = null;
  const auth = (token: string, key?: string) => ({
    authorization: `Bearer ${token}`,
    ...(key ? { 'idempotency-key': key } : {}),
  });

  afterEach(async () => test?.cleanup());

  async function setup(
    handler?: unknown,
    registrationKey = handlerKey,
    candidateCommitAdapter?: AgentCandidateCommitAdapter,
  ) {
    test = await createTestContext({
      ...(handler ? { agentHandlers: { [registrationKey]: handler as AgentJobHandler } } : {}),
      ...(candidateCommitAdapter ? { agentCandidateCommitAdapter: candidateCommitAdapter } : {}),
    });
    await test.prisma.account.create({ data: {
      id: 'agent-account', tenantId: test.tenant.id, name: 'Agent account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'agent-matter', tenantId: test.tenant.id, accountId: 'agent-account',
      name: 'Agent matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    const sourceResponse = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, `agent-source-${randomUUID()}`),
      payload: {
        source: 'agent-test', externalRef: `agent-source-${randomUUID()}`,
        title: 'Private source title', matterId: 'agent-matter',
        occurredAt: '2026-08-25T18:00:00.000Z',
      },
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(200);
    const source = sourceResponse.json<{ id: string; aclVersion: number; sourceFingerprint: string }>();
    const storedSource = await test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: source.id } });
    return { source: { ...source, sourceFingerprint: storedSource.sourceFingerprint } };
  }

  async function enable(limits?: { maxCostUnits: number; timeoutMs: number; maxAttempts: number }) {
    const response = await test!.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${jobKey}/control`,
      headers: auth(test!.token, `agent-control-${randomUUID()}`),
      payload: { jobVersion, enabled: true, expectedVersion: 0, ...(limits ? { limits } : {}) },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ enabled: boolean; controlVersion: number }>();
  }

  function runPayload(sourceId: string, sourceVersion: number) {
    return {
      jobVersion,
      customerId: 'agent-account',
      matterId: 'agent-matter',
      sourceArtifactId: sourceId,
      inputRefs: [
        { kind: 'customer', id: 'agent-account', version: 0 },
        { kind: 'matter', id: 'agent-matter', version: 0 },
        { kind: 'source_artifact', id: sourceId, version: sourceVersion },
      ],
    };
  }

  it('lists exactly three default-disabled cards without creating control rows', async () => {
    await setup();
    const response = await test!.app.inject({
      method: 'GET', url: '/api/agent-jobs', headers: auth(test!.token),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ items: Array<Record<string, unknown>> }>().items).toMatchObject([
      { jobKey: 'pre_meeting_brief', available: false, enabled: false, controlState: 'missing', controlVersion: 0 },
      { jobKey: 'post_meeting_extract', available: true, enabled: false, controlState: 'missing', controlVersion: 0 },
      { jobKey: 'relationship_radar', available: false, enabled: false, controlState: 'missing', controlVersion: 0 },
    ]);
    await expect(test!.prisma.agentJobDefinition.count()).resolves.toBe(0);
    await expect(test!.prisma.agentRun.count()).resolves.toBe(0);
  });

  it('rejects a stale token whose current tenant actor no longer exists', async () => {
    await setup();
    await test!.prisma.user.delete({ where: { id: test!.owner.id } });
    const response = await test!.app.inject({
      method: 'GET', url: '/api/agent-jobs', headers: auth(test!.token),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    await expect(test!.prisma.agentJobDefinition.count()).resolves.toBe(0);
  });

  it('rejects enabling an unavailable production card and leaves it missing', async () => {
    await setup();
    const response = await test!.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${jobKey}/control`,
      headers: auth(test!.token, 'agent-unavailable-control'),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'agent_job_unavailable' });
    await expect(test!.prisma.agentJobDefinition.count()).resolves.toBe(0);
  });

  it('rejects viewer controls and runs before CommandRun, AgentRun, or AuditEvent writes', async () => {
    const { source } = await setup({
      prepare: async () => ({ costUnits: 1, evidenceRefs: [], outputRefs: [] }),
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    const viewer = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    const token = test!.app.jwt.sign({ userId: viewer.id, tenantId: test!.tenant.id, role: 'viewer' });
    const before = await Promise.all([
      test!.prisma.agentJobDefinition.count(), test!.prisma.agentRun.count(),
      test!.prisma.commandRun.count(), test!.prisma.auditEvent.count(),
    ]);
    const control = await test!.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${jobKey}/control`,
      headers: auth(token, 'agent-viewer-control'),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    const run = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(token, 'agent-viewer-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(control.statusCode).toBe(403);
    expect(run.statusCode).toBe(403);
    await expect(Promise.all([
      test!.prisma.agentJobDefinition.count(), test!.prisma.agentRun.count(),
      test!.prisma.commandRun.count(), test!.prisma.auditEvent.count(),
    ])).resolves.toEqual(before);
  });

  it('runs one body-free read-only handler and safely replays the exact idempotency key', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let prepareCalls = 0;
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        prepareCalls += 1;
        return {
          costUnits: 7,
          evidenceRefs: [{
            sourceArtifactId: sourceId,
            locatorId: 'segment-1',
            sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: 'brief-1', version: 0 }],
        };
      },
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();
    const key = 'agent-run-replay-key';
    const request = {
      method: 'POST' as const, url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, key), payload: runPayload(source.id, source.aclVersion),
    };
    const first = await test!.app.inject(request);
    const second = await test!.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false, run: { status: 'succeeded', costUsed: 7 } });
    expect(second.json()).toMatchObject({ replayed: true, run: { status: 'succeeded', costUsed: 7 } });
    expect(first.body).not.toContain('Private source title');
    expect(prepareCalls).toBe(1);
    expect(commitCalls).toBe(1);
    await expect(test!.prisma.agentRun.count()).resolves.toBe(1);
    await expect(test!.prisma.commandRun.count({ where: { kind: `agent-job-run:${jobKey}:${jobVersion}` } }))
      .resolves.toBe(1);
    await expect(reportAgentJobMigration(test!.prisma)).resolves.toMatchObject({
      ok: true, definitions: 1, runs: 1, conflicts: [],
    });
  });

  it('does not duplicate a concurrently executing idempotent run', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let prepareCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        prepareCalls += 1;
        enteredResolve?.();
        await release;
        return {
          costUnits: 1,
          evidenceRefs: [{
            sourceArtifactId: sourceId, locatorId: 'segment-concurrent', sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: 'brief-concurrent', version: 0 }],
        };
      },
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();
    const request = {
      method: 'POST' as const, url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-concurrent-run'),
      payload: runPayload(source.id, source.aclVersion),
    };
    const firstPromise = test!.app.inject(request);
    await entered;
    const concurrent = await test!.app.inject(request);
    expect(concurrent.statusCode).toBe(409);
    releaseResolve?.();
    const first = await firstPromise;
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ run: { status: 'succeeded' } });
    expect(prepareCalls).toBe(1);
    await expect(test!.prisma.agentRun.count()).resolves.toBe(1);
  });

  it('reauthorizes and safely reclaims an expired AgentRun lease', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let prepareCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        prepareCalls += 1;
        return {
          costUnits: 1,
          evidenceRefs: [{
            sourceArtifactId: sourceId, locatorId: `segment-lease-${prepareCalls}`, sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: `brief-lease-${prepareCalls}`, version: 0 }],
        };
      },
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();
    const request = {
      method: 'POST' as const, url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-expired-lease-run'),
      payload: runPayload(source.id, source.aclVersion),
    };
    const first = await test!.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    const firstRun = first.json<{ run: { id: string } }>().run;
    await test!.prisma.agentRun.update({
      where: { id: firstRun.id },
      data: {
        status: 'running', failureCode: '', completedAt: null,
        leaseToken: 'expired-agent-lease', leaseExpiresAt: new Date(0),
      },
    });
    await test!.prisma.commandRun.updateMany({
      where: { kind: `agent-job-run:${jobKey}:${jobVersion}` },
      data: { status: 'failed', errorCode: 'injected_crash', leaseToken: '', leaseExpiresAt: null },
    });
    const reclaimed = await test!.app.inject(request);
    expect(reclaimed.statusCode, reclaimed.body).toBe(200);
    expect(reclaimed.json()).toMatchObject({
      run: { id: firstRun.id, status: 'succeeded', attemptCount: 2 },
    });
    expect(prepareCalls).toBe(2);
    await expect(test!.prisma.agentRun.count()).resolves.toBe(1);
  });

  it('uses control CAS and transport idempotency without creating another definition version', async () => {
    await setup({
      prepare: async () => ({ costUnits: 1, evidenceRefs: [], outputRefs: [] }),
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    const request = {
      method: 'PUT' as const,
      url: `/api/agent-jobs/${jobKey}/control`,
      headers: auth(test!.token, 'agent-control-replay-key'),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    };
    const first = await test!.app.inject(request);
    const replay = await test!.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(first.json()).toMatchObject({ controlVersion: 1, enabled: true, replayed: false });
    expect(replay.json()).toMatchObject({ controlVersion: 1, enabled: true, replayed: true });
    await expect(test!.prisma.agentJobDefinition.count()).resolves.toBe(1);
    await expect(test!.prisma.agentJobDefinition.findFirstOrThrow()).resolves.toMatchObject({ version: 1 });

    const changedReplay = await test!.app.inject({
      ...request,
      payload: { jobVersion, enabled: false, expectedVersion: 0 },
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({ code: 'idempotency_key_reused' });
    const stale = await test!.app.inject({
      ...request,
      headers: auth(test!.token, 'agent-control-stale-key'),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'agent_control_conflict' });
  });

  it('does not let HTTP select an action mode, model, handler, output, or budget', async () => {
    let prepareCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        prepareCalls += 1;
        return { costUnits: 1, evidenceRefs: [], outputRefs: [] };
      },
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    await enable();
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-client-authority'),
      payload: {
        ...runPayload(source.id, source.aclVersion),
        actionMode: 'candidate',
        modelRef: 'attacker-model',
        handler: 'tenant-script',
        outputRefs: [{ kind: 'review_batch', id: 'batch-1', version: 0 }],
        budgetLimit: 1_000_000,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'agent_run_input_invalid' });
    expect(prepareCalls).toBe(0);
    await expect(test!.prisma.agentRun.count()).resolves.toBe(0);
  });

  it('retries only declared retryable preparation failures within the fixed attempt bound', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let attempts = 0;
    const { source } = await setup({
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AgentPreparationError('provider_temporarily_unavailable', {
            retryable: true,
            costUnits: 3,
          });
        }
        return {
          costUnits: 4,
          evidenceRefs: [{
            sourceArtifactId: sourceId, locatorId: 'segment-retry', sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: 'brief-retry', version: 0 }],
        };
      },
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable({ maxCostUnits: 100, timeoutMs: 1_000, maxAttempts: 2 });
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-retry-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'succeeded', attemptCount: 2, costUsed: 7, maxAttempts: 2 },
    });
    expect(attempts).toBe(2);
  });

  it('fails over-budget output before the commit adapter', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => ({
        costUnits: 101,
        evidenceRefs: [{
          sourceArtifactId: sourceId, locatorId: 'segment-budget', sourceFingerprint,
          observedAt: '2026-08-25T18:00:00.000Z',
        }],
        outputRefs: [{ kind: 'review_batch', id: 'batch-forbidden', version: 0 }],
      }),
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable({ maxCostUnits: 100, timeoutMs: 1_000, maxAttempts: 1 });
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-budget-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_budget_exceeded', costUsed: 0 },
    });
    expect(commitCalls).toBe(0);
  });

  it('rejects a candidate output from a read-only job before the commit adapter', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => ({
        costUnits: 1,
        evidenceRefs: [{
          sourceArtifactId: sourceId, locatorId: 'segment-forbidden', sourceFingerprint,
          observedAt: '2026-08-25T18:00:00.000Z',
        }],
        outputRefs: [{ kind: 'review_batch', id: 'batch-forbidden', version: 0 }],
      }),
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable({ maxCostUnits: 100, timeoutMs: 1_000, maxAttempts: 1 });
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-forbidden-output-run'),
      payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_output_forbidden' },
    });
    expect(commitCalls).toBe(0);
  });

  it('allows candidate mode to finish only with a current reviewable ReviewBatch reference', async () => {
    const candidateJobKey = 'post_meeting_extract';
    const candidateHandlerKey = `${candidateJobKey}@${jobVersion}`;
    let sourceId = '';
    let sourceFingerprint = '';
    let outputBatchId = 'missing-review-batch';
    let outputBatchVersion = 0;
    let commitCalls = 0;
    await setup({
      prepare: async () => ({
        costUnits: 5,
        evidenceRefs: [{
          sourceArtifactId: sourceId,
          locatorId: 'meeting-segment-1',
          sourceFingerprint,
          observedAt: '2026-08-25T18:00:00.000Z',
        }],
        outputRefs: [{ kind: 'review_batch', id: outputBatchId, version: outputBatchVersion }],
      }),
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    }, candidateHandlerKey);
    await test!.prisma.transcript.create({ data: {
      id: 'agent-candidate-transcript',
      tenantId: test!.tenant.id,
      accountId: 'agent-account',
      opportunityId: 'agent-matter',
      source: 'manual',
      externalRef: 'agent-candidate-transcript',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test!.owner.id)}`,
      title: 'Candidate source title',
      contentEnc: 'encrypted-meeting-body',
      status: 'active',
      createdBy: test!.owner.id,
      createdByUserId: test!.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForTranscript(
      test!.prisma, test!.tenant.id, 'agent-candidate-transcript',
    );
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    const enabled = await test!.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${candidateJobKey}/control`,
      headers: auth(test!.token, 'agent-candidate-control'),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const payload = {
      jobVersion,
      customerId: 'agent-account',
      matterId: 'agent-matter',
      sourceArtifactId: source.id,
      inputRefs: [
        { kind: 'customer', id: 'agent-account', version: 0 },
        { kind: 'matter', id: 'agent-matter', version: 0 },
        { kind: 'source_artifact', id: source.id, version: source.aclVersion },
      ],
    };
    const missing = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${candidateJobKey}/runs`,
      headers: auth(test!.token, 'agent-candidate-missing-batch'), payload,
    });
    expect(missing.statusCode, missing.body).toBe(200);
    expect(missing.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_output_invalid' },
    });
    expect(commitCalls).toBe(1);

    await test!.prisma.transcript.create({ data: {
      id: 'agent-other-transcript',
      tenantId: test!.tenant.id,
      accountId: 'agent-account',
      opportunityId: 'agent-matter',
      source: 'manual',
      externalRef: 'agent-other-transcript',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test!.owner.id)}`,
      title: 'Other candidate source',
      contentEnc: 'encrypted-other-meeting-body',
      status: 'active',
      createdBy: test!.owner.id,
      createdByUserId: test!.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    const otherSource = await ensureSourceArtifactForTranscript(
      test!.prisma, test!.tenant.id, 'agent-other-transcript',
    );
    const otherCandidate = await createPersonCandidate(test!.prisma, {
      id: 'agent-other-candidate-person',
      tenantId: test!.tenant.id,
      accountId: 'agent-account',
      matterId: 'agent-matter',
      name: 'Other candidate person',
      title: 'Other decision maker',
      source: 'agent-test',
      sourceRef: 'agent:test:other-candidate',
      evidence: 'other private candidate evidence',
      confidence: 0.8,
      createdByUserId: test!.owner.id,
      dedupeKey: 'agent-other-candidate-person-dedupe',
    });
    await test!.prisma.candidate.update({
      where: { id: otherCandidate.candidateId }, data: { sourceArtifactId: otherSource.id },
    });
    const otherBatchResponse = await test!.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(test!.token, 'agent-other-review-batch'),
      payload: {
        sourceArtifactId: otherSource.id,
        expectedSourceAclVersion: otherSource.aclVersion,
        candidates: [{
          id: otherCandidate.candidateId,
          expectedVersion: otherCandidate.candidateVersion,
          expectedAclVersion: otherSource.aclVersion,
        }],
      },
    });
    expect(otherBatchResponse.statusCode, otherBatchResponse.body).toBe(200);
    const otherBatch = otherBatchResponse.json<{ id: string; version: number }>();
    const beforeMixedSource = await Promise.all([
      test!.prisma.agentRun.count(), test!.prisma.commandRun.count(), test!.prisma.auditEvent.count(),
    ]);
    const mixedSource = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${candidateJobKey}/runs`,
      headers: auth(test!.token, 'agent-candidate-mixed-source'),
      payload: {
        ...payload,
        inputRefs: [
          ...payload.inputRefs,
          { kind: 'source_artifact', id: otherSource.id, version: otherSource.aclVersion },
        ],
      },
    });
    expect(mixedSource.statusCode, mixedSource.body).toBe(400);
    expect(mixedSource.json()).toMatchObject({ code: 'agent_scope_invalid' });
    await expect(Promise.all([
      test!.prisma.agentRun.count(), test!.prisma.commandRun.count(), test!.prisma.auditEvent.count(),
    ])).resolves.toEqual(beforeMixedSource);

    outputBatchId = otherBatch.id;
    outputBatchVersion = otherBatch.version;
    const wrongAnchor = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${candidateJobKey}/runs`,
      headers: auth(test!.token, 'agent-candidate-wrong-batch-anchor'), payload,
    });
    expect(wrongAnchor.statusCode, wrongAnchor.body).toBe(200);
    expect(wrongAnchor.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_output_invalid' },
    });
    expect(commitCalls).toBe(2);

    const candidate = await createPersonCandidate(test!.prisma, {
      id: 'agent-candidate-person',
      tenantId: test!.tenant.id,
      accountId: 'agent-account',
      matterId: 'agent-matter',
      name: 'Candidate person',
      title: 'Decision maker',
      source: 'agent-test',
      sourceRef: 'agent:test:candidate',
      evidence: 'private candidate evidence',
      confidence: 0.8,
      createdByUserId: test!.owner.id,
      dedupeKey: 'agent-candidate-person-dedupe',
    });
    await test!.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { sourceArtifactId: source.id },
    });
    const batchResponse = await test!.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(test!.token, 'agent-candidate-review-batch'),
      payload: {
        sourceArtifactId: source.id,
        expectedSourceAclVersion: source.aclVersion,
        candidates: [{
          id: candidate.candidateId,
          expectedVersion: candidate.candidateVersion,
          expectedAclVersion: source.aclVersion,
        }],
      },
    });
    expect(batchResponse.statusCode, batchResponse.body).toBe(200);
    const batch = batchResponse.json<{ id: string; version: number }>();
    outputBatchId = batch.id;
    outputBatchVersion = batch.version;
    const formalBefore = await Promise.all([
      test!.prisma.person.count(), test!.prisma.edge.count(),
      test!.prisma.planAction.count(), test!.prisma.interaction.count(),
    ]);
    const valid = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${candidateJobKey}/runs`,
      headers: auth(test!.token, 'agent-candidate-valid-batch'), payload,
    });
    expect(valid.statusCode, valid.body).toBe(200);
    const validReceipt = valid.json<{ run: { id: string } }>();
    expect(validReceipt).toMatchObject({
      run: {
        status: 'succeeded',
        outputRefs: [{ kind: 'review_batch', id: batch.id, version: batch.version }],
      },
    });
    expect(commitCalls).toBe(3);
    await expect(Promise.all([
      test!.prisma.person.count(), test!.prisma.edge.count(),
      test!.prisma.planAction.count(), test!.prisma.interaction.count(),
    ])).resolves.toEqual(formalBefore);

    await test!.prisma.agentRun.update({
      where: { id: validReceipt.run.id },
      data: {
        outputRefs: JSON.stringify([{
          kind: 'review_batch', id: otherBatch.id, version: otherBatch.version,
        }]),
      },
    });
    const wrongHistoryAnchor = await test!.app.inject({
      method: 'GET', url: `/api/agent-runs/${validReceipt.run.id}`, headers: auth(test!.token),
    });
    expect(wrongHistoryAnchor.statusCode, wrongHistoryAnchor.body).toBe(404);
    await test!.prisma.agentRun.update({
      where: { id: validReceipt.run.id },
      data: {
        outputRefs: JSON.stringify([{
          kind: 'review_batch', id: batch.id, version: batch.version,
        }]),
      },
    });
    await test!.prisma.agentRun.update({
      where: { id: validReceipt.run.id },
      data: {
        inputRefs: JSON.stringify([
          ...payload.inputRefs,
          { kind: 'source_artifact', id: otherSource.id, version: otherSource.aclVersion },
        ]),
      },
    });
    const mixedSourceReport = await reportAgentJobMigration(test!.prisma);
    expect(mixedSourceReport.ok).toBe(false);
    expect(mixedSourceReport.conflicts).toContain(
      `${test!.tenant.id}:agent_run:${validReceipt.run.id}:references_invalid`,
    );
    await test!.prisma.agentRun.update({
      where: { id: validReceipt.run.id },
      data: { inputRefs: JSON.stringify(payload.inputRefs) },
    });
    await expect(reportAgentJobMigration(test!.prisma)).resolves.toMatchObject({
      ok: true, definitions: 1, runs: 3, conflicts: [],
    });
  });

  it('rejects an out-of-scope member before any run transport or audit side effect', async () => {
    const { source } = await setup({
      prepare: async () => ({ costUnits: 1, evidenceRefs: [], outputRefs: [] }),
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    await enable();
    await test!.prisma.tenant.update({ where: { id: test!.tenant.id }, data: { dataScopePolicy: 'scoped' } });
    const member = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `member-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Member', role: 'member',
    } });
    const token = test!.app.jwt.sign({ userId: member.id, tenantId: test!.tenant.id, role: 'member' });
    const before = await Promise.all([
      test!.prisma.agentRun.count(), test!.prisma.commandRun.count(), test!.prisma.auditEvent.count(),
    ]);
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(token, 'agent-member-hidden-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode).toBe(404);
    await expect(Promise.all([
      test!.prisma.agentRun.count(), test!.prisma.commandRun.count(), test!.prisma.auditEvent.count(),
    ])).resolves.toEqual(before);
  });

  it('times out preparation with a stable failure and never invokes the commit adapter', async () => {
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => new Promise((resolve) => {
        setTimeout(() => resolve({ costUnits: 1, evidenceRefs: [], outputRefs: [] }), 100);
      }),
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    });
    await enable({ maxCostUnits: 100, timeoutMs: 25, maxAttempts: 1 });
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-timeout-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      replayed: false,
      run: { status: 'failed', failureCode: 'agent_timeout', attemptCount: 1 },
    });
    expect(commitCalls).toBe(0);
  });

  it('bounds the trusted commit adapter by the same attempt deadline', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => ({
        costUnits: 1,
        evidenceRefs: [{
          sourceArtifactId: sourceId, locatorId: 'segment-commit-timeout', sourceFingerprint,
          observedAt: '2026-08-25T18:00:00.000Z',
        }],
        outputRefs: [{ kind: 'research_brief', id: 'brief-commit-timeout', version: 0 }],
      }),
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return prepared;
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable({ maxCostUnits: 100, timeoutMs: 25, maxAttempts: 1 });
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-commit-timeout-run'),
      payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_timeout', attemptCount: 1 },
    });
    expect(commitCalls).toBe(1);
  });

  it('passes request-local private preparation state to commit without persisting, returning, auditing, or logging it', async () => {
    const privateMarker = 'PRIVATE_SOURCE_BODY_MUST_NEVER_ESCAPE';
    let sourceId = '';
    let sourceFingerprint = '';
    let committedPrivateState: unknown;
    const consoleOutput: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((method) => (
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map(String).join(' '));
      })
    ));
    try {
      const { source } = await setup({
        prepare: async () => ({
          audit: {
            costUnits: 3,
            evidenceRefs: [{
              sourceArtifactId: sourceId,
              locatorId: 'segment-private-envelope',
              sourceFingerprint,
              observedAt: '2026-08-25T18:00:00.000Z',
            }],
            outputRefs: [{ kind: 'research_brief', id: 'brief-private-envelope', version: 0 }],
          },
          privateState: { sourceBody: privateMarker, providerToken: `${privateMarker}-token` },
        }),
        commit: async (_context: unknown, prepared: unknown, privateState: unknown) => {
          committedPrivateState = privateState;
          return prepared;
        },
      });
      sourceId = source.id;
      sourceFingerprint = source.sourceFingerprint;
      await enable();

      const response = await test!.app.inject({
        method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
        headers: auth(test!.token, 'agent-private-envelope-run'),
        payload: runPayload(source.id, source.aclVersion),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ run: { status: 'succeeded', costUsed: 3 } });
      expect(committedPrivateState).toEqual({
        sourceBody: privateMarker,
        providerToken: `${privateMarker}-token`,
      });

      const [run, audits] = await Promise.all([
        test!.prisma.agentRun.findFirstOrThrow({ where: { tenantId: test!.tenant.id } }),
        test!.prisma.auditEvent.findMany({ where: { tenantId: test!.tenant.id } }),
      ]);
      expect(JSON.stringify({ response: response.json(), run, audits })).not.toContain(privateMarker);
      expect(consoleOutput.join('\n')).not.toContain(privateMarker);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('fails closed on malformed private envelopes and commit-time audit mutation', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let mode: 'malformed' | 'mutated' = 'malformed';
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        const audit = {
          costUnits: 1,
          evidenceRefs: [{
            sourceArtifactId: sourceId,
            locatorId: 'segment-envelope-fail-closed',
            sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: 'brief-envelope-fail-closed', version: 0 }],
        };
        return mode === 'malformed'
          ? { audit, privateState: { sourceBody: 'private' }, unexpected: true }
          : { audit, privateState: { sourceBody: 'private' } };
      },
      commit: async (_context: unknown, prepared: any) => {
        commitCalls += 1;
        return { ...prepared, costUnits: prepared.costUnits + 1 };
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();

    const malformed = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-malformed-envelope-run'),
      payload: runPayload(source.id, source.aclVersion),
    });
    expect(malformed.statusCode, malformed.body).toBe(200);
    expect(malformed.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_output_invalid' },
    });
    expect(commitCalls).toBe(0);

    mode = 'mutated';
    const mutated = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-mutated-envelope-run'),
      payload: runPayload(source.id, source.aclVersion),
    });
    expect(mutated.statusCode, mutated.body).toBe(200);
    expect(mutated.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'agent_commit_contract_invalid' },
    });
    expect(commitCalls).toBe(1);
  });

  it('fails closed on malformed, mismatched, or multiply-used candidate commit ports', async () => {
    const candidateJobKey = 'post_meeting_extract';
    const candidateHandlerKey = `${candidateJobKey}@${jobVersion}`;
    const outputBatchId = 'review-batch-port-negative';
    let sourceId = '';
    let sourceFingerprint = '';
    let mode: 'malformed' | 'evidence' | 'mismatch' | 'twice' = 'malformed';
    let adapterCalls = 0;
    const adapter: AgentCandidateCommitAdapter = async () => {
      adapterCalls += 1;
      return mode === 'mismatch'
        ? { kind: 'review_batch', id: 'wrong-review-batch', version: 0 }
        : { kind: 'review_batch', id: outputBatchId, version: 0 };
    };
    await setup({
      prepare: async () => ({
        audit: {
          costUnits: 1,
          evidenceRefs: [{
            sourceArtifactId: sourceId,
            locatorId: 'segment-port-negative',
            sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'review_batch', id: outputBatchId, version: 0 }],
        },
        privateState: mode === 'malformed'
          ? { customerId: 'other-customer', matterId: 'agent-matter', sourceArtifactId: sourceId, items: [] }
          : {
              customerId: 'agent-account',
              matterId: 'agent-matter',
              sourceArtifactId: sourceId,
              items: [{
                kind: 'person', itemRef: 'person-port-negative',
                sourceLocator: mode === 'evidence' ? 'different-segment' : 'segment-port-negative',
                sourceQuote: '候选原句', confidence: 0.8,
                person: { name: '候选人物', title: null },
              }],
            },
      }),
      commit: async (context: any, prepared: any, privateState: unknown) => {
        await context.commitCandidateBatch(privateState);
        if (mode === 'twice') await context.commitCandidateBatch(privateState);
        return prepared;
      },
    }, candidateHandlerKey, adapter);
    await test!.prisma.transcript.create({ data: {
      id: 'agent-port-negative-transcript',
      tenantId: test!.tenant.id,
      accountId: 'agent-account',
      opportunityId: 'agent-matter',
      source: 'manual',
      externalRef: 'agent-port-negative-transcript',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test!.owner.id)}`,
      title: 'Negative port source',
      contentEnc: 'encrypted-negative-port-body',
      status: 'active',
      createdBy: test!.owner.id,
      createdByUserId: test!.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForTranscript(
      test!.prisma, test!.tenant.id, 'agent-port-negative-transcript',
    );
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    const enabled = await test!.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${candidateJobKey}/control`,
      headers: auth(test!.token, 'agent-port-negative-control'),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const payload = {
      jobVersion,
      customerId: 'agent-account',
      matterId: 'agent-matter',
      sourceArtifactId: source.id,
      inputRefs: [
        { kind: 'customer', id: 'agent-account', version: 0 },
        { kind: 'matter', id: 'agent-matter', version: 0 },
        { kind: 'source_artifact', id: source.id, version: source.aclVersion },
      ],
    };
    for (const scenario of [
      ['malformed', 'agent_candidate_batch_invalid'],
      ['evidence', 'agent_candidate_evidence_mismatch'],
      ['mismatch', 'agent_candidate_output_mismatch'],
      ['twice', 'agent_candidate_port_misuse'],
    ] as const) {
      mode = scenario[0];
      const response = await test!.app.inject({
        method: 'POST', url: `/api/agent-jobs/${candidateJobKey}/runs`,
        headers: auth(test!.token, `agent-port-negative-${mode}`), payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        run: { status: 'failed', failureCode: scenario[1] },
      });
    }
    expect(adapterCalls).toBe(2);
    await expect(test!.prisma.reviewBatch.count()).resolves.toBe(0);
    await expect(test!.prisma.candidate.count()).resolves.toBe(0);
  });

  it('creates candidate output only through the transaction-bound narrow port after preparation', async () => {
    const candidateJobKey = 'post_meeting_extract';
    const candidateHandlerKey = `${candidateJobKey}@${jobVersion}`;
    const outputBatchId = 'review-batch-narrow-port';
    const sourceQuote = '李经理负责技术评估。';
    const policy = assembleProductAccess({ edition: 'internal' }).policy;
    let sourceId = '';
    let sourceFingerprint = '';
    let commitCalls = 0;
    let adapterCalls = 0;

    const candidateCommitAdapter: AgentCandidateCommitAdapter = async (context, batch) => {
      adapterCalls += 1;
      expect(batch).toMatchObject({
        customerId: 'agent-account', matterId: 'agent-matter', sourceArtifactId: sourceId,
      });
      const item = batch.items[0];
      if (!item || item.kind !== 'person') throw new Error('expected one Person candidate');
      const person = await createPersonCandidate(context.tx, {
        id: 'agent-port-person',
        tenantId: context.tenantId,
        accountId: batch.customerId,
        matterId: batch.matterId,
        name: item.person.name,
        title: item.person.title ?? undefined,
        source: 'post_meeting_extract',
        sourceRef: `${context.runId}:${item.itemRef}`,
        evidence: item.sourceQuote,
        confidence: item.confidence,
        createdByUserId: context.actorId,
        dedupeKey: `${context.runId}:${item.itemRef}`,
      });
      await context.tx.candidate.update({
        where: { id: person.candidateId },
        data: { sourceArtifactId: batch.sourceArtifactId },
      });
      const source = await context.tx.sourceArtifact.findUniqueOrThrow({
        where: { id: batch.sourceArtifactId },
      });
      const view = await createReviewBatch(context.tx, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        actorRole: 'owner',
        channel: 'web',
        requestId: context.requestId ?? context.runId,
        assertionMode: 'user_asserted',
      }, policy, {
        id: outputBatchId,
        sourceArtifactId: batch.sourceArtifactId,
        expectedSourceAclVersion: source.aclVersion,
        candidates: [{
          id: person.candidateId,
          expectedVersion: person.candidateVersion,
          expectedAclVersion: source.aclVersion,
        }],
      });
      return { kind: 'review_batch', id: view.id, version: view.version };
    };

    await setup({
      prepare: async () => ({
        audit: {
          costUnits: 5,
          evidenceRefs: [{
            sourceArtifactId: sourceId,
            locatorId: 'meeting-segment-port',
            sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'review_batch', id: outputBatchId, version: 0 }],
        },
        privateState: {
          customerId: 'agent-account',
          matterId: 'agent-matter',
          sourceArtifactId: sourceId,
          items: [{
            kind: 'person',
            itemRef: 'person-li',
            sourceLocator: 'meeting-segment-port',
            sourceQuote,
            confidence: 0.9,
            person: { name: '李经理', title: '技术负责人' },
          }],
        },
      }),
      commit: async (context: any, prepared: any, privateState: unknown) => {
        commitCalls += 1;
        expect(context).not.toHaveProperty('tx');
        expect(context).not.toHaveProperty('db');
        expect(context).not.toHaveProperty('prisma');
        const output = await context.commitCandidateBatch(privateState);
        expect(output).toEqual(prepared.outputRefs[0]);
        return prepared;
      },
    }, candidateHandlerKey, candidateCommitAdapter);

    await test!.prisma.transcript.create({ data: {
      id: 'agent-port-transcript',
      tenantId: test!.tenant.id,
      accountId: 'agent-account',
      opportunityId: 'agent-matter',
      source: 'manual',
      externalRef: 'agent-port-transcript',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(test!.owner.id)}`,
      title: 'Port source',
      contentEnc: 'encrypted-port-source-body',
      status: 'active',
      createdBy: test!.owner.id,
      createdByUserId: test!.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForTranscript(
      test!.prisma, test!.tenant.id, 'agent-port-transcript',
    );
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    const enabled = await test!.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${candidateJobKey}/control`,
      headers: auth(test!.token, 'agent-port-control'),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const formalBefore = await Promise.all([
      test!.prisma.person.count(), test!.prisma.edge.count(),
      test!.prisma.evidenceEvent.count(), test!.prisma.planAction.count(),
      test!.prisma.interaction.count(),
    ]);
    const request = {
      method: 'POST', url: `/api/agent-jobs/${candidateJobKey}/runs`,
      headers: auth(test!.token, 'agent-narrow-port-run'),
      payload: {
        jobVersion,
        customerId: 'agent-account',
        matterId: 'agent-matter',
        sourceArtifactId: source.id,
        inputRefs: [
          { kind: 'customer', id: 'agent-account', version: 0 },
          { kind: 'matter', id: 'agent-matter', version: 0 },
          { kind: 'source_artifact', id: source.id, version: source.aclVersion },
        ],
      },
    } as const;
    const response = await test!.app.inject(request);
    const replay = await test!.app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: {
        status: 'succeeded',
        outputRefs: [{ kind: 'review_batch', id: outputBatchId, version: 0 }],
      },
    });
    expect(replay.json()).toMatchObject({ replayed: true, run: { status: 'succeeded' } });
    expect(commitCalls).toBe(1);
    expect(adapterCalls).toBe(1);
    await expect(test!.prisma.reviewBatch.count()).resolves.toBe(1);
    await expect(test!.prisma.candidate.count()).resolves.toBe(1);
    await expect(Promise.all([
      test!.prisma.person.count(), test!.prisma.edge.count(),
      test!.prisma.evidenceEvent.count(), test!.prisma.planAction.count(),
      test!.prisma.interaction.count(),
    ])).resolves.toEqual(formalBefore);
  });

  it('discards prepared output when the current role is revoked before commit', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        await test!.prisma.user.update({ where: { id: test!.owner.id }, data: { role: 'viewer' } });
        return {
          costUnits: 1,
          evidenceRefs: [{
            sourceArtifactId: sourceId, locatorId: 'segment-1', sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: 'brief-revoked', version: 0 }],
        };
      },
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-revoked-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'discarded', failureCode: 'agent_authorization_revoked' },
    });
    expect(commitCalls).toBe(0);
  });

  it('discards prepared output when the authorization fingerprint changes before commit', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    let commitCalls = 0;
    const { source } = await setup({
      prepare: async () => {
        await test!.prisma.user.update({ where: { id: test!.owner.id }, data: { role: 'admin' } });
        return {
          costUnits: 1,
          evidenceRefs: [{
            sourceArtifactId: sourceId, locatorId: 'segment-role-change', sourceFingerprint,
            observedAt: '2026-08-25T18:00:00.000Z',
          }],
          outputRefs: [{ kind: 'research_brief', id: 'brief-role-change', version: 0 }],
        };
      },
      commit: async (_context: unknown, prepared: unknown) => {
        commitCalls += 1;
        return prepared;
      },
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();
    const response = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-authorization-fingerprint-change'),
      payload: runPayload(source.id, source.aclVersion),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { status: 'discarded', failureCode: 'agent_authorization_revoked' },
    });
    expect(commitCalls).toBe(0);
  });

  it('filters body-free run history through the current customer scope', async () => {
    let sourceId = '';
    let sourceFingerprint = '';
    const { source } = await setup({
      prepare: async () => ({
        costUnits: 1,
        evidenceRefs: [{
          sourceArtifactId: sourceId, locatorId: 'segment-history', sourceFingerprint,
          observedAt: '2026-08-25T18:00:00.000Z',
        }],
        outputRefs: [{ kind: 'research_brief', id: 'brief-history', version: 0 }],
      }),
      commit: async (_context: unknown, prepared: unknown) => prepared,
    });
    sourceId = source.id;
    sourceFingerprint = source.sourceFingerprint;
    await enable();
    const created = await test!.app.inject({
      method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test!.token, 'agent-history-run'), payload: runPayload(source.id, source.aclVersion),
    });
    expect(created.statusCode, created.body).toBe(200);
    const runId = created.json<{ run: { id: string } }>().run.id;
    for (const key of ['agent-history-run-2', 'agent-history-run-3']) {
      const additional = await test!.app.inject({
        method: 'POST', url: `/api/agent-jobs/${jobKey}/runs`,
        headers: auth(test!.token, key), payload: runPayload(source.id, source.aclVersion),
      });
      expect(additional.statusCode, additional.body).toBe(200);
    }
    const ownerDetail = await test!.app.inject({
      method: 'GET', url: `/api/agent-runs/${runId}`, headers: auth(test!.token),
    });
    expect(ownerDetail.statusCode, ownerDetail.body).toBe(200);
    expect(ownerDetail.body).not.toContain('Private source title');

    await test!.prisma.tenant.update({ where: { id: test!.tenant.id }, data: { dataScopePolicy: 'scoped' } });
    const member = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `history-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'History member', role: 'member',
    } });
    const token = test!.app.jwt.sign({ userId: member.id, tenantId: test!.tenant.id, role: 'member' });
    const accountReads = vi.spyOn(test!.prisma.account, 'findMany');
    const list = await test!.app.inject({
      method: 'GET', url: '/api/agent-runs', headers: auth(token),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ items: [], nextCursor: null });
    expect(accountReads.mock.calls.length).toBeLessThan(3);
    accountReads.mockRestore();
    const detail = await test!.app.inject({
      method: 'GET', url: `/api/agent-runs/${runId}`, headers: auth(token),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'agent_run_not_found' });
  });
});
