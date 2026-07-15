import { describe, it, expect } from 'vitest';
import { previewProposalImpact } from './impact';
import { scoreFromDomain } from './g64111';
import { seedAccount } from '../data/seed';

describe('impact · 提案影响预览（v2.0）', () => {
  const acc = seedAccount;
  const opp = acc.opportunities[0];
  const role = opp.roles[0]; // 任取一个有支持度的角色作改动目标

  it('改 sentiment 返回 {before, after} 数字（百分比）', () => {
    const res = previewProposalImpact(acc, opp, { entityKind: 'oppRole', entityId: role.personId, field: 'sentiment', newValue: 'minus' });
    expect(res).not.toBeNull();
    expect(typeof res!.before).toBe('number');
    expect(typeof res!.after).toBe('number');
  });

  it('before 与 scoreFromDomain 当前分一致', () => {
    const res = previewProposalImpact(acc, opp, { entityKind: 'oppRole', entityId: role.personId, field: 'sentiment', newValue: 'star' });
    expect(res!.before).toBe(Math.round(scoreFromDomain(acc, opp).percent * 100));
  });

  it('排他支持(star) 的 after ≥ 倒戈(x) 的 after（方向正确）', () => {
    const star = previewProposalImpact(acc, opp, { entityKind: 'oppRole', entityId: role.personId, field: 'sentiment', newValue: 'star' })!;
    const x = previewProposalImpact(acc, opp, { entityKind: 'oppRole', entityId: role.personId, field: 'sentiment', newValue: 'x' })!;
    expect(star.after).toBeGreaterThanOrEqual(x.after);
  });

  it('克隆不污染原 opp（原 sentiment 不变）', () => {
    const orig = opp.roles[0].sentiment;
    previewProposalImpact(acc, opp, { entityKind: 'oppRole', entityId: opp.roles[0].personId, field: 'sentiment', newValue: 'x' });
    expect(opp.roles[0].sentiment).toBe(orig);
  });

  it('非评分字段（person.name）返回 null', () => {
    expect(previewProposalImpact(acc, opp, { entityKind: 'person', entityId: 'x', field: 'name', newValue: 'y' })).toBeNull();
  });

  it('无 opp 上下文返回 null', () => {
    expect(previewProposalImpact(acc, null, { entityKind: 'oppRole', entityId: 'x', field: 'sentiment', newValue: 'minus' })).toBeNull();
  });

  it('预览选中新 P4 时先清除 personId 更小的旧 P4', () => {
    const historical = structuredClone(opp);
    historical.roles = [
      { personId: 'sun', role: 'C', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
      { personId: 'zheng', role: 'U', sentiment: 'neutral', confidence: '明确' },
    ];
    const expected = structuredClone(historical);
    expected.roles[0].isKeyInfluencer = false;
    expected.roles[1].isKeyInfluencer = true;

    const result = previewProposalImpact(acc, historical, {
      entityKind: 'oppRole', entityId: 'zheng', field: 'isKeyInfluencer', newValue: 'true',
    });

    expect(result).toEqual({
      before: Math.round(scoreFromDomain(acc, historical).percent * 100),
      after: Math.round(scoreFromDomain(acc, expected).percent * 100),
    });
    expect(result!.after).toBeLessThan(result!.before);
  });

  it.each(['A', 'D'] as const)('不为 %s 角色生成 P4 选中预览', (role) => {
    const historical = structuredClone(opp);
    historical.roles = [{ personId: 'zhao', role, sentiment: 'star', confidence: '明确' }];

    expect(previewProposalImpact(acc, historical, {
      entityKind: 'oppRole', entityId: 'zhao', field: 'isKeyInfluencer', newValue: 'true',
    })).toBeNull();
  });
});
