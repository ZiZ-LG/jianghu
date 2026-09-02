import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RELATIONSHIP_RADAR_RULE_VERSION,
  type AgentJobCard,
  type AgentRunView,
  type RelationshipRadarResponse,
  type RelationshipRadarSnapshotPayload,
} from '@jianghu/domain-contracts';
import { RelationshipRadarPanelView, type RelationshipRadarPanelViewProps } from './RelationshipRadarPanel';

const generatedAtUtc = '2026-09-01T08:00:00.000Z';
const expiresAtUtc = '2026-09-02T08:00:00.000Z';
const matterRef = { entityKind: 'matter', entityId: 'matter-1', version: 3, scheduleVersion: null };
const dimensions = [
  'interaction_freshness', 'single_threaded_contact', 'role_coverage',
  'visible_warm_paths', 'evidence_freshness', 'next_step_completeness',
] as const;

const response: RelationshipRadarResponse = {
  status: 'ready', customerId: 'customer-1', matterId: 'matter-1',
  snapshot: {
    id: 'rrs_test', generatedAtUtc, expiresAtUtc,
    ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION, version: 1, sourceState: 'current',
  },
  projection: {
    customerId: 'customer-1', matterId: 'matter-1', generatedAtUtc, expiresAtUtc,
    ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION,
    signals: dimensions.map((dimension, index) => ({
      id: `rrsig_test_${dimension}`, dimension,
      status: index === 5 ? 'gap' as const : 'healthy' as const,
      severity: index === 5 ? 'medium' as const : 'info' as const,
      reasonCode: `${dimension}.${index === 5 ? 'gap' : 'healthy'}`,
      explanation: '只读取当前可见的正式 CRM 元数据。',
      sourceRefs: [matterRef], observedAtUtc: generatedAtUtc,
      ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION, expiresAtUtc,
      suggestedAction: index === 5
        ? { kind: 'create_commitment', label: '补充下一步', commandType: 'CREATE_COMMITMENT' as const }
        : { kind: 'view_relationship_source', label: '查看依据', commandType: null },
    })) as RelationshipRadarSnapshotPayload['signals'],
    interventions: [],
    drafts: [{
      id: 'rrdraft_test_next', state: 'uncommitted', actionType: 'CREATE_COMMITMENT',
      customerId: 'customer-1', matterId: 'matter-1',
      target: {
        entityKind: 'matter', entityId: 'matter-1', customerId: 'customer-1',
        matterId: 'matter-1', commitmentId: null, version: 3, scheduleVersion: null,
      },
      sourceRefs: [matterRef], prefill: { title: '补充下一步' },
      reasonCode: 'next_step_completeness.gap', explanation: '当前事项没有计划中的正式下一步。',
      observedAtUtc: generatedAtUtc, ruleVersion: RELATIONSHIP_RADAR_RULE_VERSION, expiresAtUtc,
    }],
  },
};

const card: AgentJobCard = {
  jobKey: 'relationship_radar', jobVersion: 'saas-212.v1',
  purpose: 'Generate explainable relationship signals, interventions, and uncommitted action drafts.',
  triggers: ['manual', 'schedule'],
  scopeManifest: {
    customer: 'required', matter: 'required', sourceArtifact: 'optional',
    allowedSourceKinds: ['transcript', 'note', 'external_reference'],
    allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
  },
  actionMode: 'draft',
  evidencePolicy: { required: false, minimumRefs: 0, maximumRefs: 0, requireSourceFingerprint: true },
  outputRefKinds: ['relationship_signal', 'intervention_item', 'draft_action'],
  modelRef: 'deterministic-relationship-rules-v1', connectorRefs: [],
  budget: { maxInputRefs: 100, maxEvidenceRefs: 0, maxOutputRefs: 100, maxCostUnits: 500 },
  timeoutMs: 30_000, maxAttempts: 2,
  available: true, enabled: true, controlState: 'valid', controlVersion: 1,
  limits: { maxCostUnits: 500, timeoutMs: 30_000, maxAttempts: 2 },
};

const run: AgentRunView = {
  id: 'run-radar-1', jobKey: 'relationship_radar', jobVersion: 'saas-212.v1',
  actionMode: 'draft', trigger: 'manual', status: 'succeeded',
  customerId: 'customer-1', matterId: 'matter-1', sourceArtifactId: null,
  actorId: 'user-1', attemptCount: 1, maxAttempts: 2,
  budgetLimit: 500, costUsed: 6, timeoutMs: 30_000,
  authorizationFingerprint: 'a'.repeat(64),
  modelRef: 'deterministic-relationship-rules-v1', connectorRefs: [],
  inputRefs: [
    { kind: 'customer', id: 'customer-1', version: 4 },
    { kind: 'matter', id: 'matter-1', version: 3 },
  ], evidenceRefs: [], outputRefs: [], failureCode: '',
  createdAt: generatedAtUtc, startedAt: generatedAtUtc,
  completedAt: '2026-09-01T08:00:01.000Z', version: 1,
};

function props(overrides: Partial<RelationshipRadarPanelViewProps> = {}): RelationshipRadarPanelViewProps {
  return {
    state: { status: 'ready', response, card, runs: [run] }, actorRole: 'owner', readonly: false,
    busy: false, notice: '', error: '', source: null,
    draftOpen: false, draftTitle: '补充下一步', draftScheduledAt: '2026-09-02T09:00',
    onReload: () => undefined, onToggleControl: () => undefined, onRun: () => undefined,
    onOpenSource: () => undefined, onOpenDraft: () => undefined, onCloseDraft: () => undefined,
    onDraftTitle: () => undefined, onDraftScheduledAt: () => undefined, onSubmitDraft: () => undefined,
    ...overrides,
  };
}

describe('SAAS-212 relationship radar panel', () => {
  it('renders exactly six dimensions without an aggregate score and keeps the draft closed', () => {
    const html = renderToStaticMarkup(createElement(RelationshipRadarPanelView, props()));
    expect((html.match(/data-radar-dimension=/g) ?? [])).toHaveLength(6);
    expect(html).toContain('互动新鲜度');
    expect(html).toContain('下一步完整性');
    expect(html).toContain('无汇总分');
    expect(html).not.toContain('data-radar-score');
    expect(html).not.toContain('关系总分');
    expect(html).toContain('打开下一步草稿');
    expect(html).not.toContain('提交为正式下一步');
    expect(html).toContain('最近运行');
    expect(html).toContain('成功');
  });

  it('shows the draft editor only after an explicit open state', () => {
    const html = renderToStaticMarkup(createElement(RelationshipRadarPanelView, props({ draftOpen: true })));
    expect(html).toContain('提交为正式下一步');
    expect(html).toContain('type="datetime-local"');
  });

  it('keeps viewer projection read-only with no control, run, or draft action', () => {
    const html = renderToStaticMarkup(createElement(
      RelationshipRadarPanelView,
      props({ actorRole: 'viewer', readonly: true }),
    ));
    expect(html).not.toContain('停用雷达任务');
    expect(html).not.toContain('重新生成');
    expect(html).not.toContain('打开下一步草稿');
    expect((html.match(/data-radar-dimension=/g) ?? [])).toHaveLength(6);
  });
});
