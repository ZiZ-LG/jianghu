// P5 「今日三件事」+ Hub 客户卡「需要你」角标。
// 通用聚合：① Commitment（最急）②巡检提醒。方法论扩展通过 additionalItems 显式注入。
import type { Account } from '../types';
import type { CommitmentV2 } from '@jianghu/domain-contracts';
import { localYmd } from './dateYmd';

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
  reminders?: { accountId: string; kind?: string; entityId?: string }[];
  evidences?: { accountId: string }[];
}
export interface ReminderLite {
  accountId: string;
  accountName: string;
  oppName?: string;
  title: string;
  severity: string;
  kind?: string;
  entityId?: string;
}

const diffDays = (a: string, b: string) => Math.round((new Date(a + 'T00:00:00').getTime() - new Date(b + 'T00:00:00').getTime()) / 86400000);

function commitmentDate(commitment: CommitmentV2): string | null {
  if (commitment.isAllDay) return commitment.localDate;
  const eventAt = commitment.dueAtUtc ?? commitment.scheduledAtUtc;
  if (!eventAt) return null;
  const parsed = new Date(eventAt);
  if (!Number.isFinite(parsed.getTime())) return null;
  try { return localYmd(parsed, commitment.timeZone); } catch { return null; }
}

function currentCommitment(commitment: CommitmentV2): boolean {
  return commitment.executionStatus === 'planned'
    && commitment.confirmationStatus !== 'declined'
    && commitment.archivedAt === null;
}

/** 今日三件事：通用来源与显式扩展混排取 top（默认 3 件）。today 传 YYYY-MM-DD，便于测试。 */
export function computeToday(
  accounts: Account[],
  reminders: ReminderLite[],
  today: string,
  max = 3,
  additionalItems: readonly TodayItem[] = [],
): TodayItem[] {
  const items: TodayItem[] = [...additionalItems];
  const directDueCommitmentIds = new Set<string>();
  // ① Commitment：只读通用字段，不从 legacy PlanAction fallback。
  for (const a of accounts) {
    for (const commitment of a.commitments ?? []) {
      if (!currentCommitment(commitment)) continue;
      const date = commitmentDate(commitment);
      if (!date) continue;
      const overdue = diffDays(today, date);
      if (!Number.isFinite(overdue) || overdue < -1) continue;
      const matterName = commitment.matterId
        ? a.opportunities.find((matter) => matter.id === commitment.matterId)?.name
        : undefined;
      const sub = [a.name, matterName].filter(Boolean).join(' · ');
      const title = commitment.title || '（未命名承诺）';
      directDueCommitmentIds.add(commitment.id);
      if (overdue > 0) {
        items.push({ icon: '⏰', text: `承诺逾期 ${overdue} 天：${title}`, sub, accId: a.id, prio: 100 - Math.min(overdue, 90) });
      } else {
        items.push({ icon: '📅', text: `${overdue === 0 ? '今天' : '明天'}到期：${title}`, sub, accId: a.id, prio: 200 + overdue });
      }
    }
  }
  // ② 巡检提醒：warn 插在缺口前，info 殿后
  for (const r of reminders) {
    if (r.kind === 'commitment_due' && r.entityId && directDueCommitmentIds.has(r.entityId)) continue;
    items.push({ icon: '🔔', text: r.title, sub: [r.accountName, r.oppName].filter(Boolean).join(' · '), accId: r.accountId, prio: r.severity === 'warn' ? 300 : 500 });
  }
  return items.sort((x, y) => x.prio - y.prio).slice(0, max);
}

/** Hub 客户卡「需要你」计数：待审项 + 到期 Commitment，同一到期提醒只计一次。 */
export function needsYouByAccount(accounts: Account[], inbox: InboxByAccount, today: string): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const k of ['rels', 'persons', 'proposals', 'evidences'] as const) {
    for (const it of inbox[k] ?? []) bump(it.accountId);
  }
  const directDueCommitmentIds = new Set<string>();
  for (const a of accounts) {
    for (const commitment of a.commitments ?? []) {
      if (!currentCommitment(commitment)) continue;
      const date = commitmentDate(commitment);
      if (!date) continue;
      const overdue = diffDays(today, date);
      if (!Number.isFinite(overdue) || overdue < 0) continue;
      directDueCommitmentIds.add(commitment.id);
      bump(a.id);
    }
  }
  for (const reminder of inbox.reminders ?? []) {
    if (reminder.kind === 'commitment_due'
      && reminder.entityId
      && directDueCommitmentIds.has(reminder.entityId)) continue;
    bump(reminder.accountId);
  }
  return m;
}
