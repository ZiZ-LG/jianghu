import { describe, it, expect } from 'vitest';
import { buildPlaybooks } from './playbook';
import { scoreFromDomain } from '../g64111';
import type { Account, Opportunity, Person, OppRole, Edge } from '../../types';

const person = (id: string, name = id): Person => ({
  id, name, title: '', orgLevel: 3,
  form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
  logs: [], x: 0, y: 0,
} as unknown as Person);
const role = (personId: string, r: OppRole['role'], sentiment: OppRole['sentiment'], extra: Partial<OppRole> = {}): OppRole =>
  ({ personId, role: r, sentiment, confidence: '明确', ...extra }) as OppRole;
const edge = (source: string, target: string): Edge => ({ id: `e_${source}_${target}`, source, target, layer: 'L2', label: '' } as Edge);

const make = (persons: Person[], roles: OppRole[], edges: Edge[] = [], over: Partial<Opportunity> = {}) => {
  const opp = {
    id: 'o1', accountId: 'a1', name: '商机', customerType: 1,
    pipelineStage: '招投标', engageStage: '需求调研立项', singleSalesGoal: '',
    roles, bis: [], ucvs: [], c3Items: {}, c5Items: {}, edges, expectedAmountW: 100, ...over,
  } as unknown as Opportunity;
  const account = { id: 'a1', name: '客户', customerType: 1, persons, opportunities: [opp], baseEdges: [] } as unknown as Account;
  return { account, opp, breakdown: scoreFromDomain(account, opp) };
};

describe('buildPlaybooks · 主攻包', () => {
  it('有 D 未触达 → 出 frontal 包，含针对 D 的 P3 gain 行动', () => {
    const { account, opp, breakdown } = make([person('d1', '钱大钧')], [role('d1', 'D', 'unknown', { confidence: '不清' })]);
    const pbs = buildPlaybooks(account, opp, breakdown);
    const frontal = pbs.find((p) => p.key === 'frontal');
    expect(frontal).toBeDefined();
    const a = frontal!.actions.find((x) => x.gapItem === 'P3' && x.kind === 'gain');
    expect(a?.personId).toBe('d1');
    expect(a?.title).toContain('钱大钧');
  });
  it('D 的 FORM 不全 → 主攻包附带 C1 补 FORM 的 probe', () => {
    const { account, opp, breakdown } = make([person('d1')], [role('d1', 'D', 'plus')]);
    const frontal = buildPlaybooks(account, opp, breakdown).find((p) => p.key === 'frontal')!;
    expect(frontal.actions.some((a) => a.gapItem === 'C1' && a.kind === 'probe')).toBe(true);
  });
});

describe('buildPlaybooks · 迂回包', () => {
  it('高杠杆未触达 A + 存在 ☆ 盟友通路 → 出 flank 包', () => {
    const { account, opp, breakdown } = make(
      [person('a1', '赵总'), person('r1', '孙教练')],
      [role('a1', 'A', 'unknown', { confidence: '不清' }), role('r1', 'R', 'star', { isKeyInfluencer: true })],
      [edge('r1', 'a1')],
    );
    const flank = buildPlaybooks(account, opp, breakdown).find((p) => p.key === 'flank');
    expect(flank).toBeDefined();
    expect(flank!.actions[0].title).toContain('孙教练');
    expect(flank!.rationale).toContain('赵总');
  });
  it('无盟友通路 → 不出 flank 包', () => {
    const { account, opp, breakdown } = make([person('a1', '赵总')], [role('a1', 'A', 'unknown', { confidence: '不清' })]);
    expect(buildPlaybooks(account, opp, breakdown).some((p) => p.key === 'flank')).toBe(false);
  });
});

describe('buildPlaybooks · 探牌包', () => {
  it('有高熵关键人 → 恒出 probe 包，全 probe 行动、clarityUp', () => {
    const { account, opp, breakdown } = make([person('d1')], [role('d1', 'D', 'unknown', { confidence: '不清' })]);
    const probe = buildPlaybooks(account, opp, breakdown).find((p) => p.key === 'probe')!;
    expect(probe).toBeDefined();
    expect(probe.actions.every((a) => a.kind === 'probe')).toBe(true);
    expect(probe.clarityUp).toBe(true);
    expect(probe.expectedWinTendency).toBe(0);
  });
  it('看得清的强支持局 → 无探牌包', () => {
    const { account, opp, breakdown } = make([person('d1')], [role('d1', 'D', 'star', { confidence: '共识' })]);
    expect(buildPlaybooks(account, opp, breakdown).some((p) => p.key === 'probe')).toBe(false);
  });
});

describe('buildPlaybooks · 边界', () => {
  it('无角色 → 空', () => {
    const { account, opp, breakdown } = make([person('p1')], []);
    expect(buildPlaybooks(account, opp, breakdown)).toEqual([]);
  });
  it('方案包至少 2 个（主攻+探牌），含 expectedWinTendency 数值', () => {
    const { account, opp, breakdown } = make([person('d1'), person('a1')], [role('d1', 'D', 'unknown', { confidence: '不清' }), role('a1', 'A', 'plus')]);
    const pbs = buildPlaybooks(account, opp, breakdown);
    expect(pbs.length).toBeGreaterThanOrEqual(2);
    expect(pbs.every((p) => typeof p.expectedWinTendency === 'number')).toBe(true);
  });
});
