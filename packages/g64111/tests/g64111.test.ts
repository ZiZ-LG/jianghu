import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE,
  aggregateLow,
  band741,
  scoreC1,
  scoreC3,
  scoreC5,
  scoreOpportunity,
  scoreP2,
  type ScoringInput,
} from '../src/index.js';

const base: ScoringInput = {
  rolesPresent: { A: true, D: true, U: true, R: true, C: true },
  nonAUnknownCount: 0,
  procurementTypesIdentified: 3,
  dFamily7Filled: 7,
  dHasBI: true,
  c3KnownCount: 7,
  engageStage: '需求调研立项',
  c5KnownCount: 5,
  ucvStatus: '已解决',
  p1PlusCount: 5,
  p1MinusCount: 0,
  p2: { purchasing: 'collude', agency: 'collude', ownerRep: 'collude' },
  dSentiments: ['plus'],
  aSentiments: ['plus'],
  keyInfluencerSentiment: 'star',
};

describe('aggregateLow（多A/多D 取中位数低分）', () => {
  it('规格 §6 的例子', () => {
    expect(aggregateLow([10, 20])).toBe(10);
    expect(aggregateLow([-10, 0, 20])).toBe(0);
    expect(aggregateLow([-20, -10, 10, 20])).toBe(-10);
  });
  it('单值与空集', () => {
    expect(aggregateLow([5])).toBe(5);
    expect(aggregateLow([])).toBe(0);
  });
});

describe('band741（已删除采购周期条件）', () => {
  it('四档边界', () => {
    expect(band741(0.8)).toBe('ABSOLUTE_ADVANTAGE');
    expect(band741(0.75)).toBe('ABSOLUTE_ADVANTAGE');
    expect(band741(0.6)).toBe('RELATIVE_ADVANTAGE');
    expect(band741(0.5)).toBe('RELATIVE_ADVANTAGE');
    expect(band741(0.3)).toBe('RELATIVE_DISADVANTAGE');
    expect(band741(0.1)).toBe('ABSOLUTE_DISADVANTAGE');
  });
  it('允许负百分比', () => {
    expect(band741(-0.2)).toBe('ABSOLUTE_DISADVANTAGE');
  });
});

describe('C1（组织图 + D的FORM）', () => {
  it('要素齐全 = 10', () => {
    expect(scoreC1(base)).toBe(10);
  });
  it('缺角色(-3) + 2个非A未知(-2) + 招采1/3 + 家庭5/7', () => {
    const input = {
      ...base,
      rolesPresent: { ...base.rolesPresent, C: false },
      nonAUnknownCount: 2,
      procurementTypesIdentified: 1,
      dFamily7Filled: 5,
    };
    expect(scoreC1(input)).toBeCloseTo(1 + 1 / 3 + 1, 5);
  });
  it('FORM 严格曲线：填<4问即0', () => {
    expect(scoreC1({ ...base, dFamily7Filled: 4 })).toBe(7);
    expect(scoreC1({ ...base, dFamily7Filled: 3 })).toBe(7);
  });
  it('线性曲线档案', () => {
    const linear = { ...DEFAULT_PROFILE, formC1Curve: 'linear' as const };
    expect(scoreC1({ ...base, dFamily7Filled: 4 }, linear)).toBe(7 + Math.round((3 * 4) / 7));
  });
});

describe('C3/C5（少一项扣一分）', () => {
  it('C3 七项映射', () => {
    expect(scoreC3({ ...base, c3KnownCount: 7 })).toBe(5);
    expect(scoreC3({ ...base, c3KnownCount: 5 })).toBe(3);
    expect(scoreC3({ ...base, c3KnownCount: 2 })).toBe(0);
  });
  it('C5 五项映射', () => {
    expect(scoreC5({ ...base, c5KnownCount: 5 })).toBe(5);
    expect(scoreC5({ ...base, c5KnownCount: 3 })).toBe(3);
    expect(scoreC5({ ...base, c5KnownCount: 0 })).toBe(0);
  });
});

describe('P2（招采关键人，可为负）', () => {
  it('三类全密谋 = 10', () => {
    expect(scoreP2(base)).toBe(10);
  });
  it('采购未接触 + 代理口头 + 甲方密谋 = 5', () => {
    expect(scoreP2({ ...base, p2: { purchasing: 'none', agency: 'verbal', ownerRep: 'collude' } })).toBe(5);
  });
  it('三类均未接触 = -5', () => {
    expect(scoreP2({ ...base, p2: { purchasing: 'none', agency: 'none', ownerRep: 'none' } })).toBe(-5);
  });
});

describe('scoreOpportunity（总分/百分比/带）', () => {
  it('要素齐全的强势局', () => {
    const result = scoreOpportunity(base);
    expect(result.clears).toBe(35);
    expect(result.priorities).toBe(35);
    expect(result.key).toBe(10);
    expect(result.total).toBe(80);
    expect(result.percent).toBeCloseTo(0.8, 5);
    expect(result.band).toBe('ABSOLUTE_ADVANTAGE');
  });

  it('D 倒向对手(x) + A 倒戈(x) → 趋赢力转负', () => {
    const input: ScoringInput = {
      ...base,
      dSentiments: ['x'],
      aSentiments: ['x'],
      p1PlusCount: 3,
      p1MinusCount: 2,
    };
    const result = scoreOpportunity(input);
    expect(result.items.P3).toBe(-20);
    expect(result.items['1K']).toBe(-20);
    expect(result.priorities).toBe(1);
    expect(result.total).toBe(16);
    expect(result.band).toBe('ABSOLUTE_DISADVANTAGE');
  });

  it('多个D 取中位数低分', () => {
    expect(scoreOpportunity({ ...base, dSentiments: ['plus', 'star'] }).items.P3).toBe(10);
  });

  it('趋赢力可为负（极端劣势）', () => {
    const input: ScoringInput = {
      rolesPresent: { A: false, D: false, U: false, R: false, C: false },
      nonAUnknownCount: 0,
      procurementTypesIdentified: 0,
      dFamily7Filled: 0,
      dHasBI: false,
      c3KnownCount: 0,
      engageStage: '招采执行',
      c5KnownCount: 0,
      ucvStatus: 'none',
      p1PlusCount: 0,
      p1MinusCount: 5,
      p2: { purchasing: 'none', agency: 'none', ownerRep: 'none' },
      dSentiments: ['x'],
      aSentiments: ['x'],
      keyInfluencerSentiment: null,
    };
    const result = scoreOpportunity(input);
    expect(result.total).toBeLessThan(0);
    expect(result.percent).toBeLessThan(0);
    expect(result.band).toBe('ABSOLUTE_DISADVANTAGE');
  });
});
