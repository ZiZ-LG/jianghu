import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CrmRelationshipGraph } from './CrmRelationshipGraph';
import { RELATIONSHIP_WORKSPACE_FIXTURE as workspace } from '../testFixtures/relationshipWorkspace';

describe('SAAS-208 CRM relationship graph', () => {
  it('visibly separates solid formal, dashed question candidates and dotted hypotheses', () => {
    const html = renderToStaticMarkup(createElement(CrmRelationshipGraph, {
      people: workspace.people,
      formalRelations: workspace.formalRelations,
      candidateRelations: workspace.candidateRelations,
      hypotheses: workspace.hypotheses,
      showCandidates: true,
      showHypotheses: true,
      focusPersonId: workspace.focus?.personId ?? null,
      title: '关系工作台图',
    }));
    expect(html).toContain('data-relation-layer="formal"');
    expect(html).toContain('data-relation-layer="candidate"');
    expect(html).toContain('data-hypothesis-layer="dotted"');
    expect(html).toContain('data-focus-person="true"');
    expect(html).toContain('?');
    expect(html).toContain('赵经理');
    expect(html).toContain('客户会安排技术评审');
  });

  it('hides overlays independently while preserving formal authority', () => {
    const html = renderToStaticMarkup(createElement(CrmRelationshipGraph, {
      people: workspace.people,
      formalRelations: workspace.formalRelations,
      candidateRelations: workspace.candidateRelations,
      hypotheses: workspace.hypotheses,
      showCandidates: false,
      showHypotheses: false,
      focusPersonId: null,
      title: '关系工作台图',
    }));
    expect(html).toContain('data-relation-layer="formal"');
    expect(html).not.toContain('data-relation-layer="candidate"');
    expect(html).not.toContain('data-hypothesis-layer="dotted"');
  });
});
