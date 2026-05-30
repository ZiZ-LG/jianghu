import { describe, it, expect } from 'vitest';
import {
  aggregateLow, band741, scoreC1, scoreC3, scoreC5, scoreP2, scoreOpportunity,
  DEFAULT_PROFILE, type ScoringInput,
} from './g64111';

// 构造一个「满分要素齐全」的基准输入，再逐项扰动
const base: ScoringInput = {
  rolesPresent: { A: true, D: true, U: true, TB: true, R: true },
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
    expect(scoreC1(base)).toBe(10); // adur=min(7,6+1)=7, form=3
  });
  it('缺角色(-3) + 2个非A未知(-2) + 招采1/3 + 家庭5/7', () => {
    const i = { ...base, rolesPresent: { ...base.rolesPresent, TB: false }, nonAUnknownCount: 2, procurementTypesIdentified: 1, dFamily7Filled: 5 };
    // roleScore=max(0,6-3-2)=1, procure=1/3≈0.333, adur≈1.333, form=max(0,3-2)=1
    expect(scoreC1(i)).toBeCloseTo(1 + 1 / 3 + 1, 5);
  });
  it('FORM 严格曲线：填<4问即0', () => {
    expect(scoreC1({ ...base, dFamily7Filled: 4 })).toBe(7); // adur=7, form=max(0,3-3)=0
    expect(scoreC1({ ...base, dFamily7Filled: 3 })).toBe(7); // form 仍 0
  });
  it('线性曲线档案', () => {
    const linear = { ...DEFAULT_PROFILE, formC1Curve: 'linear' as const };
    expect(scoreC1({ ...base, dFamily7Filled: 4 }, linear)).toBe(7 + Math.round((3 * 4) / 7)); // 7+2
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
  it('采购未接触 + 代理口头 + 甲方密谋 = 0+1+4 = 5', () => {
    expect(scoreP2({ ...base, p2: { purchasing: 'none', agency: 'verbal', ownerRep: 'collude' } })).toBe(5);
  });
  it('三类均未接触 = -5', () => {
    expect(scoreP2({ ...base, p2: { purchasing: 'none', agency: 'none', ownerRep: 'none' } })).toBe(-5);
  });
});

describe('scoreOpportunity（总分/百分比/带）', () => {
  it('要素齐全的强势局', () => {
    const r = scoreOpportunity(base);
    // 6必清: C1 10+C2 5+C3 5+C4 5+C5 5+C6 5 = 35
    expect(r.clears).toBe(35);
    // 4优势: P1 5 + P2 10 + P3 10(D plus) + P4 10(KI star) = 35
    expect(r.priorities).toBe(35);
    // 1决胜: 1K 10 (A plus)
    expect(r.key).toBe(10);
    expect(r.total).toBe(80);
    expect(r.percent).toBeCloseTo(0.8, 5);
    expect(r.band).toBe('ABSOLUTE_ADVANTAGE');
  });

  it('D 倒向对手(x) + A 倒戈(x) → 趋赢力转负', () => {
    const i: ScoringInput = {
      ...base,
      dSentiments: ['x'], // P3 -20
      aSentiments: ['x'], // 1K -20
      p1PlusCount: 3, p1MinusCount: 2,
    };
    const r = scoreOpportunity(i);
    // 4优势: P1 clamp(3-2)=1 + P2 10 + P3 -20 + P4 10 = 1
    expect(r.items.P3).toBe(-20);
    expect(r.items['1K']).toBe(-20);
    expect(r.priorities).toBe(1);
    expect(r.total).toBe(35 + 1 - 20); // 16 → 16% < 25% → 绝对劣势
    expect(r.band).toBe('ABSOLUTE_DISADVANTAGE');
  });

  it('多个D 取中位数低分', () => {
    const r = scoreOpportunity({ ...base, dSentiments: ['plus', 'star'] }); // [10,20] -> 10
    expect(r.items.P3).toBe(10);
  });

  it('趋赢力可为负（极端劣势）', () => {
    const i: ScoringInput = {
      rolesPresent: { A: false, D: false, U: false, TB: false, R: false },
      nonAUnknownCount: 0, procurementTypesIdentified: 0, dFamily7Filled: 0, dHasBI: false,
      c3KnownCount: 0, engageStage: '招采执行', c5KnownCount: 0, ucvStatus: 'none',
      p1PlusCount: 0, p1MinusCount: 5,
      p2: { purchasing: 'none', agency: 'none', ownerRep: 'none' },
      dSentiments: ['x'], aSentiments: ['x'], keyInfluencerSentiment: null,
    };
    const r = scoreOpportunity(i);
    expect(r.total).toBeLessThan(0);
    expect(r.percent).toBeLessThan(0);
    expect(r.band).toBe('ABSOLUTE_DISADVANTAGE');
  });
});
