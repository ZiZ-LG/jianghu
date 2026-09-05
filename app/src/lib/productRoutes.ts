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

export function personalMatterPath(matterId: string): string { return `/matters/${encodeURIComponent(matterId)}`; }
export function quickCapturePath(customerId: string, matterId?: string): string {
  return `/quick-capture/${encodeURIComponent(customerId)}${matterId ? `/${encodeURIComponent(matterId)}` : ''}`;
}
export function personalRouteContext(pathname: string): { matterId?: string; customerId?: string } {
  const parts = pathname.split('/').filter(Boolean);
  try {
    const values = parts.slice(1).map(decodeURIComponent);
    if (values.some(value => !/^[^\s/\\?#\u0000-\u001f\u007f]{1,200}$/u.test(value))) return {};
    if (parts[0] === 'matters' && parts.length === 2) return { matterId: values[0] };
    if (parts[0] === 'quick-capture' && (parts.length === 2 || parts.length === 3)) return { customerId: values[0], ...(values[1] ? { matterId: values[1] } : {}) };
  } catch { /* Invalid escapes never become a context. */ }
  return {};
}

/** Resolve only assembled navigation entries; a known-but-disabled direct URL is denied. */
export function resolveProductRoute(pathname: string, access: ProductAccess): ResolvedProductRoute {
  if (!access.valid || access.navigation.length === 0) throw new Error('产品能力配置无效');
  const available = access.navigation.find((entry) => entry.path === pathname);
  if (available) return { entry: available, canonicalPath: available.path, denied: false };

  const context = personalRouteContext(pathname);
  if (context.customerId || context.matterId) {
    const entry = access.navigation.find(item => item.id === (context.customerId ? 'quick-capture' : 'matters'));
    if (entry) return { entry, canonicalPath: context.customerId ? quickCapturePath(context.customerId, context.matterId) : personalMatterPath(context.matterId!), denied: false };
  }

  const requested = PRODUCT_ENTRY_REGISTRY.find((entry) => entry.path === pathname);
  const fallback = access.navigation[0];
  return {
    entry: fallback,
    canonicalPath: fallback.path,
    denied: requested !== undefined,
  };
}
