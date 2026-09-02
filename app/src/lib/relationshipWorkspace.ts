import {
  RelationshipWorkspaceResponseSchema,
  ReviewHypothesisVerificationReceiptSchema,
  SalesHypothesisCommandReceiptSchema,
  type IntelligenceItemView,
  type RelationshipVerificationReadiness,
  type RelationshipWorkspaceResponse,
  type ReviewHypothesisVerificationCommand,
  type ReviewHypothesisVerificationReceipt,
  type SalesHypothesisCommand,
  type SalesHypothesisCommandReceipt,
} from '@jianghu/domain-contracts';

export function parseRelationshipWorkspace(
  raw: unknown,
  expectedCustomerId: string,
  expectedMatterId: string,
): RelationshipWorkspaceResponse {
  const parsed = RelationshipWorkspaceResponseSchema.parse(raw);
  if (parsed.customer.id !== expectedCustomerId || parsed.matter.id !== expectedMatterId) {
    throw new Error('relationship workspace parent mismatch');
  }
  return parsed;
}

function ageLabel(value: string | null, now: Date): string {
  if (!value) return '时间未知';
  const elapsedMs = Math.max(0, now.getTime() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function relationshipFreshnessLabel(
  item: Pick<IntelligenceItemView, 'occurredAt' | 'learnedAt'>,
  now = new Date(),
): string {
  return `${ageLabel(item.occurredAt, now)}发生 · ${ageLabel(item.learnedAt, now)}得知`;
}

const readinessLabels: Record<RelationshipVerificationReadiness, string> = {
  planned: '执行中',
  awaiting_result_or_evidence: '待结果或已批准证据',
  ready_for_review: '可人工复核',
  reviewed: '已复核',
  superseded_revision: '已被新修订取代',
};

export function verificationReadinessLabel(value: RelationshipVerificationReadiness): string {
  return readinessLabels[value];
}

const reviewDisposition = {
  keep: 'kept',
  revise: 'revised',
  retire: 'retired',
} as const;

export function parseHypothesisVerificationReviewReceipt(
  raw: unknown,
  command: ReviewHypothesisVerificationCommand,
): ReviewHypothesisVerificationReceipt {
  const receipt = ReviewHypothesisVerificationReceiptSchema.parse(raw);
  const expectedCurrentRevisionId = command.disposition === 'revise'
    ? command.revision.id
    : command.expectedCurrentRevisionId;
  if (receipt.type !== command.type
    || receipt.customerId !== command.customerId
    || receipt.matterId !== command.matterId
    || receipt.commitmentId !== command.commitmentId
    || receipt.salesHypothesisId !== command.salesHypothesisId
    || receipt.previousRevisionId !== command.expectedCurrentRevisionId
    || receipt.currentRevisionId !== expectedCurrentRevisionId
    || receipt.disposition !== reviewDisposition[command.disposition]
    || receipt.commitmentVersion !== command.expectedCommitmentVersion + 1
    || receipt.hypothesisVersion !== command.expectedHypothesisVersion + 1) {
    throw new Error('hypothesis verification review receipt mismatch');
  }
  return receipt;
}

export function parseSalesHypothesisCommandReceipt(
  raw: unknown,
  command: SalesHypothesisCommand,
): SalesHypothesisCommandReceipt {
  const receipt = SalesHypothesisCommandReceiptSchema.parse(raw);
  const hypothesisId = command.type === 'CREATE_SALES_HYPOTHESIS'
    ? command.hypothesis.id
    : command.type === 'LINK_HYPOTHESIS_EVIDENCE'
      ? command.link.salesHypothesisId
      : command.salesHypothesisId;
  if (receipt.type !== command.type || receipt.salesHypothesisId !== hypothesisId) {
    throw new Error('sales hypothesis receipt mismatch');
  }
  if (command.type === 'LINK_HYPOTHESIS_EVIDENCE'
    && (receipt.evidenceLinkId !== command.link.id
      || receipt.verificationCommitmentId !== command.link.verificationCommitmentId
      || receipt.currentRevisionId !== command.link.expectedCurrentRevisionId
      || receipt.version !== command.link.expectedVersion + 1)) {
    throw new Error('sales hypothesis evidence receipt mismatch');
  }
  return receipt;
}
