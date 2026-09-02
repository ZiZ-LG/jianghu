import { describe, expect, it } from 'vitest';
import { RELATIONSHIP_RADAR_DIMENSIONS } from '@jianghu/domain-contracts';
import type { RelationshipRadarFacts } from '../src/relationshipRadar/model.js';
import { buildRelationshipRadarSnapshot } from '../src/relationshipRadar/rules.js';

const now = '2026-09-01T12:00:00.000Z';
const daysAgo = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

function facts(overrides: Partial<RelationshipRadarFacts> = {}): RelationshipRadarFacts {
  return {
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    customerVersion: 3,
    matterId: 'matter-1',
    matterVersion: 7,
    generatedAtUtc: now,
    interactions: [{ id: 'interaction-1', version: 2, occurredAtUtc: daysAgo(4) }],
    participants: [
      { id: 'participant-1', personId: 'person-1' },
      { id: 'participant-2', personId: 'person-2' },
      { id: 'participant-3', personId: 'person-3' },
    ],
    relations: [
      { id: 'relation-1', sourcePersonId: 'person-1', targetPersonId: 'person-2', version: 4, directed: false },
      { id: 'relation-2', sourcePersonId: 'person-2', targetPersonId: 'person-3', version: 5, directed: true },
    ],
    evidence: [{ id: 'evidence-1', personId: 'person-1', occurredAtUtc: daysAgo(5) }],
    intelligence: [],
    focus: { id: 'focus-1', personId: 'person-3', version: 1, confirmedAtUtc: daysAgo(3) },
    commitments: [{
      id: 'commitment-1', personId: 'person-2', version: 4, scheduleVersion: 2,
      executionStatus: 'planned', indicatorAtUtc: daysAgo(2),
    }],
    ...overrides,
  };
}

const signal = (result: ReturnType<typeof buildRelationshipRadarSnapshot>, dimension: string) => (
  result.payload.signals.find((item) => item.dimension === dimension)!
);

describe('SAAS-212 deterministic relationship radar rules', () => {
  it.each([
    [14, 'healthy', 'info'],
    [15, 'attention', 'low'],
    [30, 'attention', 'low'],
    [31, 'gap', 'medium'],
  ] as const)('maps interaction freshness day %s to %s/%s', (days, status, severity) => {
    const result = buildRelationshipRadarSnapshot(facts({
      interactions: [{ id: 'interaction-boundary', version: 1, occurredAtUtc: daysAgo(days) }],
    }));
    expect(signal(result, 'interaction_freshness')).toMatchObject({ status, severity });
  });

  it.each([
    [30, 'healthy', 'info'],
    [31, 'attention', 'low'],
    [60, 'attention', 'low'],
    [61, 'gap', 'medium'],
  ] as const)('maps approved evidence freshness day %s to %s/%s', (days, status, severity) => {
    const result = buildRelationshipRadarSnapshot(facts({
      evidence: [{ id: 'evidence-boundary', personId: 'person-1', occurredAtUtc: daysAgo(days) }],
    }));
    expect(signal(result, 'evidence_freshness')).toMatchObject({ status, severity });
  });

  it('distinguishes visible formal contact threads without inferring a hidden graph', () => {
    const two = buildRelationshipRadarSnapshot(facts());
    expect(signal(two, 'single_threaded_contact')).toMatchObject({ status: 'healthy', severity: 'info' });
    const one = buildRelationshipRadarSnapshot(facts({
      evidence: [],
      commitments: [{
        id: 'commitment-one', personId: 'person-1', version: 0, scheduleVersion: 0,
        executionStatus: 'planned', indicatorAtUtc: daysAgo(1),
      }],
    }));
    expect(signal(one, 'single_threaded_contact')).toMatchObject({ status: 'attention', severity: 'medium' });
    const none = buildRelationshipRadarSnapshot(facts({ evidence: [], commitments: [], intelligence: [] }));
    expect(signal(none, 'single_threaded_contact')).toMatchObject({ status: 'unknown', severity: 'low' });
  });

  it('uses only participants and current Focus for generic role coverage', () => {
    expect(signal(buildRelationshipRadarSnapshot(facts()), 'role_coverage'))
      .toMatchObject({ status: 'healthy', severity: 'info' });
    expect(signal(buildRelationshipRadarSnapshot(facts({ focus: null })), 'role_coverage'))
      .toMatchObject({ status: 'attention', severity: 'low' });
    expect(signal(buildRelationshipRadarSnapshot(facts({
      participants: [{ id: 'participant-1', personId: 'person-1' }], focus: null,
    })), 'role_coverage')).toMatchObject({ status: 'gap', severity: 'medium' });
  });

  it('accepts only a visible formal path of at most two edges to the current Focus', () => {
    const current = signal(buildRelationshipRadarSnapshot(facts()), 'visible_warm_paths');
    expect(current).toMatchObject({ status: 'healthy', severity: 'info' });
    expect(current.sourceRefs).toEqual(expect.arrayContaining([
      { entityKind: 'relation', entityId: 'relation-1', version: 4, scheduleVersion: null },
      { entityKind: 'relation', entityId: 'relation-2', version: 5, scheduleVersion: null },
    ]));
    expect(signal(buildRelationshipRadarSnapshot(facts({ relations: [] })), 'visible_warm_paths'))
      .toMatchObject({ status: 'gap', severity: 'medium' });
    expect(signal(buildRelationshipRadarSnapshot(facts({ focus: null })), 'visible_warm_paths'))
      .toMatchObject({ status: 'unknown', severity: 'low' });

    const reversed = [{
      id: 'relation-reversed', sourcePersonId: 'person-3', targetPersonId: 'person-1',
      version: 9, directed: false,
    }];
    expect(signal(buildRelationshipRadarSnapshot(facts({ relations: reversed })), 'visible_warm_paths'))
      .toMatchObject({ status: 'healthy', severity: 'info' });
    expect(signal(buildRelationshipRadarSnapshot(facts({
      relations: [{ ...reversed[0]!, directed: true }],
    })), 'visible_warm_paths')).toMatchObject({ status: 'gap', severity: 'medium' });
  });

  it('creates only an uncommitted CREATE_COMMITMENT draft when no planned next step exists', () => {
    const complete = buildRelationshipRadarSnapshot(facts());
    expect(signal(complete, 'next_step_completeness')).toMatchObject({ status: 'healthy', severity: 'info' });
    expect(complete.payload.drafts).toEqual([]);

    const gap = buildRelationshipRadarSnapshot(facts({ commitments: [] }));
    expect(signal(gap, 'next_step_completeness')).toMatchObject({ status: 'gap', severity: 'medium' });
    expect(gap.payload.drafts).toHaveLength(1);
    expect(gap.payload.drafts[0]).toMatchObject({ state: 'uncommitted', actionType: 'CREATE_COMMITMENT' });
    expect(gap.payload.drafts[0]).not.toHaveProperty('commitmentId');
  });

  it('is deterministic, body-free, exactly ordered, 24-hour and has no aggregate score', () => {
    const first = buildRelationshipRadarSnapshot(facts());
    const second = buildRelationshipRadarSnapshot(facts());
    expect(second).toEqual(first);
    expect(first.payload.signals.map((item) => item.dimension)).toEqual(RELATIONSHIP_RADAR_DIMENSIONS);
    expect(Date.parse(first.payload.expiresAtUtc) - Date.parse(first.payload.generatedAtUtc))
      .toBe(24 * 60 * 60 * 1_000);
    expect(first.payload).not.toHaveProperty('totalScore');
    expect(JSON.stringify(first)).not.toContain('rawContent');
    expect(JSON.stringify(first)).not.toContain('statement');
    expect(JSON.stringify(first)).not.toContain('desiredChange');
  });
});
