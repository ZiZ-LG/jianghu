// 属性测试（TASKS M1 补充项）：pwin 值域 / 否决门单调 / 时间衰减单调。
// 用固定种子 LCG 生成随机牌局 —— 确定性，不依赖 Math.random。
import { describe, expect, it } from 'vitest';
import { blend, decay, evaluate } from '../src/index.js';
import type { Cred, Deal, Mark, Slot, Stage, Stakeholder } from '../src/index.js';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = <T,>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;

const MARKS: Mark[] = ['star', 'plus', 'eq', 'unk', 'minus', 'x'];
const CREDS: Cred[] = ['consensus', 'explicit', 'inference', 'unclear'];
const STAGES: Stage[] = ['initiation', 'feasibility', 'budget_approval', 'tender_design', 'tender_execution'];
const SLOTS: Slot[] = ['A', 'D', 'PROC_MGMT', 'PROC_AGENT', 'OWNER_REP', 'KEY_INFLUENCER'];

function randomDeal(rnd: () => number): Deal {
  const n = 2 + Math.floor(rnd() * 8);
  const stakeholders: Stakeholder[] = [];
  for (let i = 0; i < n; i++) {
    const isMember = rnd() < 0.4;
    stakeholders.push({
      id: `s${i}`,
      slots: isMember ? ['MEMBER'] : [pick(rnd, SLOTS)],
      mark: pick(rnd, MARKS),
      cred: pick(rnd, CREDS),
      q: 0.5 + rnd(),
      age_days: rnd() * 400,
    });
  }
  return {
    id: 'prop', pot: 10 + rnd() * 990, planned_cost: rnd() * 50,
    stage: pick(rnd, STAGES), c_comp: 0.5 + rnd() * 0.5, stakeholders, items: [],
  };
}

describe('属性：赢面值域与分布', () => {
  it('200 组随机牌局：pwin ∈ (0,1]，分布归一', () => {
    const rnd = lcg(20260702);
    for (let i = 0; i < 200; i++) {
      const deal = randomDeal(rnd);
      const ev = evaluate(deal);
      expect(ev.pwin, `case#${i} pwin`).toBeGreaterThan(0);
      expect(ev.pwin, `case#${i} pwin`).toBeLessThanOrEqual(1);
      for (const d of ev.stakeholders) {
        expect(d.pS + d.pN + d.pO, `case#${i} ${d.id} 分布和`).toBeCloseTo(1, 9);
        expect(Math.min(d.pS, d.pN, d.pO), `case#${i} ${d.id} 非负`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('属性：否决门单调（A 越倒向对手，赢面不升）', () => {
  it('固定牌局，A 的 mark 沿 pO 升序扫描 → pwin 非增', () => {
    const base: Deal = {
      id: 'mono', pot: 100, planned_cost: 8, stage: 'budget_approval', c_comp: 0.9,
      stakeholders: [
        { id: 'A', slots: ['A'], mark: 'plus', cred: 'explicit' },
        { id: 'D', slots: ['D'], mark: 'plus', cred: 'explicit' },
        { id: 'M1', slots: ['MEMBER'], mark: 'eq', cred: 'inference' },
      ],
      items: [],
    };
    // 同 cred 下 MARK_TARGET 的 pO 升序：star .05 < plus .10 < eq .20 < minus .65 < x .85（unk 因 n 不同单独略过）
    const seq: Mark[] = ['star', 'plus', 'eq', 'minus', 'x'];
    let prev = Infinity;
    for (const mk of seq) {
      const d = structuredClone(base);
      d.stakeholders[0]!.mark = mk;
      const pwin = evaluate(d).pwin;
      expect(pwin, `A=${mk} 后 pwin 应 ≤ 前值`).toBeLessThanOrEqual(prev + 1e-12);
      prev = pwin;
    }
  });
});

describe('属性：时间衰减单调', () => {
  it('age ↑ → decay ↓；n_eff 随之 ↓', () => {
    let prev = Infinity;
    for (const age of [0, 15, 30, 90, 180, 400]) {
      const v = decay(age, 90);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThan(0);
      prev = v;
    }
    const fresh = blend('plus', 'explicit', 1.0, 0).n_eff;
    const stale = blend('plus', 'explicit', 1.0, 180).n_eff;
    expect(stale).toBeLessThan(fresh);
  });
});
