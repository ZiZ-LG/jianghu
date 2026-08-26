import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgentJobCardSchema,
  CrmContextSnapshotSchema,
  PostMeetingReviewBatchDetailSchema,
} from '@jianghu/domain-contracts';
import { createPostMeetingDraft } from '../lib/postMeetingReview';
import { PostMeetingReviewView } from './PostMeetingReviewPanel';

const context = CrmContextSnapshotSchema.parse({
  generatedAtUtc: '2026-08-25T18:00:00.000Z',
  customers: [{
    id: 'customer-1', name: '海岳能源', categoryKey: 'strategic',
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 2,
  }],
  matters: [{
    id: 'matter-1', customerId: 'customer-1', title: '储能项目', kind: 'sales_opportunity',
    lifecycleStatus: 'active', outcomeKey: null, priority: 'normal', targetDate: null,
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 3,
  }],
  people: [], matterParticipants: [], relations: [],
});

const job = AgentJobCardSchema.parse({
  jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1', purpose: '会后候选提取',
  triggers: ['manual'], scopeManifest: {
    customer: 'required', matter: 'required', sourceArtifact: 'required',
    allowedSourceKinds: ['transcript', 'uploaded_file', 'note'],
    allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
  }, actionMode: 'candidate',
  evidencePolicy: { required: true, minimumRefs: 1, maximumRefs: 20, requireSourceFingerprint: true },
  outputRefKinds: ['review_batch'], modelRef: 'tenant_byo_model', connectorRefs: [],
  budget: { maxInputRefs: 3, maxEvidenceRefs: 20, maxOutputRefs: 1, maxCostUnits: 2_000 },
  timeoutMs: 45_000, maxAttempts: 2, available: true, enabled: true,
  controlState: 'valid', controlVersion: 1,
  limits: { maxCostUnits: 2_000, timeoutMs: 45_000, maxAttempts: 2 },
});

const detail = PostMeetingReviewBatchDetailSchema.parse({
  id: 'review-batch-1', source: {
    id: 'source-1', title: '客户会谈', kind: 'note', fingerprint: 'b'.repeat(64),
    occurredAt: '2026-08-25T18:00:00.000Z',
  }, customerId: 'customer-1', matterId: 'matter-1', status: 'pending', activityKind: null,
  occurredAt: null, interactionId: null, acceptanceVersion: 0, version: 0,
  createdAt: '2026-08-25T18:00:01.000Z', updatedAt: '2026-08-25T18:00:01.000Z',
  items: [
    {
      kind: 'person', candidateId: 'candidate-person', status: 'pending', itemRef: 'item-001',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-001:chars:0-4',
      sourceQuote: '李经理负责技术评估', confidence: 0.9, defaultSelected: false, before: null,
      after: { name: '李经理', title: '技术负责人' },
    },
    {
      kind: 'field', candidateId: 'candidate-field', status: 'pending', itemRef: 'item-002',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-002:chars:5-10',
      sourceQuote: '项目优先级调整为 high', confidence: 0.85, defaultSelected: false,
      target: { kind: 'matter', field: 'priority' }, before: 'normal', after: 'high',
    },
    {
      kind: 'commitment', candidateId: 'candidate-commitment', status: 'pending', itemRef: 'item-003',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-003:chars:11-15',
      sourceQuote: '我们承诺周五前发送方案', confidence: 0.95, defaultSelected: false, before: null,
      after: { type: 'CREATE_COMMITMENT', commitment: {
        id: 'commit_00000000000000000000000000000001', customerId: 'customer-1', matterId: 'matter-1',
        personId: null, title: '周五前发送方案', kind: 'follow_up', ownerUserId: 'user-1',
        confirmationStatus: 'not_required', scheduledAtUtc: '2026-08-28T02:00:00.000Z', dueAtUtc: null,
        timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null, confirmationDueAtUtc: null,
        source: 'review_batch_candidate', sourceRef: 'candidate:candidate-commitment',
      } },
    },
  ],
});

const baseProps = {
  crmContext: context,
  actorRole: 'owner' as const,
  readonly: false,
  job,
  sources: [{
    id: 'source-1', customerId: 'customer-1', matterId: 'matter-1', title: '客户会谈',
    kind: 'note' as const, fingerprint: 'b'.repeat(64), aclVersion: 4, version: 4,
    occurredAt: '2026-08-25T18:00:00.000Z',
  }],
  runs: [{ id: 'run-1', status: 'succeeded' as const, failureCode: '', createdAt: '2026-08-25T18:00:00.000Z', outputBatchId: 'review-batch-1' }],
  customerId: 'customer-1', matterId: 'matter-1', sourceId: 'source-1',
  detail,
  draft: createPostMeetingDraft(detail),
  activityKind: 'customer_meeting',
  occurredAtLocal: '2026-08-26T02:00',
  loading: false, busy: false, error: '', notice: '',
  onCustomerChange: () => undefined,
  onMatterChange: () => undefined,
  onSourceChange: () => undefined,
  onControl: () => undefined,
  onRun: () => undefined,
  onOpenBatch: () => undefined,
  onPatchDraft: () => undefined,
  onActivityKindChange: () => undefined,
  onOccurredAtChange: () => undefined,
  onSubmit: () => undefined,
};

describe('PostMeetingReviewView', () => {
  it('renders the Job/source/run surface plus explicit typed review controls and evidence', () => {
    const html = renderToStaticMarkup(createElement(PostMeetingReviewView, baseProps));
    expect(html).toContain('data-post-meeting-review="ready"');
    expect(html).toContain('会后速审');
    expect(html).toContain('已启用');
    expect(html).toContain('客户会谈');
    expect(html).toContain('data-run-status="succeeded"');
    expect(html).toContain('data-review-kind="person"');
    expect(html).toContain('data-review-kind="field"');
    expect(html).toContain('data-review-kind="commitment"');
    expect(html).toContain('李经理负责技术评估');
    expect(html).toContain('改前');
    expect(html).toContain('normal');
    expect(html).toContain('改后');
    expect(html).toContain('high');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('value="技术负责人"');
    expect(html).toContain('value="周五前发送方案"');
    expect(html).toContain('确认处理所选项');
  });

  it('shows controls only to owner/admin and suppresses the whole write surface for viewer', () => {
    const owner = renderToStaticMarkup(createElement(PostMeetingReviewView, baseProps));
    const member = renderToStaticMarkup(createElement(PostMeetingReviewView, {
      ...baseProps, actorRole: 'member' as const,
    }));
    const viewer = renderToStaticMarkup(createElement(PostMeetingReviewView, {
      ...baseProps, actorRole: 'viewer' as const, readonly: true,
    }));
    expect(owner).toContain('data-job-control="true"');
    expect(member).not.toContain('data-job-control="true"');
    expect(viewer).toBe('');
  });
});
