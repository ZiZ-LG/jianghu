import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/compatibility.json';
import { scoreFromState, type ScoringProfile } from '../src/index.js';

describe('portable G64111 compatibility fixtures', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.id, () => {
      const result = scoreFromState(
        fixture.account as never,
        fixture.opportunity as never,
        ('profile' in fixture ? fixture.profile : undefined) as ScoringProfile | undefined,
      );
      expect(result).toEqual(fixture.expected);
    });
  }

  it('fails malformed procurement values closed in the shared normalizer', () => {
    const result = scoreFromState(
      { persons: [] },
      {
        roles: [{
          personId: 'bad',
          role: 'U',
          sentiment: 'neutral',
          confidence: '明确',
          procurementType: 'metadata' as never,
          procurementStatus: 'collude' as never,
        }],
      },
    );
    expect(result.items.C1).toBe(3);
    expect(result.items.P2).toBe(-5);
  });
});
