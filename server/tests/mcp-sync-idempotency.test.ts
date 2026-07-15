import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { CommandContext } from '@jianghu/domain-contracts';
import { handleMcpBody } from '../src/mcpServer.js';
import { syncIntelBundle } from '../src/mcp/syncBundle.js';
import { findSyncAnchorConflicts } from '../src/mcp/syncAnchorConflicts.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('WorkBuddy atomic sync bundle', () => {
  let test: TestContext;
  let ctx: CommandContext;

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      channel: 'mcp',
      requestId: 'mcp-sync-test',
      assertionMode: 'machine_proposed',
    };
  });

  afterEach(async () => test.cleanup());

  const callSync = async (id: number, args: Record<string, unknown>) => handleMcpBody(ctx, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sync_intel_bundle', arguments: args },
  });
  const storedKey = (value: string) => createHash('sha256').update(value).digest('hex');

  const toolData = (response: unknown): Record<string, any> => {
    const text = (response as any).result.content[0].text;
    return JSON.parse(text) as Record<string, any>;
  };

  it.each([
    ['legacy-count', '竞标方家数'], ['legacy-owner', '甲方代表'], ['legacy-agent', '招标代理'], ['unknown', '未知事项'],
  ])('rejects non-authoritative C5 write key %s before creating a SyncRun', async (key, invalidKey) => {
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: `invalid-c5-${key}`,
      bundle: {
        account: { externalRef: `account-${key}`, name: '虚构客户', customerType: 1 },
        opportunity: {
          externalRef: `opportunity-${key}`, name: '虚构商机',
          c5Items: { [invalidKey]: true },
        },
      },
    }, test.prisma)).rejects.toThrow('Unrecognized key');

    await expect(test.prisma.syncRun.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
    await expect(test.prisma.opportunity.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(0);
  });

  it('publishes the atomic sync_intel_bundle tool', async () => {
    const response = await handleMcpBody(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (response as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toContain('sync_intel_bundle');
  });

  it('atomically creates a bundle and replays one stable receipt', async () => {
    const args = {
      idempotencyKey: 'workbuddy-bundle-one',
      bundle: {
        account: { externalRef: 'wb-account-1', name: '示例能源集团', customerType: 2 },
        opportunity: { externalRef: 'wb-opportunity-1', name: '新能源数字化项目' },
        visit: { externalRef: 'wb-visit-1', date: '2026-07-14', summary: '用户确认的拜访纪要' },
        people: [
          { ref: 'leader', name: '李总', title: '总经理', evidence: '公开会议纪要' },
          { ref: 'director', name: '王处长', title: '信息处处长', evidence: '客户确认' },
        ],
        relations: [{ ref: 'reports-to', sourceRef: 'director', targetRef: 'leader', layer: 'L1', label: '汇报' }],
      },
    };

    const first = toolData(await callSync(2, args));
    const replay = toolData(await callSync(3, args));

    expect(first).toMatchObject({ replayed: false, failed: [], skipped: [] });
    expect(first.created).toEqual(expect.arrayContaining(['account:wb-account-1', 'opportunity:wb-opportunity-1', 'visit:wb-visit-1']));
    expect(first.proposed).toEqual(expect.arrayContaining(['person:leader', 'person:director', 'relationship:reports-to']));
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-account-1' } })).toBe(1);
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-opportunity-1' } })).toBe(1);
    expect(await test.prisma.visitNote.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-visit-1' } })).toBe(1);
    expect(await test.prisma.personSuggestion.count({ where: { tenantId: test.tenant.id, status: 'pending' } })).toBe(2);
    expect(await test.prisma.relSuggestion.count({ where: { tenantId: test.tenant.id, status: 'pending' } })).toBe(1);
  });

  it('deduplicates concurrent submissions with the same idempotency key', async () => {
    const args = {
      idempotencyKey: 'workbuddy-concurrent-bundle',
      bundle: { account: { externalRef: 'wb-concurrent-account', name: '并发客户', customerType: 2 } },
    };
    const receipts = await Promise.all([
      syncIntelBundle(ctx, args, test.prisma),
      syncIntelBundle(ctx, args, test.prisma),
    ]);
    expect(receipts.filter((receipt) => receipt.replayed)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.syncRunId)).size).toBe(1);
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-concurrent-account' } })).toBe(1);
    expect(await test.prisma.syncRun.count({ where: { tenantId: test.tenant.id, idempotencyKey: storedKey(args.idempotencyKey) } })).toBe(1);
    expect(await test.prisma.syncRun.count({ where: { tenantId: test.tenant.id, idempotencyKey: args.idempotencyKey } })).toBe(0);
  });

  it('replays a tenant sync key even when a retry uses another authorized actor', async () => {
    const teammate = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: 'sync-teammate@example.test', passwordHash: 'unused', name: 'Teammate', role: 'member',
    } });
    const args = {
      idempotencyKey: 'tenant-wide-sync-key',
      bundle: { account: { externalRef: 'tenant-wide-account', name: '租户级同步', customerType: 2 } },
    };
    const first = await syncIntelBundle(ctx, args, test.prisma);
    const retry = await syncIntelBundle({ ...ctx, actorId: teammate.id }, args, test.prisma);
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await test.prisma.syncRun.count({ where: { tenantId: test.tenant.id, idempotencyKey: storedKey(args.idempotencyKey) } })).toBe(1);
  });

  it('rolls back a failed bundle and allows the same payload and key to retry', async () => {
    const args = {
      idempotencyKey: 'workbuddy-failed-retry',
      bundle: {
        account: { externalRef: 'wb-failed-account', name: '失败回滚客户', customerType: 2 },
        opportunity: { externalRef: 'wb-failed-opportunity', name: '失败回滚商机' },
      },
    };
    await expect(syncIntelBundle(ctx, args, test.prisma, { failAfterStep: 2 })).rejects.toThrow('injected sync failure');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-failed-account' } })).toBe(0);
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-failed-opportunity' } })).toBe(0);
    const failedRun = await test.prisma.syncRun.findFirstOrThrow({ where: { tenantId: test.tenant.id, idempotencyKey: storedKey(args.idempotencyKey) } });
    expect(failedRun.status).toBe('failed');
    expect(JSON.parse(failedRun.receipt)).toMatchObject({
      syncRunId: failedRun.id,
      failed: [{ ref: 'bundle', code: 'sync_failed', message: '同步事务失败，业务数据已回滚' }],
    });

    const retryingActor = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: 'retrying-sync-actor@example.test', passwordHash: 'unused', name: 'Retrying actor', role: 'member',
    } });
    await expect(syncIntelBundle({ ...ctx, actorId: retryingActor.id }, args, test.prisma))
      .resolves.toMatchObject({ syncRunId: failedRun.id, replayed: false, failed: [] });
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'wb-failed-account' } })).toBe(1);
    expect(await test.prisma.syncRun.findUniqueOrThrow({ where: { id: failedRun.id } }))
      .toMatchObject({ status: 'completed', actorId: retryingActor.id });
  });

  it('keeps legacy discrete tools for one version and returns their sync receipt', async () => {
    const response = await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
        name: 'upsert_account',
        arguments: { externalRef: 'legacy-account-ref', name: '兼容客户', customerType: 2 },
      },
    });
    const data = toolData(response);
    expect(data).toMatchObject({
      created: true,
      deprecatedAfter: '2026-10-01',
      syncReceipt: { replayed: false, failed: [] },
    });
    expect(data.syncReceipt.created).toContain('account:legacy-account-ref');

    const opportunity = toolData(await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
        name: 'upsert_opportunity', arguments: {
          accountExternalRef: 'legacy-account-ref', externalRef: 'legacy-opportunity-ref', name: '兼容商机',
          status: 'paused', changeMode: 'T', productSolution: '完整方案', expectedAmountW: 123,
          c3Items: { 需求研究: true }, c5Items: { '竞标方名单/家数': true },
        },
      },
    }));
    expect(opportunity).toMatchObject({ created: true, deprecatedAfter: '2026-10-01', syncReceipt: { replayed: false } });
    expect(opportunity.syncReceipt.created).toContain('opportunity:legacy-opportunity-ref');
    expect(await test.prisma.opportunity.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, externalRef: 'legacy-opportunity-ref',
    } })).toMatchObject({ status: 'paused', changeMode: 'T', productSolution: '完整方案', expectedAmountW: 123 });

    const visit = toolData(await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
        name: 'append_visit_note', arguments: {
          accountExternalRef: 'legacy-account-ref', opportunityExternalRef: 'legacy-opportunity-ref',
          externalRef: 'legacy-visit-ref', date: '2026-07-14', summary: '兼容拜访纪要',
          participants: [{ name: '客户李总', side: 'customer' }, { name: '我方王经理', side: 'our' }],
        },
      },
    }));
    expect(visit).toMatchObject({ created: true, deprecatedAfter: '2026-10-01', syncReceipt: { replayed: false } });
    expect(visit.syncReceipt.created).toContain('visit:legacy-visit-ref');
    expect(JSON.parse((await test.prisma.visitNote.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, externalRef: 'legacy-visit-ref',
    } })).participants)).toEqual([{ name: '客户李总', side: 'customer' }, { name: '我方王经理', side: 'our' }]);
  });

  it('normalizes the legacy pipeline alias before the shared sync service creates a formal opportunity', async () => {
    await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
        name: 'upsert_account', arguments: { externalRef: 'legacy-stage-account', name: '阶段客户', customerType: 2 },
      },
    });
    await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 13, method: 'tools/call', params: {
        name: 'upsert_opportunity', arguments: {
          accountExternalRef: 'legacy-stage-account', externalRef: 'legacy-stage-opportunity',
          name: '阶段商机', pipelineStage: '合同签约',
        },
      },
    });
    expect(await test.prisma.opportunity.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, externalRef: 'legacy-stage-opportunity',
    } })).toMatchObject({ pipelineStage: '合同双签' });
  });

  it('does not clone a legacy opportunity that has no externalRef when appending a visit', async () => {
    await test.prisma.account.create({ data: {
      id: 'acc-legacy-no-opp-ref', tenantId: test.tenant.id, externalRef: 'legacy-no-opp-ref-account', name: '旧客户', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'opp-legacy-no-ref', tenantId: test.tenant.id, accountId: 'acc-legacy-no-opp-ref', name: '旧商机',
      customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 14, method: 'tools/call', params: {
        name: 'append_visit_note', arguments: {
          accountId: 'acc-legacy-no-opp-ref', opportunityId: 'opp-legacy-no-ref', externalRef: 'legacy-no-ref-visit',
          date: '2026-07-14', summary: '旧商机拜访',
        },
      },
    });
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id, accountId: 'acc-legacy-no-opp-ref' } })).toBe(1);
    expect(await test.prisma.visitNote.findFirstOrThrow({ where: { tenantId: test.tenant.id, externalRef: 'legacy-no-ref-visit' } }))
      .toMatchObject({ opportunityId: 'opp-legacy-no-ref' });
  });

  it('rejects conflicting parent and opportunity anchors in legacy tools', async () => {
    await test.prisma.account.createMany({ data: [
      { id: 'legacy-anchor-account-a', tenantId: test.tenant.id, externalRef: 'legacy-anchor-a', name: '客户A', customerType: 2 },
      { id: 'legacy-anchor-account-b', tenantId: test.tenant.id, externalRef: 'legacy-anchor-b', name: '客户B', customerType: 2 },
    ] });
    await test.prisma.opportunity.createMany({ data: [
      { id: 'legacy-anchor-opp-a', tenantId: test.tenant.id, accountId: 'legacy-anchor-account-a', externalRef: 'legacy-opp-a', name: '商机A', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项' },
      { id: 'legacy-anchor-opp-b', tenantId: test.tenant.id, accountId: 'legacy-anchor-account-a', externalRef: 'legacy-opp-b', name: '商机B', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项' },
    ] });

    const accountConflict = await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'upsert_opportunity', arguments: {
        accountId: 'legacy-anchor-account-a', accountExternalRef: 'legacy-anchor-b',
        externalRef: 'should-not-exist', name: '不应创建',
      } },
    }) as any;
    expect(accountConflict.result).toMatchObject({ isError: true });
    expect(accountConflict.result.content[0].text).toContain('account anchors');

    const opportunityConflict = await handleMcpBody(ctx, {
      jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'append_visit_note', arguments: {
        accountId: 'legacy-anchor-account-a', opportunityId: 'legacy-anchor-opp-a', opportunityExternalRef: 'legacy-opp-b',
        externalRef: 'should-not-exist-visit', date: '2026-07-14', summary: '不应创建',
      } },
    }) as any;
    expect(opportunityConflict.result).toMatchObject({ isError: true });
    expect(opportunityConflict.result.content[0].text).toContain('opportunity anchors');
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id, externalRef: 'should-not-exist' } })).toBe(0);
    expect(await test.prisma.visitNote.count({ where: { tenantId: test.tenant.id, externalRef: 'should-not-exist-visit' } })).toBe(0);
  });

  it('rejects invalid opportunity stages before writing any bundle row', async () => {
    const args = {
      idempotencyKey: 'invalid-stage-bundle', bundle: {
        account: { externalRef: 'invalid-stage-account', name: '不应创建' },
        opportunity: { externalRef: 'invalid-stage-opportunity', name: '不应创建', pipelineStage: '完全非法阶段' },
      },
    };
    await expect(syncIntelBundle(ctx, args, test.prisma)).rejects.toThrow();
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'invalid-stage-account' } })).toBe(0);
  });

  it('rejects invalid formal opportunity enums and server-owned meta keys before writing', async () => {
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: 'invalid-competitive-situation', bundle: {
        account: { externalRef: 'invalid-enum-account', name: '不应创建' },
        opportunity: { externalRef: 'invalid-enum-opportunity', name: '不应创建', competitiveSituation: '绝对领先' },
      },
    }, test.prisma)).rejects.toThrow();
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: 'forged-meta-origin', bundle: {
        account: { externalRef: 'forged-origin-account', name: '不应创建' },
        opportunity: { externalRef: 'forged-origin-opportunity', name: '不应创建', meta: { _mcpOrigin: { source: 'forged' } } },
      },
    }, test.prisma)).rejects.toThrow('reserved key');
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: 'opaque-ref-required', bundle: {
        account: { externalRef: 'invalid-ref-format-account', name: '不应创建' },
        people: [{ ref: '李总 phone 13800138000', name: '李总' }],
      },
    }, test.prisma)).rejects.toThrow('opaque identifier');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: { in: ['invalid-enum-account', 'forged-origin-account'] } } })).toBe(0);
  });

  it('preserves existing opportunity metadata and server provenance in a change proposal', async () => {
    await test.prisma.account.create({ data: {
      id: 'meta-account', tenantId: test.tenant.id, externalRef: 'meta-account-ref', name: '客户', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'meta-opportunity', tenantId: test.tenant.id, accountId: 'meta-account', externalRef: 'meta-opportunity-ref',
      name: '商机', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
      meta: JSON.stringify({ kept: 'value', _mcpOrigin: { source: 'mcp', syncRunId: 'original' } }),
    } });
    await syncIntelBundle(ctx, {
      idempotencyKey: 'preserve-opportunity-meta', bundle: {
        account: { id: 'meta-account', name: '客户' },
        opportunity: { externalRef: 'meta-opportunity-ref', name: '商机', meta: { added: 'value' } },
      },
    }, test.prisma);
    const proposal = await test.prisma.changeProposal.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, opportunityId: 'meta-opportunity', field: 'meta', status: 'pending',
    } });
    expect(JSON.parse(proposal.newValue)).toEqual({
      kept: 'value', added: 'value', _mcpOrigin: { source: 'mcp', syncRunId: 'original' },
    });
  });

  it('uses business anchors across different sync keys and proposes protected opportunity changes', async () => {
    const first = {
      idempotencyKey: 'business-anchor-first',
      bundle: {
        account: { externalRef: 'stable-account-anchor', name: '原客户名', customerType: 2 },
        opportunity: { externalRef: 'stable-opportunity-anchor', name: '原商机名' },
      },
    };
    const second = {
      idempotencyKey: 'business-anchor-second',
      bundle: {
        account: { externalRef: 'stable-account-anchor', name: '确认后的客户名', customerType: 2 },
        opportunity: { externalRef: 'stable-opportunity-anchor', name: '机器建议的新商机名' },
      },
    };
    await syncIntelBundle(ctx, first, test.prisma);
    const receipt = await syncIntelBundle(ctx, second, test.prisma);

    expect(receipt.updated).toContain('account:stable-account-anchor');
    expect(receipt.proposed).toContain('opportunity:stable-opportunity-anchor:name');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'stable-account-anchor' } })).toBe(1);
    expect(await test.prisma.account.findFirstOrThrow({ where: { tenantId: test.tenant.id, externalRef: 'stable-account-anchor' } }))
      .toMatchObject({ name: '确认后的客户名' });
    expect(await test.prisma.opportunity.findFirstOrThrow({ where: { tenantId: test.tenant.id, externalRef: 'stable-opportunity-anchor' } }))
      .toMatchObject({ name: '原商机名' });
    expect(await test.prisma.changeProposal.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, entityKind: 'opportunity', field: 'name', status: 'pending',
    } })).toMatchObject({ oldValue: '原商机名', newValue: '机器建议的新商机名' });
  });

  it('does not propose resetting omitted opportunity fields to defaults', async () => {
    await test.prisma.account.create({ data: {
      id: 'acc-omit-fields', tenantId: test.tenant.id, externalRef: 'omit-fields-account', name: '客户', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'opp-omit-fields', tenantId: test.tenant.id, accountId: 'acc-omit-fields', externalRef: 'omit-fields-opportunity',
      name: '现有商机', customerType: 2, pipelineStage: '合同谈判', engageStage: '招采执行',
    } });
    const receipt = await syncIntelBundle(ctx, {
      idempotencyKey: 'omit-opportunity-fields', bundle: {
        account: { id: 'acc-omit-fields', name: '客户' },
        opportunity: { externalRef: 'omit-fields-opportunity', name: '现有商机' },
      },
    }, test.prisma);
    expect(receipt.proposed).toEqual([]);
    expect(await test.prisma.changeProposal.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.opportunity.findUniqueOrThrow({ where: { id: 'opp-omit-fields' } }))
      .toMatchObject({ pipelineStage: '合同谈判', engageStage: '招采执行' });
  });

  it('does not create through an unresolved account id from another scope', async () => {
    const args = {
      idempotencyKey: 'unresolved-account-id',
      bundle: { account: { id: 'acc-outside-scope', name: '不应创建', customerType: 2 } },
    };
    await expect(syncIntelBundle(ctx, args, test.prisma)).rejects.toThrow('account id does not exist in the current tenant');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.syncRun.findFirstOrThrow({ where: { tenantId: test.tenant.id } })).toMatchObject({ status: 'failed' });
  });

  it('rejects a supplied account anchor that conflicts with an existing non-null anchor', async () => {
    await test.prisma.account.create({ data: {
      id: 'acc-conflicting-anchors', tenantId: test.tenant.id, externalRef: 'existing-external',
      unifiedCreditCode: 'existing-credit', name: '现有客户', customerType: 2,
    } });
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: 'conflicting-account-anchors', bundle: {
        account: { externalRef: 'different-external', unifiedCreditCode: 'existing-credit', name: '现有客户' },
      },
    }, test.prisma)).rejects.toThrow('account anchors conflict');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id } })).toBe(1);
  });

  it('rejects a relation whose distinct refs dedupe to the same candidate identity', async () => {
    const args = {
      idempotencyKey: 'same-candidate-self-loop', bundle: {
        account: { externalRef: 'same-candidate-account', name: '同名客户' },
        opportunity: { externalRef: 'same-candidate-opportunity', name: '同名商机' },
        people: [{ ref: 'a', name: '同名' }, { ref: 'b', name: '同名' }],
        relations: [{ ref: 'bad-self-loop', sourceRef: 'a', targetRef: 'b', label: '不应创建' }],
      },
    };
    await expect(syncIntelBundle(ctx, args, test.prisma)).rejects.toThrow('same candidate identity');
    expect(await test.prisma.relSuggestion.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id, externalRef: 'same-candidate-account' } })).toBe(0);
  });

  it('rejects duplicate evidence refs before writing the bundle', async () => {
    await test.prisma.account.create({ data: { id: 'acc-duplicate-evidence', tenantId: test.tenant.id, externalRef: 'duplicate-evidence-account', name: '证据客户', customerType: 2 } });
    await test.prisma.opportunity.create({ data: {
      id: 'opp-duplicate-evidence', tenantId: test.tenant.id, accountId: 'acc-duplicate-evidence', externalRef: 'duplicate-evidence-opportunity',
      name: '证据商机', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: { id: 'person-duplicate-evidence', tenantId: test.tenant.id, accountId: 'acc-duplicate-evidence', name: '李总', title: '总经理' } });
    const evidence = { ref: 'duplicate-ref', personId: 'person-duplicate-evidence', signalKey: 'verbal_positive' };
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: 'duplicate-evidence-refs', bundle: {
        account: { id: 'acc-duplicate-evidence', name: '证据客户' },
        opportunity: { externalRef: 'duplicate-evidence-opportunity', name: '证据商机' },
        evidences: [evidence, { ...evidence, signalKey: 'spec_alignment' }],
      },
    }, test.prisma)).rejects.toThrow('duplicate evidence ref');
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('rejects a different bundle that reuses an idempotency key', async () => {
    const key = 'same-key-different-payload';
    await syncIntelBundle(ctx, {
      idempotencyKey: key, bundle: { account: { externalRef: 'payload-a', name: 'A' } },
    }, test.prisma);
    await expect(syncIntelBundle(ctx, {
      idempotencyKey: key, bundle: { account: { externalRef: 'payload-b', name: 'B' } },
    }, test.prisma)).rejects.toThrow('idempotency key reused with a different bundle');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id } })).toBe(1);
  });

  it('validates candidate references before opening the write transaction', async () => {
    const args = {
      idempotencyKey: 'invalid-candidate-reference',
      bundle: {
        account: { externalRef: 'invalid-ref-account', name: '不应创建' },
        opportunity: { externalRef: 'invalid-ref-opportunity', name: '不应创建' },
        people: [{ ref: 'known', name: '已知候选' }],
        relations: [{ ref: 'bad-edge', sourceRef: 'known', targetRef: 'missing', label: '未知端点' }],
      },
    };
    await expect(syncIntelBundle(ctx, args, test.prisma)).rejects.toThrow('references an unknown candidate');
    expect(await test.prisma.account.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.syncRun.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('stores machine evidence only as a pending-review candidate and replays without duplication', async () => {
    await test.prisma.account.create({ data: {
      id: 'acc-evidence-sync', tenantId: test.tenant.id, externalRef: 'evidence-account', name: '证据客户', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'opp-evidence-sync', tenantId: test.tenant.id, accountId: 'acc-evidence-sync', externalRef: 'evidence-opportunity',
      name: '证据商机', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-evidence-sync', tenantId: test.tenant.id, accountId: 'acc-evidence-sync', name: '李总', title: '总经理',
    } });
    const args = {
      idempotencyKey: 'evidence-candidate-bundle',
      bundle: {
        account: { id: 'acc-evidence-sync', name: '证据客户', customerType: 2 },
        opportunity: { externalRef: 'evidence-opportunity', name: '证据商机' },
        evidences: [{ ref: 'evidence-one', personId: 'person-evidence-sync', signalKey: 'verbal_positive', rawContent: '机器提取原文' }],
      },
    };
    const first = await syncIntelBundle(ctx, args, test.prisma);
    const replay = await syncIntelBundle(ctx, args, test.prisma);
    expect(first.proposed).toContain('evidence:evidence-one');
    expect(replay.replayed).toBe(true);
    expect(await test.prisma.evidenceEvent.findFirstOrThrow({ where: { tenantId: test.tenant.id } }))
      .toMatchObject({ status: 'pending_review', origin: 'mcp', createdBy: test.owner.id });
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } })).toBe(1);
  });

  it('fails the whole bundle when the tenant pending-candidate capacity is exhausted', async () => {
    await test.prisma.account.create({ data: {
      id: 'acc-capacity', tenantId: test.tenant.id, externalRef: 'capacity-account', name: '容量客户', customerType: 2,
    } });
    await test.prisma.personSuggestion.createMany({ data: Array.from({ length: 200 }, (_, index) => ({
      id: `ps-capacity-${index}`, tenantId: test.tenant.id, accountId: 'acc-capacity', name: `候选${index}`, status: 'pending',
    })) });
    const args = {
      idempotencyKey: 'candidate-capacity-full', bundle: {
        account: { id: 'acc-capacity', name: '容量客户' },
        visit: { externalRef: 'capacity-visit', date: '2026-07-14', summary: '不应部分写入' },
        people: [{ ref: 'overflow', name: '超额候选' }],
      },
    };
    await expect(syncIntelBundle(ctx, args, test.prisma)).rejects.toThrow('候选干系人已达上限');
    expect(await test.prisma.visitNote.count({ where: { tenantId: test.tenant.id, externalRef: 'capacity-visit' } })).toBe(0);
    expect(await test.prisma.syncRun.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, idempotencyKey: storedKey(args.idempotencyKey),
    } })).toMatchObject({ status: 'failed' });
  });

  it('enforces non-null business anchors per tenant while allowing null anchors and other tenants', async () => {
    await test.prisma.account.create({ data: { id: 'acc-anchor-1', tenantId: test.tenant.id, externalRef: 'same-account', name: 'A1', customerType: 2 } });
    await expect(test.prisma.account.create({ data: { id: 'acc-anchor-2', tenantId: test.tenant.id, externalRef: 'same-account', name: 'A2', customerType: 2 } }))
      .rejects.toMatchObject({ code: 'P2002' });
    await test.prisma.account.createMany({ data: [
      { id: 'acc-null-1', tenantId: test.tenant.id, name: 'N1', customerType: 2 },
      { id: 'acc-null-2', tenantId: test.tenant.id, name: 'N2', customerType: 2 },
    ] });
    await test.prisma.tenant.create({ data: { id: 'other-sync-tenant', name: 'Other' } });
    await expect(test.prisma.account.create({ data: {
      id: 'acc-anchor-other', tenantId: 'other-sync-tenant', externalRef: 'same-account', name: 'Other A', customerType: 2,
    } })).resolves.toBeTruthy();

    await test.prisma.opportunity.create({ data: {
      id: 'opp-anchor-1', tenantId: test.tenant.id, accountId: 'acc-anchor-1', externalRef: 'same-opportunity',
      name: 'O1', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await expect(test.prisma.opportunity.create({ data: {
      id: 'opp-anchor-2', tenantId: test.tenant.id, accountId: 'acc-anchor-1', externalRef: 'same-opportunity',
      name: 'O2', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } })).rejects.toMatchObject({ code: 'P2002' });
    await test.prisma.visitNote.create({ data: {
      id: 'visit-anchor-1', tenantId: test.tenant.id, accountId: 'acc-anchor-1', externalRef: 'same-visit', summary: 'V1',
    } });
    await expect(test.prisma.visitNote.create({ data: {
      id: 'visit-anchor-2', tenantId: test.tenant.id, accountId: 'acc-anchor-1', externalRef: 'same-visit', summary: 'V2',
    } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('reports duplicate blank anchors before unique-index deployment', async () => {
    const fake = {
      account: { findMany: async () => [
        { id: 'blank-1', tenantId: 'tenant-blank', externalRef: '', unifiedCreditCode: null },
        { id: 'blank-2', tenantId: 'tenant-blank', externalRef: '', unifiedCreditCode: null },
      ] },
      opportunity: { findMany: async () => [] },
      visitNote: { findMany: async () => [] },
    } as unknown as PrismaClient;
    await expect(findSyncAnchorConflicts(fake)).resolves.toContainEqual({
      entity: 'Account', key: 'externalRef', tenantId: 'tenant-blank', value: '', ids: ['blank-1', 'blank-2'],
    });
  });

  it('allows a clean install with missing tables while still scanning any tables that already exist', async () => {
    const missingTable = () => Promise.reject(Object.assign(new Error('table does not exist'), { code: 'P2021' }));
    const partiallyInitialized = {
      account: { findMany: async () => [
        { id: 'existing-1', tenantId: 'tenant-existing', externalRef: 'duplicate', unifiedCreditCode: null },
        { id: 'existing-2', tenantId: 'tenant-existing', externalRef: 'duplicate', unifiedCreditCode: null },
      ] },
      opportunity: { findMany: missingTable },
      visitNote: { findMany: missingTable },
    } as unknown as PrismaClient;
    await expect(findSyncAnchorConflicts(partiallyInitialized)).resolves.toContainEqual({
      entity: 'Account', key: 'externalRef', tenantId: 'tenant-existing', value: 'duplicate', ids: ['existing-1', 'existing-2'],
    });

    const cleanInstall = {
      account: { findMany: missingTable }, opportunity: { findMany: missingTable }, visitNote: { findMany: missingTable },
    } as unknown as PrismaClient;
    await expect(findSyncAnchorConflicts(cleanInstall)).resolves.toEqual([]);
  });

  it('runs the sync-anchor conflict report before production db push', async () => {
    const entrypoint = await readFile(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');
    expect(entrypoint.indexOf('migrate:sync-anchor-report')).toBeGreaterThan(-1);
    expect(entrypoint.indexOf('migrate:sync-anchor-report')).toBeLessThan(entrypoint.indexOf('prisma db push'));
  });
});
