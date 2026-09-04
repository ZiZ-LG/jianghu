import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunReceiptSchema,
  MatterPortfolioReadModelSchema,
  PostMeetingReviewBatchDetailSchema,
  RelationshipRadarResponseSchema,
  ResearchBriefSnapshotDetailResponseSchema,
  assembleProductAccess,
} from '@jianghu/domain-contracts';
import { dec } from '../src/ai.js';
import { createPostMeetingHandler } from '../src/postMeeting/handler.js';
import { createPreMeetingHandler } from '../src/preMeeting/handler.js';
import { prisma } from '../src/prisma.js';
import { createRelationshipRadarHandler } from '../src/relationshipRadar/handler.js';
import {
  grantCandidateReviewer,
  revokeCandidateReviewer,
} from '../src/sensitiveAcl/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const policy = assembleProductAccess({ edition: 'internal' }).policy;
const customerId = 'g4-cao-customer';
const matterId = 'g4-cao-matter-main';
const matterIds = [
  matterId,
  'g4-cao-matter-two',
  'g4-cao-matter-three',
  'g4-cao-matter-four',
  'g4-cao-matter-five',
] as const;
const occurredAt = '2026-09-01T01:00:00.000Z';
const radarAt = new Date(Date.now() - 60_000).toISOString();
const fixtureApiKey = ['TEST', 'KEY', 'NOT', 'PERSISTED'].join('_');
const uploadBoundary = '----jianghu-saas-211-g4-upload';
const meetingBody = [
  '李经理负责技术评估。',
  '王总负责最终决策。',
  '李经理会向王总汇报方案。',
  '客户明确表示预算审批暂未通过。',
  '曹经理将在下周二确认评审安排。',
].join('\n');

const preMeetingModelResponse = JSON.stringify({
  sections: [{
    key: 'company_overview',
    content: '客户正在推进储能联合开发事项。',
    sourceIds: ['crm-customer', 'crm-matter'],
  }, {
    key: 'questions_to_verify',
    content: '确认预算审批人与技术评审安排。',
    sourceIds: ['source-artifact'],
  }],
  unknowns: [{
    key: 'open_hypotheses',
    reasonCode: 'insufficient_evidence',
    sourceIds: ['source-artifact'],
  }],
});

const postMeetingModelResponse = JSON.stringify({
  items: [{
    kind: 'person',
    ref: 'li',
    quote: '李经理负责技术评估。',
    confidence: 0.91,
    name: '李经理',
    title: '技术负责人',
  }, {
    kind: 'person',
    ref: 'wang',
    quote: '王总负责最终决策。',
    confidence: 0.88,
    name: '王总',
    title: '决策负责人',
  }, {
    kind: 'relation',
    ref: 'reporting',
    quote: '李经理会向王总汇报方案。',
    confidence: 0.82,
    sourcePerson: { kind: 'new_person', personRef: 'li' },
    targetPerson: { kind: 'new_person', personRef: 'wang' },
    layer: 'L2',
    label: '汇报关系',
  }, {
    kind: 'evidence',
    ref: 'budget',
    quote: '客户明确表示预算审批暂未通过。',
    confidence: 0.86,
    person: { kind: 'new_person', personRef: 'wang' },
    signalKey: 'budget_approval',
    direction: -1,
    tier: 'strong',
    occurredAt,
  }, {
    kind: 'commitment',
    ref: 'followup',
    quote: '曹经理将在下周二确认评审安排。',
    confidence: 0.93,
    personId: null,
    title: '确认技术评审安排',
    kindKey: 'follow_up',
    confirmationStatus: 'not_required',
    scheduledAtUtc: '2026-09-10T02:00:00.000Z',
    dueAtUtc: null,
    timeZone: 'Asia/Shanghai',
    isAllDay: false,
    localDate: null,
    confirmationDueAtUtc: null,
  }],
});

const auth = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

function multipartFile(body: string): Buffer {
  return Buffer.from([
    `--${uploadBoundary}\r\n`,
    'Content-Disposition: form-data; name="file"; filename="cao-manager-meeting.txt"\r\n',
    'Content-Type: text/plain\r\n\r\n',
    body,
    `\r\n--${uploadBoundary}--\r\n`,
  ].join(''));
}

async function addUser(test: TestContext, role: 'admin' | 'member' | 'viewer', name: string) {
  const user = await test.prisma.user.create({ data: {
    tenantId: test.tenant.id,
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name,
    role,
  } });
  return {
    user,
    token: test.app.jwt.sign({ userId: user.id, tenantId: test.tenant.id, role }),
  };
}

async function registerForeignOwner(test: TestContext) {
  const response = await test.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `foreign-${randomUUID()}@example.test`,
      password: 'test-password',
      name: '外部租户用户',
      tenantName: '外部隔离租户',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ token: string; tenant: { id: string }; user: { id: string } }>();
}

async function formalAuthority(test: TestContext) {
  const tenantId = test.tenant.id;
  return {
    customers: await test.prisma.account.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true, name: true, categoryKey: true, customerType: true,
        primaryOwnerUserId: true, version: true, archivedAt: true,
      },
    }),
    matters: await test.prisma.opportunity.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, name: true, kind: true, lifecycleStatus: true,
        outcomeKey: true, priority: true, targetDate: true, primaryOwnerUserId: true,
        pipelineStage: true, engageStage: true, primaryDPersonId: true,
        activeMethodologyBindingId: true, version: true, archivedAt: true,
      },
    }),
    people: await test.prisma.person.findMany({
      where: { tenantId, archivedAt: null }, orderBy: { id: 'asc' },
      select: { id: true, accountId: true, name: true, title: true, version: true },
    }),
    participants: await test.prisma.matterParticipant.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: { accountId: true, opportunityId: true, personId: true },
    }),
    relations: await test.prisma.edge.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, opportunityId: true, source: true, target: true,
        layer: true, label: true, version: true,
      },
    }),
    approvedEvidence: await test.prisma.evidenceEvent.findMany({
      where: { tenantId, status: 'approved' }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, opportunityId: true, personId: true,
        signalKey: true, direction: true, tier: true, status: true,
      },
    }),
    commitments: await test.prisma.planAction.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, opportunityId: true, personId: true,
        kind: true, ownerUserId: true, executionStatus: true,
        confirmationStatus: true, scheduleVersion: true, source: true,
        sourceRef: true, version: true,
      },
    }),
    interactions: await test.prisma.interaction.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, matterId: true, sourceArtifactId: true,
        activityKind: true, occurredAt: true, createdByUserId: true,
        confirmedByUserId: true, version: true,
      },
    }),
    intelligence: await test.prisma.intelligenceItem.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, customerId: true, matterId: true, assertionType: true,
        sourceKind: true, sourceRefId: true, sourceRefVersion: true,
        confidence: true, version: true, archivedAt: true,
      },
    }),
    focuses: await test.prisma.stakeholderFocus.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, customerId: true, matterId: true, personId: true,
        activeMatterKey: true, confirmedByUserId: true, version: true,
        retiredAt: true,
      },
    }),
    hypotheses: await test.prisma.salesHypothesis.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, customerId: true, matterId: true, personId: true, status: true,
        ownerUserId: true, currentRevisionId: true, statusConfirmedByUserId: true,
        version: true,
      },
    }),
  };
}

async function readSideCounts(test: TestContext) {
  const tenantId = test.tenant.id;
  return Promise.all([
    test.prisma.commandRun.count({ where: { tenantId } }),
    test.prisma.auditEvent.count({ where: { tenantId } }),
    test.prisma.agentRun.count({ where: { tenantId } }),
    test.prisma.relationshipRadarSnapshot.count({ where: { tenantId } }),
    test.prisma.account.count({ where: { tenantId } }),
    test.prisma.opportunity.count({ where: { tenantId } }),
    test.prisma.person.count({ where: { tenantId } }),
    test.prisma.edge.count({ where: { tenantId } }),
    test.prisma.evidenceEvent.count({ where: { tenantId } }),
    test.prisma.planAction.count({ where: { tenantId } }),
    test.prisma.interaction.count({ where: { tenantId } }),
    test.prisma.intelligenceItem.count({ where: { tenantId } }),
    test.prisma.stakeholderFocus.count({ where: { tenantId } }),
    test.prisma.salesHypothesis.count({ where: { tenantId } }),
  ]);
}

async function externalExecutionCounts(test: TestContext) {
  const tenantId = test.tenant.id;
  return Promise.all([
    test.prisma.accessToken.count({ where: { tenantId } }),
    test.prisma.syncRun.count({ where: { tenantId } }),
    test.prisma.weComConfig.count({ where: { tenantId } }),
    test.prisma.weComUserBind.count({ where: { tenantId } }),
    test.prisma.weComOAuthState.count({ where: { tenantId } }),
    test.prisma.scheduleSync.count({ where: { tenantId } }),
    test.prisma.recordingProviderConfig.count({ where: { tenantId } }),
    test.prisma.recordingCredential.count({ where: { tenantId } }),
  ]);
}

describe('SAAS-211 Cao manager G4 commercial journey stage gate', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  it('runs one synthetic file through three controlled jobs, human review, explainable radar and five Matters', async () => {
    const preMeetingCall = vi.fn(async () => preMeetingModelResponse);
    const postMeetingCall = vi.fn(async () => postMeetingModelResponse);
    const fixtureAiConfig = async () => ({
      provider: 'openai-compatible' as const,
      baseUrl: 'https://model.example.test/v1',
      model: 'fixture-model',
      apiKey: fixtureApiKey,
    });
    test = await createTestContext({
      agentHandlers: {
        'pre_meeting_brief@core-206.v1': createPreMeetingHandler({
          db: prisma, policy, loadAiConfig: fixtureAiConfig, callLLM: preMeetingCall,
        }),
        'post_meeting_extract@core-206.v1': createPostMeetingHandler({
          db: prisma, policy, loadAiConfig: fixtureAiConfig, callLLM: postMeetingCall,
        }),
        'relationship_radar@saas-212.v1': createRelationshipRadarHandler(
          prisma, policy, () => new Date(radarAt),
        ),
      },
    });
    await test.prisma.user.update({
      where: { id: test.owner.id }, data: { name: '曹经理' },
    });
    await test.prisma.account.create({ data: {
      id: customerId,
      tenantId: test.tenant.id,
      name: '海岳能源',
      categoryKey: 'strategic',
      customerType: 1,
      primaryOwnerUserId: test.owner.id,
      version: 4,
    } });
    await test.prisma.opportunity.createMany({ data: matterIds.map((id, index) => ({
      id,
      tenantId: test!.tenant.id,
      accountId: customerId,
      name: index === 0 ? '储能联合开发' : `组合事项 ${index + 1}`,
      kind: index < 2 ? 'sales_opportunity' : 'general',
      lifecycleStatus: 'active',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      priority: index === 0 ? 'high' : index === 1 ? 'medium' : null,
      primaryOwnerUserId: test!.owner.id,
      version: index === 0 ? 3 : 0,
    })) });
    await test.prisma.pdeDecisionContext.create({ data: {
      id: 'g4-cao-main-pde-context',
      tenantId: test.tenant.id,
      opportunityId: matterId,
      stageKey: 'initiation',
      source: 'system_default',
    } });

    const manager = await addUser(test, 'member', '区域经理');
    const sharedReader = await addUser(test, 'member', '协作同事');
    const nonCreatorAdmin = await addUser(test, 'admin', '非创建者管理员');
    const viewer = await addUser(test, 'viewer', '只读负责人');
    const foreign = await registerForeignOwner(test);
    const externalBefore = await externalExecutionCounts(test);
    expect(externalBefore).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const beforeUpload = await formalAuthority(test);
    const upload = await test.app.inject({
      method: 'POST',
      url: `/api/post-meeting/import/upload?customerId=${customerId}&matterId=${matterId}&occurredAt=${encodeURIComponent(occurredAt)}`,
      headers: {
        ...auth(test.token, 'saas-211-upload-file'),
        'content-type': `multipart/form-data; boundary=${uploadBoundary}`,
      },
      payload: multipartFile(meetingBody),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const uploaded = upload.json<{
      source: { id: string; aclVersion: number; version: number; fingerprint: string };
      replayed: boolean;
    }>();
    expect(uploaded).toMatchObject({
      source: {
        id: expect.stringMatching(/^src_[a-f0-9]{32}$/),
        aclVersion: 1,
        version: 1,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      replayed: false,
    });
    expect(upload.body).not.toContain(meetingBody);
    await expect(formalAuthority(test)).resolves.toEqual(beforeUpload);
    const transcript = await test.prisma.transcript.findFirstOrThrow({
      where: { tenantId: test.tenant.id, source: 'upload' },
    });
    expect(transcript.contentEnc).not.toContain(meetingBody);
    expect(dec(transcript.contentEnc)).toBe(meetingBody);

    const creatorRead = await test.app.inject({
      method: 'GET', url: `/api/source-artifacts/${uploaded.source.id}`, headers: auth(test.token),
    });
    expect(creatorRead.statusCode, creatorRead.body).toBe(200);
    const missingForManager = await test.app.inject({
      method: 'GET', url: '/api/source-artifacts/missing-g4-source', headers: auth(manager.token),
    });
    for (const token of [manager.token, sharedReader.token, nonCreatorAdmin.token]) {
      const hidden = await test.app.inject({
        method: 'GET', url: `/api/source-artifacts/${uploaded.source.id}`, headers: auth(token),
      });
      expect(hidden.statusCode, hidden.body).toBe(404);
      expect(hidden.json()).toEqual(missingForManager.json());
      expect(hidden.body).not.toContain('cao-manager-meeting.txt');
      expect(hidden.body).not.toContain(meetingBody);
    }

    const shared = await test.app.inject({
      method: 'PUT',
      url: `/api/source-artifacts/${uploaded.source.id}/visibility`,
      headers: auth(test.token, 'saas-211-source-share-first'),
      payload: { visibility: 'matter_shared', expectedAclVersion: uploaded.source.aclVersion },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json()).toMatchObject({ visibility: 'matter_shared', aclVersion: 2 });
    for (const token of [manager.token, sharedReader.token, nonCreatorAdmin.token]) {
      const visible = await test.app.inject({
        method: 'GET', url: `/api/source-artifacts/${uploaded.source.id}`, headers: auth(token),
      });
      expect(visible.statusCode, visible.body).toBe(200);
      expect(visible.body).not.toContain(meetingBody);
      expect(visible.body).not.toContain('contentEnc');
    }

    const privateAgain = await test.app.inject({
      method: 'PUT',
      url: `/api/source-artifacts/${uploaded.source.id}/visibility`,
      headers: auth(test.token, 'saas-211-source-private-again'),
      payload: { visibility: 'private', expectedAclVersion: 2 },
    });
    expect(privateAgain.statusCode, privateAgain.body).toBe(200);
    expect(privateAgain.json()).toMatchObject({ visibility: 'private', aclVersion: 3 });
    const revokedReader = await test.app.inject({
      method: 'GET', url: `/api/source-artifacts/${uploaded.source.id}`, headers: auth(sharedReader.token),
    });
    expect(revokedReader.statusCode, revokedReader.body).toBe(404);
    expect(revokedReader.json()).toEqual(missingForManager.json());

    const sharedAgain = await test.app.inject({
      method: 'PUT',
      url: `/api/source-artifacts/${uploaded.source.id}/visibility`,
      headers: auth(test.token, 'saas-211-source-share-final'),
      payload: { visibility: 'matter_shared', expectedAclVersion: 3 },
    });
    expect(sharedAgain.statusCode, sharedAgain.body).toBe(200);
    expect(sharedAgain.json()).toMatchObject({ visibility: 'matter_shared', aclVersion: 4 });
    const sourceVersion = 4;

    const foreignHidden = await test.app.inject({
      method: 'GET', url: `/api/source-artifacts/${uploaded.source.id}`, headers: auth(foreign.token),
    });
    const foreignMissing = await test.app.inject({
      method: 'GET', url: '/api/source-artifacts/missing-g4-source', headers: auth(foreign.token),
    });
    expect(foreignHidden.statusCode, foreignHidden.body).toBe(404);
    expect(foreignHidden.json()).toEqual(foreignMissing.json());

    await test.prisma.account.update({
      where: { id: customerId }, data: { primaryOwnerUserId: viewer.user.id },
    });
    await test.prisma.opportunity.update({
      where: { id: matterId }, data: { primaryOwnerUserId: viewer.user.id },
    });
    const viewerSource = await test.app.inject({
      method: 'GET', url: `/api/source-artifacts/${uploaded.source.id}`, headers: auth(viewer.token),
    });
    expect(viewerSource.statusCode, viewerSource.body).toBe(200);
    const beforeViewerWrites = await readSideCounts(test);
    const viewerDenied = await Promise.all([
      test.app.inject({
        method: 'PUT',
        url: '/api/agent-jobs/pre_meeting_brief/control',
        headers: auth(viewer.token, 'saas-211-viewer-control'),
        payload: { jobVersion: 'core-206.v1', enabled: true, expectedVersion: 0 },
      }),
      test.app.inject({
        method: 'POST',
        url: '/api/agent-jobs/pre_meeting_brief/runs',
        headers: auth(viewer.token, 'saas-211-viewer-run'),
        payload: {
          jobVersion: 'core-206.v1', customerId, matterId,
          sourceArtifactId: uploaded.source.id,
          inputRefs: [
            { kind: 'customer', id: customerId, version: 4 },
            { kind: 'matter', id: matterId, version: 3 },
            { kind: 'source_artifact', id: uploaded.source.id, version: sourceVersion },
          ],
        },
      }),
      test.app.inject({
        method: 'PUT',
        url: `/api/source-artifacts/${uploaded.source.id}/visibility`,
        headers: auth(viewer.token, 'saas-211-viewer-source-write'),
        payload: { visibility: 'private', expectedAclVersion: sourceVersion },
      }),
    ]);
    expect(viewerDenied.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(viewerDenied.map((response) => response.json().code))
      .toEqual(['viewer_write_denied', 'viewer_write_denied', 'viewer_write_denied']);
    await expect(readSideCounts(test)).resolves.toEqual(beforeViewerWrites);
    await test.prisma.account.update({
      where: { id: customerId }, data: { primaryOwnerUserId: test.owner.id },
    });
    await test.prisma.opportunity.update({
      where: { id: matterId }, data: { primaryOwnerUserId: test.owner.id },
    });

    const initialCards = await test.app.inject({
      method: 'GET', url: '/api/agent-jobs', headers: auth(test.token),
    });
    expect(initialCards.statusCode, initialCards.body).toBe(200);
    expect(initialCards.json<{ items: Array<Record<string, unknown>> }>().items).toMatchObject([
      {
        jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1', actionMode: 'read_only',
        available: true, enabled: false, controlVersion: 0,
      },
      {
        jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1', actionMode: 'candidate',
        available: true, enabled: false, controlVersion: 0,
      },
      {
        jobKey: 'relationship_radar', jobVersion: 'saas-212.v1', actionMode: 'draft',
        available: true, enabled: false, controlVersion: 0,
      },
    ]);
    const jobs = [
      ['pre_meeting_brief', 'core-206.v1'],
      ['post_meeting_extract', 'core-206.v1'],
      ['relationship_radar', 'saas-212.v1'],
    ] as const;
    for (const [jobKey, jobVersion] of jobs) {
      const control = await test.app.inject({
        method: 'PUT',
        url: `/api/agent-jobs/${jobKey}/control`,
        headers: auth(test.token, `saas-211-enable-${jobKey}`),
        payload: { jobVersion, enabled: true, expectedVersion: 0 },
      });
      expect(control.statusCode, control.body).toBe(200);
      expect(control.json()).toMatchObject({
        jobKey, jobVersion, enabled: true, controlVersion: 1, replayed: false,
      });
    }

    const sourceAnchors = [
      { kind: 'customer', id: customerId, version: 4 },
      { kind: 'matter', id: matterId, version: 3 },
      { kind: 'source_artifact', id: uploaded.source.id, version: sourceVersion },
    ];
    const beforeBrief = await formalAuthority(test);
    const briefRun = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/pre_meeting_brief/runs',
      headers: auth(test.token, 'saas-211-pre-meeting-run'),
      payload: {
        jobVersion: 'core-206.v1', customerId, matterId,
        sourceArtifactId: uploaded.source.id, inputRefs: sourceAnchors,
      },
    });
    expect(briefRun.statusCode, briefRun.body).toBe(200);
    const briefReceipt = AgentRunReceiptSchema.parse(briefRun.json());
    expect(briefReceipt.run.status, briefReceipt.run.failureCode).toBe('succeeded');
    expect(briefReceipt).toMatchObject({
      replayed: false,
      run: {
        jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1', actionMode: 'read_only',
        status: 'succeeded', outputRefs: [{ kind: 'research_brief', version: 1 }],
      },
    });
    expect(preMeetingCall).toHaveBeenCalledOnce();
    await expect(formalAuthority(test)).resolves.toEqual(beforeBrief);
    const brief = await test.app.inject({
      method: 'GET',
      url: `/api/research-briefs/${briefReceipt.run.outputRefs[0]!.id}`,
      headers: auth(test.token),
    });
    expect(brief.statusCode, brief.body).toBe(200);
    const briefDetail = ResearchBriefSnapshotDetailResponseSchema.parse(brief.json());
    expect(briefDetail.item.payload.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'company_overview', sourceIds: ['crm-customer', 'crm-matter'] }),
      expect.objectContaining({ key: 'questions_to_verify', sourceIds: ['source-artifact'] }),
    ]));
    expect(briefDetail.item.payload.sections.every((section) => Boolean(section.asOf))).toBe(true);
    expect(briefDetail.item.payload.sources.every((source) => (
      Boolean(source.retrievedAt) && Boolean(source.freshUntil)
    ))).toBe(true);
    expect(briefDetail.item.payload.sources.find((source) => source.id === 'source-artifact')).toMatchObject({
      observedAt: occurredAt,
    });
    expect(briefDetail.item.payload.unknowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'open_hypotheses', reasonCode: 'insufficient_evidence' }),
      expect.objectContaining({ key: 'recent_changes', reasonCode: 'missing_evidence' }),
      expect.objectContaining({ key: 'existing_cooperation', reasonCode: 'missing_evidence' }),
      expect.objectContaining({ key: 'active_matters', reasonCode: 'missing_evidence' }),
      expect.objectContaining({ key: 'stakeholders', reasonCode: 'missing_evidence' }),
      expect.objectContaining({ key: 'last_commitments', reasonCode: 'missing_evidence' }),
    ]));
    expect(briefDetail.item.payload.unknowns).toHaveLength(6);

    const beforeExtract = await formalAuthority(test);
    const extractRun = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: auth(test.token, 'saas-211-post-meeting-run'),
      payload: {
        jobVersion: 'core-206.v1', customerId, matterId,
        sourceArtifactId: uploaded.source.id, inputRefs: sourceAnchors,
      },
    });
    expect(extractRun.statusCode, extractRun.body).toBe(200);
    const extractReceipt = AgentRunReceiptSchema.parse(extractRun.json());
    expect(extractReceipt).toMatchObject({
      replayed: false,
      run: {
        jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1', actionMode: 'candidate',
        status: 'succeeded', outputRefs: [{ kind: 'review_batch', version: 0 }],
      },
    });
    expect(postMeetingCall).toHaveBeenCalledOnce();
    await expect(formalAuthority(test)).resolves.toEqual(beforeExtract);
    await expect(test.prisma.candidate.count({
      where: { tenantId: test.tenant.id, reviewBatchId: extractReceipt.run.outputRefs[0]!.id },
    })).resolves.toBe(5);

    const batchId = extractReceipt.run.outputRefs[0]!.id;
    const ownerBatch = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batchId}`, headers: auth(test.token),
    });
    expect(ownerBatch.statusCode, ownerBatch.body).toBe(200);
    const ownerDetail = PostMeetingReviewBatchDetailSchema.parse(ownerBatch.json());
    expect(ownerDetail.items.map((item) => item.kind)).toEqual([
      'person', 'person', 'relation', 'evidence', 'commitment',
    ]);
    for (const item of ownerDetail.items) {
      expect(item.defaultSelected).toBe(false);
      expect(item.confidence).toBeGreaterThan(0);
      expect(meetingBody).toContain(item.sourceQuote);
      expect(item.sourceLocator).toMatch(/^item-\d{3}:chars:\d+-\d+$/);
    }

    const managerList = await test.app.inject({
      method: 'GET', url: '/api/review-batches', headers: auth(manager.token),
    });
    expect(managerList.statusCode, managerList.body).toBe(200);
    expect(managerList.body).toContain(batchId);
    expect(managerList.body).not.toContain('预算审批暂未通过');
    const managerBeforeGrant = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batchId}`, headers: auth(manager.token),
    });
    expect(managerBeforeGrant.statusCode, managerBeforeGrant.body).toBe(404);
    const missingBatch = await test.app.inject({
      method: 'GET', url: '/api/review-batches/missing-g4-batch', headers: auth(manager.token),
    });
    expect(managerBeforeGrant.json()).toEqual(missingBatch.json());

    const viewerBeforeReviewWrites = await readSideCounts(test);
    await test.prisma.account.update({
      where: { id: customerId }, data: { primaryOwnerUserId: viewer.user.id },
    });
    const viewerReview = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(viewer.token, 'saas-211-viewer-review'),
      payload: {
        expectedVersion: ownerDetail.version,
        expectedAcceptanceVersion: ownerDetail.acceptanceVersion,
        customerId, matterId, activityKind: 'meeting', occurredAt,
        decisions: ownerDetail.items.map((item) => ({
          kind: item.kind,
          candidateId: item.candidateId,
          expectedVersion: item.expectedVersion,
          expectedAclVersion: item.expectedAclVersion,
          decision: 'accept',
        })),
      },
    });
    expect(viewerReview.statusCode, viewerReview.body).toBe(403);
    expect(viewerReview.json()).toMatchObject({ code: 'viewer_write_denied' });
    await test.prisma.account.update({
      where: { id: customerId }, data: { primaryOwnerUserId: test.owner.id },
    });
    await expect(readSideCounts(test)).resolves.toEqual(viewerBeforeReviewWrites);

    for (const item of ownerDetail.items) {
      const granted = await grantCandidateReviewer(test.prisma, {
        tenantId: test.tenant.id,
        actorId: test.owner.id,
        actorRole: 'owner',
        candidateId: item.candidateId,
        granteeUserId: manager.user.id,
        expectedAclVersion: item.expectedAclVersion,
      }, policy);
      expect(granted.aclVersion).toBe(item.expectedAclVersion + 1);
    }
    const managerBatch = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batchId}`, headers: auth(manager.token),
    });
    expect(managerBatch.statusCode, managerBatch.body).toBe(200);
    const reviewDetail = PostMeetingReviewBatchDetailSchema.parse(managerBatch.json());
    const delegatedPerson = reviewDetail.items.find(
      (item) => item.kind === 'person' && item.after.name === '李经理',
    );
    if (!delegatedPerson) throw new Error('missing delegated reviewer Person candidate');
    const reviewerPayload = {
      expectedVersion: reviewDetail.version,
      expectedAcceptanceVersion: reviewDetail.acceptanceVersion,
      customerId,
      matterId,
      activityKind: 'meeting',
      occurredAt,
      decisions: [{
        kind: delegatedPerson.kind,
        candidateId: delegatedPerson.candidateId,
        expectedVersion: delegatedPerson.expectedVersion,
        expectedAclVersion: delegatedPerson.expectedAclVersion,
        decision: 'accept' as const,
      }],
    };
    const reviewerAccepted = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(manager.token, 'saas-211-reviewer-accept'),
      payload: reviewerPayload,
    });
    expect(reviewerAccepted.statusCode, reviewerAccepted.body).toBe(200);
    const reviewerAcceptedBody = reviewerAccepted.json<{
      status: string;
      interactionId: string;
      version: number;
      acceptanceVersion: number;
      businessReplayed: boolean;
      replayed: boolean;
      items: Array<{
        candidateId: string; formalKind: string; formalId: string;
      }>;
    }>();
    expect(reviewerAcceptedBody).toMatchObject({
      status: 'pending', businessReplayed: false, replayed: false,
      interactionId: expect.any(String), version: 1, acceptanceVersion: 1,
      items: [{ candidateId: delegatedPerson.candidateId, formalKind: 'person' }],
    });

    const ownerBatchAfterReviewer = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batchId}`, headers: auth(test.token),
    });
    expect(ownerBatchAfterReviewer.statusCode, ownerBatchAfterReviewer.body).toBe(200);
    const ownerReviewDetail = PostMeetingReviewBatchDetailSchema.parse(ownerBatchAfterReviewer.json());
    const reviewPayload = {
      expectedVersion: ownerReviewDetail.version,
      expectedAcceptanceVersion: ownerReviewDetail.acceptanceVersion,
      customerId,
      matterId,
      activityKind: 'meeting',
      occurredAt,
      decisions: ownerReviewDetail.items.filter((item) => item.status === 'pending').map((item) => ({
        kind: item.kind,
        candidateId: item.candidateId,
        expectedVersion: item.expectedVersion,
        expectedAclVersion: item.expectedAclVersion,
        decision: 'accept' as const,
      })),
    };
    const accepted = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(test.token, 'saas-211-review-accept'),
      payload: reviewPayload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const acceptedBody = accepted.json<{
      status: string;
      interactionId: string;
      version: number;
      acceptanceVersion: number;
      businessReplayed: boolean;
      replayed: boolean;
      items: Array<{
        candidateId: string; formalKind: string; formalId: string;
      }>;
    }>();
    expect(acceptedBody).toMatchObject({
      status: 'accepted', businessReplayed: false, replayed: false,
      interactionId: reviewerAcceptedBody.interactionId, version: 2, acceptanceVersion: 2,
    });
    const acceptedItems = [...reviewerAcceptedBody.items, ...acceptedBody.items];
    expect(acceptedItems.map((item) => item.formalKind).sort()).toEqual([
      'commitment', 'evidence', 'person', 'person', 'relation',
    ]);
    const formalId = (kind: string) => {
      const value = acceptedItems.find((item) => item.formalKind === kind)?.formalId;
      if (!value) throw new Error(`missing ${kind} receipt`);
      return value;
    };
    const personReceipts = acceptedItems.filter((item) => item.formalKind === 'person');
    const wangCandidate = reviewDetail.items.find(
      (item) => item.kind === 'person' && item.after.name === '王总',
    );
    const wangId = acceptedItems.find(
      (item) => item.candidateId === wangCandidate?.candidateId,
    )?.formalId;
    if (!wangId || personReceipts.length !== 2) throw new Error('missing accepted Person identities');
    const evidenceId = formalId('evidence');
    const commitmentId = formalId('commitment');

    await expect(test.prisma.person.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(2);
    await expect(test.prisma.matterParticipant.count({
      where: { tenantId: test.tenant.id, opportunityId: matterId },
    })).resolves.toBe(2);
    await expect(test.prisma.edge.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.evidenceEvent.findFirstOrThrow({
      where: { id: evidenceId, tenantId: test.tenant.id },
    })).resolves.toMatchObject({ status: 'approved', direction: -1, tier: 'strong' });
    await expect(test.prisma.planAction.count({
      where: { id: commitmentId, tenantId: test.tenant.id },
    })).resolves.toBe(1);
    await expect(test.prisma.interaction.count({
      where: { id: acceptedBody.interactionId, tenantId: test.tenant.id },
    })).resolves.toBe(1);

    const formalAfterAccept = await formalAuthority(test);
    const businessReplay = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(test.token, 'saas-211-review-business-replay'),
      payload: reviewPayload,
    });
    expect(businessReplay.statusCode, businessReplay.body).toBe(200);
    expect(businessReplay.json()).toMatchObject({ businessReplayed: true, replayed: false });
    const conflictingReview = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(test.token, 'saas-211-review-conflict'),
      payload: {
        ...reviewPayload,
        decisions: reviewPayload.decisions.map((decision, index) => ({
          ...decision, decision: index === 0 ? 'reject' as const : decision.decision,
        })),
      },
    });
    expect(conflictingReview.statusCode, conflictingReview.body).toBe(409);
    expect(conflictingReview.json()).toMatchObject({ code: 'review_batch_conflict' });
    await expect(formalAuthority(test)).resolves.toEqual(formalAfterAccept);

    const replayGuardBefore = await Promise.all([
      test.prisma.person.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    await test.prisma.user.update({ where: { id: manager.user.id }, data: { role: 'viewer' } });
    const demotedReplay = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(manager.token, 'saas-211-reviewer-accept'),
      payload: reviewerPayload,
    });
    expect(demotedReplay.statusCode, demotedReplay.body).toBe(403);
    expect(demotedReplay.json()).toMatchObject({ code: 'viewer_write_denied' });
    await expect(Promise.all([
      test.prisma.person.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).resolves.toEqual(replayGuardBefore);

    await test.prisma.user.update({ where: { id: manager.user.id }, data: { role: 'member' } });
    const revokedCandidate = reviewDetail.items[0]!;
    await revokeCandidateReviewer(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      candidateId: revokedCandidate.candidateId,
      granteeUserId: manager.user.id,
      expectedAclVersion: revokedCandidate.expectedAclVersion,
    }, policy);
    const afterGrantRevoke = await Promise.all([
      test.prisma.person.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const revokedReplay = await test.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(manager.token, 'saas-211-reviewer-accept'),
      payload: reviewerPayload,
    });
    expect(revokedReplay.statusCode, revokedReplay.body).toBe(404);
    await expect(Promise.all([
      test.prisma.person.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).resolves.toEqual(afterGrantRevoke);

    const intelligence = await test.app.inject({
      method: 'POST',
      url: '/api/commands/intelligence-item',
      headers: auth(test.token, 'saas-211-intelligence-create'),
      payload: {
        type: 'CREATE_INTELLIGENCE_ITEM',
        item: {
          id: 'g4-cao-intelligence', customerId, matterId,
          assertionType: 'reported',
          statement: '预算审批尚未完成，由王总继续协调。',
          source: {
            kind: 'interaction', description: '曹经理已确认的会后互动',
            refId: acceptedBody.interactionId, refVersion: 0,
          },
          occurredAt: null, learnedAt: '2026-09-02T01:00:00.000Z', confidence: 0.8,
          targets: [{ kind: 'person', id: wangId }],
        },
      },
    });
    expect(intelligence.statusCode, intelligence.body).toBe(200);
    expect(intelligence.json()).toMatchObject({
      intelligenceItemId: 'g4-cao-intelligence', assertionType: 'reported',
      sourceKind: 'interaction', status: 'active', replayed: false,
    });
    expect(intelligence.body).not.toContain('预算审批尚未完成');

    const focus = await test.app.inject({
      method: 'POST',
      url: '/api/commands/stakeholder-focus',
      headers: auth(test.token, 'saas-211-focus-set'),
      payload: {
        type: 'SET_STAKEHOLDER_FOCUS',
        focus: {
          id: 'g4-cao-focus', customerId, matterId, personId: wangId,
          desiredChange: '推动王总确认预算审批路径',
          rationale: '王总负责最终决策',
          evidenceGap: '仍需取得书面预算批复',
          basisRefs: [{ kind: 'evidence', id: evidenceId, version: 0 }],
          validUntil: '2026-12-31T00:00:00.000Z',
        },
        expectedCurrentFocusId: null,
        expectedCurrentFocusVersion: null,
      },
    });
    expect(focus.statusCode, focus.body).toBe(200);
    expect(focus.json()).toMatchObject({
      stakeholderFocusId: 'g4-cao-focus', personId: wangId,
      status: 'active', replayed: false,
    });

    const hypothesis = await test.app.inject({
      method: 'POST',
      url: '/api/commands/sales-hypothesis',
      headers: auth(test.token, 'saas-211-hypothesis-create'),
      payload: {
        type: 'CREATE_SALES_HYPOTHESIS',
        hypothesis: {
          id: 'g4-cao-hypothesis', customerId, matterId, personId: wangId,
          ownerUserId: test.owner.id,
          nextReviewAt: '2026-09-15T00:00:00.000Z',
          revision: {
            id: 'g4-cao-hypothesis-r1',
            claim: '预算会在本轮评审前完成审批',
            reason: '王总正在协调预算路径',
            expectedSignals: ['收到书面预算批复'],
            falsificationConditions: ['评审前预算仍未审批'],
          },
        },
      },
    });
    expect(hypothesis.statusCode, hypothesis.body).toBe(200);
    expect(hypothesis.json()).toMatchObject({
      salesHypothesisId: 'g4-cao-hypothesis', currentRevisionId: 'g4-cao-hypothesis-r1',
      status: 'untested', version: 0, replayed: false,
    });

    const linked = await test.app.inject({
      method: 'POST',
      url: '/api/commands/sales-hypothesis',
      headers: auth(test.token, 'saas-211-hypothesis-link'),
      payload: {
        type: 'LINK_HYPOTHESIS_EVIDENCE',
        link: {
          id: 'g4-cao-hypothesis-link',
          salesHypothesisId: 'g4-cao-hypothesis',
          expectedVersion: 0,
          expectedCurrentRevisionId: 'g4-cao-hypothesis-r1',
          evidenceId,
          evidenceVersion: 0,
          direction: 'contradicting',
          verificationCommitmentId: null,
        },
      },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toMatchObject({
      type: 'LINK_HYPOTHESIS_EVIDENCE', evidenceLinkId: 'g4-cao-hypothesis-link',
      status: 'untested', version: 1, replayed: false,
    });
    const suggested = await test.app.inject({
      method: 'GET',
      url: '/api/sales-hypotheses/g4-cao-hypothesis/status-suggestion',
      headers: auth(test.token),
    });
    expect(suggested.statusCode, suggested.body).toBe(200);
    expect(suggested.json()).toMatchObject({
      formalStatus: 'untested', suggestedStatus: 'contradicted',
      reasonCode: 'only_contradicting', contradictingCount: 1,
      evidenceRefs: [{ evidenceId, direction: 'contradicting' }],
    });
    expect(await test.prisma.salesHypothesis.findFirstOrThrow({
      where: { id: 'g4-cao-hypothesis', tenantId: test.tenant.id },
    })).toMatchObject({ status: 'untested', statusConfirmedByUserId: null });

    const confirmedStatus = await test.app.inject({
      method: 'POST',
      url: '/api/commands/sales-hypothesis',
      headers: auth(test.token, 'saas-211-hypothesis-status'),
      payload: {
        type: 'SET_SALES_HYPOTHESIS_STATUS',
        salesHypothesisId: 'g4-cao-hypothesis', expectedVersion: 1,
        status: 'contradicted',
      },
    });
    expect(confirmedStatus.statusCode, confirmedStatus.body).toBe(200);
    expect(confirmedStatus.json()).toMatchObject({
      status: 'contradicted', version: 2, replayed: false,
    });

    const canceledCommitment = await test.app.inject({
      method: 'POST',
      url: '/api/commands/commitment',
      headers: auth(test.token, 'saas-211-commitment-cancel'),
      payload: {
        type: 'CANCEL_COMMITMENT', customerId, commitmentId,
        baseVersion: 0, expectedScheduleVersion: 0, canceledAtUtc: radarAt,
        reason: '本轮会后安排已调整，由曹经理重新规划下一步',
      },
    });
    expect(canceledCommitment.statusCode, canceledCommitment.body).toBe(200);
    expect(canceledCommitment.json()).toMatchObject({
      commitmentId, executionStatus: 'canceled', version: 1, replayed: false,
    });

    const beforeRadar = await formalAuthority(test);
    const radarRun = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/relationship_radar/runs',
      headers: auth(test.token, 'saas-211-radar-run'),
      payload: {
        jobVersion: 'saas-212.v1', customerId, matterId, sourceArtifactId: null,
        inputRefs: [
          { kind: 'customer', id: customerId, version: 4 },
          { kind: 'matter', id: matterId, version: 3 },
        ],
      },
    });
    expect(radarRun.statusCode, radarRun.body).toBe(200);
    const radarReceipt = AgentRunReceiptSchema.parse(radarRun.json());
    expect(radarReceipt).toMatchObject({
      replayed: false,
      run: {
        jobKey: 'relationship_radar', jobVersion: 'saas-212.v1',
        actionMode: 'draft', status: 'succeeded',
      },
    });
    await expect(formalAuthority(test)).resolves.toEqual(beforeRadar);
    const radar = await test.app.inject({
      method: 'GET',
      url: `/api/relationship-radar?customerId=${customerId}&matterId=${matterId}`,
      headers: auth(test.token),
    });
    expect(radar.statusCode, radar.body).toBe(200);
    const radarProjection = RelationshipRadarResponseSchema.parse(radar.json());
    if (radarProjection.status !== 'ready') throw new Error('relationship radar was not ready');
    expect(radarProjection.snapshot).toMatchObject({ sourceState: 'current', version: 1 });
    expect(radarProjection.projection.signals.map((signal) => signal.dimension)).toEqual([
      'interaction_freshness',
      'single_threaded_contact',
      'role_coverage',
      'visible_warm_paths',
      'evidence_freshness',
      'next_step_completeness',
    ]);
    expect(radarProjection.projection.signals).toHaveLength(6);
    expect(radarProjection.projection.drafts).toEqual([
      expect.objectContaining({
        state: 'uncommitted', actionType: 'CREATE_COMMITMENT',
        customerId, matterId, reasonCode: 'next_step_completeness.gap',
      }),
    ]);
    expect(radarProjection.projection.interventions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'single_threaded_contact.attention' }),
    ]));
    expect(radar.body).not.toContain('aggregateScore');
    for (const intervention of radarProjection.projection.interventions) {
      expect(intervention).toMatchObject({
        providerKey: 'relationship_radar',
        reasonCode: expect.stringMatching(/^[a-z][a-z0-9._-]+$/),
        explanation: expect.any(String),
        observedAtUtc: radarAt,
        ruleVersion: 'saas-212.relationship-radar.v1',
        suggestedAction: { kind: expect.any(String), label: expect.any(String) },
      });
      expect(intervention.sourceRefs.length).toBeGreaterThan(0);
    }

    const beforeReadModels = await readSideCounts(test);
    for (const intervention of radarProjection.projection.interventions) {
      for (const sourceRef of intervention.sourceRefs) {
        const source = await test.app.inject({
          method: 'POST',
          url: '/api/relationship-radar/source',
          headers: auth(test.token),
          payload: { customerId, matterId, sourceRef },
        });
        expect(source.statusCode, `${sourceRef.entityKind}: ${source.body}`).toBe(200);
        expect(source.body).not.toContain(meetingBody);
      }
    }
    const portfolio = await test.app.inject({
      method: 'GET', url: '/api/matter-portfolio', headers: auth(test.token),
    });
    expect(portfolio.statusCode, portfolio.body).toBe(200);
    const portfolioProjection = MatterPortfolioReadModelSchema.parse(portfolio.json());
    expect(portfolioProjection.entries).toHaveLength(5);
    expect(new Set(portfolioProjection.entries.map((entry) => entry.matter.id)))
      .toEqual(new Set(matterIds));
    expect(portfolioProjection.entries.every((entry) => entry.methodologyStage === null)).toBe(true);
    const mainEntry = portfolioProjection.entries.find((entry) => entry.matter.id === matterId);
    expect(mainEntry).toBeDefined();
    expect(mainEntry!.attentionItems.some(
      (item) => item.providerKey === 'relationship_radar',
    )).toBe(true);
    expect(mainEntry!.attentionItems.every((item) => (
      Boolean(item.reasonCode)
      && Boolean(item.explanation)
      && Boolean(item.observedAtUtc)
      && Boolean(item.ruleVersion)
      && item.sourceRefs.length > 0
      && Boolean(item.suggestedAction.kind)
    ))).toBe(true);
    expect(mainEntry!.actionDraft).toMatchObject({ state: 'uncommitted' });
    await expect(readSideCounts(test)).resolves.toEqual(beforeReadModels);

    const runHistory = await test.app.inject({
      method: 'GET', url: '/api/agent-runs', headers: auth(test.token),
    });
    expect(runHistory.statusCode, runHistory.body).toBe(200);
    const historyItems = runHistory.json<{ items: Array<{
      jobKey: string; jobVersion: string; actionMode: string; status: string;
    }> }>().items;
    expect(historyItems).toHaveLength(2);
    expect(historyItems.map((run) => [run.jobKey, run.jobVersion, run.actionMode, run.status]).sort())
      .toEqual([
        ['pre_meeting_brief', 'core-206.v1', 'read_only', 'succeeded'],
        ['relationship_radar', 'saas-212.v1', 'draft', 'succeeded'],
      ]);
    const persistedRuns = await test.prisma.agentRun.findMany({
      where: { tenantId: test.tenant.id },
      orderBy: { jobKey: 'asc' },
      select: { jobKey: true, jobVersion: true, actionMode: true, status: true },
    });
    expect(persistedRuns.map((run) => [run.jobKey, run.jobVersion, run.actionMode, run.status]))
      .toEqual([
        ['post_meeting_extract', 'core-206.v1', 'candidate', 'succeeded'],
        ['pre_meeting_brief', 'core-206.v1', 'read_only', 'succeeded'],
        ['relationship_radar', 'saas-212.v1', 'draft', 'succeeded'],
      ]);

    const stopped = await test.app.inject({
      method: 'PUT',
      url: '/api/agent-jobs/relationship_radar/control',
      headers: auth(test.token, 'saas-211-disable-radar'),
      payload: { jobVersion: 'saas-212.v1', enabled: false, expectedVersion: 1 },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ enabled: false, controlVersion: 2 });
    const beforeStoppedRun = await readSideCounts(test);
    const deniedStoppedRun = await test.app.inject({
      method: 'POST',
      url: '/api/agent-jobs/relationship_radar/runs',
      headers: auth(test.token, 'saas-211-disabled-radar-run'),
      payload: {
        jobVersion: 'saas-212.v1', customerId, matterId, sourceArtifactId: null,
        inputRefs: [
          { kind: 'customer', id: customerId, version: 4 },
          { kind: 'matter', id: matterId, version: 3 },
        ],
      },
    });
    expect(deniedStoppedRun.statusCode, deniedStoppedRun.body).toBe(409);
    expect(deniedStoppedRun.json()).toMatchObject({ code: 'agent_job_disabled' });
    await expect(readSideCounts(test)).resolves.toEqual(beforeStoppedRun);

    const bodyFreeAudit = JSON.stringify({
      agentRuns: await test.prisma.agentRun.findMany({ where: { tenantId: test.tenant.id } }),
      commandRuns: await test.prisma.commandRun.findMany({ where: { tenantId: test.tenant.id } }),
      audits: await test.prisma.auditEvent.findMany({ where: { tenantId: test.tenant.id } }),
    });
    for (const forbidden of [
      meetingBody,
      '客户明确表示预算审批暂未通过。',
      '曹经理将在下周二确认评审安排。',
      fixtureApiKey,
    ]) expect(bodyFreeAudit).not.toContain(forbidden);
    await expect(externalExecutionCounts(test)).resolves.toEqual(externalBefore);
    await expect(Promise.all([
      test.prisma.methodologyPack.count({ where: { tenantId: test.tenant.id } }),
      test.prisma.methodologyBinding.count({ where: { tenantId: test.tenant.id } }),
    ])).resolves.toEqual([0, 0]);
    await expect(test.prisma.opportunity.findFirstOrThrow({
      where: { id: matterId, tenantId: test.tenant.id },
    })).resolves.toMatchObject({
      pipelineStage: 'lead', engageStage: 'discover', primaryDPersonId: null,
      activeMethodologyBindingId: null, version: 3,
    });
  });
});
