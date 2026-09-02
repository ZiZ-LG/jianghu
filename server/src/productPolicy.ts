import {
  assembleProductAccess,
  type ProductAccess,
} from '@jianghu/domain-contracts';

/** Resolve the deployment policy from the same environment contract used by buildApp. */
export function deploymentProductAccess(explicit?: unknown): ProductAccess {
  if (explicit !== undefined) return assembleProductAccess(explicit);
  const enabledEntitlements = process.env.PRODUCT_ENTITLEMENTS
    ?.split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  return assembleProductAccess({
    edition: process.env.PRODUCT_EDITION ?? 'commercial',
    ...(enabledEntitlements && enabledEntitlements.length > 0 ? { enabledEntitlements } : {}),
  });
}
