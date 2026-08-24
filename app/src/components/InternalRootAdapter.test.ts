import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { CustomerHub } from './CustomerHub';
import { InternalRootAdapter } from './InternalRootAdapter';

const noop = () => undefined;

describe('mounted internal App adapter', () => {
  it('selects and renders the existing CustomerHub under internal policy', () => {
    const hub = createElement(CustomerHub, {
      accounts: [],
      onOpen: noop,
      onCreate: noop,
      onLoadDemo: noop,
      onArchiveAccount: noop,
      onRepairAccount: noop,
      tenantName: '内部测试租户',
      userName: 'Internal Owner',
      plan: 'internal',
      onOpenTeam: noop,
      onLogout: noop,
      onOpenAiSettings: noop,
      onOpenWecom: noop,
      theme: 'light',
      onToggleTheme: noop,
      onOpenHelp: noop,
      onOpenMcpAccess: noop,
      onOpenIntel: noop,
      onOpenInbox: noop,
      readonly: true,
    });
    const html = renderToStaticMarkup(createElement(InternalRootAdapter, {
      access: assembleProductAccess({ edition: 'internal' }),
      children: hub,
    }));

    expect(html).toContain('data-app-shell="internal_legacy"');
    expect(html).toContain('class="hub"');
    expect(html).toContain('内部测试租户');
    expect(html).toContain('江湖 · 销售干系人作战地图 · 客户工作台');
    expect(html).not.toContain('轻量客户与事项');
  });

  it('does not mount the internal adapter for commercial policy', () => {
    const html = renderToStaticMarkup(createElement(InternalRootAdapter, {
      access: assembleProductAccess({ edition: 'commercial' }),
      children: createElement('div', null, 'must not render'),
    }));
    expect(html).toBe('');
  });
});
