import { describe, it, expect } from 'vitest';
import { computeToday, needsYouByAccount } from './today';
import { seedAccount } from '../data/seed';
import { newPlanAction } from '../store';
import type { Account } from '../types';

const TODAY = '2026-07-02';

// 基于 seed 克隆一个可控 fixture：清掉行动牌，按需注入
function accWith(actions: Array<{ title: string; endDate: string; done?: boolean; draft?: boolean }>): Account {
  const acc: Account = JSON.parse(JSON.stringify(seedAccount));
  const opp = acc.opportunities[0];
  acc.planActions = actions.map((s, i) => {
    const pa = newPlanAction(acc.id, opp.id, s.endDate);
    pa.id = 'pa' + i; pa.title = s.title; pa.endDate = s.endDate; pa.done = s.done ?? false; pa.draft = s.draft ?? false;
    return pa;
  });
  return acc;
}

describe('today · 今日三件事（P5）', () => {
  it('逾期行动排最前，越久越靠前', () => {
    const acc = accWith([
      { title: '拜访 A', endDate: '2026-06-30' }, // 逾期 2 天
      { title: '拜访 B', endDate: '2026-06-20' }, // 逾期 12 天
    ]);
    const out = computeToday([acc], [], TODAY);
    expect(out[0].text).toContain('拜访 B');
    expect(out[0].text).toContain('逾期 12 天');
    expect(out[1].text).toContain('拜访 A');
  });

  it('done/draft/无到期日 的行动不进清单', () => {
    const acc = accWith([
      { title: '已完成', endDate: '2026-06-01', done: true },
      { title: '草稿', endDate: '2026-06-01', draft: true },
    ]);
    const out = computeToday([acc], [], TODAY);
    expect(out.some((t) => t.text.includes('已完成') || t.text.includes('草稿'))).toBe(false);
  });

  it('顺序：warn 提醒 > 缺口 > info 提醒；默认取 3 件', () => {
    const acc = accWith([]);
    const reminders = [
      { accountId: acc.id, accountName: acc.name, title: '商机停滞 8 天', severity: 'warn' },
      { accountId: acc.id, accountName: acc.name, title: '一条 info 提醒', severity: 'info' },
    ];
    const all = computeToday([acc], reminders, TODAY, 10); // 放宽上限看完整顺序
    const iWarn = all.findIndex((t) => t.text === '商机停滞 8 天');
    const iGap = all.findIndex((t) => t.icon === '🎒');
    const iInfo = all.findIndex((t) => t.text === '一条 info 提醒');
    expect(iWarn).toBe(0);
    expect(iGap).toBeGreaterThan(iWarn);
    expect(iInfo).toBeGreaterThan(iGap);
    expect(computeToday([acc], reminders, TODAY)).toHaveLength(3); // 默认截 3
  });

  it('今天到期的行动压过 warn 提醒', () => {
    const acc = accWith([{ title: '今天要交', endDate: TODAY }]);
    const out = computeToday([acc], [{ accountId: acc.id, accountName: acc.name, title: 'warn 提醒', severity: 'warn' }], TODAY);
    expect(out[0].text).toContain('今天要交');
  });
});

describe('today · 需要你角标（P5）', () => {
  it('聚合 inbox 各类 + 逾期行动；done/draft 不计', () => {
    const acc = accWith([
      { title: '逾期', endDate: '2026-06-30' },
      { title: '没到期', endDate: '2026-12-31' },
      { title: '草稿逾期', endDate: '2026-06-01', draft: true },
    ]);
    const inbox = {
      rels: [{ accountId: acc.id }],
      proposals: [{ accountId: acc.id }, { accountId: acc.id }],
      reminders: [{ accountId: 'other-acc' }],
    };
    const m = needsYouByAccount([acc], inbox, TODAY);
    expect(m.get(acc.id)).toBe(4);        // 1 rel + 2 proposal + 1 逾期行动
    expect(m.get('other-acc')).toBe(1);   // 别的客户的提醒各归各
  });
});
