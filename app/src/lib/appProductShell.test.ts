import { describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { selectAppRootSurface, shouldLoadLegacyState } from './appProductShell';

describe('App product shell adapter', () => {
  it('keeps the internal edition on the existing CustomerHub adapter', () => {
    const internal = assembleProductAccess({ edition: 'internal' });
    expect(selectAppRootSurface(internal, false)).toBe('internal_customer_hub');
    expect(selectAppRootSurface(internal, true)).toBe('legacy_workspace');
  });

  it('selects the commercial shell only for a commercial root session', () => {
    const commercial = assembleProductAccess({ edition: 'commercial' });
    expect(selectAppRootSurface(commercial, false)).toBe('commercial_shell');
    expect(selectAppRootSurface(commercial, true)).toBe('legacy_workspace');
  });

  it('loads the legacy full-state tree only for internal or sales-enabled sessions', () => {
    const commercialFree = assembleProductAccess({ edition: 'commercial' });
    const commercialSales = assembleProductAccess({ edition: 'commercial', enabledEntitlements: ['sales.workspace'] });
    const internal = assembleProductAccess({ edition: 'internal' });

    expect(shouldLoadLegacyState(commercialFree)).toBe(false);
    expect(shouldLoadLegacyState(commercialSales)).toBe(true);
    expect(shouldLoadLegacyState(internal)).toBe(true);
  });
});
