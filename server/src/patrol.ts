// 后台巡检引擎（确定性·零 LLM）：扫描活跃商机，发现「该动了」的信号 → 提醒型提案草稿。
// 纯函数(computeReminders)便于单测；DB 读写 / 去重 / 自动消除在 jobs.ts。
// 三规则互补于前端 GapCards(g64111 缺口)——这里只管「时间 / 覆盖」维度。
// 严守铁律②：只产出草稿(进收件箱人审)，绝不直接改库。

const DAY = 24 * 60 * 60 * 1000;
export const STALL_DAYS = 7; // 商机多久无新动作算停滞
export const RECHECK_DAYS = 14; // 关键人支持度多久没新证据该复查

// 巡检输入：单个商机的轻量快照（jobs.ts 从 prisma 组装；不依赖 prisma 类型，便于单测）
export interface PatrolRole {
  personId: string;
  personName: string;
  role: string; // A | D | U | R | C
  sentiment: string; // star|plus|neutral|unknown|minus|x
  lastEvidenceAt: Date | null; // 该人最近一条证据时间
}
export interface PatrolOpp {
  tenantId: string;
  accountId: string;
  accountName: string;
  opportunityId: string;
  oppName: string;
  createdAt: Date; // 商机建立时间（无任何活动时的停滞基准）
  lastActivityAt: Date | null; // max(visitNote/evidence/planAction createdAt)
  roles: PatrolRole[];
}

export type ReminderKind = 'stalled' | 'no_decider' | 'sentiment_recheck';
export interface ReminderDraft {
  tenantId: string;
  accountId: string;
  accountName: string;
  opportunityId: string;
  oppName: string;
  kind: ReminderKind;
  title: string;
  detail: string;
  severity: 'info' | 'warn';
  entityId: string | null;
  dedupeKey: string;
}

const SENT_LABEL: Record<string, string> = { star: '排他支持', plus: '明确支持', neutral: '中立', unknown: '未明', minus: '负面', x: '倒向对手' };
const EXPLICIT_SENT = new Set(['star', 'plus', 'minus', 'x']); // 明确表过态（值得复查时效）

// ── P2 心跳：最近一轮巡检的按租户统计（内存即可——重启后首轮巡检回填；无活跃商机的租户无条目→前端不显示心跳）。
// 状态放这里（而非 jobs.ts）：suggest.ts /api/inbox 要读，jobs.ts 已 import suggest.js，放 jobs 会成循环。
export type PatrolInfo = { at: string; scanned: number; created: number; resolved: number };
const lastPatrolByTenant = new Map<string, PatrolInfo>();
export function recordPatrol(byTenant: Map<string, { scanned: number; created: number; resolved: number }>, at: string): void {
  for (const [tid, b] of byTenant) lastPatrolByTenant.set(tid, { at, ...b });
}
export function getPatrolInfo(tenantId: string): PatrolInfo | null { return lastPatrolByTenant.get(tenantId) ?? null; }

const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / DAY);

/**
 * 对单个商机跑三条确定性巡检规则，产出提醒草稿。now 注入便于测试。
 * dedupeKey 不含天数 → 同类提醒幂等（jobs.ts 按 dedupeKey upsert，不刷屏）。
 */
export function computeReminders(opp: PatrolOpp, now: Date): ReminderDraft[] {
  const out: ReminderDraft[] = [];
  const base = { tenantId: opp.tenantId, accountId: opp.accountId, accountName: opp.accountName, opportunityId: opp.opportunityId, oppName: opp.oppName };

  // 规则①：商机停滞——最近动作(无动作则取建立时间)距今 ≥ STALL_DAYS
  const lastTouch = opp.lastActivityAt ?? opp.createdAt;
  const stallDays = daysBetween(now, lastTouch);
  if (stallDays >= STALL_DAYS) {
    out.push({
      ...base, kind: 'stalled', entityId: null,
      severity: stallDays >= STALL_DAYS * 2 ? 'warn' : 'info',
      title: `「${opp.oppName}」已 ${stallDays} 天没有新动作`,
      detail: `最近一次拜访 / 证据 / 行动在 ${stallDays} 天前，建议尽快推进或更新进展。`,
      dedupeKey: `${opp.opportunityId}:stalled`,
    });
  }

  // 规则②：决策链不完整——缺 A(批准人) 或 D(决策人)
  const roleSet = new Set(opp.roles.map((r) => r.role));
  const missing: string[] = [];
  if (!roleSet.has('A')) missing.push('批准人 A');
  if (!roleSet.has('D')) missing.push('决策人 D');
  if (missing.length) {
    out.push({
      ...base, kind: 'no_decider', entityId: null, severity: 'warn',
      title: `「${opp.oppName}」决策链不完整：缺${missing.join('、')}`,
      detail: `还没识别${missing.join('、')}，关键人缺位会让趋赢力打分失真，建议尽快补上。`,
      dedupeKey: `${opp.opportunityId}:no_decider`,
    });
  }

  // 规则③：支持度待复查——A/D 已明确表态，但最近证据 ≥ RECHECK_DAYS（或从无证据）
  for (const r of opp.roles) {
    if (r.role !== 'A' && r.role !== 'D') continue;
    if (!EXPLICIT_SENT.has(r.sentiment)) continue;
    const evDays = r.lastEvidenceAt ? daysBetween(now, r.lastEvidenceAt) : null;
    if (evDays !== null && evDays < RECHECK_DAYS) continue; // 近期有证据，不必复查
    const since = evDays === null ? '建立以来还没有证据支撑' : `已 ${evDays} 天没有新证据`;
    out.push({
      ...base, kind: 'sentiment_recheck', entityId: r.personId, severity: 'info',
      title: `${r.personName}(${r.role}) 的支持度该复查了`,
      detail: `当前支持度「${SENT_LABEL[r.sentiment] ?? r.sentiment}」，${since}，建议复查是否仍成立。`,
      dedupeKey: `${opp.opportunityId}:sentiment_recheck:${r.personId}`,
    });
  }

  return out;
}
