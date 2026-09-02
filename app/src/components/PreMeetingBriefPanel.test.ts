import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgentJobCardSchema,
  ResearchBriefSnapshotDetailSchema,
  type CrmContextSnapshot,
} from '@jianghu/domain-contracts';
import { PreMeetingBriefView } from './PreMeetingBriefPanel';

const crmContext: CrmContextSnapshot = {
  generatedAtUtc: '2026-08-27T08:00:00.000Z',
  customers: [{
    id: 'customer-205', name: '海岳能源', categoryKey: 'strategic',
    primaryOwnerUserId: 'owner-205', archivedAt: null, version: 4,
  }],
  matters: [{
    id: 'matter-205', customerId: 'customer-205', title: '储能联合开发',
    kind: 'sales_opportunity', lifecycleStatus: 'active', outcomeKey: null,
    priority: 'high', targetDate: null, primaryOwnerUserId: 'owner-205',
    archivedAt: null, version: 2,
  }],
  people: [], matterParticipants: [], relations: [],
};
const job = AgentJobCardSchema.parse({
  jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1', purpose: 'brief',
  triggers: ['manual'], scopeManifest: {
    customer: 'required', matter: 'optional', sourceArtifact: 'optional',
    allowedSourceKinds: ['note'], allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
  }, actionMode: 'read_only', evidencePolicy: {
    required: true, minimumRefs: 1, maximumRefs: 20, requireSourceFingerprint: true,
  }, outputRefKinds: ['research_brief'], modelRef: 'tenant-byo-ai', connectorRefs: [],
  budget: { maxInputRefs: 50, maxEvidenceRefs: 20, maxOutputRefs: 10, maxCostUnits: 1000 },
  timeoutMs: 30000, maxAttempts: 2, available: true, enabled: true,
  controlState: 'valid', controlVersion: 1,
  limits: { maxCostUnits: 1000, timeoutMs: 30000, maxAttempts: 2 },
});
const detail = ResearchBriefSnapshotDetailSchema.parse({
  id: 'rbs_205', customerId: 'customer-205', matterId: 'matter-205',
  status: 'partial', subjectStatus: 'matched', sourceCount: 2, sectionCount: 1,
  unknownCount: 1, failureCount: 1, version: 1,
  basedOnAt: '2026-08-27T06:00:00.000Z', freshUntil: '2026-08-28T08:00:00.000Z',
  generatedAt: '2026-08-27T08:00:00.000Z', createdAt: '2026-08-27T08:01:00.000Z',
  payload: {
    subject: {
      status: 'matched', query: '海岳能源', crmCustomerId: 'customer-205',
      selected: { legalName: '海岳能源', anchorKind: 'provider_subject_id', anchorValue: 'customer-205', provider: 'jianghu-crm' },
      candidates: [],
    },
    sources: [
      {
        id: 'source-artifact', kind: 'source_artifact', refId: 'source-205', version: 3,
        fingerprint: 'a'.repeat(64), provider: 'jianghu-source-artifact', label: '客户访谈', url: null,
        subjectAnchor: 'crm_customer:customer-205', observedAt: '2026-08-27T06:00:00.000Z',
        retrievedAt: '2026-08-27T08:00:00.000Z', freshUntil: '2026-08-28T08:00:00.000Z',
        status: 'fresh', failureCode: null,
      },
      {
        id: 'curated-ai', kind: 'curated_ai_cache', refId: 'curated-205', version: 1,
        fingerprint: 'b'.repeat(64), provider: 'jianghu-curated',
        label: '兼容资料输入 · 旧 AI 缓存（非权威）', url: null,
        subjectAnchor: 'crm_customer:customer-205', observedAt: '2026-08-26T06:00:00.000Z',
        retrievedAt: '2026-08-27T08:00:00.000Z', freshUntil: '2026-08-28T08:00:00.000Z',
        status: 'stale', failureCode: null,
      },
    ],
    sections: [{
      key: 'questions_to_verify', title: '拜访核验问题', content: '确认预算审批人。',
      sourceIds: ['source-artifact'], asOf: '2026-08-27T08:00:00.000Z',
    }],
    unknowns: [{
      key: 'stakeholders', question: '还需要确认哪些关键干系人及其角色？',
      reasonCode: 'insufficient_evidence', sourceIds: ['source-artifact'],
    }],
    failures: [{ sourceId: 'curated-ai', code: 'compatibility_stale', retryable: false }],
    generator: { version: 'saas-204.v1', modelRef: 'tenant-model', connectorRefs: [] },
  },
});

const baseProps = {
  crmContext,
  actorRole: 'owner' as const,
  readonly: false,
  job,
  sources: [{
    id: 'source-205', customerId: 'customer-205', matterId: 'matter-205', title: '客户访谈',
    kind: 'note' as const, fingerprint: 'a'.repeat(64), aclVersion: 3, version: 3,
    occurredAt: '2026-08-27T06:00:00.000Z',
  }],
  history: [{
    id: 'rbs_205', customerId: 'customer-205', matterId: 'matter-205', status: 'partial' as const,
    subjectStatus: 'matched' as const, sourceCount: 2, sectionCount: 1, unknownCount: 1,
    failureCount: 1, version: 1, basedOnAt: '2026-08-27T06:00:00.000Z',
    freshUntil: '2026-08-28T08:00:00.000Z', generatedAt: '2026-08-27T08:00:00.000Z',
    createdAt: '2026-08-27T08:01:00.000Z',
  }],
  runs: [{ id: 'run-205', status: 'failed' as const, failureCode: 'pre_meeting_model_failed', createdAt: '2026-08-27T07:00:00.000Z' }],
  customerId: 'customer-205', matterId: 'matter-205', sourceId: 'source-205',
  detail, loading: false, busy: false, error: '', notice: '',
  onCustomerChange: () => undefined, onMatterChange: () => undefined,
  onSourceChange: () => undefined, onControl: () => undefined, onRun: () => undefined,
  onOpenBrief: () => undefined,
};

describe('PreMeetingBriefView', () => {
  it('renders the sole authoritative brief with citations, source state, unknowns, failures and history', () => {
    const html = renderToStaticMarkup(createElement(PreMeetingBriefView, baseProps));
    for (const text of [
      '拜访前简报', '唯一权威', '确认预算审批人', '客户访谈',
      '2026', 'fresh', '还需要确认哪些关键干系人', 'insufficient_evidence',
      'compatibility_stale', '兼容资料输入', 'pre_meeting_model_failed',
    ]) expect(html).toContain(text);
    expect(html).not.toContain('payloadEnc');
    expect(html).not.toContain('prompt');
    expect(html).not.toContain('rawModelResponse');
  });

  it('shows owner control, member run-only, and viewer read-only access to an authorized snapshot', () => {
    const owner = renderToStaticMarkup(createElement(PreMeetingBriefView, baseProps));
    const member = renderToStaticMarkup(createElement(PreMeetingBriefView, {
      ...baseProps, actorRole: 'member',
    }));
    const viewer = renderToStaticMarkup(createElement(PreMeetingBriefView, {
      ...baseProps, actorRole: 'viewer', readonly: true,
    }));
    expect(owner).toContain('生成简报');
    expect(owner).toContain('停用任务');
    expect(member).toContain('生成简报');
    expect(member).not.toContain('停用任务');
    expect(viewer).toContain('确认预算审批人');
    expect(viewer).not.toContain('生成简报');
    expect(viewer).not.toContain('停用任务');
  });
});
