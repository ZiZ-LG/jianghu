import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { CommercialShell } from './CommercialShell';

const renderShell = (pathname: string, enabledEntitlements?: string[], readonly = false) => renderToStaticMarkup(createElement(CommercialShell, {
  access: assembleProductAccess({ edition: 'commercial', ...(enabledEntitlements ? { enabledEntitlements } : {}) }),
  pathname,
  accounts: [],
  actorUserId: 'user-cao',
  readonly,
  onNavigate: () => undefined,
  onOpenLegacy: () => undefined,
  onOpenTeam: () => undefined,
  onQuickCaptureSaved: async () => undefined,
  onLogout: () => undefined,
}));

describe('CommercialShell', () => {
  it('renders exactly the four Free navigation entries and a real panel for each route', () => {
    const html = renderShell('/today');
    const navLabels = [...html.matchAll(/data-product-entry="[^"]+"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(navLabels).toEqual(['今日', '客户', '事项', '快速记录']);
    expect(html).not.toContain('复杂销售');
    expect(html).not.toContain('G64111');
    expect(html).not.toContain('PDE');

    const todayHtml = renderShell('/today');
    expect(todayHtml).toContain('data-today-state="loading"');
    expect(todayHtml).toContain('data-today-readonly="false"');
    expect(todayHtml).not.toContain('commercial-shell-summary');
    expect(renderShell('/today', undefined, true)).toContain('data-today-readonly="true"');

    for (const path of ['/customers', '/matters']) {
      const routeHtml = renderShell(path);
      expect(routeHtml).toContain('data-product-panel');
      expect(routeHtml).toMatch(/<h1>[^<]+<\/h1>/);
      expect(routeHtml).toContain('data-crm-context-state="loading"');
      expect(routeHtml).not.toContain('还没有客户档案');
      expect(routeHtml).not.toContain('还没有进行中的事项');
    }
    const quickCaptureHtml = renderShell('/quick-capture');
    expect(quickCaptureHtml).toContain('data-product-panel="quick-capture"');
    expect(quickCaptureHtml).toContain('data-quick-capture-form="true"');
    expect(quickCaptureHtml).not.toContain('前往客户');
  });

  it('renders every gated entry and its non-empty surface only when enabled', () => {
    const enabled = ['sales.workspace', 'team.operations', 'methodology.g64111', 'decision.pde'];
    const html = renderShell('/pde', enabled);
    for (const label of ['复杂销售', '团队', 'G64111', 'PDE']) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('<h1>PDE</h1>');
    expect(html).toContain('打开 PDE 决策评估与行动排序。');
    expect(html).toContain('commercial-shell-empty');
  });

  it.each([
    ['sales.workspace', '/sales', 'sales-workspace'],
    ['team.operations', '/team', 'team'],
    ['methodology.g64111', '/g64111', 'g64111'],
    ['decision.pde', '/pde', 'pde'],
  ])('renders standalone %s as an independently usable capability surface', (entitlement, path, surface) => {
    const html = renderShell(path, [entitlement]);
    expect(html).toContain(`data-capability-surface="${surface}"`);
    expect(html).not.toContain('当前版本未启用复杂销售工作台');
  });
});
