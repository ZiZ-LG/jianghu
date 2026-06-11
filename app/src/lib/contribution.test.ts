import { describe, it, expect } from 'vitest';
import { personContributions, scoreFromDomain } from './g64111';
import type { Account, Opportunity, Person, OppRole, BurningIssue, UCV } from '../types';
import { FAMILY_7Q } from '../types';

// ── 最小领域夹具（只填贡献分用到的字段） ──
const person = (id: string, family7Filled = 0): Person => {
  const family7: Record<string, string> = {};
  FAMILY_7Q.slice(0, family7Filled).forEach((q) => { family7[q] = '已知'; });
  return {
    id, name: id, title: '', orgLevel: 3,
    form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7 },
    logs: [], x: 0, y: 0,
  } as unknown as Person;
};
const role = (personId: string, r: OppRole['role'], sentiment: OppRole['sentiment'], extra: Partial<OppRole> = {}): OppRole =>
  ({ personId, role: r, sentiment, confidence: '明确', ...extra }) as OppRole;
const bi = (id: string, personId: string, confidence = '明确'): BurningIssue =>
  ({ id, personId, description: 'x', category: '', isPrivate: false, confidence }) as BurningIssue;
const ucv = (targetBiId: string, status: UCV['status']): UCV =>
  ({ id: 'u_' + targetBiId, targetBiId, description: '', status }) as UCV;

const makeOpp = (roles: OppRole[], bis: BurningIssue[] = [], ucvs: UCV[] = []): Opportunity =>
  ({
    id: 'o1', accountId: 'a1', name: '测试商机', customerType: 1,
    pipelineStage: '线索', engageStage: '需求调研立项', singleSalesGoal: '',
    roles, bis, ucvs, c3Items: {}, c5Items: {},
  }) as unknown as Opportunity;
const makeAccount = (persons: Person[], opp: Opportunity): Account =>
  ({ id: 'a1', name: '测试客户', customerType: 1, persons, opportunities: [opp] }) as unknown as Account;

const get = (acc: Account, opp: Opportunity, pid: string) => {
  const e = personContributions(acc, opp).get(pid);
  expect(e).toBeDefined();
  return e!;
};
const part = (e: { parts: { item: string; value: number; note?: string }[] }, item: string) =>
  e.parts.find((p) => p.item === item);

describe('personContributions · 单 D / 单 A 基础归因', () => {
  it('单 D star：P3 +20 无聚合注记，potential=34（P3 20+FORM 3+C2 5+C6 5+P1 1）', () => {
    const opp = makeOpp([role('d1', 'D', 'star')]);
    const e = get(makeAccount([person('d1')], opp), opp, 'd1');
    expect(part(e, 'P3')!.value).toBe(20);
    expect(part(e, 'P3')!.note).toBeUndefined();
    expect(e.potential).toBe(34);
    expect(e.nominal).toBe(21); // P3 20 + P1 1（star 明确）
    expect(e.upside).toBe(13);
  });

  it('A unknown：nominal 0、potential 21、upside 21（最大潜力缺口）', () => {
    const opp = makeOpp([role('a1p', 'A', 'unknown', { confidence: '不清' })]);
    const e = get(makeAccount([person('a1p')], opp), opp, 'a1p');
    expect(e.nominal).toBe(0);
    expect(e.potential).toBe(21); // 1K 20 + P1 1
    expect(e.upside).toBe(21);
  });
});

describe('personContributions · 多人聚合的如实标注', () => {
  it('多 D（star + x）：各显名义 ±20，偏离实计者带「多D取低」注记', () => {
    const opp = makeOpp([role('d1', 'D', 'star'), role('d2', 'D', 'x')]);
    const acc = makeAccount([person('d1'), person('d2')], opp);
    const e1 = get(acc, opp, 'd1'), e2 = get(acc, opp, 'd2');
    // aggregateLow([20,-20]) 偶数取下中位 = -20：d1 名义 20 ≠ 实计，须标注；d2 名义=实计，不标
    expect(part(e1, 'P3')!.value).toBe(20);
    expect(part(e1, 'P3')!.note).toContain('-20');
    expect(part(e2, 'P3')!.value).toBe(-20);
    expect(part(e2, 'P3')!.note).toBeUndefined();
  });

  it('P4 多人标记：仅引擎选中的第一个计分，其余 0 +「已占用」注记且不虚加潜力', () => {
    const opp = makeOpp([
      role('r1', 'R', 'star', { isKeyInfluencer: true }),
      role('r2', 'R', 'plus', { isKeyInfluencer: true }),
    ]);
    const acc = makeAccount([person('r1'), person('r2')], opp);
    expect(part(get(acc, opp, 'r1'), 'P4')!.value).toBe(10);
    expect(part(get(acc, opp, 'r2'), 'P4')!.value).toBe(0);
    expect(part(get(acc, opp, 'r2'), 'P4')!.note).toContain('占用');
    expect(get(acc, opp, 'r2').potential).toBe(1); // 只有 P1 潜力
  });
});

describe('personContributions · P1 / P2 规则', () => {
  it('P1：未确认（推理）不计分但保留 +1 潜力；明确 minus 计 −1', () => {
    const opp = makeOpp([
      role('u1', 'U', 'plus', { confidence: '推理' }),
      role('u2', 'U', 'minus'),
    ]);
    const acc = makeAccount([person('u1'), person('u2')], opp);
    const e1 = get(acc, opp, 'u1'), e2 = get(acc, opp, 'u2');
    expect(part(e1, 'P1')).toBeUndefined();
    expect(e1.potential).toBe(1);
    expect(part(e2, 'P1')!.value).toBe(-1);
    expect(e2.nominal).toBe(-1);
  });

  it('P2：purchasing collude=+4 / agency verbal=+1，潜力按类型权重', () => {
    const opp = makeOpp([
      role('p1', 'TB', 'neutral', { procurementType: 'purchasing', procurementStatus: 'collude' }),
      role('p2', 'TB', 'neutral', { procurementType: 'agency', procurementStatus: 'verbal' }),
    ]);
    const acc = makeAccount([person('p1'), person('p2')], opp);
    expect(part(get(acc, opp, 'p1'), 'P2')!.value).toBe(4);
    expect(get(acc, opp, 'p1').potential).toBe(1 + 4);
    expect(part(get(acc, opp, 'p2'), 'P2')!.value).toBe(1);
    expect(get(acc, opp, 'p2').potential).toBe(1 + 2);
  });
});

describe('personContributions · D 的 C1-FORM / C2 / C6 归因', () => {
  it('主 D FORM 5/7 → C1 +1（strict 曲线）；非主 D 不计 FORM', () => {
    const opp = makeOpp([role('d1', 'D', 'plus'), role('d2', 'D', 'plus')]);
    const acc = makeAccount([person('d1', 5), person('d2', 7)], opp);
    expect(part(get(acc, opp, 'd1'), 'C1')!.value).toBe(1); // max(0, 3-(7-5))
    expect(part(get(acc, opp, 'd2'), 'C1')).toBeUndefined();
    expect(get(acc, opp, 'd1').potential).toBe(34);
    expect(get(acc, opp, 'd2').potential).toBe(31); // 无 FORM 3 分潜力
  });

  it('C2 归持明确 BI 的 D；C6 取最佳 UCV 状态归该 BI 持有人', () => {
    const opp = makeOpp(
      [role('d1', 'D', 'plus')],
      [bi('b1', 'd1')],
      [ucv('b1', '获认可')],
    );
    const e = get(makeAccount([person('d1')], opp), opp, 'd1');
    expect(part(e, 'C2')!.value).toBe(5);
    expect(part(e, 'C6')!.value).toBe(3);
    expect(e.nominal).toBe(10 + 1 + 5 + 3 + 0); // P3(plus)=10 + P1 + C2 + C6 + FORM(0)
  });

  it('BI 置信度仅「推理」→ C2 不计', () => {
    const opp = makeOpp([role('d1', 'D', 'plus')], [bi('b1', 'd1', '推理')]);
    expect(part(get(makeAccount([person('d1')], opp), opp, 'd1'), 'C2')).toBeUndefined();
  });
});

describe('personContributions · 身兼多职与失血', () => {
  it('同一人身兼 D+A：P3 与 1K 叠加，potential 叠加', () => {
    const opp = makeOpp([role('x1', 'D', 'plus'), role('x1', 'A', 'plus')]);
    const e = get(makeAccount([person('x1')], opp), opp, 'x1');
    expect(part(e, 'P3')!.value).toBe(10);
    expect(part(e, '1K')!.value).toBe(10);
    expect(e.nominal).toBe(10 + 10 + 1 + 1); // 两条角色各 P1 +1（与引擎按条目计数一致）
    expect(e.potential).toBe(34 + 21);
  });

  it('D 倒向友商（x 明确）：nominal=−21 失血，upside=55（扳回净增空间）', () => {
    const opp = makeOpp([role('d1', 'D', 'x')]);
    const e = get(makeAccount([person('d1')], opp), opp, 'd1');
    expect(e.nominal).toBe(-21); // P3 -20 + P1 -1
    expect(e.upside).toBe(34 - -21);
  });
});

describe('personContributions · 与引擎对账（无聚合偏差场景）', () => {
  it('单 D 单 A 简单局：Σnominal = total − 商机级分项（C1齐备+C3+C4+C5）', () => {
    const persons = [person('d1', 7), person('a1p')];
    const opp = makeOpp(
      [role('d1', 'D', 'star'), role('a1p', 'A', 'plus')],
      [bi('b1', 'd1')],
      [ucv('b1', '已解决')],
    );
    const acc = makeAccount(persons, opp);
    const bd = scoreFromDomain(acc, opp);
    const sum = [...personContributions(acc, opp).values()].reduce((s, e) => s + e.nominal, 0);
    // 商机级（不归人）分项：C1 角色齐备部分(C1−FORM满3) + C3/C4/C5 + P2 全 none 的整体 −5（本场景无人有招采类型）
    const oppLevel = (bd.items.C1 - 3) + bd.items.C3 + bd.items.C4 + bd.items.C5 + bd.items.P2;
    expect(sum).toBeCloseTo(bd.total - oppLevel, 5);
  });
});
