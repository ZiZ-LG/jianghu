// 江湖适配器（jianghuAdapter）—— 把 Account/Opportunity/G64111 转成 PdeInput，并给输出配上
// G64111 语言的文案。移植到其他 CRM = 换一个适配器，core.ts 零改动（docs/策略引擎-设计方案.md §9A）。
import type { Account, Opportunity, Sentiment, Confidence, PipelineStage } from '../../types';
import type { ScoreBreakdown, Band741 } from '../g64111';
import { personContributions } from '../g64111';
import { computePde, type PdeInput, type PdeOutput, type Stance, type Clarity } from './core';

// 六档支持度 → 三态概率质量比例（方向）。把握深度 confidence → 等效样本量 n₀。
const DIR: Record<Sentiment, [number, number, number]> = {
  star: [0.80, 0.15, 0.05], plus: [0.65, 0.25, 0.10], neutral: [0.15, 0.70, 0.15],
  unknown: [1 / 3, 1 / 3, 1 / 3], minus: [0.10, 0.25, 0.65], x: [0.05, 0.15, 0.80],
};
const SAMPLE: Record<Confidence, number> = { 共识: 8, 明确: 6, 推理: 3, 不清: 1.5 };
const STAGE_WINDOW: PipelineStage[] = ['招投标', '合同谈判']; // 评标前 / 谈判前窗口

/** 参数默认值（2026-06-12 拍板，租户级可配预留 E2） */
export const DEFAULT_PDE_PARAMS = { lambda: 1.3, k: 4, s0: 0.15, competition: 1, grossMargin: 0.3 };

const num = (v: unknown): number | undefined => (typeof v === 'number' && !Number.isNaN(v) ? v : undefined);

/** 江湖领域 → PdeInput（仅评估有角色的非友商干系人；权重 = 贡献分 potential） */
export function buildPdeInput(account: Account, opp: Opportunity, breakdown: ScoreBreakdown): PdeInput {
  void breakdown; // 预留：E2 联动缺口
  const contrib = personContributions(account, opp);
  const personById = new Map(account.persons.map((p) => [p.id, p]));

  const stakeholders = opp.roles
    .map((r) => {
      const p = personById.get(r.personId);
      if (!p || p.isCompetitor) return null;
      const dir = DIR[r.sentiment];
      const n0 = SAMPLE[r.confidence];
      const c = contrib.get(r.personId);
      return {
        id: r.personId,
        alpha: [dir[0] * n0, dir[1] * n0, dir[2] * n0] as [number, number, number],
        weight: Math.max(0.5, c?.potential ?? 1),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // 杠杆提示 = 各干系人可开发潜力（upside）
  const leverageHint: Record<string, number> = {};
  for (const [id, c] of contrib) if (c.upside > 0) leverageHint[id] = c.upside;

  const amount = num(opp.expectedAmountW) ?? null;
  const plannedCost = num(opp.meta?.plannedCostW) ?? 0;
  const sunkCost = num(opp.meta?.sunkCostW) ?? 0;
  const competition = num(opp.meta?.competitionFactor) ?? DEFAULT_PDE_PARAMS.competition;

  return {
    stakeholders,
    params: { ...DEFAULT_PDE_PARAMS, competition },
    economics: { amount: amount && amount > 0 ? amount : null, plannedCost, sunkCost },
    stageWindow: STAGE_WINDOW.includes(opp.pipelineStage),
    leverageHint,
  };
}

// ── G64111 语言文案（界面零德扑词，§5A 对照表）──
export const STANCE_LABEL: Record<Stance, { text: string; tone: 'success' | 'info' | 'warning' | 'danger' }> = {
  raise: { text: '乘胜加压', tone: 'success' },
  call: { text: '稳步推进', tone: 'info' },
  check: { text: '先清再动', tone: 'warning' },
  fold: { text: '回炉复盘', tone: 'danger' },
};
const CLARITY_LABEL: Record<Clarity, string> = { clear: '看得清', half: '半清', unclear: '未清' };
// 触发依据（机器为什么这么判，与 jointReading 的「打法建议」互补不重复）
const REASON_TEXT: Record<string, string> = {
  neg_ev_fold: '预期回报为负、局面也落后',
  neg_ev_but_unclear: '预期回报为负，但关键人还没摸清',
  key_unclear: '关键决策人立场看不清，等效样本不足',
  window_leverage: '正处评标/谈判窗口，且有人经营到位能明显加分',
  steady: '预期回报为正，暂无加压窗口',
};

// 741 档位 × 姿态 联合解读（确定性文案，每格一句；不靠 LLM）。band 给局面、stance 给建议。
const BAND_PHRASE: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '局面占优',
  RELATIVE_ADVANTAGE: '相对有利',
  RELATIVE_DISADVANTAGE: '相对落后',
  ABSOLUTE_DISADVANTAGE: '局面落后',
};
function jointReading(band: Band741, stance: Stance): string {
  const lead = BAND_PHRASE[band];
  // 特别冲突格优先（高 band×止损 / 低 band×加压 最反直觉，需点透）
  if (band === 'ABSOLUTE_ADVANTAGE' && stance === 'fold') return `${lead}但经济性差——可承诺局面、控成本拿下，勿过度投入`;
  if (band === 'ABSOLUTE_DISADVANTAGE' && stance === 'raise') return `${lead}但单大且杠杆动作在手——值得搏一把，按杠杆榜集中攻坚`;
  if (band === 'ABSOLUTE_DISADVANTAGE' && stance === 'call') return `${lead}，先稳住别加码，等局面松动或转养单`;
  const tail: Record<Stance, string> = {
    raise: '正是加压窗口，按杠杆榜集中投入',
    call: '按既定节奏推进、保温关键人',
    check: '先补必清、摸清摇摆人，再决定加码',
    fold: '经济性不足，建议控投入或转养单',
  };
  return `${lead}，${tail[stance]}`;
}

export interface JianghuPdeResult extends PdeOutput {
  stanceLabel: string;
  stanceTone: 'success' | 'info' | 'warning' | 'danger';
  reasonText: string;
  jointReading: string;
  confidenceText: string;     // 赢面旁的把握度小字
  leverageNamed: { id: string; name: string; score: number }[];
}

/** 江湖入口：领域对象 → 量化结果 + G64111 文案 */
export function analyzeDeal(account: Account, opp: Opportunity, breakdown: ScoreBreakdown): JianghuPdeResult {
  const out = computePde(buildPdeInput(account, opp, breakdown));
  const nameById = new Map(account.persons.map((p) => [p.id, p.name]));
  void CLARITY_LABEL;
  return {
    ...out,
    stanceLabel: STANCE_LABEL[out.stance].text,
    stanceTone: STANCE_LABEL[out.stance].tone,
    reasonText: REASON_TEXT[out.reasonKey] ?? '',
    jointReading: jointReading(breakdown.band, out.stance),
    confidenceText: out.lowConfidence ? '把握偏低 · 样本少' : '把握中等',
    leverageNamed: out.leverage.map((l) => ({ id: l.id, name: nameById.get(l.id) ?? '未知', score: l.score })),
  };
}
