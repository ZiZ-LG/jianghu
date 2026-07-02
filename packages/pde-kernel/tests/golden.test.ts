// 黄金测试：TS 内核 vs oracle 生成的 golden-tests.json，逐数值 |Δ|≤1e-6（golden 已 round6，最大量化误差 5e-7）。
// ⚠️ golden 期望值禁止手改（CLAUDE.md 规则 4）：测试不过 → 修 src；要改公式 → 先改 reference_impl.py 重生成。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actionDeltaEV, evaluate, PARAMS, recommend, voiCComp, voiStance, weightedScore } from '../src/index.js';
import type { Deal, KernelAction } from '../src/index.js';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/golden-tests.json', import.meta.url)), 'utf8'));

const TOL = 1e-6;

/** 递归近似深比较：数值按容差，其余全等；键集合双向一致。返回差异清单（空=通过）。 */
function diff(actual: unknown, expected: unknown, path = '$'): string[] {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) <= TOL ? [] : [`${path}: ${actual} ≠ ${expected} (|Δ|=${Math.abs(actual - expected)})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: 期望数组`];
    if (actual.length !== expected.length) return [`${path}: 长度 ${actual.length} ≠ ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, `${path}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: 期望对象`];
    const ek = Object.keys(expected as object).sort();
    const ak = Object.keys(actual as object).sort();
    const out: string[] = [];
    for (const k of ak) if (!ek.includes(k)) out.push(`${path}.${k}: 多余键`);
    for (const k of ek) {
      if (!ak.includes(k)) { out.push(`${path}.${k}: 缺键`); continue; }
      out.push(...diff((actual as any)[k], (expected as any)[k], `${path}.${k}`));
    }
    return out;
  }
  return Object.is(actual, expected) ? [] : [`${path}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`];
}

const expectMatch = (actual: unknown, expected: unknown, label: string) => {
  const d = diff(actual, expected);
  expect(d, `${label}\n${d.join('\n')}`).toEqual([]);
};

// 测试夹具补充（golden 未存输入侧的 ACTIONS 与 prev_ev —— 与 reference_impl.py fixtures()/main() 保持同步，改 oracle 时同步改这里）
const ACTIONS: Record<string, KernelAction[]> = {
  deal_A_raise: [
    { id: 'act-1k-exec-visit', stakeholder_id: 'A', new_mark: 'star', cost: 1.5 },
    { id: 'act-p3-coplan', stakeholder_id: 'D', new_mark: 'star', new_cred: 'explicit', cost: 1.0 },
  ],
  deal_B_check: [
    { id: 'act-verify-D', stakeholder_id: 'D', new_cred: 'explicit', cost: 0.3 },
    { id: 'act-1k-exec-visit', stakeholder_id: 'A', new_mark: 'star', new_cred: 'explicit', cost: 1.5 },
  ],
  deal_Gate: [
    { id: 'act-flip-A', stakeholder_id: 'A', new_mark: 'eq', new_cred: 'inference', cost: 2.0 },
  ],
  deal_Fold: [
    { id: 'act-fix-A', stakeholder_id: 'A', new_mark: 'plus', new_cred: 'explicit', cost: 1.5 },
    { id: 'act-fix-D', stakeholder_id: 'D', new_mark: 'plus', new_cred: 'explicit', cost: 1.0 },
  ],
};
const PREV_EV: Record<string, number | null> = { deal_A_raise: null, deal_B_check: null, deal_Gate: null, deal_Fold: -5.0 };

describe('params_echo 一致性', () => {
  it('TS PARAMS 与 oracle 参数逐值一致', () => {
    expectMatch(PARAMS, golden.params_echo, 'params_echo');
  });
});

describe('golden cases（run_case 四案例）', () => {
  for (const name of ['deal_A_raise', 'deal_B_check', 'deal_Gate', 'deal_Fold'] as const) {
    const g = golden.cases[name];
    const deal = g.input as Deal;
    it(`${name} · evaluate`, () => expectMatch(evaluate(deal), g.eval, `${name}.eval`));
    it(`${name} · weightedScore`, () => expectMatch(weightedScore(deal.items), g.score, `${name}.score`));
    it(`${name} · actions ΔEV`, () => {
      const devs = ACTIONS[name]!.map((a) => actionDeltaEV(deal, a));
      expectMatch(devs, g.actions, `${name}.actions`);
    });
    it(`${name} · recommendation`, () => {
      const ev = evaluate(deal);
      const devs = ACTIONS[name]!.map((a) => actionDeltaEV(deal, a));
      const rec = recommend(ev, devs, ev.stakeholders, weightedScore(deal.items), ev.m_stage, PREV_EV[name]);
      expectMatch(rec, g.recommendation, `${name}.recommendation`);
    });
  }
});

describe('golden VoI（基于 deal_B 输入）', () => {
  const dealB = golden.cases.deal_B_check.input as Deal;
  it('voiStance(B, A)：解决 A 立场的情报价值', () => {
    expectMatch(voiStance(dealB, 'A'), golden.cases.deal_B_voi_A, 'deal_B_voi_A');
  });
  it('voiCComp(B)：竞争系数的情报价值', () => {
    expectMatch(voiCComp(dealB), golden.cases.deal_B_voi_ccomp, 'deal_B_voi_ccomp');
  });
});

describe('golden 关键结论抽查（SPEC §3 验证点）', () => {
  it('deal_B：信息动作 act-verify-D 的 ratio 居首（5.83）', () => {
    const g = golden.cases.deal_B_check;
    expect(g.actions[0].action_id).toBe('act-verify-D');
    expect(Math.abs(g.actions[0].ratio - 5.83) < 0.01).toBe(true);
  });
  it('deal_Gate：否决门触发且赢面封顶 0.15', () => {
    const deal = golden.cases.deal_Gate.input as Deal;
    const ev = evaluate(deal);
    expect(ev.gate).toBe(true);
    expect(ev.pwin).toBeLessThanOrEqual(0.15 + TOL);
  });
});
