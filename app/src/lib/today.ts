// P5 「今日三件事」+ Hub 客户卡「需要你」角标（三环评价：桌面版今日一屏，纯前端可算零 schema）。
// 三源聚合：①逾期/今明到期的行动牌（最急）②巡检提醒（warn 优先）③各商机最大缺口性价比项。
// 手机场景 A 的今日一屏（MomentFlow）已有自己的引擎排序，这里只服务桌面 Hub。
import type { Account } from '../types';
import { computeGaps } from './gaps';

export interface TodayItem {
  icon: string;
  text: string;   // 主文案
  sub: string;    // 客户 · 商机 上下文
  accId: string;
  prio: number;   // 越小越靠前：逾期(10..100) < 今明到期(199..201) < warn 提醒(300) < 缺口(390..400) < info 提醒(500)
}

// inbox 各类待审项都带 accountId；这里只依赖这一个字段，避免与 api.ts 类型强耦合
export interface InboxByAccount {
  rels?: { accountId: string }[];
  persons?: { accountId: string }[];
  proposals?: { accountId: string }[];
  reminders?: { accountId: string }[];
  evidences?: { accountId: string }[];
}
export interface ReminderLite { accountId: string; accountName: string; oppName?: string; title: string; severity: string }

const diffDays = (a: string, b: string) => Math.round((new Date(a + 'T00:00:00').getTime() - new Date(b + 'T00:00:00').getTime()) / 86400000);

/** 今日三件事：三源打分混排取 top（默认 3 件）。today 传 YYYY-MM-DD，便于测试。 */
export function computeToday(accounts: Account[], reminders: ReminderLite[], today: string, max = 3): TodayItem[] {
  const items: TodayItem[] = [];
  // ① 行动牌：已上桌未完成——逾期最急（越久越前），今/明到期次之（草稿不算：还没上桌谈不上逾期）
  for (const a of accounts) {
    for (const pa of a.planActions ?? []) {
      if (pa.done || pa.draft || !pa.endDate) continue;
      const overdue = diffDays(today, pa.endDate);
      const title = pa.title || '（未命名行动）';
      if (overdue > 0) items.push({ icon: '⏰', text: `行动逾期 ${overdue} 天：${title}`, sub: a.name, accId: a.id, prio: 100 - Math.min(overdue, 90) });
      else if (overdue >= -1) items.push({ icon: '📅', text: `${overdue === 0 ? '今天' : '明天'}到期：${title}`, sub: a.name, accId: a.id, prio: 200 + overdue });
    }
  }
  // ② 巡检提醒：warn 插在缺口前，info 殿后
  for (const r of reminders) {
    items.push({ icon: '🔔', text: r.title, sub: [r.accountName, r.oppName].filter(Boolean).join(' · '), accId: r.accountId, prio: r.severity === 'warn' ? 300 : 500 });
  }
  // ③ 缺口：每个活跃商机取性价比最高一条（computeGaps 已按 deficit 降序），问句 framing 优先
  for (const a of accounts) {
    for (const o of a.opportunities) {
      if (o.status && o.status !== 'active') continue;
      const g = computeGaps(a, o)[0];
      if (g) items.push({ icon: '🎒', text: g.ask ?? g.title, sub: `${a.name} · ${o.name}`, accId: a.id, prio: 400 - g.deficit });
    }
  }
  return items.sort((x, y) => x.prio - y.prio).slice(0, max);
}

/** Hub 客户卡「需要你」计数：该客户 inbox 待审项（候选/提案/提醒/证据）+ 逾期行动。 */
export function needsYouByAccount(accounts: Account[], inbox: InboxByAccount, today: string): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const k of ['rels', 'persons', 'proposals', 'reminders', 'evidences'] as const) {
    for (const it of inbox[k] ?? []) bump(it.accountId);
  }
  for (const a of accounts) {
    for (const pa of a.planActions ?? []) {
      if (!pa.done && !pa.draft && pa.endDate && diffDays(today, pa.endDate) > 0) bump(a.id);
    }
  }
  return m;
}
