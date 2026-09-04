import { describe, expect, it, vi } from 'vitest';
import {
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  assembleProductAccess,
  type G64111MethodologyReadModel,
} from '@jianghu/domain-contracts';
import {
  invokeG64111ForMatter,
  refreshG64111AfterMatterMutation,
  resolveG64111LegacyRoute,
  selectG64111Accounts,
} from './g64111AppBoundary';

const exactReadModel: G64111MethodologyReadModel = {
  generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: true,
  installation: {
    packId: 'pack-g', versionId: 'version-g', packKey: G64111_BUILTIN_PACK_KEY,
    packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
    versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
  },
  matters: [{
    customerId: 'customer-1', customerName: '客户一', matterId: 'matter-bound', matterTitle: '已绑定',
    matterKind: 'general', lifecycleStatus: 'active', matterVersion: 1,
    activeBinding: {
      bindingId: 'binding-g', customerId: 'customer-1', matterId: 'matter-bound',
      packId: 'pack-g', versionId: 'version-g', packKey: G64111_BUILTIN_PACK_KEY,
      packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
      versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
    },
  }, {
    customerId: 'customer-1', customerName: '客户一', matterId: 'matter-unbound', matterTitle: '未绑定',
    matterKind: 'general', lifecycleStatus: 'active', matterVersion: 0, activeBinding: null,
  }],
};

const accounts = [{
  id: 'customer-1',
  opportunities: [{ id: 'matter-bound' }, { id: 'matter-unbound' }],
}];

describe('SAAS-210 App G64111 boundary', () => {
  const commercial = assembleProductAccess({
    edition: 'commercial', enabledEntitlements: ['sales.workspace', 'methodology.g64111'],
  });
  const internal = assembleProductAccess({ edition: 'internal' });

  it('does not invoke proprietary consumers for an unbound commercial Matter', () => {
    const compute = vi.fn(() => 'computed');
    expect(invokeG64111ForMatter(commercial, exactReadModel, 'customer-1', 'matter-unbound', compute)).toBeNull();
    expect(invokeG64111ForMatter(commercial, null, 'customer-1', 'matter-bound', compute)).toBeNull();
    expect(compute).not.toHaveBeenCalled();
  });

  it('invokes proprietary consumers only for exact-bound commercial Matters while preserving internal legacy behavior', () => {
    const compute = vi.fn(() => 'computed');
    expect(invokeG64111ForMatter(commercial, exactReadModel, 'customer-1', 'matter-bound', compute)).toBe('computed');
    expect(invokeG64111ForMatter(internal, null, 'any-customer', 'any-matter', compute)).toBe('computed');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('fails closed before invoking the adapter when version or engine identity drifts', () => {
    for (const activeBinding of [
      { ...exactReadModel.matters[0]!.activeBinding!, versionKey: '1.0.1' },
      { ...exactReadModel.matters[0]!.activeBinding!, engineRef: 'g64111:9.9.9' },
    ]) {
      const compute = vi.fn(() => 'must-not-run');
      const drifted = {
        ...exactReadModel,
        matters: [{ ...exactReadModel.matters[0]!, activeBinding }],
      } as unknown as G64111MethodologyReadModel;
      expect(invokeG64111ForMatter(commercial, drifted, 'customer-1', 'matter-bound', compute)).toBeNull();
      expect(compute).not.toHaveBeenCalled();
    }
  });

  it('runs active and paused Matters but excludes closed Matters from every commercial runtime path', () => {
    const withLifecycle = (lifecycleStatus: 'active' | 'paused' | 'completed' | 'canceled') => ({
      ...exactReadModel,
      matters: [{ ...exactReadModel.matters[0]!, lifecycleStatus }],
    }) as G64111MethodologyReadModel;
    const compute = vi.fn(() => 'computed');
    expect(invokeG64111ForMatter(commercial, withLifecycle('active'), 'customer-1', 'matter-bound', compute)).toBe('computed');
    expect(invokeG64111ForMatter(commercial, withLifecycle('paused'), 'customer-1', 'matter-bound', compute)).toBe('computed');
    expect(invokeG64111ForMatter(commercial, withLifecycle('completed'), 'customer-1', 'matter-bound', compute)).toBeNull();
    expect(invokeG64111ForMatter(commercial, withLifecycle('canceled'), 'customer-1', 'matter-bound', compute)).toBeNull();
    expect(selectG64111Accounts(commercial, withLifecycle('completed'), accounts)).toEqual([]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('refreshes the methodology projection with every commercial Matter mutation', async () => {
    const refreshMatterState = vi.fn(async () => 'fresh-state');
    const refreshMethodologyState = vi.fn(async () => undefined);

    await expect(refreshG64111AfterMatterMutation(
      commercial,
      refreshMatterState,
      refreshMethodologyState,
    )).resolves.toBe('fresh-state');
    expect(refreshMatterState).toHaveBeenCalledTimes(1);
    expect(refreshMethodologyState).toHaveBeenCalledTimes(1);

    refreshMatterState.mockClear();
    refreshMethodologyState.mockClear();
    await refreshG64111AfterMatterMutation(internal, refreshMatterState, refreshMethodologyState);
    expect(refreshMatterState).toHaveBeenCalledTimes(1);
    expect(refreshMethodologyState).not.toHaveBeenCalled();
  });

  it('filters commercial legacy state to exact-bound Matters without changing internal state', () => {
    expect(selectG64111Accounts(commercial, exactReadModel, accounts)).toEqual([{
      id: 'customer-1', opportunities: [{ id: 'matter-bound' }],
    }]);
    expect(selectG64111Accounts(commercial, null, accounts)).toEqual([]);
    expect(selectG64111Accounts(internal, null, accounts)).toBe(accounts);
  });

  it('accepts only an explicit exact-bound commercial deep link without opportunity fallback', () => {
    const linkedAccounts = [{
      id: 'customer-1', externalRef: 'customer-external',
      opportunities: [
        { id: 'matter-bound', externalRef: 'bound-external' },
        { id: 'matter-unbound', externalRef: 'unbound-external' },
      ],
    }];
    expect(resolveG64111LegacyRoute(commercial, exactReadModel, linkedAccounts, {
      accSeg: 'customer-external', oppSeg: 'bound-external',
    })).toEqual({ accId: 'customer-1', oppId: 'matter-bound' });
    expect(resolveG64111LegacyRoute(commercial, exactReadModel, linkedAccounts, {
      accSeg: 'customer-1', oppSeg: 'matter-unbound',
    })).toBeNull();
    expect(resolveG64111LegacyRoute(commercial, exactReadModel, linkedAccounts, {
      accSeg: 'customer-1', oppSeg: 'missing',
    })).toBeNull();
    expect(resolveG64111LegacyRoute(commercial, exactReadModel, linkedAccounts, {
      accSeg: 'customer-1',
    })).toBeNull();
  });
});
