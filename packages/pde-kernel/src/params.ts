// PDE 内核参数 —— 与 reference_impl.py / seeds/params.json 同步（oracle 为准）。
// 改参数的唯一路径：先改 reference_impl.py → 重新生成 golden → 同步此处（README-handoff 维护约定）。
import type { Cred, Mark, Slot, Stage, Volatility } from './types.js';

export const MARK_TARGET: Record<Mark, [number, number, number]> = {
  star: [0.85, 0.10, 0.05],
  plus: [0.65, 0.25, 0.10],
  eq: [0.20, 0.60, 0.20],
  unk: [1 / 3, 1 / 3, 1 / 3],
  minus: [0.10, 0.25, 0.65],
  x: [0.05, 0.10, 0.85],
};

export const CRED: Record<Cred, { c: number; n: number }> = {
  consensus: { c: 1.00, n: 8.0 },
  explicit: { c: 0.80, n: 5.0 },
  inference: { c: 0.45, n: 2.5 },
  unclear: { c: 0.15, n: 1.0 },
};

export const N0 = 2.0;                    // 均匀先验强度（贝叶斯收缩）
export const LAMBDA = 1.3;                // 反对杀伤系数
export const K = 4.0;                     // logistic 斜率
export const S_MID = 0.15;                // logistic 中点
export const GATE_PO = 0.60;              // 否决门阈值（A 槽）
export const GATE_CAP = 0.15;             // 否决门赢面封顶
export const M_STAGE: Record<Stage, number> = {
  initiation: 1.00, feasibility: 0.85, budget_approval: 0.65,
  tender_design: 0.40, tender_execution: 0.20,
};
export const C4_LEGACY: Record<Stage, number> = {
  initiation: 5, feasibility: 4, budget_approval: 3, tender_design: 2, tender_execution: 1,
};
export const HALFLIFE: Record<Volatility, number> = { procurement: 30.0, stance: 90.0, structural: 180.0 };
export const SLOT_W: Record<Slot, number> = {
  A: 20.0, D: 20.0, PROC_MGMT: 4.0, PROC_AGENT: 2.0, OWNER_REP: 4.0, KEY_INFLUENCER: 10.0, MEMBER: 1.0,
};
export const MEMBER_POOL_CAP = 5.0;       // P1 组员权重池上限
export const CHECK_NEFF = 3.0;            // CHECK：关键干系人 n_eff 阈值
export const CHECK_W_NORM = 0.15;         // 「关键干系人」= 归一化权重阈值
export const CHECK_SCORE_GAP = 20.0;      // CHECK：名义分 − 加权分 阈值
export const RAISE_RATIO = 1.5;           // RAISE：gross/cost 阈值
export const RAISE_MIN_M = 0.40;          // RAISE：阶段窗口下限

/** 供 golden params_echo 一致性检查（键名与 oracle 输出一致）。 */
export const PARAMS = {
  MARK_TARGET, CRED, N0, LAMBDA, K, S_MID, GATE_PO, GATE_CAP,
  M_STAGE, HALFLIFE, SLOT_W, MEMBER_POOL_CAP, CHECK_NEFF,
  CHECK_W_NORM, CHECK_SCORE_GAP, RAISE_RATIO, RAISE_MIN_M,
} as const;
