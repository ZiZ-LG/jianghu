import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Account } from '../types';
import { QuickCapture } from './QuickCapture';

const account = {
  id: 'legacy-account-1',
  name: '远山制造',
  customerType: null,
  categoryKey: null,
  persons: [{ id: 'person-1', name: '曹经理', title: '负责人' }],
  opportunities: [{ id: 'matter-1', name: '联合方案' }],
  baseEdges: [],
} as unknown as Account;

const render = (readonly = false, accounts: Account[] = [account]) => renderToStaticMarkup(createElement(QuickCapture, {
  accounts,
  actorUserId: 'user-cao',
  readonly,
  onSaved: async () => undefined,
}));

describe('SAAS-102 QuickCapture surface', () => {
  it('renders the three required first-screen inputs, inline Customer creation, and progressive details', () => {
    const html = render();
    expect(html).toContain('data-quick-capture-form="true"');
    expect(html).toContain('客户<span aria-hidden="true"> *</span>');
    expect(html).toContain('下一步<span aria-hidden="true"> *</span>');
    expect(html).toContain('时间<span aria-hidden="true"> *</span>');
    expect(html).toContain('value="__new__"');
    expect(html).toContain('新建客户');
    expect(html).toContain('<details');
    expect(html).toContain('事项、联系人和确认要求（可选）');
    expect(html).toContain('周四 15:00 与客户交流方案');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('生成确认草稿');
    expect(html).not.toContain('data-quick-capture-draft="true"');
  });

  it('starts with inline Customer creation when there are no Customers', () => {
    const html = render(false, []);
    expect(html).toContain('data-customer-mode="new"');
    expect(html).toContain('客户名称<span aria-hidden="true"> *</span>');
    expect(html).toMatch(/data-customer-mode="new"[\s\S]*?<input required=""/);
    expect(html).toContain('还没有客户，保存时会在同一事务内创建客户和下一步。');
  });

  it('renders no write form for viewers', () => {
    const html = render(true);
    expect(html).toContain('当前为只读视图，不能创建正式记录。');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('确认并保存');
  });
});
