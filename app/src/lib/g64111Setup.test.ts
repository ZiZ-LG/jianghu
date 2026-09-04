import { describe, expect, it } from 'vitest';
import {
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  type G64111MethodologyReadModel,
} from '@jianghu/domain-contracts';
import {
  buildG64111BindCommand,
  buildG64111InstallCommand,
  buildG64111UnbindCommand,
  g64111BoundMatterIds,
} from './g64111Setup';

const binding = (packKey: string = G64111_BUILTIN_PACK_KEY, sourceTemplateRef: string | null = G64111_BUILTIN_SOURCE_TEMPLATE_REF) => ({
  bindingId: 'binding-1', customerId: 'customer-1', matterId: 'matter-1',
  packId: 'pack-1', versionId: 'version-1', packKey, packName: 'Pack',
  sourceTemplateRef, versionKey: '1.0.0' as const, engineRef: 'g64111:0.1.0' as const,
});

const model = (
  activeBinding: ReturnType<typeof binding> | null,
  installed = true,
  lifecycleStatus: 'active' | 'paused' | 'completed' | 'canceled' = 'active',
): G64111MethodologyReadModel => ({
  generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: true,
  installation: installed ? {
    packId: 'pack-1', versionId: 'version-1', packKey: G64111_BUILTIN_PACK_KEY,
    packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
    versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
  } : null,
  matters: [{
    customerId: 'customer-1', customerName: '客户', matterId: 'matter-1', matterTitle: '事项',
    matterKind: 'general', lifecycleStatus, matterVersion: 4, activeBinding,
  }],
});

describe('SAAS-210 G64111 setup helpers', () => {
  it('treats no installation and a different active methodology as unbound', () => {
    expect([...g64111BoundMatterIds(model(null, false))]).toEqual([]);
    expect([...g64111BoundMatterIds(model(binding('tenant.other', 'tenant:other:1')))]).toEqual([]);
    expect([...g64111BoundMatterIds(model(binding()))]).toEqual(['matter-1']);
  });

  it('creates opaque materialize IDs for the fixed built-in template', () => {
    const ids = ['methodologypack_11111111111111111111111111111111', 'methodologyversion_22222222222222222222222222222222'];
    expect(buildG64111InstallCommand(() => ids.shift()!)).toEqual({
      type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
      templateKey: 'g64111',
      packId: 'methodologypack_11111111111111111111111111111111',
      versionId: 'methodologyversion_22222222222222222222222222222222',
    });
  });

  it('builds bind/switch and unbind commands from the exact current Matter CAS snapshot', () => {
    const other = model(binding('tenant.other', 'tenant:other:1'));
    expect(buildG64111BindCommand(other, 'customer-1', 'matter-1', () => (
      'methodologybinding_33333333333333333333333333333333'
    ))).toEqual({
      type: 'ACTIVATE_METHODOLOGY_BINDING',
      bindingId: 'methodologybinding_33333333333333333333333333333333',
      customerId: 'customer-1',
      matterId: 'matter-1',
      versionId: 'version-1',
      baseMatterVersion: 4,
      expectedActiveBindingId: 'binding-1',
      decisionProfileRef: null,
    });
    expect(buildG64111UnbindCommand(model(binding()), 'customer-1', 'matter-1')).toEqual({
      type: 'UNBIND_METHODOLOGY',
      customerId: 'customer-1', matterId: 'matter-1',
      baseMatterVersion: 4, expectedActiveBindingId: 'binding-1',
    });
  });

  it('fails closed when installation, parent, or exact active state is missing', () => {
    expect(() => buildG64111BindCommand(model(null, false), 'customer-1', 'matter-1', () => 'unused')).toThrow();
    expect(() => buildG64111BindCommand(model(null), 'customer-other', 'matter-1', () => 'unused')).toThrow();
    expect(() => buildG64111UnbindCommand(model(binding('tenant.other', 'tenant:other:1')), 'customer-1', 'matter-1')).toThrow();
  });

  it('does not offer a new G64111 binding for a closed Matter but preserves exact unbind recovery', () => {
    expect(() => buildG64111BindCommand(
      model(null, true, 'completed'), 'customer-1', 'matter-1',
      () => 'methodologybinding_44444444444444444444444444444444',
    )).toThrow('Matter lifecycle does not allow G64111 activation');
    expect(buildG64111UnbindCommand(model(binding(), true, 'canceled'), 'customer-1', 'matter-1')).toMatchObject({
      type: 'UNBIND_METHODOLOGY',
      expectedActiveBindingId: 'binding-1',
    });
  });
});
