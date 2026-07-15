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
});
