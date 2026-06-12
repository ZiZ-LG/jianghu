import { describe, it, expect } from 'vitest';
import { computePde, type PdeInput, type PdeStakeholderInput } from './core';

const P = { lambda: 1.3, k: 4, s0: 0.15, competition: 1, grossMargin: 0.3 };
const base = (stakeholders: PdeStakeholderInput[], over: Partial<PdeInput> = {}): PdeInput => ({
  stakeholders,
  params: P,
  economics: { amount: 100, plannedCost: 5, sunkCost: 8 },
  stageWindow: false,
  ...over,
});
// 伪计数 helper：方向比例 × 样本量
const sh = (id: string, dir: [number, number, number], n: number, weight: number): PdeStakeholderInput =>
  ({ id, alpha: [dir[0] * n, dir[1] * n, dir[2] * n], weight });
const PLUS: [number, number, number] = [0.65, 0.25, 0.10];
const STAR: [number, number, number] = [0.80, 0.15, 0.05];
const UNK: [number, number, number] = [1 / 3, 1 / 3, 1 / 3];
const X: [number, number, number] = [0.05, 0.15, 0.80];

describe('computePde · 分布与熵', () => {
  it('未知立场 → 熵≈1、未清', () => {
    const o = computePde(base([sh('a', UNK, 1.5, 34)]));
    expect(o.stakeholders[0].entropy).toBeGreaterThan(0.99);
    expect(o.stakeholders[0].clarity).toBe('unclear');
  });
  it('明确支持 → 熵低、样本足 = 看得清', () => {
    const o = computePde(base([sh('a', STAR, 8, 34)]));
    expect(o.stakeholders[0].clarity).toBe('clear');
    expect(o.stakeholders[0].pS).toBeGreaterThan(o.stakeholders[0].pO);
  });
  it('pWin 恒在 [0,1]', () => {
    for (const dir of [STAR, PLUS, UNK, X]) {
      const o = computePde(base([sh('a', dir, 6, 34)]));
      expect(o.pWin).toBeGreaterThanOrEqual(0);
      expect(o.pWin).toBeLessThanOrEqual(1);
    }
  });
});

describe('computePde · 净支持度与反对杀伤', () => {
  it('强支持 D → S>0、pWin>0.5', () => {
    const o = computePde(base([sh('d', STAR, 8, 34)]));
    expect(o.netSupport).toBeGreaterThan(0);
    expect(o.pWin).toBeGreaterThan(0.5);
  });
  it('倒戈 D → S 显著为负（λ 放大反对）', () => {
    const o = computePde(base([sh('d', X, 6, 34)]));
    expect(o.netSupport).toBeLessThan(-0.3);
    expect(o.pWin).toBeLessThan(0.3);
  });
});

describe('computePde · 四姿态', () => {
  it('强支持 + 窗口期 + 有高杠杆 → 乘胜加压 raise', () => {
    const o = computePde(base([sh('d', PLUS, 6, 34)], { stageWindow: true, leverageHint: { x: 12 } }));
    expect(o.stance).toBe('raise');
  });
  it('关键人未清 → 先清再动 check（即便 EV 为正）', () => {
    const o = computePde(base([sh('d', UNK, 1.5, 34)], { stageWindow: true, leverageHint: { x: 12 } }));
    expect(o.stance).toBe('check');
    expect(o.lowConfidence).toBe(true);
  });
  it('EV 为负 + 局面差 + 看得清 → 回炉复盘 fold', () => {
    const o = computePde(base([sh('d', X, 8, 34)], { economics: { amount: 100, plannedCost: 40, sunkCost: 8 } }));
    expect(o.ev).toBeLessThan(0);
    expect(o.stance).toBe('fold');
  });
  it('平稳支持 + 无窗口 → 稳步推进 call', () => {
    const o = computePde(base([sh('d', PLUS, 6, 34)]));
    expect(o.stance).toBe('call');
  });
});

describe('computePde · 经济性', () => {
  it('无金额 → ev=null 且永不 fold', () => {
    const o = computePde(base([sh('d', X, 8, 34)], { economics: { amount: null, plannedCost: 0, sunkCost: 0 } }));
    expect(o.ev).toBeNull();
    expect(o.stance).not.toBe('fold');
  });
  it('沉没成本不入 EV（plannedCost 入、sunkCost 不入）', () => {
    const a = computePde(base([sh('d', STAR, 8, 34)], { economics: { amount: 100, plannedCost: 5, sunkCost: 8 } }));
    const b = computePde(base([sh('d', STAR, 8, 34)], { economics: { amount: 100, plannedCost: 5, sunkCost: 999 } }));
    expect(a.ev).toBe(b.ev);
    expect(a.ev).toBeCloseTo(a.pWin * 30 - 5, 6);
  });
});

describe('computePde · 杠杆榜', () => {
  it('按可开发潜力降序', () => {
    const o = computePde(base([sh('d', PLUS, 6, 34)], { leverageHint: { a: 21, b: 11, c: 3 } }));
    expect(o.leverage.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });
});
