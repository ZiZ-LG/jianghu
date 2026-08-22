import { describe, expect, it } from 'vitest';
import fixtures from '@jianghu/g64111/fixtures/compatibility.json';
import type { ScoreBreakdown, ScoringProfile } from '@jianghu/g64111';
import {
  G64111AdapterConfigurationError,
  G64111_RUNTIME_CONFIG,
  createG64111Adapter,
  projectG64111LegacyState,
  scoreFromDomain,
} from './g64111';

function assertExact(expected: ScoreBreakdown, actual: ScoreBreakdown): void {
  expect(actual).toEqual(expected);
}

describe('G64111 app adapter fixture contract', () => {
  it('fails closed when engineRef or registered legacy bindings drift', () => {
    expect(() => createG64111Adapter({
      ...G64111_RUNTIME_CONFIG,
      engineRef: 'g64111:9.9.9',
    })).toThrow(G64111AdapterConfigurationError);

    expect(() => createG64111Adapter({
      ...G64111_RUNTIME_CONFIG,
      storageBindings: G64111_RUNTIME_CONFIG.storageBindings.slice(1),
    })).toThrow(G64111AdapterConfigurationError);

    expect(() => createG64111Adapter({
      ...G64111_RUNTIME_CONFIG,
      storageBindings: G64111_RUNTIME_CONFIG.storageBindings.map((binding) => (
        binding.key === 'g64111.primary_d'
          ? { ...binding, storageBindingPath: 'Opportunity.unregisteredPrimaryD' }
          : binding
      )),
    })).toThrow(G64111AdapterConfigurationError);
  });

  it('projects only values reached through the registered legacy paths', () => {
    const projected = projectG64111LegacyState({
      persons: [{
        id: 'person-d',
        form: { family7: { '生日': '08-21' }, privateMemo: 'must-not-cross-adapter' },
        name: 'must-not-cross-adapter',
      }],
      privateAccountField: 'must-not-cross-adapter',
    } as never, {
      primaryDPersonId: 'person-d',
      pipelineStage: '合同谈判',
      engageStage: '预算批复',
      c3Items: { '项目名称': true },
      c5Items: { '招标参数': true },
      roles: [{
        personId: 'person-d',
        role: 'D',
        sentiment: 'plus',
        confidence: '明确',
        privateRoleField: 'must-not-cross-adapter',
      }],
      bis: [{
        id: 'bi-1',
        personId: 'person-d',
        confidence: '明确',
        description: 'must-not-cross-adapter',
      }],
      ucvs: [{
        targetBiId: 'bi-1',
        status: '获认可',
        description: 'must-not-cross-adapter',
      }],
      privateOpportunityField: 'must-not-cross-adapter',
    } as never);

    expect(projected).toEqual({
      account: {
        persons: [{ id: 'person-d', form: { family7: { '生日': '08-21' } } }],
      },
      opportunity: {
        primaryDPersonId: 'person-d',
        engageStage: '预算批复',
        c3Items: { '项目名称': true },
        c5Items: { '招标参数': true },
        roles: [{ personId: 'person-d', role: 'D', sentiment: 'plus', confidence: '明确' }],
        bis: [{ id: 'bi-1', personId: 'person-d', confidence: '明确' }],
        ucvs: [{ targetBiId: 'bi-1', status: '获认可' }],
      },
      pipelineStage: '合同谈判',
    });
  });

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
