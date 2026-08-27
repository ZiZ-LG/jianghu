import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { enc } from '../src/ai.js';
import { AgentPreparationError } from '../src/agents/model.js';
import { loadPreMeetingSources } from '../src/preMeeting/source.js';
import {
  ensureSourceArtifactForNote,
  ensureSourceArtifactForTranscript,
} from '../src/sourceArtifacts/service.js';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const policy = assembleProductAccess({ edition: 'internal' }).policy;
const generatedAt = new Date('2026-08-27T08:00:00.000Z');

describe('SAAS-205 authorized pre-meeting sources', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  async function setup() {
    test = await createTestContext({ agentHandlers: {} });
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
    return test;
  }

  async function createNoteBundle() {
    const ctx = await setup();
    const body = '客户要求下周确认技术评审参会人，预算审批人尚未明确。';
    await ctx.prisma.note.create({ data: {
      id: 'note-205', tenantId: ctx.tenant.id, accountId: 'customer-205',
      opportunityId: 'matter-205', content: body, source: 'manual',
      createdBy: ctx.owner.id, createdByUserId: ctx.owner.id,
      visibility: 'private', aclVersion: 1,
      createdAt: new Date('2026-08-27T06:00:00.000Z'),
    } });
    const source = await ensureSourceArtifactForNote(ctx.prisma, ctx.tenant.id, 'note-205');
    return { ctx, source, body };
  }

  function input(ctx: TestContext, source: { id: string; aclVersion: number }) {
    return {
      tenantId: ctx.tenant.id,
      actorId: ctx.owner.id,
      customerId: 'customer-205',
      matterId: 'matter-205',
      sourceArtifactId: source.id,
      generatedAt,
      inputRefs: [
        { kind: 'customer' as const, id: 'customer-205', version: 4 },
        { kind: 'matter' as const, id: 'matter-205', version: 3 },
        { kind: 'source_artifact' as const, id: source.id, version: source.aclVersion },
      ],
    };
  }

  it('loads one exact body plus current CRM and attributable curated inputs', async () => {
    const { ctx, source, body } = await createNoteBundle();
    const human = await ctx.prisma.curatedSummary.create({ data: {
      id: 'curated-human-205', tenantId: ctx.tenant.id, entityKind: 'account',
      entityId: 'customer-205', content: '客户战略方向由人工确认。',
      editedByHuman: true, editedBy: ctx.owner.id, aclVersion: 0,
      updatedAt: new Date('2026-08-27T06:30:00.000Z'),
    } });
    const ai = await ctx.prisma.curatedSummary.create({ data: {
      id: 'curated-ai-205', tenantId: ctx.tenant.id, entityKind: 'opportunity',
      entityId: 'matter-205', content: '旧 AI 缓存，仅作待核输入。', model: 'legacy-model',
      editedByHuman: false, aclVersion: 1,
      updatedAt: new Date('2026-08-27T06:40:00.000Z'),
    } });

    const loaded = await loadPreMeetingSources(ctx.prisma, policy, input(ctx, source));

    expect(loaded.subject).toMatchObject({
      status: 'matched', query: '海岳能源', crmCustomerId: 'customer-205',
      selected: {
        anchorKind: 'unified_credit_code', anchorValue: '91110108SAAS205',
        provider: 'jianghu-crm',
      },
    });
    expect(loaded.sources.map((item) => item.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'crm-customer', kind: 'crm_fact', refId: 'customer-205@4', version: 4 }),
      expect.objectContaining({ id: 'crm-matter', kind: 'crm_fact', refId: 'matter-205@3', version: 3 }),
      expect.objectContaining({
        id: 'source-artifact', kind: 'source_artifact', refId: source.id,
        version: source.aclVersion, fingerprint: source.sourceFingerprint,
      }),
      expect.objectContaining({
        id: 'curated-account', kind: 'curated_human', refId: human.id,
        label: expect.stringContaining('人工'),
      }),
      expect.objectContaining({
        id: 'curated-matter', kind: 'curated_ai_cache', refId: ai.id,
        label: expect.stringContaining('兼容资料输入'),
      }),
    ]));
    expect(loaded.sources.find((item) => item.metadata.id === 'source-artifact')?.content).toBe(body);
    expect(loaded.sources.find((item) => item.metadata.id === 'curated-account')?.content).toBe(human.content);
    expect(loaded.sources.find((item) => item.metadata.id === 'curated-matter')?.content).toBe(ai.content);
    expect(loaded.evidence).toEqual({
      sourceArtifactId: source.id,
      locatorId: 'pre-meeting-source',
      sourceFingerprint: source.sourceFingerprint,
      observedAt: source.occurredAt?.toISOString() ?? source.createdAt.toISOString(),
    });
    expect(JSON.stringify(loaded.sources.map((item) => item.metadata))).not.toContain(body);
    expect(JSON.stringify(loaded)).not.toContain('person');
  });

  it('excludes empty, unattributed-human and unsafe legacy AI summaries', async () => {
    const { ctx, source } = await createNoteBundle();
    await ctx.prisma.curatedSummary.create({ data: {
      id: 'curated-unsafe-account', tenantId: ctx.tenant.id, entityKind: 'account',
      entityId: 'customer-205', content: '没有同租户编辑者的伪人工摘要',
      editedByHuman: true, editedBy: 'missing-user', aclVersion: 1,
    } });
    await ctx.prisma.curatedSummary.create({ data: {
      id: 'curated-unsafe-matter', tenantId: ctx.tenant.id, entityKind: 'opportunity',
      entityId: 'matter-205', content: '旧 AI 内容', model: 'legacy',
      editedByHuman: false, aclVersion: 0,
    } });

    const loaded = await loadPreMeetingSources(ctx.prisma, policy, input(ctx, source));
    expect(loaded.sources.map((item) => item.metadata.kind)).toEqual([
      'crm_fact', 'crm_fact', 'source_artifact',
    ]);
  });

  it('decrypts an exact Transcript only after fingerprint and ACL checks', async () => {
    const ctx = await setup();
    const body = '转写正文：技术评审定在周三。';
    const ciphertext = enc(body);
    await ctx.prisma.transcript.create({ data: {
      id: 'transcript-205', tenantId: ctx.tenant.id, accountId: 'customer-205',
      opportunityId: 'matter-205', source: 'manual',
      idempotencyDomain: `creator-private-v1:${JSON.stringify(ctx.owner.id)}`,
      title: '拜访转写', contentEnc: ciphertext,
      recordedAt: new Date('2026-08-27T05:00:00.000Z'),
      createdBy: ctx.owner.id, createdByUserId: ctx.owner.id,
      visibility: 'private', aclVersion: 1,
    } });
    const source = await ensureSourceArtifactForTranscript(
      ctx.prisma, ctx.tenant.id, 'transcript-205',
    );
    const decrypt = vi.fn((value: string) => value === ciphertext ? body : '');

    const loaded = await loadPreMeetingSources(
      ctx.prisma, policy, input(ctx, source), { decrypt },
    );
    expect(loaded.sources.find((item) => item.metadata.id === 'source-artifact')?.content).toBe(body);
    expect(decrypt).toHaveBeenCalledOnce();

    await ctx.prisma.transcript.update({
      where: { id: 'transcript-205' }, data: { contentEnc: enc('tampered') },
    });
    decrypt.mockClear();
    await expect(loadPreMeetingSources(
      ctx.prisma, policy, input(ctx, source), { decrypt },
    )).rejects.toMatchObject({ code: 'post_meeting_source_fingerprint_mismatch' });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('fails closed on tenant, hidden creator, stale anchors and unavailable retention', async () => {
    const { ctx, source } = await createNoteBundle();
    const staleCases = [
      { inputRefs: input(ctx, source).inputRefs.map((ref) => ref.kind === 'customer' ? { ...ref, version: 3 } : ref) },
      { inputRefs: input(ctx, source).inputRefs.map((ref) => ref.kind === 'matter' ? { ...ref, version: 2 } : ref) },
      { inputRefs: input(ctx, source).inputRefs.map((ref) => ref.kind === 'source_artifact' ? { ...ref, version: 2 } : ref) },
    ];
    for (const drift of staleCases) {
      await expect(loadPreMeetingSources(ctx.prisma, policy, {
        ...input(ctx, source), ...drift,
      })).rejects.toBeInstanceOf(AgentPreparationError);
    }

    const member = await ctx.prisma.user.create({ data: {
      tenantId: ctx.tenant.id, email: `member-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Member', role: 'member',
    } });
    await ctx.prisma.account.update({
      where: { id: 'customer-205' }, data: { primaryOwnerUserId: member.id },
    });
    await expect(loadPreMeetingSources(ctx.prisma, policy, {
      ...input(ctx, source), actorId: member.id,
    })).rejects.toMatchObject({ code: 'post_meeting_source_not_found' });

    const otherTenant = await ctx.prisma.tenant.create({ data: { id: 'other-205', name: 'Other' } });
    const otherOwner = await ctx.prisma.user.create({ data: {
      tenantId: otherTenant.id, email: `other-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Other', role: 'owner',
    } });
    await expect(loadPreMeetingSources(ctx.prisma, policy, {
      ...input(ctx, source), tenantId: otherTenant.id, actorId: otherOwner.id,
    })).rejects.toMatchObject({ code: 'post_meeting_source_not_found' });

    await ctx.prisma.sourceArtifact.update({
      where: { id: source.id }, data: { retentionState: 'degraded' },
    });
    try {
      await loadPreMeetingSources(ctx.prisma, policy, input(ctx, source));
      throw new Error('expected degraded source to fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentPreparationError);
      expect(['post_meeting_source_unavailable', 'post_meeting_source_not_found'])
        .toContain((error as AgentPreparationError).code);
    }
  });
});
