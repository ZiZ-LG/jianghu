import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Account } from '../types';
import { NewOpportunityDialog } from './NewOpportunityDialog';

const account: Account = {
  id: 'account-role-labels',
  name: '虚构能源客户',
  customerType: 1,
  profile: {},
  persons: [],
  baseEdges: [],
  opportunities: [],
};

describe('NewOpportunityDialog ADURC labels', () => {
  it('renders C as 教练 and R as 影响者·技术把关 without legacy TB', () => {
    const html = renderToStaticMarkup(
      createElement(NewOpportunityDialog, { account, onClose: () => {}, onCreate: () => {} }),
    );

    expect(html).toContain('C</span>信息化业务骨干');
    expect(html).toContain('教练');
    expect(html).toContain('影响者·技术把关');
    expect(html).not.toContain('TB');
    expect(html).not.toContain('影响者/教练');
  });

  it('keeps an unclassified customer on a blank canvas without falling back to the type-1 skeleton', () => {
    const unclassifiedAccount: Account = {
      ...account,
      id: 'account-unclassified',
      customerType: null,
    };

    const html = renderToStaticMarkup(
      createElement(NewOpportunityDialog, { account: unclassifiedAccount, onClose: () => {}, onCreate: () => {} }),
    );

    expect(html).toContain('未设置销售分类');
    expect(html).toContain('请先选择销售分类后再使用典型决策链');
    expect(html).not.toContain('C</span>信息化业务骨干');
    expect(html).not.toContain('央企发电集团（五大六小）');
  });
});
