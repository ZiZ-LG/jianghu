import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RelationshipWorkspacePanelView } from './RelationshipWorkspacePanel';
import { RELATIONSHIP_WORKSPACE_FIXTURE as workspace } from '../testFixtures/relationshipWorkspace';

const callbacks = {
  onReload: () => undefined,
  onCreateVerification: () => undefined,
  onComplete: () => undefined,
  onRecordResult: () => undefined,
  onReview: () => undefined,
};

describe('SAAS-208 relationship workspace panel', () => {
  it('shows source/time/confidence, Focus, falsification and ready human review actions', () => {
    const html = renderToStaticMarkup(createElement(RelationshipWorkspacePanelView, {
      state: { status: 'ready', workspace }, readonly: false,
      showCandidates: true, showHypotheses: true,
      onToggleCandidates: () => undefined, onToggleHypotheses: () => undefined,
      ...callbacks,
    }));
    for (const expected of [
      '报告信息', '人工会后记录', '80%', '推动安排技术评审',
      '明确拒绝评审', '客户已同意安排评审', '保留假设', '修订假设', '退休假设',
    ]) expect(html).toContain(expected);
    expect(html).toContain('data-relationship-workspace="ready"');
    expect(html).not.toContain('pipelineStage');
    expect(html).not.toContain('G64111');
    expect(html).not.toContain('ADURC');
  });

  it('keeps the authorized projection read-only for viewer', () => {
    const html = renderToStaticMarkup(createElement(RelationshipWorkspacePanelView, {
      state: { status: 'ready', workspace }, readonly: true,
      showCandidates: false, showHypotheses: true,
      onToggleCandidates: () => undefined, onToggleHypotheses: () => undefined,
      ...callbacks,
    }));
    expect(html).toContain('客户会安排技术评审');
    expect(html).not.toContain('保留假设');
    expect(html).not.toContain('修订假设');
    expect(html).not.toContain('退休假设');
    expect(html).not.toContain('data-relation-layer="candidate"');
  });

  it('renders bounded loading, error and empty-selection states', () => {
    expect(renderToStaticMarkup(createElement(RelationshipWorkspacePanelView, {
      state: { status: 'loading' }, readonly: false,
      showCandidates: true, showHypotheses: true,
      onToggleCandidates: () => undefined, onToggleHypotheses: () => undefined,
      ...callbacks,
    }))).toContain('data-relationship-workspace="loading"');
    expect(renderToStaticMarkup(createElement(RelationshipWorkspacePanelView, {
      state: { status: 'error', message: '加载失败' }, readonly: false,
      showCandidates: true, showHypotheses: true,
      onToggleCandidates: () => undefined, onToggleHypotheses: () => undefined,
      ...callbacks,
    }))).toContain('加载失败');
    expect(renderToStaticMarkup(createElement(RelationshipWorkspacePanelView, {
      state: { status: 'idle' }, readonly: false,
      showCandidates: true, showHypotheses: true,
      onToggleCandidates: () => undefined, onToggleHypotheses: () => undefined,
      ...callbacks,
    }))).toContain('选择事项');
  });
});
