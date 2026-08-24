import type { ReactNode } from 'react';
import type { ProductAccess } from '@jianghu/domain-contracts';
import { selectAppRootSurface } from '../lib/appProductShell';

/** Thin edition adapter around the existing internal Hub; it does not fork or rewrite the legacy shell. */
export function InternalRootAdapter({ access, children }: { access: ProductAccess; children: ReactNode }) {
  if (selectAppRootSurface(access, false) !== 'internal_customer_hub') return null;
  return <div className="internal-root-adapter" data-app-shell="internal_legacy">{children}</div>;
}
