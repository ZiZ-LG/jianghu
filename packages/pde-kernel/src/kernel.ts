// PDE 数学内核 —— 逐函数移植自 docs/pde-handoff/kernel/reference_impl.py（唯一权威规范）。
// 纯函数、确定性、零 I/O、零 LLM；任何公式改动必须先改 oracle 重生成 golden 再改这里（CLAUDE.md 规则 4）。
import type {
  ActionDelta, BlendResult, Cred, Deal, EvalResult, FourAction, KernelAction, Mark,
  Recommendation, ScoreItem, ScoreResult, Stakeholder, StakeholderDetail, VoiCCompResult, VoiStanceResult,
} from './types.js';
import {
  CHECK_NEFF, CHECK_SCORE_GAP, CHECK_W_NORM, CRED, GATE_CAP, GATE_PO, HALFLIFE, K, LAMBDA,
  MARK_TARGET, MEMBER_POOL_CAP, M_STAGE, N0, RAISE_MIN_M, RAISE_RATIO, SLOT_W, S_MID,
} from './params.js';

/** 信息年龄衰减：0.5^(age/halfLife)。 */
export function decay(ageDays: number, halfLife: number): number {
  return 0.5 ** (ageDays / halfLife);
}

/** (标记, 可信度, 信源质量, 信息年龄, 已审证据伪计数) → 混合后立场分布 p=(pS,pN,pO) + 有效样本量 n_eff。
 *  目标分布 × 等效样本量 + 均匀先验 N0 + evidenceAlpha 后归一化；mark=unk 时忽略 cred（按 unclear 的 n）。 */
export function blend(
  mark: Mark,
  cred: Cred = 'unclear',
  q = 1.0,
  ageDays = 0.0,
  halfLife: number = HALFLIFE.stance,
  evidenceAlpha: readonly [number, number, number] = [0, 0, 0],
): BlendResult {
  const n = (mark === 'unk' ? CRED.unclear.n : CRED[cred].n) * q * decay(ageDays, halfLife);
  const t = MARK_TARGET[mark];
  const a = [
    n * t[0] + N0 / 3.0 + evidenceAlpha[0],
    n * t[1] + N0 / 3.0 + evidenceAlpha[1],
    n * t[2] + N0 / 3.0 + evidenceAlpha[2],
  ];
  const s = a[0]! + a[1]! + a[2]!;
  return { p: [a[0]! / s, a[1]! / s, a[2]! / s], n_eff: n };
}

/** 归一化熵 ∈[0,1]，仅展示用，不参与决策触发（SPEC §K5）。 */
export function entropy3(p: readonly [number, number, number]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  return h / Math.log(3);
}

function stakeholderWeight(st: Stakeholder): number {
  let w = 0;
  for (const s of st.slots) w += SLOT_W[s];
  return w;
}

const isMemberOnly = (st: Stakeholder) => st.slots.length === 1 && st.slots[0] === 'MEMBER';

/** 牌局评估：S、赢面(pwin)、否决门、EV、逐干系人明细。 */
export function evaluate(deal: Deal): EvalResult {
  const members = deal.stakeholders.filter(isMemberOnly);
  const memberW = members.length > MEMBER_POOL_CAP ? MEMBER_POOL_CAP / members.length : 1.0;
  let num = 0, den = 0;
  let gate = false;
  const detail: StakeholderDetail[] = [];
  for (const st of deal.stakeholders) {
    const w = isMemberOnly(st) ? memberW : stakeholderWeight(st);
    const { p, n_eff } = blend(st.mark, st.cred ?? 'unclear', st.q ?? 1.0, st.age_days ?? 0.0, HALFLIFE.stance, st.evidence_alpha);
    const net = p[0] - LAMBDA * p[2];
    num += w * net;
    den += w;
    if (st.slots.includes('A') && p[2] >= GATE_PO) gate = true;
    detail.push({ id: st.id, w, pS: p[0], pN: p[1], pO: p[2], net, n_eff, entropy: entropy3(p), w_norm: 0 });
  }
  for (const d of detail) d.w_norm = d.w / den;
  const S = num / den;
  const pwinRaw = 1.0 / (1.0 + Math.exp(-K * (S - S_MID)));
  let pwin = pwinRaw * (deal.c_comp ?? 1.0);
  if (gate) pwin = Math.min(pwin, GATE_CAP);
  const m = M_STAGE[deal.stage];
  const ev = pwin * deal.pot - deal.planned_cost;
  return { S, pwin_raw: pwinRaw, pwin, gate, m_stage: m, ev_continue: ev, stakeholders: detail };
}

/** 双轨分：名义分（Σraw）/ 加权分（Σraw×c̃，c̃=可信度×信源质量×时间衰减）。gap=判断建立在推测上的部分。 */
export function weightedScore(items: ScoreItem[]): ScoreResult {
  let nominal = 0, weighted = 0;
  for (const it of items) {
    const hl = HALFLIFE[it.volatility ?? 'stance'];
    const cEff = CRED[it.cred].c * (it.q ?? 1.0) * decay(it.age_days ?? 0.0, hl);
    nominal += it.raw;
    weighted += it.raw * cEff;
  }
  return { nominal, weighted, gap: nominal - weighted };
}

/** 施加动作效果（mark_shift / cred_upgrade），信息年龄归零。返回深拷贝，不改原 deal。 */
export function applyEffect(deal: Deal, stakeholderId: string, newMark?: Mark, newCred?: Cred): Deal {
  const d = structuredClone(deal);
  for (const st of d.stakeholders) {
    if (st.id === stakeholderId) {
      if (newMark) st.mark = newMark;
      if (newCred) st.cred = newCred;
      st.age_days = 0.0;
    }
  }
  return d;
}

/** 行动 ΔEV：gross=Δ赢面×pot×m(stage)，dEV=gross−cost。信息动作＝可信度升级，无需特殊分支。 */
export function actionDeltaEV(deal: Deal, action: KernelAction): ActionDelta {
  const base = evaluate(deal);
  const after = evaluate(applyEffect(deal, action.stakeholder_id, action.new_mark, action.new_cred));
  const dPwin = after.pwin - base.pwin;
  const gross = dPwin * deal.pot * base.m_stage;
  const dev = gross - action.cost;
  return {
    action_id: action.id, d_pwin: dPwin, gross, cost: action.cost, dEV: dev,
    ratio: action.cost > 0 ? gross / action.cost : Infinity,
  };
}

/** 立场类未知项的情报价值（VoI）：乐观/悲观合理值扫描的 EV 摆动。 */
export function voiStance(
  deal: Deal, stakeholderId: string,
  opt: [Mark, Cred] = ['plus', 'explicit'], pess: [Mark, Cred] = ['minus', 'explicit'],
): VoiStanceResult {
  const pOpt = evaluate(applyEffect(deal, stakeholderId, opt[0], opt[1])).pwin;
  const pPes = evaluate(applyEffect(deal, stakeholderId, pess[0], pess[1])).pwin;
  const m = M_STAGE[deal.stage];
  return { stakeholder_id: stakeholderId, pwin_opt: pOpt, pwin_pess: pPes, voi: (pOpt - pPes) * deal.pot * m };
}

/** C5 招采未知 → 竞争系数 c_comp 扫描的情报价值。 */
export function voiCComp(deal: Deal, lo = 0.70, hi = 1.00): VoiCCompResult {
  const d1 = structuredClone(deal); d1.c_comp = hi;
  const d2 = structuredClone(deal); d2.c_comp = lo;
  const m = M_STAGE[deal.stage];
  return { var: 'c_comp', voi: (evaluate(d1).pwin - evaluate(d2).pwin) * deal.pot * m };
}

/** 四动作纪律，优先级 FOLD > CHECK > RAISE > CALL（展示层映射：止损/摸底/强攻/跟进）。 */
export function recommend(
  evNow: EvalResult, actionsDev: ActionDelta[], stakeholdersDetail: StakeholderDetail[],
  score: ScoreResult, mStage: number, prevEv?: number | null,
): Recommendation {
  const hasPositive = actionsDev.some((a) => a.dEV > 0);
  if (evNow.ev_continue < 0 && prevEv !== undefined && prevEv !== null && prevEv < 0 && !hasPositive) {
    return { action: 'FOLD' as FourAction, reason: 'EV 连续两期为负且无正 ΔEV 动作' };
  }
  const weakKey = stakeholdersDetail.filter((d) => d.w_norm >= CHECK_W_NORM && d.n_eff < CHECK_NEFF).map((d) => d.id);
  if (weakKey.length || score.gap > CHECK_SCORE_GAP) {
    return { action: 'CHECK', reason: '关键干系人低可信度或名义/加权分差过大', weak_key_stakeholders: weakKey, score_gap: score.gap };
  }
  const raisable = actionsDev.filter((a) => a.dEV > 0 && a.ratio >= RAISE_RATIO);
  if (raisable.length && mStage >= RAISE_MIN_M) {
    let best = raisable[0]!;
    for (const a of raisable) if (a.dEV > best.dEV) best = a;
    return { action: 'RAISE', reason: '存在高杠杆动作且阶段窗口未关闭', best_action: best.action_id };
  }
  return { action: 'CALL', reason: evNow.ev_continue > 0 ? 'EV 为正，维持节奏' : 'EV 为负但存在正 ΔEV 动作或未满两期，观察一期' };
}
