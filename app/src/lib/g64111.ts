// G64111 趋赢力评分引擎 —— 严格实现 docs/G64111-评分规格.md
// 纯函数、无副作用、可单元测试。任何冲突以行动宝典 / 评分规格为准。

import type {
  Account, Opportunity, Role, Sentiment, Confidence, EngageStage, ProcurementType, ProcurementStatus,
} from '../types';
import { C3_ITEMS, C5_ITEMS, FAMILY_7Q } from '../types';

// ───────────────────────── 常量映射（规格 §4/§5） ─────────────────────────

/** P3 / 1K 计分：☆+20 / ++10 / =? 0 / − −10 / x −20 */
export const P3_1K_MAP: Record<Sentiment, number> = {
  star: 20, plus: 10, neutral: 0, unknown: 0, minus: -10, x: -20,
};
/** P4 计分：☆+10 / ++5 / 其余 0（不为负） */
export const P4_MAP: Record<Sentiment, number> = {
  star: 10, plus: 5, neutral: 0, unknown: 0, minus: 0, x: 0,
};
/** C4 介入阶段 → 分（越早越高） */
export const C4_MAP: Record<EngageStage, number> = {
  需求调研立项: 5, 方案可研: 4, 预算批复: 3, 招标论证: 2, 招采执行: 1,
};
/** 741 竞争策略带阈值（规格 §7，已删除采购周期条件） */
export type Band741 = 'ABSOLUTE_ADVANTAGE' | 'RELATIVE_ADVANTAGE' | 'RELATIVE_DISADVANTAGE' | 'ABSOLUTE_DISADVANTAGE';
export const BAND_LABEL: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '绝对优势 · 可承诺',
  RELATIVE_ADVANTAGE: '相对优势 · 可争取',
  RELATIVE_DISADVANTAGE: '相对劣势 · 可参与',
  ABSOLUTE_DISADVANTAGE: '绝对劣势 · 重新复盘',
};
export const BAND_STRATEGY: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '直接赢单：控节奏、加速签约、绑框架/多项目复制、防节外生枝',
  RELATIVE_ADVANTAGE: '制定规则/加速进度/总包：主导技术参数与评分、推动尽快挂网、联合体绑定设计院',
  RELATIVE_DISADVANTAGE: '改变规则/减速拖延/拆包：把客户从比价格引到比一体化降本、拖到有利时点、拆出对手强项模块',
  ABSOLUTE_DISADVANTAGE: '重新回炉：评估放弃或养单、优先补 C1/C2 与 D/A 关系、争下一期',
};

// ───────────────────────── 评分档案（规格 §8，可配置权重） ─────────────────────────

export interface ScoringProfile {
  id: string;
  name: string;
  formC1Curve: 'strict' | 'linear'; // C1 家庭7问曲线
  bands: { absAdv: number; relAdv: number; relDis: number }; // 741 阈值
}
export const DEFAULT_PROFILE: ScoringProfile = {
  id: 'energy-g64111-v1',
  name: '数字能源 G64111 v1.0',
  formC1Curve: 'strict',
  bands: { absAdv: 0.75, relAdv: 0.5, relDis: 0.25 },
};

// ───────────────────────── 通用工具 ─────────────────────────

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 多 A / 多 D 聚合：取中位数的低分（偶数取偏低的下中位数）。规格 §6 */
export function aggregateLow(scores: number[]): number {
  if (scores.length === 0) return 0;
  const s = [...scores].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : s[n / 2 - 1];
}

/** 741 带判定。规格 §7 */
export function band741(percent: number, bands = DEFAULT_PROFILE.bands): Band741 {
  if (percent >= bands.absAdv) return 'ABSOLUTE_ADVANTAGE';
  if (percent >= bands.relAdv) return 'RELATIVE_ADVANTAGE';
  if (percent >= bands.relDis) return 'RELATIVE_DISADVANTAGE';
  return 'ABSOLUTE_DISADVANTAGE';
}

const CONF_RANK: Record<Confidence, number> = { 共识: 3, 明确: 2, 推理: 1, 不清: 0 };
/** 是否「明确」及以上 */
export const isConfirmed = (c: Confidence) => CONF_RANK[c] >= CONF_RANK['明确'];

// ───────────────────────── 评分输入（领域 → 扁平输入，便于单测） ─────────────────────────

export interface ScoringInput {
  rolesPresent: Record<Role, boolean>;
  nonAUnknownCount: number;
  procurementTypesIdentified: number; // 0..3
  dFamily7Filled: number; // 0..7
  dHasBI: boolean; // confidence ≥ 明确
  c3KnownCount: number; // 0..7
  engageStage: EngageStage | null;
  c5KnownCount: number; // 0..5
  ucvStatus: 'none' | '建议' | '获认可' | '已解决';
  p1PlusCount: number; // 明确确认的 +/☆ 人数
  p1MinusCount: number; // 明确确认的 −/x 人数
  p2: Record<ProcurementType, ProcurementStatus>;
  dSentiments: Sentiment[];
  aSentiments: Sentiment[];
  keyInfluencerSentiment: Sentiment | null;
}

// ───────────────────────── 单项计分函数（规格 §3-§5） ─────────────────────────

export function scoreC1(i: ScoringInput, profile = DEFAULT_PROFILE): number {
  const anyRoleMissing = (['A', 'D', 'U', 'TB', 'R'] as Role[]).some((r) => !i.rolesPresent[r]);
  const roleScore = Math.max(0, 6 - (anyRoleMissing ? 3 : 0) - i.nonAUnknownCount);
  const procureScore = (i.procurementTypesIdentified / 3) * 1;
  const adur = Math.min(7, roleScore + procureScore);
  const formScore =
    profile.formC1Curve === 'linear'
      ? Math.round((3 * i.dFamily7Filled) / 7)
      : Math.max(0, 3 - (7 - i.dFamily7Filled)); // 严格曲线
  return adur + formScore; // 0..10
}
export const scoreC2 = (i: ScoringInput): number => (i.dHasBI ? 5 : 0);
export const scoreC3 = (i: ScoringInput): number => clamp(5 - (7 - i.c3KnownCount), 0, 5);
export const scoreC4 = (i: ScoringInput): number => (i.engageStage ? C4_MAP[i.engageStage] : 0);
export const scoreC5 = (i: ScoringInput): number => clamp(5 - (5 - i.c5KnownCount), 0, 5);
export const scoreC6 = (i: ScoringInput): number =>
  i.ucvStatus === '已解决' ? 5 : i.ucvStatus === '获认可' ? 3 : 0;

export const scoreP1 = (i: ScoringInput): number => clamp(i.p1PlusCount - i.p1MinusCount, -5, 5);

const P2_WEIGHT = { purchasing: 4, agency: 2, ownerRep: 4 } as const;
export function scoreP2(i: ScoringInput): number {
  const types = Object.keys(P2_WEIGHT) as ProcurementType[];
  const allNone = types.every((t) => i.p2[t] === 'none');
  if (allNone) return -5;
  let sum = 0;
  for (const t of types) {
    const st = i.p2[t];
    if (st === 'collude') sum += P2_WEIGHT[t];
    else if (st === 'verbal') sum += 1;
  }
  return sum; // -5 .. +10
}

export const scoreP3 = (i: ScoringInput): number => aggregateLow(i.dSentiments.map((s) => P3_1K_MAP[s]));
export const scoreP4 = (i: ScoringInput): number => (i.keyInfluencerSentiment ? P4_MAP[i.keyInfluencerSentiment] : 0);
export const score1K = (i: ScoringInput): number => aggregateLow(i.aSentiments.map((s) => P3_1K_MAP[s]));

// ───────────────────────── 汇总（规格 §0/§7） ─────────────────────────

export type ItemKey = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'P1' | 'P2' | 'P3' | 'P4' | '1K';
export const ITEM_MAX: Record<ItemKey, number> = {
  C1: 10, C2: 5, C3: 5, C4: 5, C5: 5, C6: 5, P1: 5, P2: 10, P3: 20, P4: 10, '1K': 20,
};
export const ITEM_LABEL: Record<ItemKey, string> = {
  C1: 'C1 组织图+D的FORM', C2: 'C2 拍板人BI', C3: 'C3 立项材料+排序', C4: 'C4 介入阶段',
  C5: 'C5 招采事项', C6: 'C6 UCV解决度', P1: 'P1 多数人支持', P2: 'P2 招采关键人',
  P3: 'P3 与D密谋/支持', P4: 'P4 关键影响人', '1K': '1K 与A密谋/支持',
};
export const ITEM_GROUP: Record<ItemKey, '6必清' | '4优势' | '1决胜'> = {
  C1: '6必清', C2: '6必清', C3: '6必清', C4: '6必清', C5: '6必清', C6: '6必清',
  P1: '4优势', P2: '4优势', P3: '4优势', P4: '4优势', '1K': '1决胜',
};

export interface ScoreBreakdown {
  items: Record<ItemKey, number>;
  clears: number; // 6必清(35)
  priorities: number; // 4优势(45)
  key: number; // 1决胜(20)
  total: number; // -50 .. 100
  percent: number; // total/100，允许为负
  band: Band741;
}

export function scoreOpportunity(i: ScoringInput, profile = DEFAULT_PROFILE): ScoreBreakdown {
  const items: Record<ItemKey, number> = {
    C1: scoreC1(i, profile),
    C2: scoreC2(i),
    C3: scoreC3(i),
    C4: scoreC4(i),
    C5: scoreC5(i),
    C6: scoreC6(i),
    P1: scoreP1(i),
    P2: scoreP2(i),
    P3: scoreP3(i),
    P4: scoreP4(i),
    '1K': score1K(i),
  };
  const clears = items.C1 + items.C2 + items.C3 + items.C4 + items.C5 + items.C6;
  const priorities = items.P1 + items.P2 + items.P3 + items.P4;
  const key = items['1K'];
  const total = clears + priorities + key;
  const percent = total / 100;
  return { items, clears, priorities, key, total, percent, band: band741(percent, profile.bands) };
}

// ───────────────────────── 领域模型 → 评分输入 ─────────────────────────

export function buildScoringInput(account: Account, opp: Opportunity): ScoringInput {
  const roles = opp.roles;
  const personById = new Map(account.persons.map((p) => [p.id, p]));

  const rolesPresent = { A: false, D: false, U: false, TB: false, R: false } as Record<Role, boolean>;
  for (const r of roles) rolesPresent[r.role] = true;

  const nonAUnknownCount = roles.filter((r) => r.role !== 'A' && r.sentiment === 'unknown').length;

  const procurementTypesIdentified = new Set(
    roles.filter((r) => r.procurementType).map((r) => r.procurementType),
  ).size;

  // C1 的 FORM 取主拍板人 D（多 D 时取第一个）
  const dRoles = roles.filter((r) => r.role === 'D');
  const primaryD = dRoles[0];
  const dPerson = primaryD ? personById.get(primaryD.personId) : undefined;
  const dFamily7Filled = dPerson
    ? FAMILY_7Q.filter((q) => (dPerson.form.family7[q] ?? '').trim() !== '').length
    : 0;

  const dPersonIds = new Set(dRoles.map((r) => r.personId));
  const dHasBI = opp.bis.some((bi) => dPersonIds.has(bi.personId) && isConfirmed(bi.confidence));

  const c3KnownCount = C3_ITEMS.filter((k) => opp.c3Items[k]).length;
  const c5KnownCount = C5_ITEMS.filter((k) => opp.c5Items[k]).length;

  // C6：取针对 D 的 BI 的最佳 UCV 状态
  const dBiIds = new Set(opp.bis.filter((bi) => dPersonIds.has(bi.personId)).map((bi) => bi.id));
  let ucvStatus: ScoringInput['ucvStatus'] = 'none';
  for (const u of opp.ucvs) {
    if (!dBiIds.has(u.targetBiId)) continue;
    if (u.status === '已解决') { ucvStatus = '已解决'; break; }
    if (u.status === '获认可') ucvStatus = '获认可';
    else if (u.status === '建议' && ucvStatus === 'none') ucvStatus = '建议';
  }

  // P1：仅计「明确」及以上确认
  const confirmed = roles.filter((r) => isConfirmed(r.confidence));
  const p1PlusCount = confirmed.filter((r) => r.sentiment === 'plus' || r.sentiment === 'star').length;
  const p1MinusCount = confirmed.filter((r) => r.sentiment === 'minus' || r.sentiment === 'x').length;

  // P2
  const p2: Record<ProcurementType, ProcurementStatus> = { purchasing: 'none', agency: 'none', ownerRep: 'none' };
  for (const r of roles) {
    if (r.procurementType && r.procurementStatus) p2[r.procurementType] = r.procurementStatus;
  }

  const dSentiments = dRoles.map((r) => r.sentiment);
  const aSentiments = roles.filter((r) => r.role === 'A').map((r) => r.sentiment);
  const ki = roles.find((r) => r.isKeyInfluencer);

  return {
    rolesPresent,
    nonAUnknownCount,
    procurementTypesIdentified,
    dFamily7Filled,
    dHasBI,
    c3KnownCount,
    engageStage: opp.engageStage ?? null,
    c5KnownCount,
    ucvStatus,
    p1PlusCount,
    p1MinusCount,
    p2,
    dSentiments,
    aSentiments,
    keyInfluencerSentiment: ki ? ki.sentiment : null,
  };
}

/** 便捷：直接从领域模型算分 */
export function scoreFromDomain(account: Account, opp: Opportunity, profile = DEFAULT_PROFILE): ScoreBreakdown {
  return scoreOpportunity(buildScoringInput(account, opp), profile);
}
