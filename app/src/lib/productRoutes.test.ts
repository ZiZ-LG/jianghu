import { describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { personalRouteContext, resolveProductRoute } from './productRoutes';

describe('commercial product routes', () => {
  it('preserves a validated opportunity or capture context across refresh and rejects malformed paths', () => {
    const access = assembleProductAccess({ edition: 'commercial' });
    expect(resolveProductRoute('/matters/lead-1', access)).toMatchObject({ canonicalPath: '/matters/lead-1', entry: { id: 'matters' } });
    expect(resolveProductRoute('/quick-capture/c1/m1', access)).toMatchObject({ canonicalPath: '/quick-capture/c1/m1', entry: { id: 'quick-capture' } });
    expect(personalRouteContext('/quick-capture/c1/m1')).toEqual({ customerId: 'c1', matterId: 'm1' });
    for (const path of ['/matters/%2fprivate', '/matters/%ZZ', '/quick-capture/c1/m1/extra', '/matters/%00', '/matters/id%3fquery']) {
      expect(personalRouteContext(path)).toEqual({});
      expect(resolveProductRoute(path, access).canonicalPath).toBe('/matters');
    }
  });

  it('fails closed instead of synthesizing Today for invalid product access', () => {
    const access = assembleProductAccess({
      edition: 'commercial',
      enabledEntitlements: ['not-a-real-entitlement'],
    });

    expect(access.valid).toBe(false);
    expect(() => resolveProductRoute('/today', access)).toThrow('产品能力配置无效');
  });

  it('resolves every Free entry to a non-empty surface and rejects gated direct routes', () => {
    const access = assembleProductAccess({ edition: 'commercial' });

    for (const path of ['/today', '/customers', '/matters', '/quick-capture']) {
      const route = resolveProductRoute(path, access);
      expect(route.denied).toBe(false);
      expect(route.entry.path).toBe(path);
      expect(route.entry.title.trim()).not.toBe('');
      expect(route.entry.description.trim()).not.toBe('');
    }
    for (const path of ['/sales', '/team', '/g64111', '/pde']) {
      expect(resolveProductRoute(path, access)).toMatchObject({
        denied: true,
        canonicalPath: '/matters',
        entry: { id: 'matters' },
      });
    }
  });

  it('resolves capability-enabled routes while unknown routes fall back to the opportunity workbench', () => {
    const access = assembleProductAccess({
      edition: 'commercial',
      enabledEntitlements: ['sales.workspace', 'team.operations', 'methodology.g64111', 'decision.pde'],
    });

    expect(['/sales', '/team', '/g64111', '/pde'].map((path) => resolveProductRoute(path, access).entry.id))
      .toEqual(['sales-workspace', 'team', 'g64111', 'pde']);
    expect(resolveProductRoute('/not-a-real-entry', access)).toMatchObject({
      denied: false,
      canonicalPath: '/matters',
      entry: { id: 'matters' },
    });
  });
});
