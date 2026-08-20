import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_KEYS,
  PERMISSION_KEYS,
  CapabilityPolicySchema,
  capabilityPolicyAllows,
} from '../src/index.js';

describe('central capability policy', () => {
  it('publishes the approved product layers and scoped permissions as stable keys', () => {
    expect(ENTITLEMENT_KEYS).toEqual([
      'crm.core',
      'sales.workspace',
      'team.operations',
      'methodology.center',
      'methodology.g64111',
      'decision.pde',
    ]);
    expect(PERMISSION_KEYS).toEqual([
      'portfolio.read',
      'coaching.manage',
      'commitment.assign',
      'source.read_shared',
      'candidate.review_shared',
      'data.read_all',
    ]);
  });

  it('fails closed for absent grants and requires both grants when both are requested', () => {
    const policy = {
      entitlements: ['crm.core', 'team.operations'],
      permissions: ['portfolio.read'],
    };

    expect(capabilityPolicyAllows(policy, { entitlement: 'crm.core' })).toBe(true);
    expect(capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })).toBe(false);
    expect(capabilityPolicyAllows(policy, { permission: 'portfolio.read' })).toBe(true);
    expect(capabilityPolicyAllows(policy, {
      entitlement: 'team.operations',
      permission: 'coaching.manage',
    })).toBe(false);
    expect(capabilityPolicyAllows({
      entitlements: ['team.operations'],
      permissions: ['coaching.manage'],
    }, {
      entitlement: 'team.operations',
      permission: 'coaching.manage',
    })).toBe(true);
  });

  it('rejects unknown, duplicate, or plan-shaped policy input', () => {
    expect(CapabilityPolicySchema.safeParse({
      entitlements: ['crm.core', 'root.everything'],
      permissions: [],
    }).success).toBe(false);
    expect(CapabilityPolicySchema.safeParse({
      entitlements: ['crm.core', 'crm.core'],
      permissions: [],
    }).success).toBe(false);
    expect(CapabilityPolicySchema.safeParse({
      plan: 'enterprise',
      entitlements: ['crm.core'],
      permissions: [],
    }).success).toBe(false);

    expect(capabilityPolicyAllows({
      entitlements: ['crm.core', 'root.everything'], permissions: [],
    }, { entitlement: 'crm.core' })).toBe(false);
    expect(capabilityPolicyAllows({
      entitlements: ['crm.core'], permissions: [], plan: 'enterprise',
    }, { entitlement: 'crm.core' })).toBe(false);
    expect(capabilityPolicyAllows({
      entitlements: ['crm.core'], permissions: [],
    }, {})).toBe(false);
    expect(capabilityPolicyAllows({
      entitlements: ['crm.core'], permissions: [],
    }, { permission: 'root.everything' })).toBe(false);
  });
});
