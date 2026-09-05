import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_KEYS,
  PERMISSION_KEYS,
  PRODUCT_ENTRY_REGISTRY,
  TENANT_DATA_SCOPE_POLICIES,
  CapabilityPolicySchema,
  TenantDataScopePolicySchema,
  assembleProductAccess,
  capabilityRequirementForActionType,
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
    expect(TENANT_DATA_SCOPE_POLICIES).toEqual([
      'legacy_tenant_shared',
      'scoped',
    ]);
  });

  it('publishes an explicit, fail-closed tenant data-scope policy contract', () => {
    expect(TenantDataScopePolicySchema.parse('legacy_tenant_shared')).toBe('legacy_tenant_shared');
    expect(TenantDataScopePolicySchema.parse('scoped')).toBe('scoped');
    expect(TenantDataScopePolicySchema.safeParse('enterprise').success).toBe(false);
    expect(TenantDataScopePolicySchema.safeParse(undefined).success).toBe(false);
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

  it('assembles commercial Free with exactly the four lightweight entries', () => {
    const access = assembleProductAccess({ edition: 'commercial' });

    expect(access).toMatchObject({
      valid: true,
      edition: 'commercial',
      shell: 'commercial',
      policy: { entitlements: ['crm.core'], permissions: [] },
    });
    expect(access.navigation.map(({ id, label, path }) => ({ id, label, path }))).toEqual([
      { id: 'matters', label: '商机', path: '/matters' },
      { id: 'today', label: '今日', path: '/today' },
      { id: 'customers', label: '客户', path: '/customers' },
      { id: 'quick-capture', label: '快速记录', path: '/quick-capture' },
    ]);
    expect(access.navigation.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(['sales-workspace', 'team', 'g64111', 'pde']),
    );
  });

  it('adds gated commercial entries without changing the Free default', () => {
    const access = assembleProductAccess({
      edition: 'commercial',
      enabledEntitlements: ['sales.workspace', 'team.operations', 'methodology.g64111', 'decision.pde'],
    });

    expect(access.navigation.map((entry) => entry.id)).toEqual([
      'matters', 'today', 'customers', 'quick-capture',
      'sales-workspace', 'team', 'g64111', 'pde',
    ]);
    expect(assembleProductAccess({ edition: 'commercial' }).navigation).toHaveLength(4);
    expect(PRODUCT_ENTRY_REGISTRY.every((entry) => entry.title.trim() && entry.description.trim())).toBe(true);
  });

  it('keeps the internal edition on the legacy shell and fails closed for malformed configuration', () => {
    const internal = assembleProductAccess({ edition: 'internal' });
    expect(internal).toMatchObject({ valid: true, edition: 'internal', shell: 'internal_legacy' });
    expect(internal.policy.entitlements).toEqual(ENTITLEMENT_KEYS);
    expect(internal.navigation).toEqual([]);

    const malformed = assembleProductAccess({
      edition: 'commercial',
      enabledEntitlements: ['crm.core', 'root.everything'],
    });
    expect(malformed).toMatchObject({ valid: false, edition: null, shell: 'commercial' });
    expect(malformed.policy).toEqual({ entitlements: [], permissions: [] });
    expect(malformed.navigation).toEqual([]);
  });

  it('maps legacy mutation actions to the entitlement that owns their service path', () => {
    expect(capabilityRequirementForActionType('ADD_ACCOUNT')).toEqual({ entitlement: 'crm.core' });
    expect(capabilityRequirementForActionType('ADD_PERSON')).toEqual({ entitlement: 'crm.core' });
    expect(capabilityRequirementForActionType('ADD_OPP')).toEqual({ entitlement: 'sales.workspace' });
    expect(capabilityRequirementForActionType('ADD_PLAN_ACTION')).toEqual({ entitlement: 'sales.workspace' });
    expect(capabilityRequirementForActionType('SET_ROLE')).toEqual({ entitlement: 'methodology.g64111' });
    expect(capabilityRequirementForActionType('ADD_BI')).toEqual({ entitlement: 'methodology.g64111' });
    expect(capabilityRequirementForActionType('not-an-action')).toBeNull();
  });
});
