import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import {
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  type G64111MethodologyReadModel,
} from '@jianghu/domain-contracts';
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
  methodologyState: { status: 'loading' },
  onNavigate: () => undefined,
  onOpenLegacy: () => undefined,
  onMethodologyAction: async () => undefined,
  onRetryMethodology: () => undefined,
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
      methodologyState: { status: 'loading' },
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onMethodologyAction: async () => undefined,
      onRetryMethodology: () => undefined,
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
      methodologyState: { status: 'loading' },
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onMethodologyAction: async () => undefined,
      onRetryMethodology: () => undefined,
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
      methodologyState: { status: 'ready', snapshot: {
        generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: true,
        installation: null, matters: [],
      } },
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onMethodologyAction: async () => undefined,
      onRetryMethodology: () => undefined,
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
      methodologyState: { status: 'ready', snapshot: {
        generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: false,
        installation: null, matters: [],
      } },
      onNavigate: () => undefined,
      onOpenLegacy: () => undefined,
      onMethodologyAction: async () => undefined,
      onRetryMethodology: () => undefined,
      onOpenTeam: () => undefined,
      onQuickCaptureSaved: async () => undefined,
      onLogout: () => undefined,
    }));

    expect(owner).toContain('data-pre-meeting-brief="loading"');
    expect(owner).toContain('data-post-meeting-review="loading"');
    expect(owner).toContain('data-relationship-workspace="idle"');
    expect(owner.indexOf('data-pre-meeting-brief')).toBeLessThan(owner.indexOf('data-post-meeting-review'));
    expect(owner.indexOf('data-post-meeting-review')).toBeLessThan(owner.indexOf('data-relationship-workspace'));
    expect(owner.indexOf('data-relationship-workspace')).toBeLessThan(owner.indexOf('尚无已启用 G64111 的事项'));
    expect(viewer).toContain('data-pre-meeting-brief="loading"');
    expect(viewer).not.toContain('data-post-meeting-review');
    expect(viewer).toContain('data-relationship-workspace="idle"');
    expect(viewer).toContain('尚无已启用 G64111 的事项');
  });

  it('keeps the complex-sales loop usable with no methodology and exposes no proprietary legacy consumer', () => {
    const noMethodology: G64111MethodologyReadModel = {
      generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: true,
      installation: null,
      matters: [{
        customerId: 'neutral-customer', customerName: '中性客户', matterId: 'neutral-matter',
        matterTitle: '中性事项', matterKind: 'general', matterVersion: 0, activeBinding: null,
      }],
    };
    const html = renderToStaticMarkup(createElement(CommercialShell, {
      access: assembleProductAccess({ edition: 'commercial', enabledEntitlements: ['sales.workspace', 'methodology.g64111'] }),
      pathname: '/sales',
      accounts: [{
        id: 'neutral-customer', name: '中性客户', customerType: 1, persons: [], edges: [],
        opportunities: [{
          id: 'neutral-matter', name: '中性事项', customerType: 1,
          pipelineStage: 'POISON_PIPELINE', engageStage: 'POISON_ENGAGE', roles: [], bis: [], ucvs: [],
          plan: [], milestones: [], visits: [], strategy: { cards: [], risks: [], resources: [] },
        }], visitNotes: [], notes: [],
      }] as any,
      crmContextState: { status: 'ready', snapshot: EMPTY_CRM_CONTEXT, refreshing: false, refreshError: null },
      actorUserId: 'user-cao', actorRole: 'owner', readonly: false,
      methodologyState: { status: 'ready', snapshot: noMethodology },
      onNavigate: () => undefined, onOpenLegacy: () => undefined, onOpenTeam: () => undefined,
      onMethodologyAction: async () => undefined, onRetryMethodology: () => undefined,
      onQuickCaptureSaved: async () => undefined, onLogout: () => undefined,
    }));

    expect(html).toContain('data-pre-meeting-brief="loading"');
    expect(html).toContain('data-post-meeting-review="loading"');
    expect(html).toContain('data-relationship-workspace="idle"');
    expect(html).toContain('尚无已启用 G64111 的事项');
    expect(html).not.toContain('data-legacy-g64111-matter');
    expect(html).not.toContain('POISON_PIPELINE');
    expect(html).not.toContain('POISON_ENGAGE');
    expect(html).not.toContain('趋赢力方法论已就绪');
  });

  it('lists only exact-bound Matters in the frozen legacy entry', () => {
    const bound: G64111MethodologyReadModel = {
      generatedAtUtc: '2026-09-03T12:00:00.000Z', commandsEnabled: true, canManage: true,
      installation: {
        packId: 'pack-g', versionId: 'version-g', packKey: G64111_BUILTIN_PACK_KEY,
        packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
        versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
      },
      matters: [{
        customerId: 'customer-1', customerName: '客户一', matterId: 'matter-bound', matterTitle: '精确绑定事项',
        matterKind: 'general', matterVersion: 2,
        activeBinding: {
          bindingId: 'binding-g', customerId: 'customer-1', matterId: 'matter-bound',
          packId: 'pack-g', versionId: 'version-g', packKey: G64111_BUILTIN_PACK_KEY,
          packName: 'G64111 趋赢力', sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
          versionKey: '1.0.0', engineRef: 'g64111:0.1.0',
        },
      }, {
        customerId: 'customer-1', customerName: '客户一', matterId: 'matter-unbound', matterTitle: '未绑定事项',
        matterKind: 'general', matterVersion: 0, activeBinding: null,
      }],
    };
    const html = renderToStaticMarkup(createElement(CommercialShell, {
      access: assembleProductAccess({ edition: 'commercial', enabledEntitlements: ['sales.workspace', 'methodology.g64111'] }),
      pathname: '/sales', accounts: [], crmContextState: { status: 'loading' },
      actorUserId: 'user-cao', actorRole: 'owner', readonly: false,
      methodologyState: { status: 'ready', snapshot: bound },
      onNavigate: () => undefined, onOpenLegacy: () => undefined, onOpenTeam: () => undefined,
      onMethodologyAction: async () => undefined, onRetryMethodology: () => undefined,
      onQuickCaptureSaved: async () => undefined, onLogout: () => undefined,
    }));
    expect(html).toContain('data-legacy-g64111-matter="matter-bound"');
    expect(html).toContain('精确绑定事项');
    expect(html).not.toContain('未绑定事项');
  });
});
