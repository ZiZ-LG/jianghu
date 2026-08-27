import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CuratedSummary } from './CuratedSummary';

describe('SAAS-205 CuratedSummary compatibility input', () => {
  it('is collapsed and labeled non-authoritative without an AI regenerate control', () => {
    const html = renderToStaticMarkup(createElement(CuratedSummary, {
      entityKind: 'account', entityId: 'customer-205', readonly: false,
    }));
    expect(html).toContain('<details');
    expect(html).toContain('兼容资料输入');
    expect(html).toContain('非拜访简报权威');
    expect(html).not.toContain('重新梳理');
    expect(html).not.toContain('AI 整理 · 待核');
  });
});
