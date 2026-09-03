import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MatterPortfolioReadModelSchema,
  type MatterPortfolioAttentionBucket,
  type MatterPortfolioEntry,
  type MatterPortfolioReadModel,
  type TodaySourceView,
} from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import {
  MatterPortfolioPanelStateView,
  matterPortfolioActionPath,
} from './MatterPortfolioPanel';
import { MATTER_PORTFOLIO_FIXTURE } from '../testFixtures/matterPortfolio';

const categories: Array<{
  bucket: Exclude<MatterPortfolioAttentionBucket, 'manual' | 'clear'>;
  providerKey: 'core.today' | 'relationship_radar' | 'matter_portfolio.intelligence' | 'matter_portfolio.hypothesis';
  reasonCode: string;
  title: string;
}> = [
  { bucket: 'urgent', providerKey: 'core.today', reasonCode: 'commitment_due', title: '逾期承诺' },
  { bucket: 'next_step', providerKey: 'core.today', reasonCode: 'matter_without_next_commitment', title: '缺少下一步' },
  { bucket: 'relationship', providerKey: 'relationship_radar', reasonCode: 'relationship.coverage_gap', title: '关系覆盖缺口' },
  { bucket: 'intelligence', providerKey: 'matter_portfolio.intelligence', reasonCode: 'intelligence.stale', title: '信息超过三十天' },
  { bucket: 'hypothesis', providerKey: 'matter_portfolio.hypothesis', reasonCode: 'hypothesis.review_due', title: '关键假设待验证' },
];

function portfolioEntry(index: number): MatterPortfolioEntry {
  const template = MATTER_PORTFOLIO_FIXTURE.entries[0]!;
  const category = categories[index]!;
  const customerId = `customer-${index + 1}`;
  const matterId = `matter-${index + 1}`;
  const version = index + 1;
  const sourceRef = { entityKind: 'matter', entityId: matterId, version, scheduleVersion: null };
  const target = {
    entityKind: 'matter', entityId: matterId, customerId, matterId,
    commitmentId: null, version, scheduleVersion: null,
  };
  const time = category.bucket === 'urgent'
    ? {
        kind: 'instant' as const,
        atUtc: '2026-09-01T06:00:00Z',
        timeZone: 'Asia/Shanghai',
        relation: 'overdue' as const,
        label: '已逾期 1 天',
      }
    : {
        kind: 'observed' as const,
        atUtc: `2026-09-0${index + 1}T06:00:00Z`,
        relation: 'missing' as const,
        label: category.title,
      };
  const suggestedAction = {
    kind: index === 2 ? 'view_relationship_source' : 'create_commitment',
    label: index === 2 ? '打开关系工作台' : '准备下一步',
    commandType: index === 2 ? null : 'CREATE_COMMITMENT' as const,
  };
  const item = {
    ...template.attentionItems[0]!,
    id: `portfolio-item-${index + 1}`,
    providerKey: category.providerKey,
    title: category.title,
    context: { customerName: `客户${index + 1}`, matterName: `事项${index + 1}` },
    reasonCode: category.reasonCode,
    explanation: `${category.title}，需要现在处理。`,
    sourceRefs: [sourceRef],
    observedAtUtc: `2026-09-0${index + 1}T06:00:00Z`,
    ruleVersion: `${category.providerKey}.v1`,
    time,
    suggestedAction,
    target,
  };
  const sales = index === 1;
  return {
    customer: {
      ...template.customer,
      id: customerId,
      name: `客户${index + 1}`,
      version,
    },
    matter: {
      ...template.matter,
      id: matterId,
      customerId,
      title: `事项${index + 1}`,
      kind: sales ? 'sales_opportunity' : 'general',
      version,
    },
    methodologyStage: sales ? {
      ...template.methodologyStage!,
      customerId,
      matterId,
    } : null,
    salesEstimate: sales ? template.salesEstimate : null,
    attentionBucket: category.bucket,
    attentionItems: [item],
    actionDraft: {
      state: 'uncommitted',
      sourceItemId: item.id,
      providerKey: item.providerKey,
      target,
      sourceRefs: [sourceRef],
      suggestedAction,
      observedAtUtc: item.observedAtUtc,
      ruleVersion: item.ruleVersion,
    },
  };
}

const PORTFOLIO = MatterPortfolioReadModelSchema.parse({
  generatedAtUtc: '2026-09-02T06:00:00Z',
  ruleVersion: 'saas-209.matter-portfolio.v1',
  entries: categories.map((_, index) => portfolioEntry(index)),
}) as MatterPortfolioReadModel;

const SOURCE: TodaySourceView = {
  sourceRef: PORTFOLIO.entries[0]!.attentionItems[0]!.sourceRefs[0]!,
  customerId: PORTFOLIO.entries[0]!.customer.id,
  matterId: PORTFOLIO.entries[0]!.matter.id,
  label: '当前事项',
  detail: '正式事项版本 1',
};

const renderView = (
  state: Parameters<typeof MatterPortfolioPanelStateView>[0]['state'],
  readonly = false,
  sourceState: Parameters<typeof MatterPortfolioPanelStateView>[0]['sourceState'] = { status: 'idle' },
) => renderToStaticMarkup(createElement(MatterPortfolioPanelStateView, {
  state,
  sourceState,
  readonly,
  onRetry: () => undefined,
  onOpenSource: () => undefined,
  onOpenAction: () => undefined,
  onCloseSource: () => undefined,
}));

describe('SAAS-209 Matter portfolio panel', () => {
  it('renders a five-Matter categorical portfolio with why-now, exact source, stage and sales-only inputs', () => {
    const html = renderView({ status: 'ready', model: PORTFOLIO, refreshing: false, refreshError: null });

    expect(html).toContain('data-matter-portfolio="ready"');
    expect(html).toContain('5 个可见进行中事项');
    for (const label of ['立即处理', '补齐下一步', '关系缺口', '信息陈旧', '假设待验证']) {
      expect(html).toContain(label);
    }
    expect(html.indexOf('立即处理')).toBeLessThan(html.indexOf('补齐下一步'));
    expect(html.indexOf('补齐下一步')).toBeLessThan(html.indexOf('关系缺口'));
    expect(html).toContain('为什么现在');
    expect(html).toContain('正式来源');
    expect(html).toContain('matter · matter-1 · v1');
    expect(html).toContain('core.today.v1');
    expect(html).toContain('dateTime="2026-09-01T06:00:00Z"');
    expect(html).toContain('未配置');
    expect(html.match(/class="matter-portfolio-sales"/g)).toHaveLength(1);
    expect(html).toContain('未提交行动草稿');
    expect(html).toContain('data-matter-portfolio-action="true"');
  });

  it('keeps source drill explicit and hides draft action controls from a viewer', () => {
    const html = renderView(
      { status: 'ready', model: PORTFOLIO, refreshing: false, refreshError: null },
      true,
      { status: 'ready', source: SOURCE },
    );
    expect(html).toContain('data-matter-portfolio-source="matter"');
    expect(html).toContain('正式事项版本 1');
    expect(html).toContain('只读视图不提供草稿操作');
    expect(html).not.toContain('data-matter-portfolio-action="true"');
  });

  it('shows a bounded repair state instead of fabricated sales estimate values', () => {
    const model = MatterPortfolioReadModelSchema.parse({
      ...PORTFOLIO,
      entries: PORTFOLIO.entries.map((entry) => (
        entry.matter.kind === 'sales_opportunity'
          ? {
              ...entry,
              salesEstimate: {
                kind: 'sales_estimate_unavailable',
                reason: 'invalid_stored_values',
              },
            }
          : entry
      )),
    });
    const html = renderView({ status: 'ready', model, refreshing: false, refreshError: null });

    expect(html).toContain('销售估算数据需修复');
    expect(html).not.toContain('预期金额 undefined');
    expect(html).not.toContain('主观胜率 undefined');
  });

  it('renders loading, error, empty, retained refresh-error and source-error states', () => {
    expect(renderView({ status: 'loading' })).toContain('data-matter-portfolio="loading"');
    expect(renderView({ status: 'error', message: '事项组合加载失败' })).toContain('事项组合加载失败');
    expect(renderView({
      status: 'ready',
      model: { ...PORTFOLIO, entries: [] },
      refreshing: false,
      refreshError: null,
    })).toContain('当前没有可见的进行中事项');
    expect(renderView({
      status: 'ready', model: PORTFOLIO, refreshing: false, refreshError: '刷新失败，已保留上次数据',
    }, false, { status: 'error', message: '来源已变化' })).toContain('来源已变化');
  });

  it('maps an explicit draft click only to existing non-writing destinations', () => {
    expect(matterPortfolioActionPath(PORTFOLIO.entries[1]!.actionDraft!.suggestedAction)).toBe('/quick-capture');
    expect(matterPortfolioActionPath(PORTFOLIO.entries[2]!.actionDraft!.suggestedAction)).toBe('/sales');
  });
});
