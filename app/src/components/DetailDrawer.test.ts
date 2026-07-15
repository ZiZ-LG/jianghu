import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OppRole, Person } from '../types';
import { DetailDrawer } from './DetailDrawer';

const person: Person = {
  id: 'historical-a', name: '虚构批准人', title: '虚构岗位', orgLevel: 1,
  form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
  logs: [], x: 0, y: 0,
};

describe('DetailDrawer P4 cleanup', () => {
  it('allows a historical A/D P4 checkbox to be unchecked while blocking a new illegal selection', () => {
    const render = (oppRole: OppRole) => renderToStaticMarkup(createElement(DetailDrawer, {
      accId: 'account', oppId: 'opportunity', person, oppRole, bis: [], ucvs: [],
      dispatch: () => {}, onClose: () => {},
    }));
    const checked = render({ personId: person.id, role: 'A', sentiment: 'star', confidence: '明确', isKeyInfluencer: true })
      .match(/<input type="checkbox"[^>]*>/)?.[0];
    const unchecked = render({ personId: person.id, role: 'D', sentiment: 'star', confidence: '明确', isKeyInfluencer: false })
      .match(/<input type="checkbox"[^>]*>/)?.[0];

    expect(checked).toContain('checked=""');
    expect(checked).not.toContain('disabled=""');
    expect(unchecked).toContain('disabled=""');
  });
});
