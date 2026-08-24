import { capabilityPolicyAllows, type ProductAccess } from '@jianghu/domain-contracts';

export type AppRootSurface = 'commercial_shell' | 'internal_customer_hub' | 'legacy_workspace';

/** Single App adapter boundary: internal sessions keep the existing Hub/workspace path. */
export function selectAppRootSurface(access: ProductAccess, hasAccount: boolean): AppRootSurface {
  if (hasAccount) return 'legacy_workspace';
  return access.shell === 'commercial' ? 'commercial_shell' : 'internal_customer_hub';
}

/** Commercial Free uses only the neutral CRM DTO; the legacy tree belongs to the sales adapter. */
export function shouldLoadLegacyState(access: ProductAccess): boolean {
  return access.shell === 'internal_legacy'
    || capabilityPolicyAllows(access.policy, { entitlement: 'sales.workspace' });
}
