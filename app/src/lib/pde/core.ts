// 策略引擎内核（PDE core）—— 纯函数、零 React/Prisma/PII/江湖依赖，可移植到其他 CRM。
// 输入 PdeInput（通用契约）→ 输出 PdeOutput（局势量化）。江湖特有映射全在 ../pde/adapter.ts。
// 数学口径见 docs/策略引擎-设计方案.md §3；参数初值 λ=1.3 / k=4 / S₀=0.15（2026-06-12 拍板）。

/** 单个干系人输入：三态伪计数 [支持, 摇摆, 反对] + 影响力权重（未归一） */
export interface PdeStakeholderInput {
  id: string;
  alpha: [number, number, number];
  weight: number;
}
export interface PdeParams {
  lambda: number;       // 反对杀伤系数（一票否决语境，默认 1.3）
  k: number;            // logistic 陡度（默认 4）
  s0: number;           // logistic 中点（默认 0.15）
  competition: number;  // 竞争修正 C ∈ (0,1]（默认 1）
  grossMargin: number;  // 毛利率（底池 = 金额 × 毛利率，默认 0.3）
}
export interface PdeEconomics {
  amount: number | null; // 预计金额（万元）；null = 未设
  plannedCost: number;   // 还需投入（万元）
  sunkCost: number;      // 已投入（万元，沉没成本，不入决策式）
}
export interface PdeInput {
  stakeholders: PdeStakeholderInput[];
  params: PdeParams;
  economics: PdeEconomics;
  stageWindow: boolean;                  // 是否处阶段窗口期（评标前/谈判前 → 影响 RAISE）
  leverageHint?: Record<string, number>; // id → 可开发潜力（杠杆与 RAISE 判定用）
}

export type Stance = 'raise' | 'call' | 'check' | 'fold';
export type Clarity = 'clear' | 'half' | 'unclear';

export interface StakeholderPosture {
  id: string;
  pS: number; pN: number; pO: number;   // 归一化概率
  n: number;                            // 等效样本量
  entropy: number;                      // 归一化熵 ∈ [0,1]
  clarity: Clarity;
  weightShare: number;                  // 归一化权重占比
}
export interface PdeOutput {
  stakeholders: StakeholderPosture[];
  netSupport: number;                   // S
  pWin: number;                         // 赢面参考 ∈ [0,1]
  potValue: number | null;              // 底池（万元）
  ev: number | null;                    // 预期回报（万元）；金额缺失时 null
  stance: Stance;
  reasonKey: string;                    // 触发理由 key（文案在 adapter）
  lowConfidence: boolean;               // 关键人看不清 / 样本不足
  leverage: { id: string; score: number }[]; // 杠杆榜（降序）
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** 三态归一化熵 ∈ [0,1]，1 = 完全看不清 */
function normEntropy(ps: number[]): number {
  let h = 0;
  for (const p of ps) if (p > 0) h -= p * Math.log(p);
  return h / Math.log(ps.length);
}

function clarityOf(entropy: number, n: number): Clarity {
  if (entropy >= 0.85 || n < 3) return 'unclear';
  if (entropy <= 0.65 && n >= 6) return 'clear';
  return 'half';
}

const KEY_WEIGHT_SHARE = 0.25; // 关键干系人门槛
const LEVERAGE_PLAY = 8;       // 「有值得攻的高潜力人」门槛（≈ 一个 P4 / 半个 P3）

export function computePde(input: PdeInput): PdeOutput {
  const { stakeholders, params, economics, stageWindow, leverageHint } = input;
  const totalW = stakeholders.reduce((s, x) => s + x.weight, 0) || 1;

  const postures: StakeholderPosture[] = stakeholders.map((x) => {
    const n = x.alpha[0] + x.alpha[1] + x.alpha[2] || 1;
    const pS = x.alpha[0] / n, pN = x.alpha[1] / n, pO = x.alpha[2] / n;
    const entropy = normEntropy([pS, pN, pO]);
    return { id: x.id, pS, pN, pO, n, entropy, clarity: clarityOf(entropy, n), weightShare: x.weight / totalW };
  });

  // 净支持度 S = Σ wᵢ(pSᵢ − λ·pOᵢ) / Σ wᵢ
  let sNum = 0;
  for (const x of stakeholders) {
    const n = x.alpha[0] + x.alpha[1] + x.alpha[2] || 1;
    sNum += x.weight * (x.alpha[0] / n - params.lambda * (x.alpha[2] / n));
  }
  const netSupport = sNum / totalW;

  const pWin = clamp01(sigmoid(params.k * (netSupport - params.s0)) * params.competition);

  const potValue = economics.amount != null ? economics.amount * params.grossMargin : null;
  const ev = potValue != null ? pWin * potValue - economics.plannedCost : null;

  // 杠杆榜（降序）：纯可开发潜力（E1 再叠路径可达性）
  const leverage = Object.entries(leverageHint ?? {})
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
  const topLeverage = leverage[0]?.score ?? 0;

  const keyUnclear = postures.some((p) => p.weightShare > KEY_WEIGHT_SHARE && p.clarity === 'unclear');
  const lowConfidence = keyUnclear || postures.every((p) => p.n < 4);
  const hasLeverPlay = topLeverage >= LEVERAGE_PLAY;

  // 姿态决策树（E0 可执行近似；FOLD 需经济性为负，无金额时不会 fold）
  let stance: Stance, reasonKey: string;
  if (ev != null && ev < 0) {
    if (keyUnclear) { stance = 'check'; reasonKey = 'neg_ev_but_unclear'; }
    else { stance = 'fold'; reasonKey = 'neg_ev_fold'; }
  } else if (keyUnclear) {
    stance = 'check'; reasonKey = 'key_unclear';
  } else if (stageWindow && hasLeverPlay) {
    stance = 'raise'; reasonKey = 'window_leverage';
  } else {
    stance = 'call'; reasonKey = 'steady';
  }

  return { stakeholders: postures, netSupport, pWin, potValue, ev, stance, reasonKey, lowConfidence, leverage };
}
