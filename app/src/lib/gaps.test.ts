import { describe, expect, it } from 'vitest';
import { seedAccount } from '../data/seed';
import { FAMILY_7Q, type Opportunity } from '../types';
import { computeGaps } from './gaps';

function opportunity(patch: Partial<Opportunity>): Opportunity {
  return { ...structuredClone(seedAccount.opportunities[0]), ...patch };
}

describe('computeGaps legacy canonical reads', () => {
  it('anchors FORM guidance to the explicit second D used by scoring', () => {
    const account = structuredClone(seedAccount);
    const firstD = account.persons.find((person) => person.id === 'qian')!;
    const primaryD = account.persons.find((person) => person.id === 'zhao')!;
    firstD.form.family7 = {};
    primaryD.form.family7 = Object.fromEntries(FAMILY_7Q.slice(0, 2).map((key) => [key, '已知']));
    const opp = opportunity({
      primaryDPersonId: primaryD.id,
      roles: [
        { personId: firstD.id, role: 'D', sentiment: 'plus', confidence: '明确' },
        { personId: primaryD.id, role: 'D', sentiment: 'neutral', confidence: '明确' },
      ],
      bis: [],
      ucvs: [],
    });

    const formGap = computeGaps(account, opp).find((gap) => gap.id === 'form-d');

    expect(formGap).toMatchObject({ personId: primaryD.id });
    expect(formGap?.title).toBe(`${primaryD.name} 的家庭 7 问缺 5 项`);
    expect(formGap?.ask).toContain(`「${primaryD.name}」`);
    expect(formGap?.ask).toContain('还差 5 项');
  });

  it('treats A/D-only historical P4 as missing, but accepts a stable legal duplicate set', () => {
    const illegalOnly = opportunity({
      roles: [{ personId: 'a-only', role: 'A', sentiment: 'star', confidence: '明确', isKeyInfluencer: true }],
    });
    const legalDuplicates = opportunity({
      roles: [
        { personId: 'z-legal', role: 'R', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
        { personId: 'a-legal', role: 'C', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
      ],
    });

    expect(computeGaps(seedAccount, illegalOnly).map((gap) => gap.id)).toContain('p4');
    expect(computeGaps(seedAccount, legalDuplicates).map((gap) => gap.id)).not.toContain('p4');
  });

  it('does not report canonical C5 gaps when all five values are known through legacy aliases', () => {
    const legacy = opportunity({
      c5Items: {
        '竞标方家数': true, '甲方代表': true, '招标代理': true,
        '招标参数': true, '评标规则': true,
      } as Opportunity['c5Items'],
    });

    expect(computeGaps(seedAccount, legacy).map((gap) => gap.id)).not.toContain('c5');
  });
});
