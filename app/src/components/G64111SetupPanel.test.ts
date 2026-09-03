import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  type G64111MethodologyReadModel,
} from '@jianghu/domain-contracts';
import { G64111SetupPanel, type G64111SetupPanelState } from './G64111SetupPanel';

const snapshot: G64111MethodologyReadModel = {
  generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: true,
  installation: {
    packId: 'pack-g', versionId: 'version-g', packKey: G64111_BUILTIN_PACK_KEY,
    packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
    versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
  },
  matters: [{
    customerId: 'customer-1', customerName: '客户一', matterId: 'matter-unbound', matterTitle: '未绑定事项',
    matterKind: 'general', matterVersion: 0, activeBinding: null,
  }, {
    customerId: 'customer-1', customerName: '客户一', matterId: 'matter-bound', matterTitle: '已绑定事项',
    matterKind: 'general', matterVersion: 2,
    activeBinding: {
      bindingId: 'binding-g', customerId: 'customer-1', matterId: 'matter-bound',
      packId: 'pack-g', versionId: 'version-g', packKey: G64111_BUILTIN_PACK_KEY,
      packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
      versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
    },
  }, {
    customerId: 'customer-2', customerName: '客户二', matterId: 'matter-other', matterTitle: '其他方法事项',
    matterKind: 'general', matterVersion: 5,
    activeBinding: {
      bindingId: 'binding-other', customerId: 'customer-2', matterId: 'matter-other',
      packId: 'pack-other', versionId: 'version-other', packKey: 'tenant.other',
      packName: '企业方法论', sourceTemplateRef: 'tenant:other:1', versionKey: '2.0.0', engineRef: 'declarative:1',
    },
  }],
};

const render = (state: G64111SetupPanelState) => renderToStaticMarkup(createElement(G64111SetupPanel, {
  state,
  onRetry: () => undefined,
  onAction: async () => undefined,
}));

describe('G64111SetupPanel', () => {
  it('renders explicit loading and retryable error states without claiming readiness', () => {
    expect(render({ status: 'loading' })).toContain('data-g64111-setup-state="loading"');
    const error = render({ status: 'error', message: '读取失败' });
    expect(error).toContain('data-g64111-setup-state="error"');
    expect(error).toContain('读取失败');
    expect(error).toContain('重试');
    expect(error).not.toContain('已就绪');
  });

  it('requires an explicit install and hides the action when commands or manager rights are absent', () => {
    const missing = { ...snapshot, installation: null, matters: snapshot.matters.map((matter) => ({ ...matter, activeBinding: null })) };
    expect(render({ status: 'ready', snapshot: missing })).toContain('安装 G64111');
    expect(render({ status: 'ready', snapshot: { ...missing, commandsEnabled: false } })).not.toContain('>安装 G64111</button>');
    expect(render({ status: 'ready', snapshot: { ...missing, canManage: false } })).not.toContain('>安装 G64111</button>');
  });

  it('distinguishes unbound, exact G64111, and other-methodology Matters', () => {
    const html = render({ status: 'ready', snapshot });
    expect(html).toContain('未绑定事项');
    expect(html).toContain('为此事项启用');
    expect(html).toContain('已绑定事项');
    expect(html).toContain('解绑 G64111');
    expect(html).toContain('其他方法事项');
    expect(html).toContain('切换到 G64111');
    expect(html).toContain('企业方法论');
  });

  it('keeps viewer/member projections read-only even if the outer shell is writable', () => {
    const html = render({ status: 'ready', snapshot: { ...snapshot, canManage: false } });
    expect(html).toContain('仅可查看方法论状态');
    expect(html).not.toContain('解绑 G64111');
    expect(html).not.toContain('切换到 G64111');
    expect(html).not.toContain('为此事项启用');
  });
});
