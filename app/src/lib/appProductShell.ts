import type { ProductAccess } from '@jianghu/domain-contracts';

export type AppRootSurface = 'commercial_shell' | 'internal_customer_hub' | 'legacy_workspace';

/** Single App adapter boundary: internal sessions keep the existing Hub/workspace path. */
export function selectAppRootSurface(access: ProductAccess, hasAccount: boolean): AppRootSurface {
  if (hasAccount) return 'legacy_workspace';
  return access.shell === 'commercial' ? 'commercial_shell' : 'internal_customer_hub';
}
