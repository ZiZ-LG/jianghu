import { describe, expect, it } from 'vitest';
import {
  AgentJobCardSchema,
  AgentRunViewSchema,
  PostMeetingReviewBatchDetailSchema,
  type PostMeetingReviewRequest,
} from '@jianghu/domain-contracts';
import {
  buildPostMeetingReviewRequest,
  createPostMeetingDraft,
  parsePostMeetingJobCards,
  parsePostMeetingReviewDetail,
  parsePostMeetingReviewReceipt,
  postMeetingReviewNotice,
  parsePostMeetingRuns,
  parsePostMeetingSourceOptions,
  patchPostMeetingDraftItem,
  rebasePostMeetingDraft,
  stablePostMeetingSubmission,
} from './postMeetingReview';

const JOB = AgentJobCardSchema.parse({
  jobKey: 'post_meeting_extract',
  jobVersion: 'core-206.v1',
  purpose: '从会后资料中提取待人审候选',
  triggers: ['manual'],
  scopeManifest: {
    customer: 'required', matter: 'required', sourceArtifact: 'required',
    allowedSourceKinds: ['transcript', 'uploaded_file', 'note'],
    allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
  },
  actionMode: 'candidate',
  evidencePolicy: { required: true, minimumRefs: 1, maximumRefs: 20, requireSourceFingerprint: true },
  outputRefKinds: ['review_batch'],
  modelRef: 'tenant_byo_model',
  connectorRefs: [],
  budget: { maxInputRefs: 3, maxEvidenceRefs: 20, maxOutputRefs: 1, maxCostUnits: 2_000 },
  timeoutMs: 45_000,
  maxAttempts: 2,
  available: true,
  enabled: true,
  controlState: 'valid',
  controlVersion: 1,
  limits: { maxCostUnits: 2_000, timeoutMs: 45_000, maxAttempts: 2 },
});

const RUN = AgentRunViewSchema.parse({
  id: 'agent_run_1',
  jobKey: 'post_meeting_extract',
  jobVersion: 'core-206.v1',
  actionMode: 'candidate',
  trigger: 'manual',
  status: 'succeeded',
  customerId: 'customer-1',
  matterId: 'matter-1',
  sourceArtifactId: 'source-1',
  actorId: 'user-1',
  attemptCount: 1,
  maxAttempts: 2,
  budgetLimit: 2_000,
  costUsed: 5,
  timeoutMs: 45_000,
  authorizationFingerprint: 'a'.repeat(64),
  modelRef: 'tenant_byo_model',
  connectorRefs: [],
  inputRefs: [
    { kind: 'customer', id: 'customer-1', version: 2 },
    { kind: 'matter', id: 'matter-1', version: 3 },
    { kind: 'source_artifact', id: 'source-1', version: 4 },
  ],
  evidenceRefs: [{
    sourceArtifactId: 'source-1', locatorId: 'item-001:chars:0-4',
    sourceFingerprint: 'b'.repeat(64), observedAt: '2026-08-25T18:00:00.000Z',
  }],
  outputRefs: [{ kind: 'review_batch', id: 'review-batch-1', version: 0 }],
  failureCode: '',
  createdAt: '2026-08-25T18:00:00.000Z',
  startedAt: '2026-08-25T18:00:00.000Z',
  completedAt: '2026-08-25T18:00:01.000Z',
  version: 1,
});

const DETAIL = PostMeetingReviewBatchDetailSchema.parse({
  id: 'review-batch-1',
  source: {
    id: 'source-1', title: '客户会谈', kind: 'note', fingerprint: 'b'.repeat(64),
    occurredAt: '2026-08-25T18:00:00.000Z',
  },
  customerId: 'customer-1',
  matterId: 'matter-1',
  status: 'pending',
  activityKind: null,
  occurredAt: null,
  interactionId: null,
  acceptanceVersion: 0,
  version: 0,
  createdAt: '2026-08-25T18:00:01.000Z',
  updatedAt: '2026-08-25T18:00:01.000Z',
  items: [
    {
      kind: 'person', candidateId: 'candidate-person', status: 'pending', itemRef: 'item-001',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-001:chars:0-4',
      sourceQuote: '李经理负责', confidence: 0.9, defaultSelected: false, before: null,
      after: { name: '李经理', title: '技术负责人' },
    },
    {
      kind: 'relation', candidateId: 'candidate-relation', status: 'pending', itemRef: 'item-002',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-002:chars:5-10',
      sourceQuote: '王总授权李经理', confidence: 0.8, defaultSelected: false, before: null,
      after: {
        sourcePerson: { kind: 'existing_person', personId: 'person-wang' },
        targetPerson: { kind: 'new_person', itemRef: 'item-001' },
        layer: 'L2', label: '授权',
      },
    },
    {
      kind: 'field', candidateId: 'candidate-field', status: 'pending', itemRef: 'item-003',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-003:chars:11-15',
      sourceQuote: '优先级 high', confidence: 0.85, defaultSelected: false,
      target: { kind: 'matter', field: 'priority' }, before: 'normal', after: 'high',
    },
    {
      kind: 'evidence', candidateId: 'candidate-evidence', status: 'pending', itemRef: 'item-004',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-004:chars:16-20',
      sourceQuote: '李经理支持', confidence: 0.75, defaultSelected: false, before: null,
      after: {
        person: { kind: 'new_person', itemRef: 'item-001' }, signalKey: 'technical_owner',
        direction: 1, tier: 'strong', occurredAt: '2026-08-25T18:00:00.000Z',
      },
    },
    {
      kind: 'commitment', candidateId: 'candidate-commitment', status: 'pending', itemRef: 'item-005',
      expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-005:chars:21-25',
      sourceQuote: '周五发方案', confidence: 0.95, defaultSelected: false, before: null,
      after: {
        type: 'CREATE_COMMITMENT',
        commitment: {
          id: 'commit_00000000000000000000000000000001', customerId: 'customer-1', matterId: 'matter-1',
          personId: null, title: '周五发方案', kind: 'follow_up', ownerUserId: 'user-1',
          confirmationStatus: 'not_required', scheduledAtUtc: '2026-08-28T02:00:00.000Z',
          dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
          confirmationDueAtUtc: null, source: 'review_batch_candidate',
          sourceRef: 'candidate:candidate-commitment',
        },
      },
    },
  ],
});

describe('SAAS-202 post-meeting transport parsing', () => {
  it('parses bounded Job/Run/Detail/Receipt envelopes and rejects leaked or malformed fields', () => {
    expect(parsePostMeetingJobCards({ items: [JOB] })).toEqual({ items: [JOB] });
    expect(() => parsePostMeetingJobCards({ items: [JOB], prompt: 'private' })).toThrow();
    expect(parsePostMeetingRuns({ items: [RUN], nextCursor: null })).toEqual({ items: [RUN], nextCursor: null });
    expect(() => parsePostMeetingRuns({ items: [{ ...RUN, rawResponse: 'private' }], nextCursor: null })).toThrow();
    expect(parsePostMeetingReviewDetail(DETAIL, DETAIL.id)).toEqual(DETAIL);
    expect(() => parsePostMeetingReviewDetail({ ...DETAIL, payload: {} }, DETAIL.id)).toThrow();
    expect(parsePostMeetingReviewReceipt({
      batchId: DETAIL.id, status: 'accepted', interactionId: 'interaction-1', version: 1,
      acceptanceVersion: 1, items: [{
        candidateId: 'candidate-person', decision: 'accept', status: 'accepted',
        formalKind: 'person', formalId: 'person-1',
      }], businessReplayed: false, replayed: false,
    })).toMatchObject({ batchId: DETAIL.id, status: 'accepted' });
  });

  it('maps only exact mounted available local sources and rejects hidden body fields', () => {
    const source = {
      id: 'source-1', accountId: 'customer-1', matterId: 'matter-1', personId: null,
      backingKind: 'note', artifactKind: 'note', source: 'manual', externalRef: null,
      title: '', occurredAt: '2026-08-25T18:00:00.000Z', fingerprintKind: 'content_sha256_v1',
      sourceFingerprint: 'b'.repeat(64), retentionState: 'available',
      retentionUpdatedAt: '2026-08-25T18:00:00.000Z', createdByUserId: 'user-1',
      visibility: 'private', aclVersion: 4, createdAt: '2026-08-25T18:00:00.000Z',
      updatedAt: '2026-08-25T18:00:00.000Z', backingPresent: true, contentAvailable: true,
      canDegrade: false, canDelete: true, explanation: 'local_body_available',
    };
    expect(parsePostMeetingSourceOptions({ items: [source], nextCursor: null }, {
      customerId: 'customer-1', matterId: 'matter-1',
    })).toEqual([{ id: 'source-1', customerId: 'customer-1', matterId: 'matter-1', title: '会后记录',
      kind: 'note', fingerprint: 'b'.repeat(64), aclVersion: 4, version: 4,
      occurredAt: '2026-08-25T18:00:00.000Z' }]);
    expect(parsePostMeetingSourceOptions({ items: [{
      ...source, id: 'external-1', artifactKind: 'external_reference', backingKind: 'external_reference',
      retentionState: 'reference_only', contentAvailable: false, backingPresent: false,
    }], nextCursor: null }, { customerId: 'customer-1', matterId: 'matter-1' })).toEqual([]);
    expect(() => parsePostMeetingSourceOptions({
      items: [{ ...source, content: 'PRIVATE_BODY' }], nextCursor: null,
    }, { customerId: 'customer-1', matterId: 'matter-1' })).toThrow();
    expect(() => parsePostMeetingSourceOptions({
      items: [{ ...source, matterId: 'other-matter' }], nextCursor: null,
    }, { customerId: 'customer-1', matterId: 'matter-1' })).toThrow();
  });
});

describe('SAAS-202 post-meeting review draft state', () => {
  it('describes an incremental review as pending instead of rejected', () => {
    expect(postMeetingReviewNotice({ status: 'pending', itemCount: 1 }))
      .toBe('已处理 1 项，本批次仍有待审项。');
    expect(postMeetingReviewNotice({ status: 'accepted', itemCount: 2 }))
      .toBe('已处理 2 项，本批次已完成采纳。');
    expect(postMeetingReviewNotice({ status: 'rejected', itemCount: 3 }))
      .toBe('已处理 3 项，本批次已全部驳回。');
  });

  it('defaults every pending item unselected and builds only explicit typed decisions', () => {
    let draft = createPostMeetingDraft(DETAIL);
    expect(Object.values(draft.items).every((item) => item.selected === false)).toBe(true);
    expect(draft.items['item-001']).toMatchObject({ kind: 'person', selected: false });
    expect(draft.items['item-002']).toMatchObject({ kind: 'relation', selected: false });

    draft = patchPostMeetingDraftItem(draft, 'item-001', {
      selected: true, edit: { name: '李经理', title: '技术总监' },
    });
    draft = patchPostMeetingDraftItem(draft, 'item-003', {
      selected: true, edit: { value: 'urgent' },
    });
    draft = patchPostMeetingDraftItem(draft, 'item-004', {
      selected: true, decision: 'reject',
    });
    const request = buildPostMeetingReviewRequest({
      detail: DETAIL, draft, activityKind: 'customer_meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
    });
    expect(request.decisions).toEqual([
      expect.objectContaining({ kind: 'person', candidateId: 'candidate-person', decision: 'accept', edit: { name: '李经理', title: '技术总监' } }),
      expect.objectContaining({ kind: 'field', candidateId: 'candidate-field', decision: 'accept', edit: { value: 'urgent' } }),
      expect.not.objectContaining({ edit: expect.anything() }),
    ]);
    expect(request.decisions[2]).toMatchObject({ kind: 'evidence', decision: 'reject' });
  });

  it('retains matching drafts across a conflict refresh but never auto-selects terminal or new items', () => {
    let draft = patchPostMeetingDraftItem(createPostMeetingDraft(DETAIL), 'item-001', {
      selected: true, edit: { name: '李经理', title: '保留的编辑' },
    });
    draft = patchPostMeetingDraftItem(draft, 'item-003', { selected: true });
    const refreshed = PostMeetingReviewBatchDetailSchema.parse({
      ...DETAIL,
      version: 1,
      items: [
        { ...DETAIL.items[0], expectedVersion: 2 },
        { ...DETAIL.items[1], status: 'accepted', expectedVersion: 2 },
        ...DETAIL.items.slice(2),
        {
          ...DETAIL.items[2], candidateId: 'candidate-new', itemRef: 'item-006',
          sourceLocator: 'item-006:chars:26-30', sourceQuote: '新候选',
        },
      ],
    });
    const rebased = rebasePostMeetingDraft(draft, refreshed, {
      code: 'review_batch_conflict',
      items: [{ candidateId: 'candidate-person', status: 'conflict', reason: 'candidate_version_conflict' }],
    });
    expect(rebased.items['item-001']).toMatchObject({
      selected: true, edit: { name: '李经理', title: '保留的编辑' },
      conflictReason: 'candidate_version_conflict',
    });
    expect(rebased.items['item-002']?.selected).toBe(false);
    expect(rebased.items['item-006']?.selected).toBe(false);
  });

  it('reuses one key only for the exact same request and rotates after edits or version refresh', () => {
    const request = buildPostMeetingReviewRequest({
      detail: DETAIL,
      draft: patchPostMeetingDraftItem(createPostMeetingDraft(DETAIL), 'item-003', { selected: true }),
      activityKind: 'customer_meeting', occurredAt: '2026-08-25T18:00:00.000Z',
    });
    const keys = ['key-1', 'key-2', 'key-3'];
    const createKey = () => keys.shift()!;
    const first = stablePostMeetingSubmission(request, null, createKey);
    const replay = stablePostMeetingSubmission(request, first, createKey);
    const edited: PostMeetingReviewRequest = {
      ...request,
      decisions: request.decisions.map((decision) => decision.kind === 'field'
        ? { ...decision, edit: { value: 'critical' } }
        : decision),
    };
    const changed = stablePostMeetingSubmission(edited, replay, createKey);
    expect(first.idempotencyKey).toBe('key-1');
    expect(replay.idempotencyKey).toBe('key-1');
    expect(changed.idempotencyKey).toBe('key-2');
  });
});
