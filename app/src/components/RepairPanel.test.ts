import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { seedAccount } from '../data/seed';
import type { Account } from '../types';
import { RepairPanel, toAccountRepairPatch } from './RepairPanel';

describe('INT-301 RepairPanel', () => {
  it('provides the internal repair surface', async () => {
    const modulePath = './RepairPanel';
    const repairPanelModule = await import(modulePath).catch(() => null);
    expect(repairPanelModule).not.toBeNull();
    expect(typeof repairPanelModule?.RepairPanel).toBe('function');
  });

  it('lists account records so incorrectly mounted visits and notes remain reachable', () => {
    const account: Account = {
      ...seedAccount,
      visitNotes: [{
        id: 'visit-wrong-parent', accountId: seedAccount.id, date: '2026-07-14', topic: '错误客户拜访',
        summary: 'needs repair', participants: [], origin: 'workbuddy',
      }],
      notes: [{ id: 'note-wrong-parent', accountId: seedAccount.id, content: '错误挂载笔记', source: 'manual' }],
    };
    const html = renderToStaticMarkup(createElement(RepairPanel, {
      target: { kind: 'account', account },
      accounts: [account],
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onRepairRecord: vi.fn(),
    }));

    expect(html).toContain('错误客户拜访');
    expect(html).toContain('错误挂载笔记');
    expect(html.match(/修正挂载/g)).toHaveLength(2);
  });

  it('preserves an unmatched legacy owner when only another account field changes', () => {
    const legacyAccount: Account = {
      ...seedAccount,
      primaryOwner: '同名待人工确认',
      primaryOwnerUserId: null,
    };

    expect(toAccountRepairPatch(legacyAccount, {
      name: '修正后的客户名',
      customerType: legacyAccount.customerType === null ? '' : legacyAccount.customerType,
      primaryOwnerUserId: '',
      ownerChanged: false,
    })).toEqual({
      base: {
        name: seedAccount.name,
        customerType: seedAccount.customerType,
        primaryOwner: '同名待人工确认',
        primaryOwnerUserId: null,
      },
      name: '修正后的客户名',
    });
  });

  it('preserves a missing sales classification instead of defaulting repair to type 2', () => {
    const unclassifiedAccount: Account = {
      ...seedAccount,
      id: 'account-unclassified',
      customerType: null,
    };

    expect(toAccountRepairPatch(unclassifiedAccount, {
      name: unclassifiedAccount.name,
      customerType: '',
      primaryOwnerUserId: '',
      ownerChanged: false,
    })).toEqual({
      base: {
        name: unclassifiedAccount.name,
        customerType: null,
        primaryOwner: unclassifiedAccount.primaryOwner ?? '',
        primaryOwnerUserId: unclassifiedAccount.primaryOwnerUserId ?? null,
      },
    });

    const html = renderToStaticMarkup(createElement(RepairPanel, {
      target: { kind: 'account', account: unclassifiedAccount },
      accounts: [unclassifiedAccount],
      onClose: vi.fn(),
      onChanged: vi.fn(),
    }));
    expect(html).toContain('<option value="" selected="">未设置销售分类</option>');
  });

  it('closes a committed repair before refresh and surfaces refresh failure outside the closed panel', async () => {
    const repairModule = await import('./RepairPanel') as unknown as {
      completeCommittedRepair?: (
        onClose: () => void,
        onChanged: () => Promise<void>,
        onRefreshError: (message: string) => void,
      ) => Promise<void>;
    };
    expect(typeof repairModule.completeCommittedRepair).toBe('function');
    const order: string[] = [];
    await repairModule.completeCommittedRepair!(
      () => { order.push('close'); },
      async () => { order.push('refresh'); throw new Error('offline'); },
      (message) => { order.push(message); },
    );
    expect(order).toEqual(['close', 'refresh', '纠错已保存，但刷新失败；请稍后重新进入客户。']);
  });

  it('makes duplicate-person merge direction, archive consequence and conflict decisions explicit', () => {
    const html = renderToStaticMarkup(createElement(RepairPanel, {
      target: { kind: 'account', account: seedAccount },
      accounts: [seedAccount],
      onClose: vi.fn(),
      onChanged: vi.fn(),
    }));
    expect(html).toContain('合并重复人物');
    expect(html).toContain('源人物（将归档）');
    expect(html).toContain('目标人物（保留）');
    expect(html).toContain('源人物会被归档');
    expect(html).toContain('每个角色冲突都必须明确选择');
  });

  it('allows only one in-flight merge submission and refreshes after the committed call', async () => {
    const module = await import('./RepairPanel') as unknown as {
      submitPersonMergeOnce?: (
        lock: { current: boolean },
        submit: () => Promise<void>,
        afterCommit: () => Promise<void>,
      ) => Promise<'committed' | 'ignored'>;
    };
    expect(typeof module.submitPersonMergeOnce).toBe('function');
    const lock = { current: false };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const first = module.submitPersonMergeOnce!(lock, async () => { calls.push('submit'); await pending; }, async () => { calls.push('refresh'); });
    const second = module.submitPersonMergeOnce!(lock, async () => { calls.push('duplicate'); }, async () => { calls.push('duplicate-refresh'); });
    await expect(second).resolves.toBe('ignored');
    release();
    await expect(first).resolves.toBe('committed');
    expect(calls).toEqual(['submit', 'refresh']);
  });

  it('reuses one idempotency key across manual retries until payload changes or success is confirmed', async () => {
    const module = await import('./RepairPanel') as unknown as {
      stablePersonMergeKey?: (
        cache: { current: { signature: string; key: string } | null },
        payload: { targetPersonId: string; sourcePersonId: string; roleConflictByOpportunity: Record<string, 'keep_target' | 'keep_source'> },
        createKey: () => string,
      ) => string;
      clearStablePersonMergeKey?: (cache: { current: { signature: string; key: string } | null }) => void;
    };
    expect(typeof module.stablePersonMergeKey).toBe('function');
    expect(typeof module.clearStablePersonMergeKey).toBe('function');
    const cache = { current: null as { signature: string; key: string } | null };
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const payload = { targetPersonId: 'target', sourcePersonId: 'source', roleConflictByOpportunity: { opp: 'keep_target' as const } };
    expect(module.stablePersonMergeKey!(cache, payload, createKey)).toBe('key-1');
    expect(module.stablePersonMergeKey!(cache, { ...payload, roleConflictByOpportunity: { opp: 'keep_target' } }, createKey)).toBe('key-1');
    expect(module.stablePersonMergeKey!(cache, { ...payload, roleConflictByOpportunity: { opp: 'keep_source' } }, createKey)).toBe('key-2');
    module.clearStablePersonMergeKey!(cache);
    expect(module.stablePersonMergeKey!(cache, { ...payload, roleConflictByOpportunity: { opp: 'keep_source' } }, createKey)).toBe('key-3');
  });
});
