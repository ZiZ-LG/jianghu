import { describe, expect, it } from 'vitest';
import {
  canonicalFocusBasisRefs,
  canonicalIntelligenceTargets,
  parseStoredFocusBasisRefs,
  parseStoredIntelligenceTargets,
  projectStakeholderFocus,
} from '../src/intelligenceFocus/model.js';

describe('SAAS-206 intelligence/focus portable model helpers', () => {
  it('serializes structured references canonically and rejects duplicate or non-canonical storage', () => {
    const targets = [
      { kind: 'matter' as const, id: 'matter-206' },
      { kind: 'person' as const, id: 'person-206' },
    ];
    const targetJson = canonicalIntelligenceTargets(targets);
    expect(targetJson).toBe('[{"kind":"matter","id":"matter-206"},{"kind":"person","id":"person-206"}]');
    expect(parseStoredIntelligenceTargets(targetJson)).toEqual(targets);
    expect(() => canonicalIntelligenceTargets([targets[0]!, targets[0]!])).toThrow('intelligence_target_refs_invalid');
    expect(() => parseStoredIntelligenceTargets(` ${targetJson}`)).toThrow('intelligence_target_refs_corrupt');

    const basis = [
      { kind: 'intelligence_item' as const, id: 'intel-206', version: 2 },
      { kind: 'evidence' as const, id: 'evidence-206', version: 0 },
    ];
    const basisJson = canonicalFocusBasisRefs(basis);
    expect(parseStoredFocusBasisRefs(basisJson)).toEqual(basis);
    expect(() => canonicalFocusBasisRefs([basis[0]!, basis[0]!])).toThrow('stakeholder_focus_basis_refs_invalid');
    expect(() => parseStoredFocusBasisRefs(`${basisJson}\n`)).toThrow('stakeholder_focus_basis_refs_corrupt');
  });

  it('derives expiry only as a read projection and never mutates the current-focus identity', () => {
    const row = {
      id: 'focus-206', customerId: 'customer-206', matterId: 'matter-206', personId: 'person-206',
      desiredChange: '确认下一次评审条件', rationale: '该干系人负责组织评审', evidenceGap: null,
      basisRefs: '[{"kind":"intelligence_item","id":"intel-206","version":0}]',
      validUntil: new Date('2026-09-01T00:00:00.000Z'), activeMatterKey: 'matter-206',
      confirmedByUserId: 'user-206', confirmedAt: new Date('2026-08-27T00:00:00.000Z'),
      retiredByUserId: null, retiredAt: null, version: 0,
      createdAt: new Date('2026-08-27T00:00:00.000Z'), updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    expect(projectStakeholderFocus(row, new Date('2026-08-28T00:00:00.000Z'))).toMatchObject({
      status: 'active', matterId: 'matter-206', personId: 'person-206',
    });
    expect(projectStakeholderFocus(row, new Date('2026-09-02T00:00:00.000Z'))).toMatchObject({
      status: 'expired', matterId: 'matter-206', personId: 'person-206',
    });
    expect(row.activeMatterKey).toBe('matter-206');
  });
});
