import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const customerId = 'customer-1';
const matterId = 'matter-1';
const sourceArtifactId = 'source-artifact-1';

const evidence = {
  sourceLocator: 'segment-4',
  sourceQuote: '王总明确表示由李经理负责技术评估。',
  confidence: 0.86,
};

const commitmentCommand = {
  type: 'CREATE_COMMITMENT',
  commitment: {
    id: 'commit_00112233445566778899aabbccddeeff',
    customerId,
    matterId,
    personId: null,
    title: '周五前发送技术方案',
    kind: 'follow_up',
    ownerUserId: 'user-1',
    confirmationStatus: 'not_required',
    scheduledAtUtc: '2026-08-28T02:00:00.000Z',
    dueAtUtc: null,
    timeZone: 'Asia/Shanghai',
    isAllDay: false,
    localDate: null,
    confirmationDueAtUtc: null,
    source: 'review_batch_candidate',
    sourceRef: 'candidate:candidate-commitment-1',
  },
};

const candidateBatch = {
  customerId,
  matterId,
  sourceArtifactId,
  items: [
    {
      kind: 'person',
      itemRef: 'person-li',
      ...evidence,
      person: { name: '李经理', title: '技术负责人' },
    },
    {
      kind: 'relation',
      itemRef: 'relation-wang-li',
      ...evidence,
      sourcePerson: { kind: 'existing_person', personId: 'person-wang' },
      targetPerson: { kind: 'new_person', itemRef: 'person-li' },
      layer: 'L2',
      label: '业务授权',
    },
    {
      kind: 'field',
      itemRef: 'field-priority',
      ...evidence,
      target: { kind: 'matter', field: 'priority' },
      proposedValue: 'high',
    },
    {
      kind: 'evidence',
      itemRef: 'evidence-li',
      ...evidence,
      person: { kind: 'new_person', itemRef: 'person-li' },
      signalKey: 'technical_owner',
      direction: 1,
      tier: 'strong',
      occurredAt: '2026-08-25T18:00:00.000Z',
    },
    {
      kind: 'commitment',
      itemRef: 'commitment-plan',
      ...evidence,
      command: commitmentCommand,
    },
  ],
};

describe('SAAS-202 post-meeting candidate contracts', () => {
  it('exports one strict batch contract for exactly five evidence-backed candidate kinds', () => {
    const batchSchema = schema('PostMeetingCandidateBatchSchema');
    expect(batchSchema, 'PostMeetingCandidateBatchSchema must be exported').toBeDefined();
    expect(batchSchema!.safeParse(candidateBatch).success).toBe(true);

    for (const item of candidateBatch.items) {
      const isolated = item.kind === 'relation'
        ? { ...item, targetPerson: { kind: 'existing_person', personId: 'person-li' } }
        : item.kind === 'evidence'
          ? { ...item, person: { kind: 'existing_person', personId: 'person-li' } }
          : item;
      expect(batchSchema!.safeParse({ ...candidateBatch, items: [isolated] }).success).toBe(true);
    }
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{ ...candidateBatch.items[0], kind: 'forecast' }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{ ...candidateBatch.items[0], sourceQuote: '' }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{ ...candidateBatch.items[0], confidence: 1.01 }],
    }).success).toBe(false);
  });

  it('caps a batch at 20 unique items and resolves new-person endpoints inside that batch', () => {
    const batchSchema = schema('PostMeetingCandidateBatchSchema');
    expect(batchSchema).toBeDefined();
    const repeated = Array.from({ length: 20 }, (_, index) => ({
      ...candidateBatch.items[0],
      itemRef: `person-${index}`,
      person: { name: `Person ${index}`, title: null },
    }));
    expect(batchSchema!.safeParse({ ...candidateBatch, items: repeated }).success).toBe(true);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [...repeated, { ...repeated[0], itemRef: 'person-20' }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [repeated[0], { ...repeated[1], itemRef: repeated[0]!.itemRef }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{
        ...candidateBatch.items[1],
        targetPerson: { kind: 'new_person', itemRef: 'missing-person' },
      }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [
        candidateBatch.items[2],
        {
          ...candidateBatch.items[1],
          targetPerson: { kind: 'new_person', itemRef: candidateBatch.items[2]!.itemRef },
        },
      ],
    }).success).toBe(false);
  });

  it('keeps anchors exact and rejects parallel customer type, stage, forecast, key-person, body and arbitrary target fields', () => {
    const batchSchema = schema('PostMeetingCandidateBatchSchema');
    expect(batchSchema).toBeDefined();
    expect(batchSchema!.safeParse({ ...candidateBatch, customerType: 'strategic' }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{
        ...candidateBatch.items[2],
        target: { kind: 'customer', field: 'customerType' },
      }],
    }).success).toBe(false);
    for (const forbidden of ['pipelineStage', 'forecast', 'keyPersonStatus']) {
      expect(batchSchema!.safeParse({
        ...candidateBatch,
        items: [{
          ...candidateBatch.items[2],
          target: { kind: 'matter', field: forbidden },
        }],
      }).success).toBe(false);
    }
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{
        ...candidateBatch.items[2],
        target: { kind: 'matter', field: 'priority', id: 'other-matter' },
      }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      body: 'full private transcript',
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{ ...candidateBatch.items[0], providerResponse: { raw: true } }],
    }).success).toBe(false);
  });

  it('requires Matter-bound kinds and parses Commitment drafts through the formal create command', () => {
    const batchSchema = schema('PostMeetingCandidateBatchSchema');
    expect(batchSchema).toBeDefined();
    for (const item of [candidateBatch.items[1], candidateBatch.items[2], candidateBatch.items[3]]) {
      expect(batchSchema!.safeParse({ ...candidateBatch, matterId: null, items: [item] }).success).toBe(false);
    }
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{
        ...candidateBatch.items[4],
        command: {
          ...commitmentCommand,
          commitment: { ...commitmentCommand.commitment, customerId: 'other-customer' },
        },
      }],
    }).success).toBe(false);
    expect(batchSchema!.safeParse({
      ...candidateBatch,
      items: [{
        ...candidateBatch.items[4],
        command: {
          ...commitmentCommand,
          commitment: {
            ...commitmentCommand.commitment,
            scheduledAtUtc: null,
            dueAtUtc: null,
            localDate: null,
          },
        },
      }],
    }).success).toBe(false);
  });
});

const reviewDetail = {
  id: 'review-batch-1',
  source: {
    id: sourceArtifactId,
    title: '8 月 25 日客户会谈',
    kind: 'transcript',
    fingerprint: 'a'.repeat(64),
    occurredAt: '2026-08-25T18:00:00.000Z',
  },
  customerId,
  matterId,
  status: 'pending',
  activityKind: null,
  occurredAt: null,
  interactionId: null,
  acceptanceVersion: 0,
  version: 0,
  createdAt: '2026-08-25T18:01:00.000Z',
  updatedAt: '2026-08-25T18:01:00.000Z',
  items: [{
    kind: 'person',
    candidateId: 'candidate-person-1',
    status: 'pending',
    itemRef: 'person-li',
    expectedVersion: 1,
    expectedAclVersion: 2,
    sourceLocator: evidence.sourceLocator,
    sourceQuote: evidence.sourceQuote,
    confidence: evidence.confidence,
    defaultSelected: false,
    before: null,
    after: { name: '李经理', title: '技术负责人' },
  }],
};

describe('SAAS-202 post-meeting review transport contracts', () => {
  it('publishes body-free source, Job and Run response boundaries', () => {
    const sourceSchema = schema('PostMeetingSourceOptionSchema');
    const jobsSchema = schema('PostMeetingJobCardsResponseSchema');
    const runsSchema = schema('PostMeetingRunListResponseSchema');
    expect(sourceSchema, 'PostMeetingSourceOptionSchema must be exported').toBeDefined();
    expect(jobsSchema, 'PostMeetingJobCardsResponseSchema must be exported').toBeDefined();
    expect(runsSchema, 'PostMeetingRunListResponseSchema must be exported').toBeDefined();

    const source = {
      id: sourceArtifactId,
      customerId,
      matterId,
      title: '8 月 25 日客户会谈',
      kind: 'transcript',
      fingerprint: 'a'.repeat(64),
      aclVersion: 2,
      version: 1,
      occurredAt: '2026-08-25T18:00:00.000Z',
    };
    expect(sourceSchema!.safeParse(source).success).toBe(true);
    expect(sourceSchema!.safeParse({ ...source, body: 'private transcript' }).success).toBe(false);
    expect(sourceSchema!.safeParse({ ...source, kind: 'external_reference' }).success).toBe(false);
    expect(jobsSchema!.safeParse({ items: [] }).success).toBe(true);
    expect(jobsSchema!.safeParse({ items: [], prompt: 'hidden model prompt' }).success).toBe(false);
    expect(runsSchema!.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(runsSchema!.safeParse({ items: [], nextCursor: null, rawResponse: 'private' }).success).toBe(false);
  });

  it('returns only typed bounded detail and defaults identity candidates unselected', () => {
    const detailSchema = schema('PostMeetingReviewBatchDetailSchema');
    expect(detailSchema, 'PostMeetingReviewBatchDetailSchema must be exported').toBeDefined();
    expect(detailSchema!.safeParse(reviewDetail).success).toBe(true);
    expect(detailSchema!.safeParse({
      ...reviewDetail,
      items: reviewDetail.items.map(({ status: _status, ...item }) => item),
    }).success).toBe(false);
    expect(detailSchema!.safeParse({
      ...reviewDetail,
      items: [{ ...reviewDetail.items[0], defaultSelected: true }],
    }).success).toBe(false);
    expect(detailSchema!.safeParse({
      ...reviewDetail,
      source: { ...reviewDetail.source, ciphertext: 'encrypted-body' },
    }).success).toBe(false);
    expect(detailSchema!.safeParse({
      ...reviewDetail,
      items: [{ ...reviewDetail.items[0], payload: { arbitrary: true } }],
    }).success).toBe(false);
    expect(detailSchema!.safeParse({
      ...reviewDetail,
      items: [{ ...reviewDetail.items[0], sourceQuote: 'x'.repeat(2_001) }],
    }).success).toBe(false);
  });

  it('requires explicit unique decisions and keeps edits typed by candidate kind', () => {
    const requestSchema = schema('PostMeetingReviewRequestSchema');
    expect(requestSchema, 'PostMeetingReviewRequestSchema must be exported').toBeDefined();
    const decision = {
      kind: 'person',
      candidateId: 'candidate-person-1',
      expectedVersion: 1,
      expectedAclVersion: 2,
      decision: 'accept',
      edit: { name: '李经理', title: '技术总监' },
    };
    const request = {
      expectedVersion: 0,
      expectedAcceptanceVersion: 0,
      customerId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      existingInteractionId: null,
      decisions: [decision],
    };
    expect(requestSchema!.safeParse(request).success).toBe(true);
    expect(requestSchema!.safeParse({ ...request, decisions: [] }).success).toBe(false);
    expect(requestSchema!.safeParse({ ...request, decisions: [decision, decision] }).success).toBe(false);
    expect(requestSchema!.safeParse({
      ...request,
      decisions: [{ ...decision, edit: { layer: 'L1' } }],
    }).success).toBe(false);
    expect(requestSchema!.safeParse({
      ...request,
      decisions: [{ ...decision, decision: 'reject', edit: decision.edit }],
    }).success).toBe(false);
  });

  it('publishes deterministic success and conflict receipts without provider or source bodies', () => {
    const receiptSchema = schema('PostMeetingReviewReceiptSchema');
    expect(receiptSchema, 'PostMeetingReviewReceiptSchema must be exported').toBeDefined();
    const receipt = {
      batchId: 'review-batch-1',
      status: 'accepted',
      interactionId: 'interaction-1',
      version: 1,
      acceptanceVersion: 1,
      items: [{
        candidateId: 'candidate-person-1',
        decision: 'accept',
        status: 'accepted',
        formalKind: 'person',
        formalId: 'person-1',
      }],
      businessReplayed: false,
      replayed: false,
    };
    expect(receiptSchema!.safeParse(receipt).success).toBe(true);
    expect(receiptSchema!.safeParse({ ...receipt, rawResponse: 'provider output' }).success).toBe(false);
    expect(receiptSchema!.safeParse({
      code: 'review_batch_conflict',
      items: [{ candidateId: 'candidate-person-1', status: 'conflict', reason: 'candidate_changed' }],
    }).success).toBe(true);
    expect(receiptSchema!.safeParse({
      code: 'review_batch_conflict',
      items: [{ candidateId: 'candidate-person-1', status: 'conflict', reason: 'x'.repeat(121) }],
    }).success).toBe(false);
  });

  it('accepts incremental review receipts while candidates remain pending', () => {
    const receiptSchema = schema('PostMeetingReviewReceiptSchema');
    expect(receiptSchema, 'PostMeetingReviewReceiptSchema must be exported').toBeDefined();
    expect(receiptSchema!.safeParse({
      batchId: 'review-batch-1',
      status: 'pending',
      interactionId: 'interaction-1',
      version: 1,
      acceptanceVersion: 1,
      items: [{
        candidateId: 'candidate-person-1',
        decision: 'accept',
        status: 'accepted',
        formalKind: 'person',
        formalId: 'person-1',
      }],
      businessReplayed: false,
      replayed: false,
    }).success).toBe(true);
    expect(receiptSchema!.safeParse({
      batchId: 'review-batch-1',
      status: 'accepted',
      interactionId: 'interaction-1',
      version: 2,
      acceptanceVersion: 2,
      items: [{
        candidateId: 'candidate-field-1',
        decision: 'reject',
        status: 'rejected',
        formalKind: null,
        formalId: null,
      }],
      businessReplayed: false,
      replayed: false,
    }).success).toBe(true);
  });
});
