import { describe, expect, it } from 'vitest';
import {
  parseRelationshipWorkspace,
  relationshipFreshnessLabel,
  verificationReadinessLabel,
} from './relationshipWorkspace';
import { RELATIONSHIP_WORKSPACE_FIXTURE } from '../testFixtures/relationshipWorkspace';

describe('SAAS-208 relationship workspace client domain', () => {
  it('accepts only the exact requested Customer/Matter projection', () => {
    expect(parseRelationshipWorkspace(
      RELATIONSHIP_WORKSPACE_FIXTURE, 'customer-208', 'matter-208',
    )).toEqual(RELATIONSHIP_WORKSPACE_FIXTURE);
    expect(() => parseRelationshipWorkspace(
      RELATIONSHIP_WORKSPACE_FIXTURE, 'other-customer', 'matter-208',
    )).toThrow('relationship workspace parent mismatch');
    expect(() => parseRelationshipWorkspace({
      ...RELATIONSHIP_WORKSPACE_FIXTURE,
      formalRelations: [{ ...RELATIONSHIP_WORKSPACE_FIXTURE.formalRelations[0]!, rendering: 'dashed' }],
    }, 'customer-208', 'matter-208')).toThrow();
  });

  it('derives exact freshness copy and deterministic readiness labels without a score', () => {
    expect(relationshipFreshnessLabel(
      RELATIONSHIP_WORKSPACE_FIXTURE.intelligence[0]!,
      new Date('2026-09-01T08:00:00.000Z'),
    )).toBe('1 天前发生 · 1 天前得知');
    expect(verificationReadinessLabel('planned')).toBe('执行中');
    expect(verificationReadinessLabel('awaiting_result_or_evidence')).toBe('待结果或已批准证据');
    expect(verificationReadinessLabel('ready_for_review')).toBe('可人工复核');
    expect(verificationReadinessLabel('reviewed')).toBe('已复核');
    expect(verificationReadinessLabel('superseded_revision')).toBe('已被新修订取代');
  });
});
