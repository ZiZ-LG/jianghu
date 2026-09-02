import {
  PostMeetingJobCardsResponseSchema,
  PostMeetingReviewBatchDetailSchema,
  PostMeetingReviewReceiptSchema,
  PostMeetingReviewRequestSchema,
  PostMeetingRunListResponseSchema,
  PostMeetingSourceOptionSchema,
  type PostMeetingReviewBatchDetail,
  type PostMeetingReviewReceipt,
  type PostMeetingReviewRequest,
  type PostMeetingSourceOption,
} from '@jianghu/domain-contracts';

type ReviewItem = PostMeetingReviewBatchDetail['items'][number];
type ReviewDecision = PostMeetingReviewRequest['decisions'][number];
type ReviewConflict = Extract<PostMeetingReviewReceipt, { code: 'review_batch_conflict' }>;

type PersonEdit = NonNullable<Extract<ReviewDecision, { kind: 'person' }>['edit']>;
type RelationEdit = NonNullable<Extract<ReviewDecision, { kind: 'relation' }>['edit']>;
type FieldEdit = NonNullable<Extract<ReviewDecision, { kind: 'field' }>['edit']>;
type EvidenceEdit = NonNullable<Extract<ReviewDecision, { kind: 'evidence' }>['edit']>;
type CommitmentEdit = NonNullable<Extract<ReviewDecision, { kind: 'commitment' }>['edit']>;

interface DraftCommon {
  selected: boolean;
  decision: 'accept' | 'reject';
  conflictReason: string | null;
}

export type PostMeetingDraftItem =
  | (DraftCommon & { kind: 'person'; edit: PersonEdit })
  | (DraftCommon & { kind: 'relation'; edit: RelationEdit })
  | (DraftCommon & { kind: 'field'; edit: FieldEdit })
  | (DraftCommon & { kind: 'evidence'; edit: EvidenceEdit })
  | (DraftCommon & { kind: 'commitment'; edit: CommitmentEdit });

export interface PostMeetingDraft {
  batchId: string;
  items: Record<string, PostMeetingDraftItem>;
}

export type PostMeetingDraftPatch = Partial<
  Pick<PostMeetingDraftItem, 'selected' | 'decision' | 'edit'>
>;

export interface StablePostMeetingSubmission {
  idempotencyKey: string;
  canonicalRequest: string;
  request: PostMeetingReviewRequest;
}

const SOURCE_VIEW_KEYS = new Set([
  'id', 'accountId', 'matterId', 'personId', 'backingKind', 'artifactKind', 'source',
  'externalRef', 'title', 'occurredAt', 'fingerprintKind', 'sourceFingerprint',
  'retentionState', 'retentionUpdatedAt', 'createdByUserId', 'visibility', 'aclVersion',
  'createdAt', 'updatedAt', 'backingPresent', 'contentAvailable', 'canDegrade',
  'canDelete', 'explanation',
]);

function invalidResponse(message: string): never {
  throw new Error(`invalid_post_meeting_response:${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse(label);
  return value as Record<string, unknown>;
}

function initialDraftItem(item: ReviewItem): PostMeetingDraftItem {
  const common: DraftCommon = {
    selected: false,
    decision: 'accept',
    conflictReason: null,
  };
  if (item.kind === 'person') {
    return { kind: 'person', ...common, edit: { ...item.after } };
  }
  if (item.kind === 'relation') {
    return {
      kind: 'relation', ...common,
      edit: { layer: item.after.layer, label: item.after.label },
    };
  }
  if (item.kind === 'field') {
    return { kind: 'field', ...common, edit: { value: item.after } };
  }
  if (item.kind === 'evidence') {
    return {
      kind: 'evidence', ...common,
      edit: { direction: item.after.direction, tier: item.after.tier },
    };
  }
  return { kind: 'commitment', ...common, edit: { command: item.after } };
}

export function parsePostMeetingJobCards(raw: unknown) {
  const parsed = PostMeetingJobCardsResponseSchema.safeParse(raw);
  if (!parsed.success) invalidResponse('job_cards');
  return parsed.data;
}

export function parsePostMeetingRuns(raw: unknown) {
  const parsed = PostMeetingRunListResponseSchema.safeParse(raw);
  if (!parsed.success) invalidResponse('runs');
  return parsed.data;
}

export function parsePostMeetingReviewDetail(
  raw: unknown,
  expectedBatchId: string,
): PostMeetingReviewBatchDetail {
  const parsed = PostMeetingReviewBatchDetailSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== expectedBatchId) invalidResponse('review_detail');
  return parsed.data;
}

export function parsePostMeetingReviewReceipt(raw: unknown): PostMeetingReviewReceipt {
  const parsed = PostMeetingReviewReceiptSchema.safeParse(raw);
  if (!parsed.success) invalidResponse('review_receipt');
  return parsed.data;
}

export function postMeetingReviewNotice(input: {
  status: 'pending' | 'accepted' | 'rejected';
  itemCount: number;
}): string {
  const outcome = input.status === 'pending'
    ? '本批次仍有待审项'
    : input.status === 'accepted' ? '本批次已完成采纳' : '本批次已全部驳回';
  return `已处理 ${input.itemCount} 项，${outcome}。`;
}

export function parsePostMeetingSourceOptions(
  raw: unknown,
  anchor: { customerId: string; matterId: string | null },
): PostMeetingSourceOption[] {
  const envelope = record(raw, 'source_envelope');
  if (Object.keys(envelope).some((key) => key !== 'items' && key !== 'nextCursor')
    || !Array.isArray(envelope.items)
    || envelope.items.length > 100
    || !(envelope.nextCursor === null || typeof envelope.nextCursor === 'string')) {
    invalidResponse('source_envelope');
  }
  const options: PostMeetingSourceOption[] = [];
  for (const [index, value] of envelope.items.entries()) {
    const source = record(value, `source_${index}`);
    if (Object.keys(source).some((key) => !SOURCE_VIEW_KEYS.has(key))) {
      invalidResponse(`source_${index}_unknown_field`);
    }
    if (typeof source.id !== 'string'
      || source.accountId !== anchor.customerId
      || source.matterId !== anchor.matterId
      || typeof source.artifactKind !== 'string'
      || typeof source.title !== 'string'
      || typeof source.sourceFingerprint !== 'string'
      || !Number.isSafeInteger(source.aclVersion)
      || typeof source.retentionState !== 'string'
      || typeof source.contentAvailable !== 'boolean'
      || typeof source.backingPresent !== 'boolean'
      || !(source.occurredAt === null || typeof source.occurredAt === 'string')) {
      invalidResponse(`source_${index}_shape`);
    }
    if (!['transcript', 'uploaded_file', 'note'].includes(source.artifactKind)
      || source.retentionState !== 'available'
      || source.contentAvailable !== true
      || source.backingPresent !== true) continue;
    const kind = source.artifactKind as 'transcript' | 'uploaded_file' | 'note';
    const fallbackTitle = kind === 'transcript'
      ? '会议转写' : kind === 'uploaded_file' ? '上传文件' : '会后记录';
    const parsed = PostMeetingSourceOptionSchema.safeParse({
      id: source.id,
      customerId: anchor.customerId,
      matterId: anchor.matterId,
      title: source.title.trim() || fallbackTitle,
      kind,
      fingerprint: source.sourceFingerprint,
      aclVersion: source.aclVersion,
      version: source.aclVersion,
      occurredAt: source.occurredAt,
    });
    if (!parsed.success) invalidResponse(`source_${index}_contract`);
    options.push(parsed.data);
  }
  return options;
}

export function createPostMeetingDraft(detail: PostMeetingReviewBatchDetail): PostMeetingDraft {
  return {
    batchId: detail.id,
    items: Object.fromEntries(detail.items.map((item) => [item.itemRef, initialDraftItem(item)])),
  };
}

export function patchPostMeetingDraftItem(
  draft: PostMeetingDraft,
  itemRef: string,
  patch: PostMeetingDraftPatch,
): PostMeetingDraft {
  const current = draft.items[itemRef];
  if (!current) throw new Error('post_meeting_draft_item_not_found');
  return {
    ...draft,
    items: {
      ...draft.items,
      [itemRef]: { ...current, ...patch, conflictReason: null } as PostMeetingDraftItem,
    },
  };
}

function decisionFor(
  item: ReviewItem,
  draft: PostMeetingDraftItem,
): unknown {
  const common = {
    candidateId: item.candidateId,
    expectedVersion: item.expectedVersion,
    expectedAclVersion: item.expectedAclVersion,
    decision: draft.decision,
  };
  if (draft.decision === 'reject') {
    return { kind: item.kind, ...common };
  }
  if (item.kind !== draft.kind) throw new Error('post_meeting_draft_kind_mismatch');
  return { kind: item.kind, ...common, edit: draft.edit };
}

export function buildPostMeetingReviewRequest(input: {
  detail: PostMeetingReviewBatchDetail;
  draft: PostMeetingDraft;
  activityKind: string;
  occurredAt: string;
  existingInteractionId?: string | null;
}): PostMeetingReviewRequest {
  if (input.draft.batchId !== input.detail.id) throw new Error('post_meeting_draft_batch_mismatch');
  const decisions = input.detail.items.flatMap((item) => {
    const draft = input.draft.items[item.itemRef];
    if (item.status !== 'pending' || !draft?.selected) return [];
    return [decisionFor(item, draft)];
  });
  return PostMeetingReviewRequestSchema.parse({
    expectedVersion: input.detail.version,
    expectedAcceptanceVersion: input.detail.acceptanceVersion,
    customerId: input.detail.customerId,
    matterId: input.detail.matterId,
    activityKind: input.activityKind,
    occurredAt: input.occurredAt,
    existingInteractionId: input.existingInteractionId ?? input.detail.interactionId,
    decisions,
  });
}

export function rebasePostMeetingDraft(
  previous: PostMeetingDraft,
  refreshed: PostMeetingReviewBatchDetail,
  conflict?: ReviewConflict | null,
): PostMeetingDraft {
  const next = createPostMeetingDraft(refreshed);
  const previousItemRefByCandidate = new Map(
    refreshed.items.map((item) => [item.candidateId, item.itemRef]),
  );
  const conflictByItemRef = new Map((conflict?.items ?? []).flatMap((item) => {
    const itemRef = previousItemRefByCandidate.get(item.candidateId);
    return itemRef ? [[itemRef, item.reason] as const] : [];
  }));
  for (const item of refreshed.items) {
    if (item.status !== 'pending') continue;
    const old = previous.items[item.itemRef];
    if (!old || old.kind !== item.kind) continue;
    next.items[item.itemRef] = {
      ...old,
      conflictReason: conflictByItemRef.get(item.itemRef) ?? null,
    } as PostMeetingDraftItem;
  }
  return next;
}

export function stablePostMeetingSubmission(
  request: PostMeetingReviewRequest,
  previous: StablePostMeetingSubmission | null,
  createKey: () => string = () => crypto.randomUUID(),
): StablePostMeetingSubmission {
  const parsed = PostMeetingReviewRequestSchema.parse(request);
  const canonicalRequest = JSON.stringify(parsed);
  if (previous?.canonicalRequest === canonicalRequest) return previous;
  return { idempotencyKey: createKey(), canonicalRequest, request: parsed };
}
