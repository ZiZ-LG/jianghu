// G64111 趋赢力评分引擎 —— server 侧精简实现，严格对齐 docs/G64111-评分规格.md。
// 与 app/src/lib/g64111.ts 算法一致，但自包含（不跨目录引用 app），输入用「组装态」形状
// （见 state.ts：accounts[].opportunities[].{roles,bis,ucvs,c3Items,c5Items,...} 与 persons[].form）。
// 纯函数、无副作用；只读，绝不写库。

// ───────────────────────── 领域类型（与组装态对齐的最小子集） ─────────────────────────

export type Role = 'A' | 'D' | 'U' | 'TB' | 'R';
export type Sentiment = 'star' | 'plus' | 'neutral' | 'unknown' | 'minus' | 'x';
export type Confidence = '共识' | '明确' | '推理' | '不清';
export type EngageStage = '需求调研立项' | '方案可研' | '预算批复' | '招标论证' | '招采执行';
export type ProcurementType = 'purchasing' | 'agency' | 'ownerRep';
export type ProcurementStatus = 'collude' | 'verbal' | 'none';

export interface SForm {
  family7?: Record<string, string | undefined>;
}
export interface SPerson {
  id: string;
  form?: SForm;
}
export interface SRole {
  personId: string;
  role: Role;
  sentiment: Sentiment;
  confidence: Confidence;
  isKeyInfluencer?: boolean;
  procurementType?: ProcurementType;
  procurementStatus?: ProcurementStatus;
}
export interface SBI {
  id: string;
  personId: string;
  confidence: Confidence;
}
export interface SUCV {
  targetBiId: string;
  status: '建议' | '获认可' | '已解决';
}
export interface SOpportunity {
  engageStage?: EngageStage | string | null;
  c3Items?: Record<string, boolean>;
  c5Items?: Record<string, boolean>;
  roles: SRole[];
  bis: SBI[];
  ucvs: SUCV[];
}
export interface SAccount {
  persons: SPerson[];
}

// ───────────────────────── 常量映射（规格 §4/§5/§7） ─────────────────────────

const P3_1K_MAP: Record<Sentiment, number> = { star: 20, plus: 10, neutral: 0, unknown: 0, minus: -10, x: -20 };
const P4_MAP: Record<Sentiment, number> = { star: 10, plus: 5, neutral: 0, unknown: 0, minus: 0, x: 0 };
const C4_MAP: Record<EngageStage, number> = { 需求调研立项: 5, 方案可研: 4, 预算批复: 3, 招标论证: 2, 招采执行: 1 };

const C3_ITEMS = ['立项原因', '项目名称', '项目预算', '实施计划', '资金来源', '项目排序', '采购方式'] as const;
const C5_ITEMS = ['竞标方家数', '招标参数', '评标规则', '甲方代表', '招标代理'] as const;
const FAMILY_7Q = ['籍贯', '年纪', '生日', '毕业院校', '配偶', '子女', '父母'] as const;

export type Band741 = 'ABSOLUTE_ADVANTAGE' | 'RELATIVE_ADVANTAGE' | 'RELATIVE_DISADVANTAGE' | 'ABSOLUTE_DISADVANTAGE';
const BAND_LABEL: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '绝对优势 · 可承诺',
  RELATIVE_ADVANTAGE: '相对优势 · 可争取',
  RELATIVE_DISADVANTAGE: '相对劣势 · 可参与',
  ABSOLUTE_DISADVANTAGE: '绝对劣势 · 重新复盘',
};
const BAND_STRATEGY: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '直接赢单：控节奏、加速签约、绑框架/多项目复制、防节外生枝',
  RELATIVE_ADVANTAGE: '制定规则/加速进度/总包：主导技术参数与评分、推动尽快挂网、联合体绑定设计院',
  RELATIVE_DISADVANTAGE: '改变规则/减速拖延/拆包：把客户从比价格引到比一体化降本、拖到有利时点、拆出对手强项模块',
  ABSOLUTE_DISADVANTAGE: '重新回炉：评估放弃或养单、优先补 C1/C2 与 D/A 关系、争下一期',
};

const BANDS = { absAdv: 0.75, relAdv: 0.5, relDis: 0.25 };

// ───────────────────────── 通用工具 ─────────────────────────

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 多 A / 多 D 聚合：取中位数的低分（偶数取偏低的下中位数）。规格 §6 */
function aggregateLow(scores: number[]): number {
  if (scores.length === 0) return 0;
  const s = [...scores].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : s[n / 2 - 1];
}

function band741(percent: number): Band741 {
  if (percent >= BANDS.absAdv) return 'ABSOLUTE_ADVANTAGE';
  if (percent >= BANDS.relAdv) return 'RELATIVE_ADVANTAGE';
  if (percent >= BANDS.relDis) return 'RELATIVE_DISADVANTAGE';
  return 'ABSOLUTE_DISADVANTAGE';
}

const CONF_RANK: Record<Confidence, number> = { 共识: 3, 明确: 2, 推理: 1, 不清: 0 };
const isConfirmed = (c: Confidence) => CONF_RANK[c] >= CONF_RANK['明确'];

// ───────────────────────── 评分项 ─────────────────────────

export type ItemKey = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'P1' | 'P2' | 'P3' | 'P4' | '1K';
export const ITEM_MAX: Record<ItemKey, number> = {
  C1: 10, C2: 5, C3: 5, C4: 5, C5: 5, C6: 5, P1: 5, P2: 10, P3: 20, P4: 10, '1K': 20,
};
export const ITEM_LABEL: Record<ItemKey, string> = {
  C1: 'C1 组织图+D的FORM', C2: 'C2 拍板人BI', C3: 'C3 立项材料+排序', C4: 'C4 介入阶段',
  C5: 'C5 招采事项', C6: 'C6 UCV解决度', P1: 'P1 多数人支持', P2: 'P2 招采关键人',
  P3: 'P3 与D密谋/支持', P4: 'P4 关键影响人', '1K': '1K 与A密谋/支持',
};

export interface ScoreBreakdown {
  items: Record<ItemKey, number>;
  clears: number; // 6必清(35)
  priorities: number; // 4优势(45)
  key: number; // 1决胜(20)
  total: number; // -50..100
  percent: number; // total/100，允许为负
  band: Band741;
  bandLabel: string;
  strategy: string;
}

const P2_WEIGHT = { purchasing: 4, agency: 2, ownerRep: 4 } as const;

/** 从组装态的 account + opportunity 计算 G64111 趋赢力。规格 §0-§7 */
export function scoreFromState(account: SAccount, opp: SOpportunity): ScoreBreakdown {
  const roles = opp.roles ?? [];
  const personById = new Map(account.persons.map((p) => [p.id, p]));

  // —— C1：ADUR 图分(满7) + D家庭FORM分(满3) ——
  const rolesPresent: Record<Role, boolean> = { A: false, D: false, U: false, TB: false, R: false };
  for (const r of roles) rolesPresent[r.role] = true;
  const anyRoleMissing = (['A', 'D', 'U', 'TB', 'R'] as Role[]).some((r) => !rolesPresent[r]);
  const nonAUnknownCount = roles.filter((r) => r.role !== 'A' && r.sentiment === 'unknown').length;
  const roleScore = Math.max(0, 6 - (anyRoleMissing ? 3 : 0) - nonAUnknownCount);
  const procurementTypesIdentified = new Set(roles.filter((r) => r.procurementType).map((r) => r.procurementType)).size;
  const procureScore = (procurementTypesIdentified / 3) * 1;
  const adur = Math.min(7, roleScore + procureScore);

  const dRoles = roles.filter((r) => r.role === 'D');
  const primaryD = dRoles[0];
  const dPerson = primaryD ? personById.get(primaryD.personId) : undefined;
  const family7 = dPerson?.form?.family7 ?? {};
  const dFamily7Filled = dPerson ? FAMILY_7Q.filter((q) => (family7[q] ?? '').trim() !== '').length : 0;
  const formScore = Math.max(0, 3 - (7 - dFamily7Filled)); // 严格曲线
  const C1 = adur + formScore;

  // —— C2：D 有 confidence≥明确 的 BI ——
  const dPersonIds = new Set(dRoles.map((r) => r.personId));
  const dHasBI = opp.bis.some((bi) => dPersonIds.has(bi.personId) && isConfirmed(bi.confidence));
  const C2 = dHasBI ? 5 : 0;

  // —— C3 / C5：max(0, 满分 − 缺失项) ——
  const c3KnownCount = C3_ITEMS.filter((k) => opp.c3Items?.[k]).length;
  const c5KnownCount = C5_ITEMS.filter((k) => opp.c5Items?.[k]).length;
  const C3 = clamp(5 - (7 - c3KnownCount), 0, 5);
  const C5 = clamp(5 - (5 - c5KnownCount), 0, 5);

  // —— C4：介入阶段 ——
  const stage = opp.engageStage as EngageStage | null | undefined;
  const C4 = stage && stage in C4_MAP ? C4_MAP[stage] : 0;

  // —— C6：针对 D 的 BI 的最佳 UCV 状态 ——
  const dBiIds = new Set(opp.bis.filter((bi) => dPersonIds.has(bi.personId)).map((bi) => bi.id));
  let ucvStatus: 'none' | '建议' | '获认可' | '已解决' = 'none';
  for (const u of opp.ucvs) {
    if (!dBiIds.has(u.targetBiId)) continue;
    if (u.status === '已解决') { ucvStatus = '已解决'; break; }
    if (u.status === '获认可') ucvStatus = '获认可';
    else if (u.status === '建议' && ucvStatus === 'none') ucvStatus = '建议';
  }
  const C6 = ucvStatus === '已解决' ? 5 : ucvStatus === '获认可' ? 3 : 0;

  // —— P1：仅计「明确」及以上确认 ——
  const confirmed = roles.filter((r) => isConfirmed(r.confidence));
  const p1Plus = confirmed.filter((r) => r.sentiment === 'plus' || r.sentiment === 'star').length;
  const p1Minus = confirmed.filter((r) => r.sentiment === 'minus' || r.sentiment === 'x').length;
  const P1 = clamp(p1Plus - p1Minus, -5, 5);

  // —— P2：招采三类（密谋满权重 / 口头1 / 未接触0；全未接触 −5）——
  const p2: Record<ProcurementType, ProcurementStatus> = { purchasing: 'none', agency: 'none', ownerRep: 'none' };
  for (const r of roles) if (r.procurementType && r.procurementStatus) p2[r.procurementType] = r.procurementStatus;
  const types = Object.keys(P2_WEIGHT) as ProcurementType[];
  let P2: number;
  if (types.every((t) => p2[t] === 'none')) {
    P2 = -5;
  } else {
    let sum = 0;
    for (const t of types) {
      if (p2[t] === 'collude') sum += P2_WEIGHT[t];
      else if (p2[t] === 'verbal') sum += 1;
    }
    P2 = sum;
  }

  // —— P3 / P4 / 1K ——
  const P3 = aggregateLow(dRoles.map((r) => P3_1K_MAP[r.sentiment]));
  const ki = roles.find((r) => r.isKeyInfluencer);
  const P4 = ki ? P4_MAP[ki.sentiment] : 0;
  const K1 = aggregateLow(roles.filter((r) => r.role === 'A').map((r) => P3_1K_MAP[r.sentiment]));

  const items: Record<ItemKey, number> = { C1, C2, C3, C4, C5, C6, P1, P2, P3, P4, '1K': K1 };
  const clears = C1 + C2 + C3 + C4 + C5 + C6;
  const priorities = P1 + P2 + P3 + P4;
  const total = clears + priorities + K1;
  const percent = total / 100;
  const band = band741(percent);
  return { items, clears, priorities, key: K1, total, percent, band, bandLabel: BAND_LABEL[band], strategy: BAND_STRATEGY[band] };
}
