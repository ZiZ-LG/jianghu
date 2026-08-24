import {
  PRODUCT_ENTRY_REGISTRY,
  type ProductAccess,
  type ProductEntryDefinition,
} from '@jianghu/domain-contracts';

export interface ResolvedProductRoute {
  entry: ProductEntryDefinition;
  canonicalPath: string;
  denied: boolean;
}

/** Resolve only assembled navigation entries; a known-but-disabled direct URL is denied. */
export function resolveProductRoute(pathname: string, access: ProductAccess): ResolvedProductRoute {
  if (!access.valid || access.navigation.length === 0) throw new Error('产品能力配置无效');
  const available = access.navigation.find((entry) => entry.path === pathname);
  if (available) return { entry: available, canonicalPath: available.path, denied: false };

  const requested = PRODUCT_ENTRY_REGISTRY.find((entry) => entry.path === pathname);
  const fallback = access.navigation[0];
  return {
    entry: fallback,
    canonicalPath: fallback.path,
    denied: requested !== undefined,
  };
}
