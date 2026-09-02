import { describe, expect, it } from 'vitest';
import type { CommitmentV2 } from '@jianghu/domain-contracts';
import { computeToday, needsYouByAccount } from './today';
import { computeG64111Today } from './g64111Today';
import { seedAccount } from '../data/seed';
import { newPlanAction } from '../store';
import type { Account } from '../types';

const TODAY = '2026-07-02';

type CommitmentSeed = {
  title: string;
  localDate: string;
  executionStatus?: CommitmentV2['executionStatus'];
  confirmationStatus?: CommitmentV2['confirmationStatus'];
  matterId?: string | null;
};

function accWith(items: CommitmentSeed[]): Account {
  const account: Account = JSON.parse(JSON.stringify(seedAccount));
  const matter = account.opportunities[0];
  account.commitments = items.map((item, index): CommitmentV2 => ({
    id: `commitment-${index}`,
    customerId: account.id,
    matterId: item.matterId === undefined ? matter.id : item.matterId,
    personId: null,
    title: item.title,
    kind: 'task',
    ownerUserId: 'owner-a',
    executionStatus: item.executionStatus ?? 'planned',
    confirmationStatus: item.confirmationStatus ?? 'not_required',
    scheduledAtUtc: null,
    dueAtUtc: null,
    timeZone: 'Asia/Shanghai',
    isAllDay: true,
    localDate: item.localDate,
    confirmationDueAtUtc: null,
    confirmedAtUtc: null,
    confirmedByUserId: null,
    scheduleVersion: 0,
    nextCommitmentId: null,
    source: 'manual',
    sourceRef: null,
    archivedAt: null,
    version: 0,
    hypothesisId: null,
    hypothesisRevisionId: null,
    completionResult: '',
    completionResultRecordedAtUtc: null,
    completionResultRecordedByUserId: null,
    verificationReviewDisposition: null,
    verificationReviewedAtUtc: null,
    verificationReviewedByUserId: null,
  }));
  return account;
}

describe('today · generic Commitment consumer', () => {
  it('G64111 未安装时只返回通用提醒，不隐式计算销售方法论缺口', () => {
    const account = accWith([]);
    const out = computeToday([account], [{
      accountId: account.id,
      accountName: account.name,
      title: '通用提醒',
      severity: 'warn',
    }], TODAY, 10);

    expect(out.map((item) => item.text)).toEqual(['通用提醒']);
    expect(out.some((item) => item.icon === '🎒')).toBe(false);
  });

  it('逾期 Commitment 排最前，越久越靠前', () => {
    const account = accWith([
      { title: '拜访 A', localDate: '2026-06-30' },
      { title: '拜访 B', localDate: '2026-06-20' },
    ]);
    const out = computeToday([account], [], TODAY);
    expect(out[0].text).toContain('拜访 B');
    expect(out[0].text).toContain('逾期 12 天');
    expect(out[1].text).toContain('拜访 A');
  });

  it('终态、客户拒绝和 legacy PlanAction 都不进入通用清单', () => {
    const account = accWith([
      { title: '已完成', localDate: '2026-06-01', executionStatus: 'completed' },
      { title: '已取消', localDate: '2026-06-01', executionStatus: 'canceled' },
      { title: '客户拒绝', localDate: '2026-06-01', confirmationStatus: 'declined' },
    ]);
    const legacy = newPlanAction(account.id, account.opportunities[0].id, '2026-05-01');
    legacy.title = '旧行动牌不得 fallback';
    account.planActions = [legacy];

    const out = computeToday([account], [], TODAY, 20);
    expect(out.some((item) => ['已完成', '已取消', '客户拒绝', '旧行动牌不得 fallback']
      .some((text) => item.text.includes(text)))).toBe(false);
  });

  it('客户级 Commitment 无 Matter 也能进入 Today', () => {
    const account = accWith([{ title: '客户级回访', localDate: TODAY, matterId: null }]);
    expect(computeToday([account], [], TODAY)[0]).toMatchObject({
      text: expect.stringContaining('客户级回访'),
      sub: account.name,
    });
  });

  it('顺序：warn 提醒 > 缺口 > info 提醒；默认取 3 件', () => {
    const account = accWith([]);
    const reminders = [
      { accountId: account.id, accountName: account.name, title: '商机停滞 8 天', severity: 'warn' },
      { accountId: account.id, accountName: account.name, title: '一条 info 提醒', severity: 'info' },
    ];
    const all = computeG64111Today([account], reminders, TODAY, 10);
    const iWarn = all.findIndex((item) => item.text === '商机停滞 8 天');
    const iGap = all.findIndex((item) => item.icon === '🎒');
    const iInfo = all.findIndex((item) => item.text === '一条 info 提醒');
    expect(iWarn).toBe(0);
    expect(iGap).toBeGreaterThan(iWarn);
    expect(iInfo).toBeGreaterThan(iGap);
    expect(computeG64111Today([account], reminders, TODAY)).toHaveLength(3);
  });

  it('今天到期的 Commitment 压过 warn 提醒', () => {
    const account = accWith([{ title: '今天要交', localDate: TODAY }]);
    const out = computeToday([account], [{
      accountId: account.id, accountName: account.name, title: 'warn 提醒', severity: 'warn',
    }], TODAY);
    expect(out[0].text).toContain('今天要交');
  });
});

describe('today · 需要你角标', () => {
  it('聚合 inbox 与到期 Commitment，并按 entityId 避免同一到期提醒重复计数', () => {
    const account = accWith([
      { title: '逾期', localDate: '2026-06-30' },
      { title: '没到期', localDate: '2026-12-31' },
    ]);
    const dueId = account.commitments![0].id;
    const inbox = {
      rels: [{ accountId: account.id }],
      proposals: [{ accountId: account.id }, { accountId: account.id }],
      reminders: [
        { accountId: account.id, kind: 'commitment_due', entityId: dueId },
        { accountId: 'other-acc' },
      ],
    };
    const counts = needsYouByAccount([account], inbox, TODAY);
    expect(counts.get(account.id)).toBe(4);
    expect(counts.get('other-acc')).toBe(1);
  });
});
