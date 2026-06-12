// 江湖行为信号库（E2）—— 「言语会诈唬，下注模式不会」：行为信号高权重，口头表态低权重。
// 前端常量预置；租户级可配（表化 SignalCatalog）留后续。docs/策略引擎-设计方案.md §6。
// 证据 → 三态伪计数增量：direction +1 加 αS、−1 加 αO；强度档定量级。

export type SignalTier = 'weak' | 'mid' | 'strong';

export interface SignalDef {
  key: string;
  label: string;
  direction: 1 | -1 | 0;     // 0 = 需录入时人工定向（既可能利好也可能不利）
  behavioral: boolean;        // 行为信号 vs 言语信号
  delta: Record<SignalTier, number>;
  hint?: string;
}

export const SIGNAL_CATALOG: SignalDef[] = [
  { key: 'intro_referral', label: '主动引荐更高层', direction: 1, behavioral: true, delta: { weak: 1, mid: 1.5, strong: 2 }, hint: '用自己的政治资本背书，最强利好信号之一' },
  { key: 'spec_alignment', label: '需求/规格向我方收敛', direction: 1, behavioral: true, delta: { weak: 1, mid: 1.5, strong: 2 }, hint: '文档动作 > 口头表态' },
  { key: 'attendance_upgrade', label: '出席级别提升', direction: 1, behavioral: true, delta: { weak: 0.5, mid: 1, strong: 1.5 } },
  { key: 'proactive_followup', label: '主动跟进/索要资料', direction: 1, behavioral: true, delta: { weak: 0.5, mid: 1, strong: 1.5 } },
  { key: 'verbal_positive', label: '口头积极表态', direction: 1, behavioral: false, delta: { weak: 0.5, mid: 0.5, strong: 1 }, hint: '刻意低权重——言语会诈唬' },
  { key: 'reply_latency_up', label: '回复明显变慢', direction: -1, behavioral: true, delta: { weak: 0.5, mid: 1, strong: 1.5 } },
  { key: 'meeting_cancel', label: '关键会议被取消/降级', direction: -1, behavioral: true, delta: { weak: 1, mid: 1.5, strong: 2 } },
  { key: 'competitor_lean', label: '明显倾向竞品', direction: -1, behavioral: true, delta: { weak: 1, mid: 2, strong: 2.5 } },
  { key: 'competitor_quote', label: '主动索要竞品对比', direction: 0, behavioral: true, delta: { weak: 1, mid: 1.5, strong: 2 }, hint: '可能是流程要求，也可能是倒戈信号——录入时人工定向' },
  { key: 'internal_blocker', label: '透露内部反对声音', direction: 0, behavioral: true, delta: { weak: 1, mid: 1.5, strong: 2 }, hint: '既可能是负信号，也可能是"队友递牌"——人工定向' },
];

export const SIGNAL_BY_KEY = new Map(SIGNAL_CATALOG.map((s) => [s.key, s]));

/** 一条已审证据 → 三态伪计数增量 [Δs, Δn, Δo]（direction 取最终定稿值） */
export function evidenceAlpha(signalKey: string, direction: number, tier: SignalTier): [number, number, number] {
  const def = SIGNAL_BY_KEY.get(signalKey);
  if (!def) return [0, 0, 0];
  const mag = def.delta[tier] ?? def.delta.mid;
  if (direction > 0) return [mag, 0, 0];
  if (direction < 0) return [0, 0, mag];
  return [0, 0, 0];
}
