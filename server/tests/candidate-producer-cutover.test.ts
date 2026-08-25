import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { CommandContext } from '@jianghu/domain-contracts';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { ingestVoiceText } from '../src/voice.js';
import {
  claimNextJob,
  enqueueEnrichJob,
  writeEnrichCandidates,
} from '../src/jobs.js';
import { generateRelSuggestions } from '../src/suggest.js';
import { syncIntelBundle } from '../src/mcp/syncBundle.js';
import { handleMcpBody } from '../src/mcpServer.js';
import { internalProductPolicy } from './helpers/productPolicy.js';

describe('CORE-202 Candidate producer cutover', () => {
  let test: TestContext;
  let ctx: CommandContext;

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'core-202-producer',
      assertionMode: 'user_asserted',
    };
  });

  afterEach(async () => test.cleanup());

  async function seedTree(suffix: string) {
    const accountId = `core-202-producer-account-${suffix}`;
    const matterId = `core-202-producer-matter-${suffix}`;
    await test.prisma.account.create({ data: {
      id: accountId,
      tenantId: test.tenant.id,
      name: `Producer Account ${suffix}`,
      customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId,
      tenantId: test.tenant.id,
      accountId,
      name: `Producer Matter ${suffix}`,
      customerType: 2,
      pipelineStage: '线索',
      engageStage: '需求调研立项',
    } });
    return { accountId, matterId };
  }

  it('writes voice person/relation extraction only as replay-safe Candidates plus legacy projections', async () => {
    const tree = await seedTree('voice');
    const voiceCtx = { ...ctx, requestId: 'core-202-voice-request' };
    const extracted = {
      account: null,
      opportunity: null,
      persons: [
        { name: '语音候选甲', title: '负责人', kind: 'inferred', confidence: 0.72, evidence: '录音提到甲负责技术评审' },
        { name: '语音候选乙', title: '使用部门', kind: 'inferred', confidence: 0.68, evidence: '录音提到乙参与使用评估' },
      ],
      relationships: [{
        source: '语音候选甲',
        target: '语音候选乙',
        layer: 'L3',
        label: '可能影响',
        kind: 'inferred',
        confidence: 0.64,
        evidence: '原句表示甲可能影响乙的意见',
      }],
      burningIssues: [],
      ucvs: [],
      evidences: [],
      rawNote: '用于 CORE-202 的虚构口述测试',
    };

    const first = await ingestVoiceText(voiceCtx, {
      text: '用于 CORE-202 的虚构口述测试',
      accountId: tree.accountId,
      opportunityId: tree.matterId,
    }, test.prisma, { extracted });
    const replay = await ingestVoiceText(voiceCtx, {
      text: '用于 CORE-202 的虚构口述测试',
      accountId: tree.accountId,
      opportunityId: tree.matterId,
    }, test.prisma, { extracted });

    expect(first).toMatchObject({ ok: true, receipt: { candidates: {
      persons: [{ name: '语音候选甲' }, { name: '语音候选乙' }],
      relationships: [{ source: '语音候选甲', target: '语音候选乙', label: '可能影响' }],
    } } });
    expect(replay).toMatchObject({ ok: true });
    const candidates = await test.prisma.candidate.findMany({
      where: { tenantId: test.tenant.id },
      orderBy: [{ kind: 'asc' }, { sourceRef: 'asc' }],
    });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'person_create', 'person_create', 'relation_create',
    ]);
    expect(candidates.map((candidate) => candidate.sourceRef)).toEqual([
      'voice:core-202-voice-request:person:0',
      'voice:core-202-voice-request:person:1',
      'voice:core-202-voice-request:relation:0',
    ]);
    for (const candidate of candidates) expect(candidate).toMatchObject({
      tenantId: test.tenant.id,
      accountId: tree.accountId,
      matterId: tree.matterId,
      status: 'pending',
      source: 'voice',
      createdByUserId: test.owner.id,
      visibility: 'private',
      version: 0,
    });
    expect(candidates.every((candidate) => candidate.evidence.trim().length > 0)).toBe(true);
    await expect(test.prisma.personSuggestion.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(2);
    await expect(test.prisma.relSuggestion.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.person.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
    await expect(test.prisma.edge.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
  });

  it('writes enrich discoveries through one Candidate authority and dedupes within the claimed job transaction', async () => {
    const tree = await seedTree('enrich');
    const enqueued = await enqueueEnrichJob(test.tenant.id, tree.accountId, 'auto', test.prisma);
    const claimed = await claimNextJob('core-202-enrich-worker', new Date(Date.now() + 1_000), test.prisma);
    expect(claimed?.id).toBe(enqueued.id);

    await expect(writeEnrichCandidates(claimed!, 'qcc', [
      { name: '企查查候选人', title: '部门经理' },
      { name: '企查查候选人', title: '部门总监' },
    ], '虚构企查查测试结果')).resolves.toEqual({ created: 1, deduped: 1, skipped: 0 });

    const legacy = await test.prisma.personSuggestion.findFirstOrThrow({ where: {
      tenantId: test.tenant.id,
      accountId: tree.accountId,
      name: '企查查候选人',
    } });
    expect(legacy).toMatchObject({ title: '部门总监', origin: 'qcc', status: 'pending', confidence: 0.6 });
    const candidate = await test.prisma.candidate.findUniqueOrThrow({ where: {
      tenantId_legacySourceKind_legacySourceId: {
        tenantId: test.tenant.id,
        legacySourceKind: 'PersonSuggestion',
        legacySourceId: legacy.id,
      },
    } });
    expect(candidate).toMatchObject({
      kind: 'person_create',
      accountId: tree.accountId,
      matterId: null,
      source: 'qcc',
      createdByUserId: null,
      visibility: 'owner_admin_only',
      confidence: 0.6,
      status: 'pending',
      version: 1,
    });
    expect(candidate.sourceRef).toContain(`enrich:${claimed!.id}:qcc:`);
    expect(candidate.evidence).toContain('企查查');
    expect(JSON.parse(candidate.payload)).toMatchObject({ title: '部门总监', legacyStatus: 'pending' });
    await expect(test.prisma.candidate.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.person.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
    await expect(test.prisma.enrichJob.findUniqueOrThrow({ where: { id: claimed!.id } }))
      .resolves.toMatchObject({ status: 'done' });
  });

  it('writes graph suggestions as Candidate projections and replays without another relation or Edge', async () => {
    const tree = await seedTree('suggest');
    const [left, right, commonA, commonB] = ['left', 'right', 'common-a', 'common-b']
      .map((name) => `core-202-suggest-${name}`);
    await test.prisma.person.createMany({ data: [
      { id: left, tenantId: test.tenant.id, accountId: tree.accountId, name: '左侧人物', title: '' },
      { id: right, tenantId: test.tenant.id, accountId: tree.accountId, name: '右侧人物', title: '' },
      { id: commonA, tenantId: test.tenant.id, accountId: tree.accountId, name: '共同联系人甲', title: '', isCompetitor: true },
      { id: commonB, tenantId: test.tenant.id, accountId: tree.accountId, name: '共同联系人乙', title: '', isCompetitor: true },
    ] });
    await test.prisma.edge.createMany({ data: [
      { id: 'core-202-edge-left-a', tenantId: test.tenant.id, accountId: tree.accountId, opportunityId: tree.matterId, source: left, target: commonA, layer: 'L2', label: '已知' },
      { id: 'core-202-edge-right-a', tenantId: test.tenant.id, accountId: tree.accountId, opportunityId: tree.matterId, source: right, target: commonA, layer: 'L2', label: '已知' },
      { id: 'core-202-edge-left-b', tenantId: test.tenant.id, accountId: tree.accountId, opportunityId: tree.matterId, source: left, target: commonB, layer: 'L2', label: '已知' },
      { id: 'core-202-edge-right-b', tenantId: test.tenant.id, accountId: tree.accountId, opportunityId: tree.matterId, source: right, target: commonB, layer: 'L2', label: '已知' },
    ] });

    await expect(generateRelSuggestions(test.tenant.id, tree.matterId, undefined, test.owner.id))
      .resolves.toEqual({ added: 1, total: 1 });
    await expect(generateRelSuggestions(test.tenant.id, tree.matterId, undefined, test.owner.id))
      .resolves.toEqual({ added: 0, total: 1 });

    const legacy = await test.prisma.relSuggestion.findFirstOrThrow({ where: {
      tenantId: test.tenant.id,
      opportunityId: tree.matterId,
    } });
    const candidate = await test.prisma.candidate.findUniqueOrThrow({ where: {
      tenantId_legacySourceKind_legacySourceId: {
        tenantId: test.tenant.id,
        legacySourceKind: 'RelSuggestion',
        legacySourceId: legacy.id,
      },
    } });
    expect(candidate).toMatchObject({
      kind: 'relation_create',
      accountId: tree.accountId,
      matterId: tree.matterId,
      source: 'graph',
      createdByUserId: test.owner.id,
      visibility: 'private',
      status: 'pending',
      version: 0,
    });
    expect(candidate.evidence).toContain('共同联系人');
    expect(JSON.parse(candidate.payload)).toMatchObject({
      legacyStatus: 'pending', sourceKind: 'person', targetKind: 'person',
    });
    await expect(test.prisma.candidate.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.edge.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(4);
  });

  it('writes MCP sync people and relation as one-to-one Candidate projections with stable replay', async () => {
    const mcpCtx = { ...ctx, channel: 'mcp' as const, assertionMode: 'machine_proposed' as const };
    const args = {
      idempotencyKey: 'core-202-sync-bundle',
      bundle: {
        account: { externalRef: 'core-202-sync-account', name: '同步候选客户', customerType: 2 },
        opportunity: { externalRef: 'core-202-sync-matter', name: '同步候选商机' },
        people: [
          { ref: 'left', name: '同步候选甲', evidence: '同步来源中的甲' },
          { ref: 'right', name: '同步候选乙', evidence: '同步来源中的乙' },
        ],
        relations: [{ ref: 'pair', sourceRef: 'left', targetRef: 'right', label: '疑似同盟' }],
      },
    };

    const first = await syncIntelBundle(mcpCtx, args, test.prisma);
    const replay = await syncIntelBundle(mcpCtx, args, test.prisma);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    const candidates = await test.prisma.candidate.findMany({ where: { tenantId: test.tenant.id } });
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((candidate) => candidate.kind === 'person_create')).toHaveLength(2);
    expect(candidates.filter((candidate) => candidate.kind === 'relation_create')).toHaveLength(1);
    for (const candidate of candidates) expect(candidate).toMatchObject({
      source: 'mcp',
      status: 'pending',
      createdByUserId: test.owner.id,
      visibility: 'private',
      version: 0,
    });
    expect(candidates.every((candidate) => candidate.sourceRef.startsWith(`mcp-sync:${first.syncRunId}:`))).toBe(true);
    expect(candidates.every((candidate) => candidate.evidence.trim().length > 0)).toBe(true);
    await expect(test.prisma.personSuggestion.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(2);
    await expect(test.prisma.relSuggestion.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.person.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
    await expect(test.prisma.edge.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
  });

  it('writes direct MCP proposals as Candidates and keeps duplicate calls projection-stable', async () => {
    const tree = await seedTree('mcp-direct');
    await test.prisma.person.createMany({ data: [
      { id: 'core-202-mcp-person-left', tenantId: test.tenant.id, accountId: tree.accountId, name: '正式甲', title: '' },
      { id: 'core-202-mcp-person-right', tenantId: test.tenant.id, accountId: tree.accountId, name: '正式乙', title: '' },
    ] });
    const mcpCtx = { ...ctx, channel: 'mcp' as const, assertionMode: 'machine_proposed' as const };
    const call = (id: number, name: string, args: Record<string, unknown>) => handleMcpBody(mcpCtx, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    }, internalProductPolicy);
    const personArgs = {
      accountId: tree.accountId,
      opportunityId: tree.matterId,
      name: 'MCP 候选人物',
      title: '评审负责人',
      evidence: 'MCP 提供的人物依据',
      confidence: 0.71,
    };
    const relationArgs = {
      opportunityId: tree.matterId,
      source: { kind: 'person', id: 'core-202-mcp-person-left' },
      target: { kind: 'person', id: 'core-202-mcp-person-right' },
      label: '疑似协作',
      evidence: 'MCP 提供的关系依据',
      confidence: 0.69,
    };

    await call(1, 'propose_person', personArgs);
    await call(2, 'propose_person', personArgs);
    await call(3, 'propose_relationship', relationArgs);
    await call(4, 'propose_relationship', relationArgs);

    const candidates = await test.prisma.candidate.findMany({ where: { tenantId: test.tenant.id } });
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.kind).sort()).toEqual(['person_create', 'relation_create']);
    for (const candidate of candidates) expect(candidate).toMatchObject({
      source: 'mcp',
      status: 'pending',
      createdByUserId: test.owner.id,
      visibility: 'private',
    });
    expect(candidates.every((candidate) => candidate.evidence.trim().length > 0)).toBe(true);
    await expect(test.prisma.personSuggestion.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.relSuggestion.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.person.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(2);
    await expect(test.prisma.edge.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
  });
});

describe('CORE-203 legacy review-table freeze', () => {
  async function typescriptFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }));
    return nested.flat();
  }

  it('permits legacy review-table writes only inside Candidate helpers plus formal Evidence actions', async () => {
    const sourceRoot = resolve('src');
    const files = await typescriptFiles(sourceRoot);
    const mutation = /\b(personSuggestion|relSuggestion|changeProposal|reminder|evidenceEvent)\.(create|update|updateMany|delete|deleteMany|upsert)\b/g;
    const allowedHelpers = new Set([
      'candidates/personRelation.ts',
      'candidates/reviewItems.ts',
    ]);
    const bypasses: string[] = [];
    for (const path of files) {
      const name = relative(sourceRoot, path);
      const contents = await readFile(path, 'utf8');
      for (const match of contents.matchAll(mutation)) {
        if (allowedHelpers.has(name)) continue;
        const operation = `${match[1]}.${match[2]}`;
        if (name === 'mutate.ts'
          && (operation === 'evidenceEvent.create' || operation === 'evidenceEvent.deleteMany')) continue;
        bypasses.push(`${name}:${operation}`);
      }
    }
    expect(bypasses).toEqual([]);

    const suggest = await readFile(join(sourceRoot, 'suggest.ts'), 'utf8');
    const inboxStart = suggest.indexOf("app.get('/api/inbox'");
    const inboxEnd = suggest.indexOf("app.post('/api/evidence", inboxStart);
    expect(inboxStart).toBeGreaterThanOrEqual(0);
    expect(inboxEnd).toBeGreaterThan(inboxStart);
    const inboxSource = suggest.slice(inboxStart, inboxEnd);
    for (const legacyModel of [
      'personSuggestion', 'relSuggestion', 'changeProposal', 'reminder', 'evidenceEvent',
    ]) expect(inboxSource).not.toContain(`prisma.${legacyModel}`);
    expect(inboxSource).toContain('prisma.candidate.findMany');
    expect(inboxSource).toContain('CANDIDATE_BACKFILL_MARKER');
  });
});
