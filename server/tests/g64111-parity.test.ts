import { describe, expect, it } from 'vitest';
import fixtures from '@jianghu/g64111/fixtures/compatibility.json';
import type { ScoreBreakdown, ScoringProfile } from '@jianghu/g64111';
import {
  G64111AdapterConfigurationError,
  G64111_RUNTIME_CONFIG,
  createG64111Adapter,
  projectG64111LegacyState,
  scoreFromState,
} from '../src/g64111.js';

function assertExact(expected: ScoreBreakdown, actual: ScoreBreakdown): void {
  expect(actual).toEqual(expected);
}

describe('G64111 server/MCP adapter fixture contract', () => {
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
        binding.key === 'g64111.roles'
          ? { ...binding, storageBindingKind: 'methodology_value' }
          : binding
      )),
    })).toThrow(G64111AdapterConfigurationError);
  });

  it('projects server snapshots through the registered legacy paths', () => {
    const projected = projectG64111LegacyState({
      persons: [{ id: 'person-a', form: { family7: { '籍贯': '杭州' } }, tenantId: 'hidden' }],
    } as never, {
      pipelineStage: '线索',
      roles: [],
      bis: [],
      ucvs: [],
      tenantId: 'hidden',
    } as never);

    expect(projected).toEqual({
      account: { persons: [{ id: 'person-a', form: { family7: { '籍贯': '杭州' } } }] },
      opportunity: {
        primaryDPersonId: undefined,
        engageStage: undefined,
        c3Items: undefined,
        c5Items: undefined,
        roles: [],
        bis: [],
        ucvs: [],
      },
      pipelineStage: '线索',
    });
  });

  it('rejects a deliberate one-point adapter drift', () => {
    const fixture = fixtures.cases[0];
    const actual = scoreFromState(fixture.account as never, fixture.opportunity as never);
    expect(() => assertExact(actual, { ...actual, total: actual.total + 1 })).toThrow();
  });

  for (const fixture of fixtures.cases) {
    it(`matches the static shared fixture exactly: ${fixture.id}`, () => {
      const profile = ('profile' in fixture ? fixture.profile : undefined) as ScoringProfile | undefined;
      const serverResult = scoreFromState(fixture.account as never, fixture.opportunity as never, profile);
      assertExact(fixture.expected as ScoreBreakdown, serverResult);
    });
  }
});
