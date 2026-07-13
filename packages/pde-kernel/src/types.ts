// 类型与 reference_impl.py 的字典结构一一对应（SPEC §1）。
// 字段名保持 snake_case —— golden-tests.json 逐键深比较依赖它，勿改驼峰。

export type Mark = 'star' | 'plus' | 'eq' | 'unk' | 'minus' | 'x';
export type Cred = 'consensus' | 'explicit' | 'inference' | 'unclear';
export type Slot = 'A' | 'D' | 'PROC_MGMT' | 'PROC_AGENT' | 'OWNER_REP' | 'KEY_INFLUENCER' | 'MEMBER';
export type Stage = 'initiation' | 'feasibility' | 'budget_approval' | 'tender_design' | 'tender_execution';
export type Volatility = 'procurement' | 'stance' | 'structural';

export interface Stakeholder {
  id: string;
  slots: Slot[];          // 同一自然人占多 slot 权重相加（决策#2）
  mark: Mark;
  cred?: Cred;            // 缺省 unclear；mark=unk 时忽略（按 unclear 的 n）
  q?: number;             // 信源质量，默认 1.0
  age_days?: number;      // 信息年龄（天），默认 0
  evidence_alpha?: [number, number, number]; // 已审证据三态伪计数 [αS, αN, αO]
}

export interface ScoreItem {
  key: string;            // C1..C6 / P1..P4 / 1K
  raw: number;
  cred: Cred;
  q?: number;
  age_days?: number;
  volatility?: Volatility; // 半衰期档，默认 stance(90天)
}

export interface Deal {
  id: string;
  pot: number;            // 万元
  planned_cost: number;
  stage: Stage;
  c_comp?: number;        // 竞争系数，默认 1.0
  stakeholders: Stakeholder[];
  items: ScoreItem[];
}

export interface KernelAction {
  id: string;
  stakeholder_id: string;
  new_mark?: Mark;
  new_cred?: Cred;        // 信息动作＝仅可信度升级（无需特殊分支）
  cost: number;
}

export interface BlendResult { p: [number, number, number]; n_eff: number }

export interface StakeholderDetail {
  id: string; w: number; pS: number; pN: number; pO: number;
  net: number; n_eff: number; entropy: number; w_norm: number;
}

export interface EvalResult {
  S: number; pwin_raw: number; pwin: number; gate: boolean;
  m_stage: number; ev_continue: number; stakeholders: StakeholderDetail[];
}

export interface ScoreResult { nominal: number; weighted: number; gap: number }

export interface ActionDelta {
  action_id: string; d_pwin: number; gross: number; cost: number; dEV: number; ratio: number;
}

export interface VoiStanceResult { stakeholder_id: string; pwin_opt: number; pwin_pess: number; voi: number }
export interface VoiCCompResult { var: 'c_comp'; voi: number }

export type FourAction = 'FOLD' | 'CHECK' | 'RAISE' | 'CALL';
export interface Recommendation {
  action: FourAction;
  reason: string;
  weak_key_stakeholders?: string[];
  score_gap?: number;
  best_action?: string;
}
