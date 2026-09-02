import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleProductAccess,
  PostMeetingReviewBatchDetailSchema,
  PostMeetingReviewReceiptSchema,
  type PostMeetingCandidateBatch,
} from '@jianghu/domain-contracts';
import { enc } from '../src/ai.js';
import {
  AgentPreparationError,
  type AgentCommitContext,
  type AgentPreparationContext,
} from '../src/agents/model.js';
import { builtInAgentDefinition } from '../src/agents/registry.js';
import {
  createPostMeetingHandler,
  postMeetingReviewBatchId,
} from '../src/postMeeting/handler.js';
import { createPostMeetingCandidateCommitAdapter } from '../src/postMeeting/commit.js';
import { parsePostMeetingModelResponse } from '../src/postMeeting/extractor.js';
import { loadAuthorizedPostMeetingSource } from '../src/postMeeting/source.js';
import { prisma } from '../src/prisma.js';
import {
  acceptReviewBatch,
  ReviewBatchConflictError,
} from '../src/reviewBatches/acceptance.js';
import { readableReviewBatchById } from '../src/reviewBatches/service.js';
import {
  ensureSourceArtifactForNote,
  ensureSourceArtifactForTranscript,
} from '../src/sourceArtifacts/service.js';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const policy = assembleProductAccess({ edition: 'internal' }).policy;

describe('SAAS-202 authorized post-meeting source body', () => {
  let test: TestContext | null = null;

  afterEach(async () => test?.cleanup());

  async function setup() {
    test = await createTestContext({ agentHandlers: {} });
    await test.prisma.account.create({ data: {
      id: 'post-account',
      tenantId: test.tenant.id,
      name: '海岳能源',
      categoryKey: 'strategic',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'post-matter',
      tenantId: test.tenant.id,
      accountId: 'post-account',
      name: '储能项目',
      kind: 'sales_opportunity',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      priority: 'high',
      targetDate: '2026-09-30',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.createMany({ data: [
      {
        id: 'person-wang', tenantId: test.tenant.id, accountId: 'post-account',
        name: '王总', title: '总经理', version: 2,
      },
      {
        id: 'person-zhao', tenantId: test.tenant.id, accountId: 'post-account',
        name: '赵经理', title: '采购经理', version: 1,
      },
    ] });
    return test;
  }

  async function createNoteSource(body = '王总明确表示由李经理负责技术评估。') {
    const ctx = await setup();
    await ctx.prisma.note.create({ data: {
      id: 'post-note',
      tenantId: ctx.tenant.id,
      accountId: 'post-account',
      opportunityId: 'post-matter',
      content: body,
      source: 'manual',
      createdBy: ctx.owner.id,
      createdByUserId: ctx.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForNote(ctx.prisma, ctx.tenant.id, 'post-note');
    return { ctx, source, body };
  }

  const inputFor = (ctx: TestContext, source: { id: string; aclVersion: number }) => ({
    tenantId: ctx.tenant.id,
    actorId: ctx.owner.id,
    customerId: 'post-account',
    matterId: 'post-matter',
    sourceArtifactId: source.id,
    expectedAclVersion: source.aclVersion,
  });

  it('reads one exact Note only after current scope/ACL checks and returns bounded CRM context', async () => {
    const { ctx, source, body } = await createNoteSource();
    const loaded = await loadAuthorizedPostMeetingSource(
      ctx.prisma,
      policy,
      inputFor(ctx, source),
    );

    expect(loaded).toMatchObject({
      id: source.id,
      artifactKind: 'note',
      body,
      customer: { id: 'post-account', name: '海岳能源', categoryKey: 'strategic', version: 0 },
      matter: { id: 'post-matter', customerId: 'post-account', title: '储能项目', version: 0 },
      people: [
        { id: 'person-wang', name: '王总', title: '总经理', version: 2 },
        { id: 'person-zhao', name: '赵经理', title: '采购经理', version: 1 },
      ],
    });
    expect(loaded.sourceFingerprint).toBe(source.sourceFingerprint);
    expect(JSON.stringify({ ...loaded, body: undefined })).not.toContain(body);
  });

  it('denies viewer execution and private non-creator access before loading the backing body', async () => {
    const { ctx, source } = await createNoteSource('PRIVATE_BODY_MUST_NOT_LOAD');
    const viewer = await ctx.prisma.user.create({ data: {
      tenantId: ctx.tenant.id,
      email: `viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: 'Viewer',
      role: 'viewer',
    } });
    await ctx.prisma.account.update({
      where: { id: 'post-account' },
      data: { primaryOwnerUserId: viewer.id },
    });

    await expect(loadAuthorizedPostMeetingSource(ctx.prisma, policy, {
      ...inputFor(ctx, source), actorId: viewer.id,
    })).rejects.toMatchObject({ code: 'viewer_write_denied' });

    const member = await ctx.prisma.user.create({ data: {
      tenantId: ctx.tenant.id,
      email: `member-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: 'Member',
      role: 'member',
    } });
    await ctx.prisma.account.update({
      where: { id: 'post-account' },
      data: { primaryOwnerUserId: member.id },
    });
    await expect(loadAuthorizedPostMeetingSource(ctx.prisma, policy, {
      ...inputFor(ctx, source), actorId: member.id,
    })).rejects.toMatchObject({ code: 'post_meeting_source_not_found' });
  });

  it('fails closed on tenant, mount, ACL-version and Note fingerprint drift', async () => {
    const { ctx, source } = await createNoteSource();
    const otherTenant = await ctx.prisma.tenant.create({ data: {
      id: 'other-tenant', name: 'Other tenant',
    } });
    const otherActor = await ctx.prisma.user.create({ data: {
      tenantId: otherTenant.id,
      email: `other-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Other owner', role: 'owner',
    } });
    await expect(loadAuthorizedPostMeetingSource(ctx.prisma, policy, {
      ...inputFor(ctx, source), tenantId: otherTenant.id, actorId: otherActor.id,
    })).rejects.toMatchObject({ code: 'post_meeting_source_not_found' });

    await expect(loadAuthorizedPostMeetingSource(ctx.prisma, policy, {
      ...inputFor(ctx, source), matterId: null,
    })).rejects.toMatchObject({ code: 'post_meeting_source_not_found' });
    await expect(loadAuthorizedPostMeetingSource(ctx.prisma, policy, {
      ...inputFor(ctx, source), expectedAclVersion: source.aclVersion + 1,
    })).rejects.toMatchObject({ code: 'post_meeting_source_stale' });

    await ctx.prisma.note.update({ where: { id: 'post-note' }, data: { content: 'tampered body' } });
    await expect(loadAuthorizedPostMeetingSource(
      ctx.prisma, policy, inputFor(ctx, source),
    )).rejects.toMatchObject({ code: 'post_meeting_source_fingerprint_mismatch' });
  });

  it('checks Transcript ciphertext fingerprint before decrypting and rejects unavailable sources', async () => {
    const ctx = await setup();
    const body = '会议转写正文：周五前发送技术方案。';
    const ciphertext = enc(body);
    await ctx.prisma.transcript.create({ data: {
      id: 'post-transcript',
      tenantId: ctx.tenant.id,
      accountId: 'post-account',
      opportunityId: 'post-matter',
      source: 'manual',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(ctx.owner.id)}`,
      title: '客户会谈',
      contentEnc: ciphertext,
      recordedAt: new Date('2026-08-25T18:00:00.000Z'),
      createdBy: ctx.owner.id,
      createdByUserId: ctx.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForTranscript(
      ctx.prisma, ctx.tenant.id, 'post-transcript',
    );
    const decrypt = vi.fn((value: string) => (value === ciphertext ? body : ''));
    const loaded = await loadAuthorizedPostMeetingSource(
      ctx.prisma, policy, inputFor(ctx, source), { decrypt },
    );
    expect(loaded.body).toBe(body);
    expect(decrypt).toHaveBeenCalledOnce();

    await ctx.prisma.transcript.update({
      where: { id: 'post-transcript' }, data: { contentEnc: enc('changed') },
    });
    decrypt.mockClear();
    await expect(loadAuthorizedPostMeetingSource(
      ctx.prisma, policy, inputFor(ctx, source), { decrypt },
    )).rejects.toMatchObject({ code: 'post_meeting_source_fingerprint_mismatch' });
    expect(decrypt).not.toHaveBeenCalled();

    await ctx.prisma.transcript.update({
      where: { id: 'post-transcript' }, data: { contentEnc: '', status: 'redacted' },
    });
    await ctx.prisma.sourceArtifact.update({
      where: { id: source.id }, data: { retentionState: 'degraded' },
    });
    await expect(loadAuthorizedPostMeetingSource(
      ctx.prisma, policy, inputFor(ctx, source), { decrypt },
    )).rejects.toMatchObject({ code: 'post_meeting_source_unavailable' });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('rejects reference-only/deleted sources and an oversized body without returning content', async () => {
    const { ctx, source } = await createNoteSource('x'.repeat(65));
    await expect(loadAuthorizedPostMeetingSource(
      ctx.prisma,
      policy,
      inputFor(ctx, source),
      { maxBodyBytes: 64 },
    )).rejects.toMatchObject({ code: 'post_meeting_source_too_large' });

    await ctx.prisma.sourceArtifact.update({
      where: { id: source.id }, data: { retentionState: 'deleted' },
    });
    await expect(loadAuthorizedPostMeetingSource(
      ctx.prisma, policy, inputFor(ctx, source),
    )).rejects.toMatchObject({ code: 'post_meeting_source_unavailable' });

    const external = await ctx.prisma.sourceArtifact.create({ data: {
      id: 'source-reference-only',
      tenantId: ctx.tenant.id,
      accountId: 'post-account',
      matterId: 'post-matter',
      backingKind: 'external_reference',
      backingId: 'source-reference-only',
      artifactKind: 'external_reference',
      source: 'manual',
      externalRef: 'external-1',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(ctx.owner.id)}`,
      title: 'Reference only',
      fingerprintKind: 'reference_sha256_v1',
      sourceFingerprint: 'a'.repeat(64),
      retentionState: 'reference_only',
      createdByUserId: ctx.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });
    await expect(loadAuthorizedPostMeetingSource(ctx.prisma, policy, {
      ...inputFor(ctx, source), sourceArtifactId: external.id,
    })).rejects.toMatchObject({ code: 'post_meeting_source_unavailable' });
  });
});

const transcriptBody = [
  '王总明确表示由李经理负责技术评估。',
  '李经理将负责技术评估，王总授予其技术决策建议权。',
  '项目优先级调整为 high。',
  '李经理对方案表达明确支持。',
  '我们承诺周五前发送技术方案。',
].join('\n');

const validModelResponse = JSON.stringify({
  items: [
    {
      kind: 'person', ref: 'li', quote: '王总明确表示由李经理负责技术评估。', confidence: 0.86,
      name: '李经理', title: '技术负责人',
    },
    {
      kind: 'relation', ref: 'wang-li', quote: '李经理将负责技术评估，王总授予其技术决策建议权。', confidence: 0.82,
      sourcePerson: { kind: 'existing_person', personId: 'person-wang' },
      targetPerson: { kind: 'new_person', personRef: 'li' },
      layer: 'L2', label: '业务授权',
    },
    {
      kind: 'field', ref: 'priority', quote: '项目优先级调整为 high。', confidence: 0.91,
      target: { kind: 'matter', field: 'priority' }, proposedValue: 'high',
    },
    {
      kind: 'evidence', ref: 'li-support', quote: '李经理对方案表达明确支持。', confidence: 0.8,
      person: { kind: 'new_person', personRef: 'li' }, signalKey: 'technical_owner',
      direction: 1, tier: 'strong', occurredAt: '2026-08-25T18:00:00.000Z',
    },
    {
      kind: 'commitment', ref: 'send-proposal', quote: '我们承诺周五前发送技术方案。', confidence: 0.95,
      personId: 'person-wang', title: '周五前发送技术方案', kindKey: 'follow_up',
      confirmationStatus: 'not_required', scheduledAtUtc: '2026-08-28T02:00:00.000Z',
      dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
      confirmationDueAtUtc: null,
    },
  ],
});

const extractionContext = {
  tenantId: 'tenant-1',
  actorId: 'user-1',
  runId: 'agent-run-1',
  customerId: 'post-account',
  matterId: 'post-matter',
  sourceArtifactId: 'source-1',
  body: transcriptBody,
  people: [
    { id: 'person-wang', name: '王总', title: '总经理', version: 2 },
    { id: 'person-zhao', name: '赵经理', title: '采购经理', version: 1 },
  ],
};

describe('SAAS-202 strict model response normalization', () => {
  it('normalizes all five kinds, derives locators/IDs and preserves exact evidence', () => {
    const batch = parsePostMeetingModelResponse(validModelResponse, extractionContext);
    expect(batch).toMatchObject({
      customerId: 'post-account',
      matterId: 'post-matter',
      sourceArtifactId: 'source-1',
      items: [
        { kind: 'person', itemRef: 'item-001', sourceQuote: '王总明确表示由李经理负责技术评估。' },
        {
          kind: 'relation', itemRef: 'item-002',
          sourcePerson: { kind: 'existing_person', personId: 'person-wang' },
          targetPerson: { kind: 'new_person', itemRef: 'item-001' },
        },
        { kind: 'field', itemRef: 'item-003', target: { kind: 'matter', field: 'priority' } },
        { kind: 'evidence', itemRef: 'item-004', person: { kind: 'new_person', itemRef: 'item-001' } },
        {
          kind: 'commitment', itemRef: 'item-005',
          command: { type: 'CREATE_COMMITMENT', commitment: {
            customerId: 'post-account', matterId: 'post-matter', personId: 'person-wang',
            ownerUserId: 'user-1', source: 'review_batch_candidate',
          } },
        },
      ],
    });
    for (const [index, item] of batch.items.entries()) {
      expect(item.sourceLocator).toMatch(new RegExp(`^item-00${index + 1}:chars:[0-9]+-[0-9]+$`));
      expect(transcriptBody).toContain(item.sourceQuote);
    }
    const commitment = batch.items[4];
    expect(commitment?.kind).toBe('commitment');
    if (commitment?.kind === 'commitment') {
      expect(commitment.command.commitment.id).toMatch(/^commit_[a-f0-9]{32}$/);
      expect(commitment.command.commitment.sourceRef).toBe('post-meeting:agent-run-1:item-005');
    }
  });

  it('rejects markdown, unknown keys, invented people, unsupported fields and ungrounded quotes', () => {
    expect(() => parsePostMeetingModelResponse(`\`\`\`json\n${validModelResponse}\n\`\`\``, extractionContext))
      .toThrowError(AgentPreparationError);
    const parsed = JSON.parse(validModelResponse) as { items: Array<Record<string, unknown>> };
    expect(() => parsePostMeetingModelResponse(JSON.stringify({ ...parsed, provider: 'raw' }), extractionContext))
      .toThrowError(AgentPreparationError);
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: [{ ...parsed.items[0], personId: 'invented-formal-id' }],
    }), extractionContext)).toThrowError(AgentPreparationError);
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: [{
        ...parsed.items[1],
        sourcePerson: { kind: 'existing_person', personId: 'person-invented' },
      }],
    }), extractionContext)).toThrowError(AgentPreparationError);
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: [{
        ...parsed.items[2],
        target: { kind: 'customer', field: 'customerType' },
      }],
    }), extractionContext)).toThrowError(AgentPreparationError);
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: [{ ...parsed.items[0], quote: '模型编造的原句' }],
    }), extractionContext)).toThrowError(AgentPreparationError);
  });

  it('rejects duplicate logical refs, unresolved new people and more than 20 outputs', () => {
    const parsed = JSON.parse(validModelResponse) as { items: Array<Record<string, unknown>> };
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: [parsed.items[0], { ...parsed.items[0], name: '另一个人' }],
    }), extractionContext)).toThrowError(AgentPreparationError);
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: [{
        ...parsed.items[1],
        targetPerson: { kind: 'new_person', personRef: 'missing' },
      }],
    }), extractionContext)).toThrowError(AgentPreparationError);
    expect(() => parsePostMeetingModelResponse(JSON.stringify({
      items: Array.from({ length: 21 }, (_, index) => ({
        ...parsed.items[0], ref: `person-${index}`, name: `Person ${index}`,
      })),
    }), extractionContext)).toThrowError(AgentPreparationError);
  });
});

describe('SAAS-202 production post-meeting handler', () => {
  let test: TestContext | null = null;

  afterEach(async () => test?.cleanup());

  async function setupHandler(modelResponse: string | null = validModelResponse) {
    test = await createTestContext({ agentHandlers: {} });
    await test.prisma.account.create({ data: {
      id: 'post-account', tenantId: test.tenant.id, name: '海岳能源',
      categoryKey: 'strategic', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'post-matter', tenantId: test.tenant.id, accountId: 'post-account',
      name: '储能项目', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: 'person-wang', tenantId: test.tenant.id, accountId: 'post-account',
      name: '王总', title: '总经理', version: 2,
    } });
    await test.prisma.note.create({ data: {
      id: 'post-note', tenantId: test.tenant.id, accountId: 'post-account',
      opportunityId: 'post-matter', content: transcriptBody, source: 'manual',
      createdBy: test.owner.id, createdByUserId: test.owner.id,
      visibility: 'private', aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForNote(test.prisma, test.tenant.id, 'post-note');
    const complete = vi.fn(async (
      _config: { baseUrl: string; model: string; apiKey: string },
      _system: string,
      _user: string,
      _maxTokens?: number,
    ) => modelResponse ?? '');
    const loadConfig = vi.fn(async () => (modelResponse === null ? null : ({
      provider: 'openai-compatible', baseUrl: 'https://model.example.test/v1',
      model: 'tenant-model', apiKey: 'TEST_KEY_NOT_PERSISTED',
    })));
    const handler = createPostMeetingHandler({
      db: test.prisma,
      policy,
      loadAiConfig: loadConfig,
      callLLM: complete,
    });
    const definition = builtInAgentDefinition('post_meeting_extract', 'core-206.v1');
    if (!definition) throw new Error('post-meeting definition missing');
    const context: AgentPreparationContext = {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      requestId: 'request-1',
      runId: 'agent-run-1',
      definition,
      limits: { maxCostUnits: 2_000, timeoutMs: 45_000, maxAttempts: 2 },
      customerId: 'post-account',
      matterId: 'post-matter',
      sourceArtifactId: source.id,
      inputRefs: [
        { kind: 'customer', id: 'post-account', version: 0 },
        { kind: 'matter', id: 'post-matter', version: 0 },
        { kind: 'source_artifact', id: source.id, version: source.aclVersion },
      ] as const,
      attempt: 1,
      budgetRemaining: 2_000,
      signal: new AbortController().signal,
    };
    return { handler, context, source, complete, loadConfig };
  }

  it('keeps source/model payload request-local and commits only through the narrow candidate port', async () => {
    const { handler, context, source, complete } = await setupHandler();
    const prepared = await handler.prepare(context);
    expect(prepared).toHaveProperty('audit');
    expect(prepared).toHaveProperty('privateState');
    expect(JSON.stringify((prepared as { audit: unknown }).audit)).not.toContain(transcriptBody);
    expect(JSON.stringify((prepared as { audit: unknown }).audit)).not.toContain('TEST_KEY_NOT_PERSISTED');
    expect(JSON.stringify((prepared as { privateState: unknown }).privateState)).not.toContain('TEST_KEY_NOT_PERSISTED');
    expect(complete).toHaveBeenCalledOnce();
    expect(JSON.parse(complete.mock.calls[0]![2]) as Record<string, unknown>)
      .toMatchObject({ SOURCE_BODY: transcriptBody });

    const commitCandidateBatch = vi.fn(async (_batch: PostMeetingCandidateBatch) => ({
      kind: 'review_batch' as const,
      id: postMeetingReviewBatchId(context.tenantId, context.runId),
      version: 0,
    }));
    const commitContext: AgentCommitContext = {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestId: context.requestId,
      runId: context.runId,
      definition: context.definition,
      customerId: context.customerId,
      matterId: context.matterId,
      sourceArtifactId: source.id,
      inputRefs: context.inputRefs,
      authorizationFingerprint: 'a'.repeat(64),
      commitCandidateBatch,
      signal: new AbortController().signal,
    };
    const envelope = prepared as { audit: Parameters<typeof handler.commit>[1]; privateState: unknown };
    const committed = await handler.commit(commitContext, envelope.audit, envelope.privateState);
    expect(committed).toEqual(envelope.audit);
    expect(commitCandidateBatch).toHaveBeenCalledOnce();
    expect(commitCandidateBatch.mock.calls[0]?.[0]).toMatchObject({
      customerId: 'post-account', matterId: 'post-matter', sourceArtifactId: source.id,
    });
  });

  it('fails with stable codes when BYO model config is absent or provider output is invalid', async () => {
    const missing = await setupHandler(null);
    await expect(missing.handler.prepare(missing.context)).rejects.toMatchObject({
      code: 'post_meeting_ai_not_configured', retryable: false,
    });
    expect(missing.complete).not.toHaveBeenCalled();
    await test!.cleanup();
    test = null;

    const malformed = await setupHandler('{"items":[]}');
    await expect(malformed.handler.prepare(malformed.context)).rejects.toMatchObject({
      code: 'post_meeting_model_output_invalid', retryable: false,
    });
  });
});

describe('SAAS-202 transactional candidate and ReviewBatch commit', () => {
  let test: TestContext | null = null;
  const auth = (token: string, key: string) => ({
    authorization: `Bearer ${token}`,
    'idempotency-key': key,
  });

  afterEach(async () => test?.cleanup());

  const reviewKind = (kind: string) => {
    if (kind === 'person_create') return 'person' as const;
    if (kind === 'relation_create') return 'relation' as const;
    if (kind === 'field_change') return 'field' as const;
    if (kind === 'evidence_create') return 'evidence' as const;
    if (kind === 'commitment_create') return 'commitment' as const;
    throw new Error(`unexpected candidate kind: ${kind}`);
  };

  async function setup(
    adapter = createPostMeetingCandidateCommitAdapter({ policy }),
  ) {
    const handler = createPostMeetingHandler({
      db: prisma,
      policy,
      loadAiConfig: async () => ({
        provider: 'openai-compatible', baseUrl: 'https://model.example.test/v1',
        model: 'tenant-model', apiKey: 'TEST_KEY_NOT_PERSISTED',
      }),
      callLLM: async () => validModelResponse,
    });
    test = await createTestContext({
      agentHandlers: { 'post_meeting_extract@core-206.v1': handler },
      agentCandidateCommitAdapter: adapter,
    });
    await test.prisma.account.create({ data: {
      id: 'post-account', tenantId: test.tenant.id, name: '海岳能源',
      categoryKey: 'strategic', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'post-matter', tenantId: test.tenant.id, accountId: 'post-account',
      name: '储能项目', kind: 'sales_opportunity', customerType: 1,
      pipelineStage: 'lead', engageStage: 'discover', priority: 'normal',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.pdeDecisionContext.create({ data: {
      id: 'post-matter-pde-context',
      tenantId: test.tenant.id,
      opportunityId: 'post-matter',
      stageKey: 'initiation',
      source: 'system_default',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-wang', tenantId: test.tenant.id, accountId: 'post-account',
      name: '王总', title: '总经理', version: 2,
    } });
    await test.prisma.note.create({ data: {
      id: 'post-note', tenantId: test.tenant.id, accountId: 'post-account',
      opportunityId: 'post-matter', content: transcriptBody, source: 'manual',
      createdBy: test.owner.id, createdByUserId: test.owner.id,
      visibility: 'private', aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForNote(test.prisma, test.tenant.id, 'post-note');
    const control = await test.app.inject({
      method: 'PUT',
      url: '/api/agent-jobs/post_meeting_extract/control',
      headers: auth(test.token, 'post-meeting-control-enable'),
      payload: { jobVersion: 'core-206.v1', enabled: true, expectedVersion: 0 },
    });
    expect(control.statusCode, control.body).toBe(200);
    const request = {
      method: 'POST' as const,
      url: '/api/agent-jobs/post_meeting_extract/runs',
      headers: auth(test.token, 'post-meeting-run-exact-replay'),
      payload: {
        jobVersion: 'core-206.v1',
        customerId: 'post-account', matterId: 'post-matter', sourceArtifactId: source.id,
        inputRefs: [
          { kind: 'customer', id: 'post-account', version: 0 },
          { kind: 'matter', id: 'post-matter', version: 0 },
          { kind: 'source_artifact', id: source.id, version: source.aclVersion },
        ],
      },
    };
    return { source, request };
  }

  it('creates five unified candidates plus compatibility rows and one batch, with zero formal writes', async () => {
    const { source, request } = await setup();
    const formalBefore = await Promise.all([
      test!.prisma.account.count(), test!.prisma.opportunity.count(), test!.prisma.person.count(),
      test!.prisma.edge.count(), test!.prisma.planAction.count(), test!.prisma.interaction.count(),
    ]);
    const first = await test!.app.inject(request);
    const second = await test!.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const batchId = postMeetingReviewBatchId(test!.tenant.id, first.json<{ run: { id: string } }>().run.id);
    expect(first.json()).toMatchObject({
      replayed: false,
      run: {
        status: 'succeeded',
        outputRefs: [{ kind: 'review_batch', id: batchId, version: 0 }],
      },
    });
    expect(second.json()).toMatchObject({ replayed: true, run: { status: 'succeeded' } });
    expect(first.body).not.toContain(transcriptBody);

    await expect(Promise.all([
      test!.prisma.candidate.count(), test!.prisma.reviewBatch.count(),
      test!.prisma.personSuggestion.count(), test!.prisma.relSuggestion.count(),
      test!.prisma.changeProposal.count(), test!.prisma.evidenceEvent.count(),
    ])).resolves.toEqual([5, 1, 1, 1, 1, 1]);
    await expect(Promise.all([
      test!.prisma.account.count(), test!.prisma.opportunity.count(), test!.prisma.person.count(),
      test!.prisma.edge.count(), test!.prisma.planAction.count(), test!.prisma.interaction.count(),
    ])).resolves.toEqual(formalBefore);

    const batch = await test!.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch).toMatchObject({
      tenantId: test!.tenant.id,
      sourceArtifactId: source.id,
      accountId: 'post-account', matterId: 'post-matter',
      createdByUserId: test!.owner.id, visibility: 'private', aclVersion: source.aclVersion,
      status: 'pending', version: 0,
    });
    const candidates = await test!.prisma.candidate.findMany({ orderBy: { kind: 'asc' } });
    expect(candidates.map((candidate) => candidate.kind).sort()).toEqual([
      'commitment_create', 'evidence_create', 'field_change', 'person_create', 'relation_create',
    ]);
    expect(candidates.every((candidate) => (
      candidate.sourceArtifactId === source.id
      && candidate.reviewBatchId === batchId
      && candidate.createdByUserId === test!.owner.id
      && candidate.visibility === 'private'
      && candidate.aclVersion === source.aclVersion
      && candidate.version === 1
    ))).toBe(true);
    expect(await test!.prisma.changeProposal.findFirst()).toMatchObject({
      entityKind: 'matter', entityId: 'post-matter', field: 'priority',
      oldValue: '"normal"', newValue: '"high"', status: 'pending',
    });
  });

  it('returns one ACL-checked typed review sheet without arbitrary payload or source body fields', async () => {
    const { source, request } = await setup();
    const runResponse = await test!.app.inject(request);
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const batchId = postMeetingReviewBatchId(test!.tenant.id, runId);

    const detailResponse = await test!.app.inject({
      method: 'GET',
      url: `/api/review-batches/${batchId}`,
      headers: { authorization: `Bearer ${test!.token}` },
    });
    expect(detailResponse.statusCode, detailResponse.body).toBe(200);
    const detail = PostMeetingReviewBatchDetailSchema.parse(detailResponse.json());
    expect(detail).toMatchObject({
      id: batchId,
      source: {
        id: source.id,
        kind: 'note',
        fingerprint: source.sourceFingerprint,
      },
      customerId: 'post-account',
      matterId: 'post-matter',
      status: 'pending',
      activityKind: null,
      occurredAt: null,
      interactionId: null,
      acceptanceVersion: 0,
      version: 0,
    });
    expect(detail.items.map((item) => [item.itemRef, item.kind])).toEqual([
      ['item-001', 'person'],
      ['item-002', 'relation'],
      ['item-003', 'field'],
      ['item-004', 'evidence'],
      ['item-005', 'commitment'],
    ]);
    expect(detail.items.every((item) => item.status === 'pending')).toBe(true);
    expect(detail.items.every((item) => (
      item.defaultSelected === false
      && transcriptBody.includes(item.sourceQuote)
      && item.sourceLocator.startsWith(`${item.itemRef}:chars:`)
    ))).toBe(true);
    expect(detail.items[0]).toMatchObject({
      before: null,
      after: { name: '李经理', title: '技术负责人' },
    });
    expect(detail.items[2]).toMatchObject({
      target: { kind: 'matter', field: 'priority' },
      before: 'normal',
      after: 'high',
    });
    expect(detail.items[3]).toMatchObject({
      after: { person: { kind: 'new_person', itemRef: 'item-001' } },
    });
    expect(detailResponse.body).not.toContain(transcriptBody);
    expect(detailResponse.body).not.toContain('contentEnc');
    expect(detailResponse.body).not.toContain('payload');
    expect(detailResponse.body).not.toContain('provider');

    const viewer = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id,
      email: `post-review-viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: 'Post meeting viewer',
      role: 'viewer',
    } });
    const viewerToken = test!.app.jwt.sign({
      userId: viewer.id, tenantId: test!.tenant.id, role: 'viewer',
    });
    const hidden = await test!.app.inject({
      method: 'GET', url: `/api/review-batches/${batchId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    const missing = await test!.app.inject({
      method: 'GET', url: '/api/review-batches/missing-post-meeting-batch',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());
    expect(hidden.body).not.toContain(detail.items[0]!.sourceQuote);
  });

  it('accepts typed per-kind edits through the shared review request contract', async () => {
    const { request } = await setup();
    const runResponse = await test!.app.inject(request);
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const batchId = postMeetingReviewBatchId(test!.tenant.id, runId);
    const detailResponse = await test!.app.inject({
      method: 'GET', url: `/api/review-batches/${batchId}`,
      headers: { authorization: `Bearer ${test!.token}` },
    });
    const detail = PostMeetingReviewBatchDetailSchema.parse(detailResponse.json());
    const decisions = detail.items.map((item) => {
      const common = {
        kind: item.kind,
        candidateId: item.candidateId,
        expectedVersion: item.expectedVersion,
        expectedAclVersion: item.expectedAclVersion,
        decision: 'accept' as const,
      };
      if (item.kind === 'person') {
        return { ...common, kind: 'person' as const, edit: { title: '技术总监' } };
      }
      if (item.kind === 'relation') {
        return { ...common, kind: 'relation' as const, edit: { layer: 'L3' as const, label: '正式授权' } };
      }
      if (item.kind === 'field') {
        return { ...common, kind: 'field' as const, edit: { value: 'urgent' } };
      }
      if (item.kind === 'evidence') {
        return { ...common, kind: 'evidence' as const, edit: { direction: -1 as const, tier: 'weak' as const } };
      }
      return {
        ...common,
        kind: 'commitment' as const,
        edit: {
          command: {
            ...item.after,
            commitment: {
              ...item.after.commitment,
              title: '周五前发送修订技术方案',
            },
          },
        },
      };
    });
    const accepted = await test!.app.inject({
      method: 'POST',
      url: `/api/review-batches/${batchId}/accept`,
      headers: auth(test!.token, 'post-meeting-typed-review-accept'),
      payload: {
        expectedVersion: detail.version,
        expectedAcceptanceVersion: detail.acceptanceVersion,
        customerId: detail.customerId,
        matterId: detail.matterId,
        activityKind: 'customer_meeting',
        occurredAt: '2026-08-25T18:00:00.000Z',
        existingInteractionId: null,
        decisions,
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(PostMeetingReviewReceiptSchema.parse(accepted.json())).toMatchObject({
      batchId,
      status: 'accepted',
      acceptanceVersion: 1,
      version: 1,
      businessReplayed: false,
      replayed: false,
    });
    await expect(test!.prisma.person.findFirstOrThrow({
      where: { tenantId: test!.tenant.id, name: '李经理' },
    })).resolves.toMatchObject({ title: '技术总监' });
    await expect(test!.prisma.edge.findFirstOrThrow({
      where: { tenantId: test!.tenant.id },
    })).resolves.toMatchObject({ layer: 'L3', label: '正式授权' });
    await expect(test!.prisma.opportunity.findUniqueOrThrow({ where: { id: 'post-matter' } }))
      .resolves.toMatchObject({ priority: 'urgent', version: 1 });
    await expect(test!.prisma.evidenceEvent.findFirstOrThrow({
      where: { tenantId: test!.tenant.id },
    })).resolves.toMatchObject({ direction: -1, tier: 'weak', status: 'approved' });
    await expect(test!.prisma.planAction.findFirstOrThrow({
      where: { tenantId: test!.tenant.id },
    })).resolves.toMatchObject({ title: '周五前发送修订技术方案' });
  });

  it('fails closed when a post-meeting candidate has a malformed source identity', async () => {
    const { request } = await setup();
    const runResponse = await test!.app.inject(request);
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const batchId = postMeetingReviewBatchId(test!.tenant.id, runId);
    const [batch, person] = await Promise.all([
      test!.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } }),
      test!.prisma.candidate.findFirstOrThrow({
        where: { tenantId: test!.tenant.id, reviewBatchId: batchId, kind: 'person_create' },
      }),
    ]);
    await test!.prisma.candidate.update({
      where: { id: person.id },
      data: { sourceRef: 'post-meeting:damaged-source-identity' },
    });

    await expect(test!.prisma.$transaction((tx) => acceptReviewBatch(tx, {
      tenantId: test!.tenant.id,
      actorId: test!.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'post-meeting-malformed-source',
      assertionMode: 'user_asserted',
    }, policy, batch.id, {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId: 'post-account',
      matterId: 'post-matter',
      activityKind: 'customer_meeting',
      occurredAt: new Date('2026-08-25T18:00:00.000Z'),
      decisions: [{
        candidateId: person.id,
        expectedVersion: person.version,
        expectedAclVersion: person.aclVersion,
        decision: 'accept',
      }],
    }))).rejects.toMatchObject({
      code: 'review_batch_conflict',
      items: [{
        candidateId: person.id,
        status: 'conflict',
        reason: 'candidate_kind_conflict',
      }],
    });
    await expect(test!.prisma.person.count({ where: { name: '李经理' } })).resolves.toBe(0);
    await expect(test!.prisma.interaction.count()).resolves.toBe(0);
  });

  it('rolls back every candidate, compatibility row and batch when the adapter throws', async () => {
    const real = createPostMeetingCandidateCommitAdapter({ policy });
    const { request } = await setup(async (context, batch) => {
      await real(context, batch);
      throw new Error('forced post-meeting adapter failure');
    });
    const response = await test!.app.inject({
      ...request,
      headers: auth(test!.token, 'post-meeting-run-forced-rollback'),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ run: { status: 'failed', failureCode: 'agent_commit_failed' } });
    await expect(Promise.all([
      test!.prisma.candidate.count(), test!.prisma.reviewBatch.count(),
      test!.prisma.personSuggestion.count(), test!.prisma.relSuggestion.count(),
      test!.prisma.changeProposal.count(), test!.prisma.evidenceEvent.count(),
    ])).resolves.toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('human acceptance materializes all five kinds atomically, including a schema-parsed Matter field', async () => {
    const { request } = await setup();
    const runResponse = await test!.app.inject(request);
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const batchId = postMeetingReviewBatchId(test!.tenant.id, runId);
    const [batch, candidates] = await Promise.all([
      test!.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } }),
      test!.prisma.candidate.findMany({ where: { reviewBatchId: batchId }, orderBy: { id: 'asc' } }),
    ]);
    const receipt = await test!.prisma.$transaction((tx) => acceptReviewBatch(tx, {
      tenantId: test!.tenant.id,
      actorId: test!.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'post-meeting-human-accept',
      assertionMode: 'user_asserted',
    }, policy, batch.id, {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId: 'post-account',
      matterId: 'post-matter',
      activityKind: 'customer_meeting',
      occurredAt: new Date('2026-08-25T18:00:00.000Z'),
      decisions: candidates.map((candidate) => ({
        kind: reviewKind(candidate.kind),
        candidateId: candidate.id,
        expectedVersion: candidate.version,
        expectedAclVersion: candidate.aclVersion,
        decision: 'accept' as const,
      })),
    })).catch((error: unknown) => {
      if (error instanceof ReviewBatchConflictError) {
        throw new Error(`unexpected review conflict: ${JSON.stringify(error.items.map((item) => ({
          ...item,
          kind: candidates.find((candidate) => candidate.id === item.candidateId)?.kind,
        })))}`);
      }
      throw error;
    });
    expect(receipt).toMatchObject({
      batchId,
      status: 'accepted',
      acceptanceVersion: 1,
      version: 1,
      businessReplayed: false,
    });
    expect(receipt.items).toHaveLength(5);
    expect(receipt.items.every((item) => item.status === 'accepted' && item.formalId)).toBe(true);

    const [matter, people, edges, evidence, commitments, interactions, terminalCandidates] = await Promise.all([
      test!.prisma.opportunity.findUniqueOrThrow({ where: { id: 'post-matter' } }),
      test!.prisma.person.findMany({ where: { tenantId: test!.tenant.id }, orderBy: { id: 'asc' } }),
      test!.prisma.edge.findMany({ where: { tenantId: test!.tenant.id } }),
      test!.prisma.evidenceEvent.findMany({ where: { tenantId: test!.tenant.id } }),
      test!.prisma.planAction.findMany({ where: { tenantId: test!.tenant.id } }),
      test!.prisma.interaction.findMany({ where: { tenantId: test!.tenant.id } }),
      test!.prisma.candidate.findMany({ where: { reviewBatchId: batchId } }),
    ]);
    expect(matter).toMatchObject({ priority: 'high', version: 1 });
    expect(people).toHaveLength(2);
    expect(people.some((person) => person.name === '李经理' && person.title === '技术负责人')).toBe(true);
    expect(edges).toHaveLength(1);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ status: 'approved', signalKey: 'technical_owner' });
    expect(people.some((person) => person.id === evidence[0]!.personId)).toBe(true);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ title: '周五前发送技术方案', source: 'review_batch' });
    expect(interactions).toHaveLength(1);
    expect(terminalCandidates.every((candidate) => candidate.status === 'accepted')).toBe(true);
  });

  it('a stale formal before-value produces one batch conflict and zero partial human-review writes', async () => {
    const { request } = await setup();
    const runResponse = await test!.app.inject(request);
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const batchId = postMeetingReviewBatchId(test!.tenant.id, runId);
    const [batch, candidates] = await Promise.all([
      test!.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batchId } }),
      test!.prisma.candidate.findMany({ where: { reviewBatchId: batchId }, orderBy: { id: 'asc' } }),
    ]);
    await test!.prisma.opportunity.update({
      where: { id: 'post-matter' },
      data: { priority: 'externally_changed', version: { increment: 1 } },
    });
    const attempt = test!.prisma.$transaction((tx) => acceptReviewBatch(tx, {
      tenantId: test!.tenant.id,
      actorId: test!.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'post-meeting-stale-field',
      assertionMode: 'user_asserted',
    }, policy, batch.id, {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId: 'post-account',
      matterId: 'post-matter',
      activityKind: 'customer_meeting',
      occurredAt: new Date('2026-08-25T18:00:00.000Z'),
      decisions: candidates.map((candidate) => ({
        kind: reviewKind(candidate.kind),
        candidateId: candidate.id,
        expectedVersion: candidate.version,
        expectedAclVersion: candidate.aclVersion,
        decision: 'accept' as const,
      })),
    }));
    await expect(attempt).rejects.toBeInstanceOf(ReviewBatchConflictError);
    await expect(Promise.all([
      test!.prisma.person.count(),
      test!.prisma.edge.count(),
      test!.prisma.planAction.count(),
      test!.prisma.interaction.count(),
      test!.prisma.candidate.count({ where: { reviewBatchId: batchId, status: 'pending' } }),
    ])).resolves.toEqual([1, 0, 0, 0, 5]);
    await expect(test!.prisma.opportunity.findUniqueOrThrow({ where: { id: 'post-matter' } }))
      .resolves.toMatchObject({ priority: 'externally_changed', version: 1 });
  });

  it('lets a currently scoped member extract a shared source and grants only that actor review access', async () => {
    const { source, request } = await setup();
    const member = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id,
      email: `post-member-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: 'Shared source reviewer',
      role: 'member',
    } });
    const memberToken = test!.app.jwt.sign({
      userId: member.id, tenantId: test!.tenant.id, role: 'member',
    });
    const shared = await test!.app.inject({
      method: 'PUT',
      url: `/api/source-artifacts/${source.id}/visibility`,
      headers: auth(test!.token, 'post-meeting-source-share'),
      payload: { visibility: 'matter_shared', expectedAclVersion: source.aclVersion },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const sharedAclVersion = shared.json<{ aclVersion: number }>().aclVersion;
    const response = await test!.app.inject({
      ...request,
      headers: auth(memberToken, 'post-meeting-shared-member-run'),
      payload: {
        ...request.payload,
        inputRefs: request.payload.inputRefs.map((ref) => (
          ref.kind === 'source_artifact' ? { ...ref, version: sharedAclVersion } : ref
        )),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ run: { status: 'succeeded' } });
    const runId = response.json<{ run: { id: string } }>().run.id;
    const batchId = postMeetingReviewBatchId(test!.tenant.id, runId);
    const candidates = await test!.prisma.candidate.findMany({ where: { reviewBatchId: batchId } });
    expect(candidates).toHaveLength(5);
    expect(candidates.every((candidate) => (
      candidate.createdByUserId === test!.owner.id
      && candidate.visibility === 'matter_shared'
      && candidate.aclVersion === sharedAclVersion
    ))).toBe(true);
    await expect(test!.prisma.sensitiveResourceGrant.count({ where: {
      tenantId: test!.tenant.id,
      granteeUserId: member.id,
      resourceKind: 'candidate',
      grantKind: 'reviewer',
      resourceAclVersion: sharedAclVersion,
      revokedAt: null,
    } })).resolves.toBe(5);
    await expect(readableReviewBatchById(test!.prisma, {
      tenantId: test!.tenant.id,
      actorId: member.id,
      actorRole: 'member',
      channel: 'web',
      requestId: 'post-meeting-shared-review-read',
      assertionMode: 'user_asserted',
    }, policy, batchId, 'review')).resolves.not.toBeNull();
  });
});
