import { describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { resolveProductRoute } from './productRoutes';

describe('commercial product routes', () => {
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
        canonicalPath: '/today',
        entry: { id: 'today' },
      });
    }
  });

  it('resolves capability-enabled routes while unknown routes fall back to Today', () => {
    const access = assembleProductAccess({
      edition: 'commercial',
      enabledEntitlements: ['sales.workspace', 'team.operations', 'methodology.g64111', 'decision.pde'],
    });

    expect(['/sales', '/team', '/g64111', '/pde'].map((path) => resolveProductRoute(path, access).entry.id))
      .toEqual(['sales-workspace', 'team', 'g64111', 'pde']);
    expect(resolveProductRoute('/not-a-real-entry', access)).toMatchObject({
      denied: false,
      canonicalPath: '/today',
      entry: { id: 'today' },
    });
  });
});
