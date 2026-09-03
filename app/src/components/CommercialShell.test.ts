import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { CommercialShell } from './CommercialShell';

const EMPTY_CRM_CONTEXT = {
  generatedAtUtc: '2026-08-24T00:00:00Z',
  customers: [],
  matters: [],
  people: [],
  matterParticipants: [],
  relations: [],
};

const renderShell = (pathname: string, enabledEntitlements?: string[], readonly = false) => renderToStaticMarkup(createElement(CommercialShell, {
  access: assembleProductAccess({ edition: 'commercial', ...(enabledEntitlements ? { enabledEntitlements } : {}) }),
  pathname,
  accounts: [],
  crmContextState: { status: 'loading' },
  actorUserId: 'user-cao',
  actorRole: readonly ? 'viewer' : 'owner',
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

  it('wires the Matter list/portfolio selector without adding a navigation entry', () => {
    const freeHtml = renderShell('/matters');
    const html = renderShell('/matters', ['sales.workspace']);
    expect(freeHtml).not.toContain('data-matter-surface-toggle="true"');
    expect(html).toContain('data-matter-surface-toggle="true"');
    expect(html).toContain('>事项列表</button>');
    expect(html).toContain('>注意组合</button>');
    expect(html.match(/data-product-entry=/g)).toHaveLength(5);
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

  it('renders Quick Capture customer choices from the neutral CRM snapshot without legacy state', () => {
    const html = renderToStaticMarkup(createElement(CommercialShell, {
      access: assembleProductAccess({ edition: 'commercial' }),
      pathname: '/quick-capture',
      accounts: [],
      crmContextState: {
        status: 'ready', refreshing: false, refreshError: null,
        snapshot: {
          ...EMPTY_CRM_CONTEXT,
          customers: [{
            id: 'neutral-customer', name: '中性客户档案', categoryKey: null,
            primaryOwnerUserId: 'user-cao', archivedAt: null, version: 0,
          }],
        },
      },
      actorUserId: 'user-cao',
      actorRole: 'owner',
      readonly: false,
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onOpenTeam: () => undefined,
      onQuickCaptureSaved: async () => undefined,
      onLogout: () => undefined,
    }));

    expect(html).toContain('中性客户档案');
    expect(html).not.toContain('复杂销售');
  });

  it('renders Customer pages from the same neutral snapshot used by Quick Capture', () => {
    const context = {
      ...EMPTY_CRM_CONTEXT,
      customers: [{
        id: 'shared-customer', name: '共享上下文客户', categoryKey: null,
        primaryOwnerUserId: 'user-cao', archivedAt: null, version: 0,
      }],
    };
    const html = renderToStaticMarkup(createElement(CommercialShell, {
      access: assembleProductAccess({ edition: 'commercial' }),
      pathname: '/customers',
      accounts: [],
      crmContextState: { status: 'ready', snapshot: context, refreshing: false, refreshError: null },
      actorUserId: 'user-cao',
      actorRole: 'owner',
      readonly: false,
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onOpenTeam: () => undefined,
      onQuickCaptureSaved: async () => undefined,
      onLogout: () => undefined,
    }));

    expect(html).toContain('共享上下文客户');
    expect(html).toContain('data-crm-context-state="ready"');
    expect(html).not.toContain('data-crm-context-state="loading"');
  });

  it('orders pre-meeting, post-meeting, relationship and frozen legacy surfaces while keeping viewer reads', () => {
    const enabled = ['sales.workspace'];
    const owner = renderToStaticMarkup(createElement(CommercialShell, {
      access: assembleProductAccess({ edition: 'commercial', enabledEntitlements: enabled }),
      pathname: '/sales',
      accounts: [],
      crmContextState: {
        status: 'ready', refreshing: false, refreshError: null,
        snapshot: EMPTY_CRM_CONTEXT,
      },
      actorUserId: 'user-cao',
      actorRole: 'owner',
      readonly: false,
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onOpenTeam: () => undefined,
      onQuickCaptureSaved: async () => undefined,
      onLogout: () => undefined,
    }));
    const viewer = renderToStaticMarkup(createElement(CommercialShell, {
      access: assembleProductAccess({ edition: 'commercial', enabledEntitlements: enabled }),
      pathname: '/sales',
      accounts: [],
      crmContextState: {
        status: 'ready', refreshing: false, refreshError: null,
        snapshot: EMPTY_CRM_CONTEXT,
      },
      actorUserId: 'viewer-cao',
      actorRole: 'viewer',
      readonly: true,
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onOpenTeam: () => undefined,
      onQuickCaptureSaved: async () => undefined,
      onLogout: () => undefined,
    }));

    expect(owner).toContain('data-pre-meeting-brief="loading"');
    expect(owner).toContain('data-post-meeting-review="loading"');
    expect(owner).toContain('data-relationship-workspace="idle"');
    expect(owner.indexOf('data-pre-meeting-brief')).toBeLessThan(owner.indexOf('data-post-meeting-review'));
    expect(owner.indexOf('data-post-meeting-review')).toBeLessThan(owner.indexOf('data-relationship-workspace'));
    expect(owner.indexOf('data-relationship-workspace')).toBeLessThan(owner.indexOf('还没有可打开的客户'));
    expect(viewer).toContain('data-pre-meeting-brief="loading"');
    expect(viewer).not.toContain('data-post-meeting-review');
    expect(viewer).toContain('data-relationship-workspace="idle"');
    expect(viewer).toContain('还没有可打开的客户');
  });
});
