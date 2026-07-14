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
      customerType: legacyAccount.customerType,
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
});
