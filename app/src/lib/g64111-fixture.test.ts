import { describe, expect, it } from 'vitest';
import fixtures from '@jianghu/g64111/fixtures/compatibility.json';
import type { ScoreBreakdown, ScoringProfile } from '@jianghu/g64111';
import { scoreFromDomain } from './g64111';

function assertExact(expected: ScoreBreakdown, actual: ScoreBreakdown): void {
  expect(actual).toEqual(expected);
}

describe('G64111 app adapter fixture contract', () => {
  it('rejects a deliberate one-point adapter drift', () => {
    const fixture = fixtures.cases[0];
    const actual = scoreFromDomain(fixture.account as never, fixture.opportunity as never);
    expect(() => assertExact(actual, { ...actual, total: actual.total + 1 })).toThrow();
  });

  for (const fixture of fixtures.cases) {
    it(`matches the static shared fixture exactly: ${fixture.id}`, () => {
      const profile = ('profile' in fixture ? fixture.profile : undefined) as ScoringProfile | undefined;
      const actual = scoreFromDomain(fixture.account as never, fixture.opportunity as never, profile);
      assertExact(fixture.expected as ScoreBreakdown, actual);
    });
  }
});
