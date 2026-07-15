import { describe, expect, it } from 'vitest';
import { seedAccount } from './data/seed';
import { scoreFromDomain } from './lib/g64111';
import { buildAiContext } from './aiContext';

describe('buildAiContext G64111 selection semantics', () => {
  it('marks only the explicit second D and the shared legal P4 keeper', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    opp.primaryDPersonId = 'zhao';
    opp.roles = [
      { personId: 'qian', role: 'D', sentiment: 'plus', confidence: '明确' },
      { personId: 'zhao', role: 'D', sentiment: 'neutral', confidence: '明确' },
      { personId: 'sun', role: 'A', sentiment: 'star', confidence: '明确', isKeyInfluencer: true },
      { personId: 'zheng', role: 'U', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
      { personId: 'li', role: 'C', sentiment: 'neutral', confidence: '明确', isKeyInfluencer: true },
    ];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));
    const byName = new Map(context.people.map((person) => [person.name, person]));

    expect(byName.get('钱大钧')).toMatchObject({ role: 'D', isPrimaryD: false });
    expect(byName.get('赵建国')).toMatchObject({ role: 'D', isPrimaryD: true });
    expect(context.people.filter((person) => person.isPrimaryD)).toHaveLength(1);
    expect(byName.get('孙学文')).toMatchObject({ role: 'A', isKeyInfluencer: false });
    expect(byName.get('李进')).toMatchObject({ role: 'C', isKeyInfluencer: true });
    expect(byName.get('郑工')).toMatchObject({ role: 'U', isKeyInfluencer: false });
    expect(context.people.filter((person) => person.isKeyInfluencer)).toHaveLength(1);
  });

  it('uses the existing first-D fallback when no explicit primary D is valid', () => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    opp.primaryDPersonId = 'not-a-current-d';
    opp.roles = [
      { personId: 'qian', role: 'D', sentiment: 'plus', confidence: '明确' },
      { personId: 'zhao', role: 'D', sentiment: 'neutral', confidence: '明确' },
    ];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));

    expect(context.people.find((person) => person.isPrimaryD)?.name).toBe('钱大钧');
  });

  it.each([
    ['no roles', []],
    ['ordinary U/R/C without P4', [
      { personId: 'li', role: 'U', sentiment: 'neutral', confidence: '明确' },
      { personId: 'zhou', role: 'R', sentiment: 'neutral', confidence: '明确' },
      { personId: 'sun', role: 'C', sentiment: 'plus', confidence: '明确' },
    ]],
  ] as const)('does not invent primary D or P4 markers with %s', (_name, roles) => {
    const account = structuredClone(seedAccount);
    const opp = structuredClone(account.opportunities[0]);
    opp.primaryDPersonId = null;
    opp.roles = [...roles];

    const context = buildAiContext(account, opp, scoreFromDomain(account, opp));

    expect(context.people.filter((person) => person.isPrimaryD)).toHaveLength(0);
    expect(context.people.filter((person) => person.isKeyInfluencer)).toHaveLength(0);
  });
});
