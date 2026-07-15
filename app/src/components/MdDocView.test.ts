import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { seedAccount } from '../data/seed';
import type { Account } from '../types';
import { MdDocView } from './MdDocView';

describe('MdDocView C5 legacy aliases', () => {
  it('renders legacy true values as their canonical checked rows', () => {
    const account = structuredClone(seedAccount) as Account;
    account.opportunities[0].c5Items = {
      '竞标方家数': true,
      '甲方代表': true,
      '招标代理': true,
    } as Account['opportunities'][number]['c5Items'];

    const html = renderToStaticMarkup(createElement(MdDocView, {
      account, sel: { kind: 'opp', id: account.opportunities[0].id }, dispatch: () => {}, readonly: true,
    }));

    expect(html).toContain('<th>竞标方名单/家数</th><td><span>✓ 已掌握</span>');
    expect(html).toContain('<th>甲方项目代表</th><td><span>✓ 已掌握</span>');
    expect(html).toContain('<th>招标代理机构</th><td><span>✓ 已掌握</span>');
  });
});
