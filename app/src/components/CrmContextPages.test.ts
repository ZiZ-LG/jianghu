import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CrmContextSnapshotSchema, type CrmContextSnapshot } from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import * as CrmContextComponents from './CrmContextPages';

type CrmContextViewComponent = (props: {
  mode: 'customers' | 'matters';
  snapshot: CrmContextSnapshot;
  onQuickCapture: () => void;
  initialCustomerId?: string;
  initialMatterId?: string;
}) => ReturnType<typeof createElement>;

type CrmContextPanelStateViewComponent = (props: {
  mode: 'customers' | 'matters';
  state:
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; snapshot: CrmContextSnapshot; refreshing: boolean; refreshError: string | null };
  onRetry: () => void;
  onQuickCapture: () => void;
}) => ReturnType<typeof createElement>;

type CrmContextPanelComponent = (props: {
  mode: 'customers' | 'matters';
  state: Parameters<CrmContextPanelStateViewComponent>[0]['state'];
  onRetry: () => void;
  onQuickCapture: () => void;
}) => ReturnType<typeof createElement>;

const SNAPSHOT = CrmContextSnapshotSchema.parse({
  generatedAtUtc: '2026-08-23T23:50:00Z',
  customers: [{
    id: 'customer-1', name: '远山制造', categoryKey: 'strategic_partner',
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
  }, {
    id: 'customer-2', name: '海川研究院', categoryKey: null,
    primaryOwnerUserId: null, archivedAt: null, version: 0,
  }],
  matters: [{
    id: 'matter-general', customerId: 'customer-1', title: '联合研究', kind: 'general',
    lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
  }, {
    id: 'matter-sales', customerId: 'customer-1', title: '设备采购', kind: 'sales_opportunity',
    lifecycleStatus: 'paused', outcomeKey: null, priority: 'important', targetDate: '2026-10-01',
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
  }, {
    id: 'matter-unknown', customerId: 'customer-2', title: '生态共建', kind: 'ecosystem_cocreation',
    lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
    primaryOwnerUserId: null, archivedAt: null, version: 0,
  }],
  people: [{
    id: 'person-1', customerId: 'customer-1', name: '李总', title: '负责人', archivedAt: null, version: 0,
  }, {
    id: 'person-2', customerId: 'customer-1', name: '王经理', title: null, archivedAt: null, version: 0,
  }, {
    id: 'person-3', customerId: 'customer-1', name: '陈顾问', title: '顾问', archivedAt: null, version: 0,
  }, {
    id: 'person-4', customerId: 'customer-2', name: '赵老师', title: null, archivedAt: null, version: 0,
  }],
  matterParticipants: [{
    id: 'participant-1', customerId: 'customer-1', matterId: 'matter-general', personId: 'person-1',
  }],
  relations: [{
    id: 'relation-base', customerId: 'customer-1', matterId: null,
    sourcePersonId: 'person-1', targetPersonId: 'person-2', kind: 'reports_to',
    label: '汇报', directed: true, version: 0,
  }, {
    id: 'relation-general', customerId: 'customer-1', matterId: 'matter-general',
    sourcePersonId: 'person-2', targetPersonId: 'person-3', kind: 'trusted_advisor',
    label: null, directed: false, version: 0,
  }, {
    id: 'relation-sales', customerId: 'customer-1', matterId: 'matter-sales',
    sourcePersonId: 'person-1', targetPersonId: 'person-3', kind: 'unknown_open_relation',
    label: null, directed: false, version: 0,
  }],
});

function view() {
  const component = Reflect.get(CrmContextComponents, 'CrmContextView') as CrmContextViewComponent | undefined;
  expect(component, 'CrmContextView must be exported').toBeDefined();
  return component!;
}

describe('SAAS-105 generic CRM context pages', () => {
  it('renders a neutral Customer list and Customer detail without Matter relations leaking into the Customer graph', () => {
    const CustomerView = view();
    const listHtml = renderToStaticMarkup(createElement(CustomerView, {
      mode: 'customers', snapshot: SNAPSHOT, onQuickCapture: () => undefined,
    }));
    expect(listHtml).toContain('data-crm-context-page="customers"');
    expect(listHtml).toContain('远山制造');
    expect(listHtml).toContain('海川研究院');
    expect(listHtml).toContain('2 个事项');

    const detailHtml = renderToStaticMarkup(createElement(CustomerView, {
      mode: 'customers', snapshot: SNAPSHOT, initialCustomerId: 'customer-1',
      onQuickCapture: () => undefined,
    }));
    expect(detailHtml).toContain('data-customer-detail="customer-1"');
    expect(detailHtml).toContain('战略合作');
    expect(detailHtml).toContain('联合研究');
    expect(detailHtml).toContain('设备采购');
    expect(detailHtml).toContain('李总');
    expect(detailHtml).toContain('王经理');
    expect(detailHtml).toContain('汇报关系');
    expect(detailHtml).not.toContain('信任顾问');
    expect(detailHtml).toContain('data-crm-quick-capture="customer"');
  });

  it('renders general, sales-opportunity, and unknown Matter kinds together', () => {
    const MatterView = view();
    const html = renderToStaticMarkup(createElement(MatterView, {
      mode: 'matters', snapshot: SNAPSHOT, onQuickCapture: () => undefined,
    }));
    expect(html).toContain('data-crm-context-page="matters"');
    expect(html).toContain('联合研究');
    expect(html).toContain('通用事项');
    expect(html).toContain('设备采购');
    expect(html).toContain('销售事项');
    expect(html).toContain('生态共建');
    expect(html).toContain('自定义事项 · ecosystem_cocreation');
  });

  it('renders a Matter detail with base and Matter relations, open-kind fallback, and no proprietary methodology wording', () => {
    const MatterView = view();
    const html = renderToStaticMarkup(createElement(MatterView, {
      mode: 'matters', snapshot: SNAPSHOT, initialMatterId: 'matter-sales',
      onQuickCapture: () => undefined,
    }));
    expect(html).toContain('data-matter-detail="matter-sales"');
    expect(html).toContain('远山制造');
    expect(html).toContain('销售事项');
    expect(html).toContain('已暂停');
    expect(html).toContain('客户关系');
    expect(html).toContain('事项关系');
    expect(html).toContain('自定义关系 · unknown_open_relation');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="关系清单"');
    expect(html).toContain('data-crm-quick-capture="matter"');
    for (const forbidden of ['G64111', '趋赢力', 'ADURC', '拍板人', '主D', 'L1', 'L2', 'L3', 'L4', 'pipelineStage', 'engageStage']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('keeps detail and Quick Capture available when there are no relations', () => {
    const MatterView = view();
    const html = renderToStaticMarkup(createElement(MatterView, {
      mode: 'matters', snapshot: { ...SNAPSHOT, relations: [] }, initialMatterId: 'matter-general',
      onQuickCapture: () => undefined,
    }));
    expect(html).toContain('联合研究');
    expect(html).toContain('暂时没有可展示的关系');
    expect(html).toContain('data-relation-context="empty"');
    expect(html).toContain('data-crm-quick-capture="relation-empty"');
  });

  it('renders loading, recoverable error, and retained-data refresh failure states', () => {
    const StateView = Reflect.get(CrmContextComponents, 'CrmContextPanelStateView') as CrmContextPanelStateViewComponent | undefined;
    expect(StateView, 'CrmContextPanelStateView must be exported').toBeDefined();

    const loadingHtml = renderToStaticMarkup(createElement(StateView!, {
      mode: 'customers', state: { status: 'loading' },
      onRetry: () => undefined, onQuickCapture: () => undefined,
    }));
    expect(loadingHtml).toContain('data-crm-context-state="loading"');

    const errorHtml = renderToStaticMarkup(createElement(StateView!, {
      mode: 'customers', state: { status: 'error', message: '上下文暂时不可用' },
      onRetry: () => undefined, onQuickCapture: () => undefined,
    }));
    expect(errorHtml).toContain('data-crm-context-state="error"');
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain('重新加载');

    const retainedHtml = renderToStaticMarkup(createElement(StateView!, {
      mode: 'customers',
      state: { status: 'ready', snapshot: SNAPSHOT, refreshing: false, refreshError: '刷新失败，已保留上次数据' },
      onRetry: () => undefined, onQuickCapture: () => undefined,
    }));
    expect(retainedHtml).toContain('data-crm-context-state="ready"');
    expect(retainedHtml).toContain('刷新失败，已保留上次数据');
    expect(retainedHtml).toContain('远山制造');
    expect(retainedHtml).toContain('再次刷新');
  });

  it('preserves the shared owner refresh error and retry action through CrmContextPanel', () => {
    const Panel = Reflect.get(CrmContextComponents, 'CrmContextPanel') as CrmContextPanelComponent | undefined;
    expect(Panel, 'CrmContextPanel must be exported').toBeDefined();
    const html = renderToStaticMarkup(createElement(Panel!, {
      mode: 'customers',
      state: { status: 'ready', snapshot: SNAPSHOT, refreshing: false, refreshError: '共享刷新失败' },
      onRetry: () => undefined,
      onQuickCapture: () => undefined,
    }));
    expect(html).toContain('共享刷新失败');
    expect(html).toContain('再次刷新');
    expect(html).toContain('远山制造');
  });
});
