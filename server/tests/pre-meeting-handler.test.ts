import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleProductAccess, type ResearchBriefPreparedPayload } from '@jianghu/domain-contracts';
import { dec } from '../src/ai.js';
import type { AgentJobHandler } from '../src/agents/model.js';
import { createPreMeetingHandler } from '../src/preMeeting/handler.js';
import { parsePreMeetingModelResponse } from '../src/preMeeting/model.js';
import { loadPreMeetingSources } from '../src/preMeeting/source.js';
import { prisma } from '../src/prisma.js';
import { researchBriefSnapshotId } from '../src/researchBriefs/service.js';
import { ensureSourceArtifactForNote } from '../src/sourceArtifacts/service.js';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const policy = assembleProductAccess({ edition: 'internal' }).policy;
const jobKey = 'pre_meeting_brief';
const jobVersion = 'core-206.v1';
const handlerKey = `${jobKey}@${jobVersion}`;
const sourceBody = '客户要求下周确认技术评审参会人，预算审批人尚未明确。';
const modelResponse = JSON.stringify({
  sections: [
    {
      key: 'company_overview',
      content: '客户正在推进储能联合开发事项。',
      sourceIds: ['crm-customer', 'crm-matter'],
    },
    {
      key: 'questions_to_verify',
      content: '确认技术评审参会人和预算审批人。',
      sourceIds: ['source-artifact'],
    },
  ],
  unknowns: [{
    key: 'stakeholders',
    reasonCode: 'insufficient_evidence',
    sourceIds: ['source-artifact'],
  }],
});

const auth = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

describe('SAAS-205 production pre-meeting handler and snapshot port', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  async function setup(handler?: AgentJobHandler) {
    const callLLM = vi.fn(async () => modelResponse);
    const productionHandler = createPreMeetingHandler({
      db: prisma,
      policy,
      loadAiConfig: async () => ({
        provider: 'openai-compatible',
        baseUrl: 'https://model.example.test/v1',
        model: 'tenant-model',
        apiKey: 'TEST_PRE_MEETING_KEY_NOT_PERSISTED',
      }),
      callLLM,
    });
    test = await createTestContext({
      agentHandlers: { [handlerKey]: handler ?? productionHandler },
    });
    await test.prisma.account.create({ data: {
      id: 'customer-205', tenantId: test.tenant.id, name: '海岳能源',
      categoryKey: 'strategic', unifiedCreditCode: '91110108SAAS205', version: 4,
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'matter-205', tenantId: test.tenant.id, accountId: 'customer-205',
      name: '储能联合开发', kind: 'sales_opportunity', customerType: 1,
      pipelineStage: 'lead', engageStage: 'discover', priority: 'high',
      targetDate: '2026-10-31', version: 3, primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.note.create({ data: {
      id: 'note-205', tenantId: test.tenant.id, accountId: 'customer-205',
      opportunityId: 'matter-205', content: sourceBody, source: 'manual',
      createdBy: test.owner.id, createdByUserId: test.owner.id,
      visibility: 'private', aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForNote(test.prisma, test.tenant.id, 'note-205');
    const control = await test.app.inject({
      method: 'PUT', url: `/api/agent-jobs/${jobKey}/control`,
      headers: auth(test.token, `pre-meeting-control-${randomUUID()}`),
      payload: { jobVersion, enabled: true, expectedVersion: 0 },
    });
    expect(control.statusCode, control.body).toBe(200);
    const request = {
      method: 'POST' as const,
      url: `/api/agent-jobs/${jobKey}/runs`,
      headers: auth(test.token, 'pre-meeting-run-stable-key'),
      payload: {
        jobVersion,
        customerId: 'customer-205',
        matterId: 'matter-205',
        sourceArtifactId: source.id,
        inputRefs: [
          { kind: 'customer', id: 'customer-205', version: 4 },
          { kind: 'matter', id: 'matter-205', version: 3 },
          { kind: 'source_artifact', id: source.id, version: source.aclVersion },
        ],
      },
    };
    return { source, request, callLLM };
  }

  async function formalState() {
    return Promise.all([
      test!.prisma.account.findMany(), test!.prisma.opportunity.findMany(),
      test!.prisma.person.findMany(), test!.prisma.edge.findMany(),
      test!.prisma.evidenceEvent.findMany(), test!.prisma.planAction.findMany(),
      test!.prisma.interaction.findMany(), test!.prisma.candidate.findMany(),
      test!.prisma.reviewBatch.findMany(), test!.prisma.curatedSummary.findMany(),
    ]);
  }

  it('creates one encrypted immutable brief, replays exactly, and changes no formal CRM state', async () => {
    const { request, callLLM } = await setup();
    const before = await formalState();

    const first = await test!.app.inject(request);
    const second = await test!.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const firstBody = first.json<{ run: { id: string; outputRefs: Array<{ kind: string; id: string; version: number }> }; replayed: boolean }>();
    expect(firstBody).toMatchObject({
      replayed: false,
      run: {
        status: 'succeeded',
        outputRefs: [{ kind: 'research_brief', version: 1 }],
      },
    });
    expect(second.json()).toMatchObject({ replayed: true, run: { status: 'succeeded' } });
    expect(callLLM).toHaveBeenCalledOnce();
    expect(await formalState()).toEqual(before);

    const expectedId = researchBriefSnapshotId(
      test!.tenant.id, test!.owner.id, `agent-run:${firstBody.run.id}`,
    );
    expect(firstBody.run.outputRefs).toEqual([{ kind: 'research_brief', id: expectedId, version: 1 }]);
    const snapshot = await test!.prisma.researchBriefSnapshot.findUniqueOrThrow({ where: { id: expectedId } });
    expect(snapshot).toMatchObject({
      tenantId: test!.tenant.id,
      customerId: 'customer-205',
      matterId: 'matter-205',
      createdByUserId: test!.owner.id,
      version: 1,
    });
    expect(snapshot.payloadEnc).not.toContain('确认技术评审参会人和预算审批人');
    expect(dec(snapshot.payloadEnc)).toContain('确认技术评审参会人和预算审批人');
    expect(first.body).not.toContain(sourceBody);
    expect(first.body).not.toContain('TEST_PRE_MEETING_KEY_NOT_PERSISTED');

    const persistedBodyFree = JSON.stringify({
      runs: await test!.prisma.agentRun.findMany(),
      commands: await test!.prisma.commandRun.findMany(),
      audits: await test!.prisma.auditEvent.findMany(),
    });
    expect(persistedBodyFree).not.toContain(sourceBody);
    expect(persistedBodyFree).not.toContain('确认技术评审参会人和预算审批人');
    expect(persistedBodyFree).not.toContain('TEST_PRE_MEETING_KEY_NOT_PERSISTED');
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(1);
  });

  it('rejects viewer execution before CommandRun, AgentRun, snapshot or audit writes', async () => {
    const { request } = await setup();
    const viewer = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    await test!.prisma.account.update({
      where: { id: 'customer-205' }, data: { primaryOwnerUserId: viewer.id },
    });
    const token = test!.app.jwt.sign({
      userId: viewer.id, tenantId: test!.tenant.id, role: 'viewer',
    });
    const before = await Promise.all([
      test!.prisma.commandRun.count(), test!.prisma.agentRun.count(),
      test!.prisma.researchBriefSnapshot.count(), test!.prisma.auditEvent.count(),
    ]);
    const response = await test!.app.inject({
      ...request,
      headers: auth(token, 'viewer-pre-meeting-run'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'viewer_write_denied' });
    await expect(Promise.all([
      test!.prisma.commandRun.count(), test!.prisma.agentRun.count(),
      test!.prisma.researchBriefSnapshot.count(), test!.prisma.auditEvent.count(),
    ])).resolves.toEqual(before);
  });

  it('uses stable safe failures for absent BYO config and malformed provider output', async () => {
    const absent = createPreMeetingHandler({
      db: prisma, policy, loadAiConfig: async () => null,
      callLLM: vi.fn(async () => modelResponse),
    });
    const first = await setup(absent);
    const missing = await test!.app.inject(first.request);
    expect(missing.statusCode, missing.body).toBe(200);
    expect(missing.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'pre_meeting_ai_not_configured' },
    });
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(0);

    await test!.cleanup();
    test = null;
    const malformed = createPreMeetingHandler({
      db: prisma,
      policy,
      loadAiConfig: async () => ({
        provider: 'openai-compatible', baseUrl: 'https://model.example.test/v1',
        model: 'tenant-model', apiKey: 'TEST_KEY',
      }),
      callLLM: async () => 'not-json',
    });
    const second = await setup(malformed);
    const invalid = await test!.app.inject({
      ...second.request,
      headers: auth(test!.token, 'pre-meeting-malformed-run'),
    });
    expect(invalid.statusCode, invalid.body).toBe(200);
    expect(invalid.json()).toMatchObject({
      run: { status: 'failed', failureCode: 'pre_meeting_model_output_invalid' },
    });
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(0);
  });

  function portProbe(mode: 'missing' | 'duplicate' | 'mismatch'): AgentJobHandler {
    return {
      commitPort: 'research_brief',
      async prepare(context) {
        const generatedAt = new Date();
        const bundle = await loadPreMeetingSources(prisma, policy, {
          tenantId: context.tenantId,
          actorId: context.actorId,
          customerId: context.customerId,
          matterId: context.matterId,
          sourceArtifactId: context.sourceArtifactId!,
          generatedAt,
          inputRefs: context.inputRefs,
        });
        const payload = parsePreMeetingModelResponse(modelResponse, {
          generatedAt,
          modelRef: 'tenant-model',
          subject: bundle.subject,
          sources: bundle.sources,
        });
        const exactId = researchBriefSnapshotId(
          context.tenantId, context.actorId, `agent-run:${context.runId}`,
        );
        return {
          audit: {
            costUnits: 1,
            evidenceRefs: [bundle.evidence],
            outputRefs: [{
              kind: 'research_brief',
              id: mode === 'mismatch' ? 'rbs_wrong_output' : exactId,
              version: 1,
            }],
          },
          privateState: { generatedAt: generatedAt.toISOString(), payload },
        };
      },
      async commit(context, prepared, privateState) {
        if (mode === 'missing') return prepared;
        const input = privateState as { generatedAt: string; payload: ResearchBriefPreparedPayload };
        await context.commitResearchBrief!(input);
        if (mode === 'duplicate') await context.commitResearchBrief!(input);
        return prepared;
      },
    };
  }

  it.each([
    ['missing', 'agent_research_brief_port_misuse'],
    ['duplicate', 'agent_research_brief_port_misuse'],
    ['mismatch', 'agent_research_brief_output_mismatch'],
  ] as const)('rolls back when the one-shot snapshot port is %s', async (mode, code) => {
    const { request } = await setup(portProbe(mode));
    const response = await test!.app.inject({
      ...request,
      headers: auth(test!.token, `pre-meeting-port-${mode}`),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ run: { status: 'failed', failureCode: code } });
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(0);
  });
});
