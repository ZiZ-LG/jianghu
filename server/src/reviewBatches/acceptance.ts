import { randomUUID } from 'node:crypto';
import {
  ActorRoleSchema,
  CreateCommitmentCommandSchema,
  type CapabilityPolicy,
  type CommandContext,
  type CommitmentCommand,
} from '@jianghu/domain-contracts';
import { Prisma } from '@prisma/client';
import { businessYmd } from '../businessDate.js';
import {
  rejectPersonCandidate,
  rejectRelationCandidate,
} from '../candidates/personRelation.js';
import {
  rejectFieldCandidate,
  reviewEvidenceCandidate,
} from '../candidates/reviewItems.js';
import { executeCommitmentCommand } from '../mutation/commitments.js';
import type { PostCommitEffect } from '../mutate.js';
import {
  acceptProposalInTransaction,
  assertProposalAcceptancePreflight,
  rejectProposalInTransaction,
} from '../proposals.js';
import { createPdeSnapshot } from '../pde/routes.js';
import {
  acceptRelationSuggestionInTransaction,
  materializePerson,
} from '../suggest.js';
import {
  commitmentIdForReviewCandidate,
  edgeIdForReviewCandidate,
  interactionIdForReviewBatch,
  personIdForReviewCandidate,
  reviewAcceptanceHash,
  storedReviewBatchReceiptIsValid,
} from './model.js';
import {
  readableReviewBatchById,
  ReviewBatchError,
  type ReviewBatchContext,
} from './service.js';

export interface ReviewDecisionInput {
  candidateId: string;
  expectedVersion: number;
  expectedAclVersion: number;
  decision: 'accept' | 'reject';
  person?: { name?: string; title?: string };
  relation?: { layer?: 'L1' | 'L2' | 'L3' | 'L4'; label?: string };
  newValue?: string;
  evidence?: { direction?: -1 | 0 | 1; tier?: 'weak' | 'mid' | 'strong' };
}

export interface AcceptReviewBatchInput {
  expectedVersion: number;
  expectedAcceptanceVersion: number;
  accountId: string;
  matterId: string | null;
  activityKind: string;
  occurredAt: Date;
  existingInteractionId?: string | null;
  decisions: ReviewDecisionInput[];
}

export interface ReviewBatchItemResult {
  candidateId: string;
  decision: 'accept' | 'reject';
  status: 'accepted' | 'rejected';
  formalKind: string | null;
  formalId: string | null;
}

export interface ReviewBatchAcceptanceReceipt {
  batchId: string;
  status: string;
  interactionId: string | null;
  version: number;
  acceptanceVersion: number;
  items: ReviewBatchItemResult[];
  businessReplayed: boolean;
  effects: PostCommitEffect[];
}

export interface ReviewBatchConflictItem {
  candidateId: string;
  status: 'conflict' | 'not_applied';
  reason: string;
}

export class ReviewBatchConflictError extends Error {
  readonly code = 'review_batch_conflict';
  readonly statusCode = 409;
  readonly items: ReviewBatchConflictItem[];

  constructor(items: ReviewBatchConflictItem[]) {
    super('会后速审项已变化，请刷新后重新确认');
    this.name = 'ReviewBatchConflictError';
    this.items = items;
  }
}

const fullCandidateSelect = {
  id: true,
  tenantId: true,
  kind: true,
  status: true,
  accountId: true,
  matterId: true,
  targetKind: true,
  targetId: true,
  fieldKey: true,
  oldValue: true,
  newValue: true,
  payload: true,
  sourceArtifactId: true,
  reviewBatchId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  dedupeKey: true,
  legacySourceKind: true,
  legacySourceId: true,
  version: true,
} as const;
type FullCandidate = Prisma.CandidateGetPayload<{ select: typeof fullCandidateSelect }>;

const terminalDedupeKey = (candidateId: string) => `terminal-v1:${candidateId}`;

function normalizedRequest(input: AcceptReviewBatchInput) {
  return {
    expectedVersion: input.expectedVersion,
    expectedAcceptanceVersion: input.expectedAcceptanceVersion,
    accountId: input.accountId,
    matterId: input.matterId,
    activityKind: input.activityKind.trim(),
    occurredAt: input.occurredAt.toISOString(),
    existingInteractionId: input.existingInteractionId ?? null,
    decisions: [...input.decisions].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  };
}

function conflictItems(
  decisions: readonly ReviewDecisionInput[],
  conflicts: ReadonlyMap<string, string>,
): ReviewBatchConflictItem[] {
  return decisions.map((decision) => ({
    candidateId: decision.candidateId,
    status: conflicts.has(decision.candidateId) ? 'conflict' : 'not_applied',
    reason: conflicts.get(decision.candidateId) ?? 'selected_set_conflict',
  }));
}

function errorReason(error: unknown): string {
  if (error instanceof ReviewBatchError) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('正式字段已被人工更新')) return 'formal_target_changed';
  if (message.includes('不存在') || message.includes('not found')) return 'target_missing';
  return 'candidate_apply_conflict';
}

async function currentContext(
  tx: Prisma.TransactionClient,
  ctx: ReviewBatchContext,
): Promise<ReviewBatchContext> {
  const actor = await tx.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId }, select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success) throw new ReviewBatchError('review_batch_not_found', 404, true);
  if (role.data === 'viewer') throw new ReviewBatchError('viewer_write_denied', 403);
  return { ...ctx, actorRole: role.data };
}

function legacyIdentity(candidate: FullCandidate, expected: string): string {
  if (candidate.legacySourceKind !== expected || !candidate.legacySourceId) {
    throw new ReviewBatchError('candidate_legacy_authority_invalid');
  }
  return candidate.legacySourceId;
}

async function preflightPerson(tx: Prisma.TransactionClient, candidate: FullCandidate): Promise<void> {
  const id = legacyIdentity(candidate, 'PersonSuggestion');
  const row = await tx.personSuggestion.findFirst({ where: {
    id, tenantId: candidate.tenantId, accountId: candidate.accountId,
    opportunityId: candidate.matterId, status: 'pending', resolvedPersonId: null,
  }, select: { id: true } });
  if (!row) throw new ReviewBatchError('person_candidate_changed');
}

async function preflightRelation(
  tx: Prisma.TransactionClient,
  candidate: FullCandidate,
  acceptedCandidateIds: ReadonlySet<string>,
): Promise<void> {
  const id = legacyIdentity(candidate, 'RelSuggestion');
  const row = await tx.relSuggestion.findFirst({ where: {
    id, tenantId: candidate.tenantId, opportunityId: candidate.matterId ?? undefined, status: 'pending',
  } });
  if (!row) throw new ReviewBatchError('relation_candidate_changed');
  for (const endpoint of [
    { kind: row.sourceKind, id: row.sourcePersonId },
    { kind: row.targetKind, id: row.targetPersonId },
  ]) {
    if (endpoint.kind === 'person') {
      const person = await tx.person.findFirst({ where: {
        id: endpoint.id, tenantId: candidate.tenantId, accountId: candidate.accountId,
        archivedAt: null, mergedIntoPersonId: null,
      }, select: { id: true } });
      if (!person) throw new ReviewBatchError('relation_endpoint_missing');
      continue;
    }
    if (endpoint.kind !== 'suggestion') throw new ReviewBatchError('relation_endpoint_invalid');
    const endpointCandidate = await tx.candidate.findFirst({ where: {
      tenantId: candidate.tenantId,
      legacySourceKind: 'PersonSuggestion',
      legacySourceId: endpoint.id,
    }, select: { id: true, status: true, reviewBatchId: true } });
    if (!endpointCandidate
      || (endpointCandidate.status === 'pending'
        && (!acceptedCandidateIds.has(endpointCandidate.id)
          || endpointCandidate.reviewBatchId !== candidate.reviewBatchId))
      || (endpointCandidate.status === 'accepted'
        && !await tx.personSuggestion.findFirst({ where: {
          id: endpoint.id, tenantId: candidate.tenantId, resolvedPersonId: { not: null },
        }, select: { id: true } }))) {
      throw new ReviewBatchError('relation_endpoint_not_selected');
    }
  }
}

async function preflightEvidence(tx: Prisma.TransactionClient, candidate: FullCandidate): Promise<void> {
  const id = legacyIdentity(candidate, 'EvidenceEvent');
  const row = await tx.evidenceEvent.findFirst({ where: {
    id, tenantId: candidate.tenantId, accountId: candidate.accountId,
    opportunityId: candidate.matterId ?? undefined, status: 'pending_review',
  }, select: { id: true } });
  if (!row) throw new ReviewBatchError('evidence_candidate_changed');
}

function commitmentCommand(candidate: FullCandidate, interactionId: string | null = null) {
  let raw: unknown;
  try { raw = JSON.parse(candidate.payload); } catch { throw new ReviewBatchError('commitment_candidate_invalid'); }
  const command = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { command?: unknown }).command
    : undefined;
  const parsed = CreateCommitmentCommandSchema.safeParse(command);
  if (!parsed.success
    || parsed.data.commitment.customerId !== candidate.accountId
    || parsed.data.commitment.matterId !== candidate.matterId) {
    throw new ReviewBatchError('commitment_candidate_invalid');
  }
  return {
    ...parsed.data,
    commitment: {
      ...parsed.data.commitment,
      id: commitmentIdForReviewCandidate(candidate.tenantId, candidate.id),
      source: 'review_batch',
      sourceRef: interactionId ? `interaction:${interactionId}` : `candidate:${candidate.id}`,
    },
  } as Extract<CommitmentCommand, { type: 'CREATE_COMMITMENT' }>;
}

async function preflightCandidate(
  tx: Prisma.TransactionClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  candidate: FullCandidate,
  decision: ReviewDecisionInput,
  acceptedCandidateIds: ReadonlySet<string>,
): Promise<void> {
  if (decision.decision === 'reject') return;
  if (candidate.kind === 'person_create') return preflightPerson(tx, candidate);
  if (candidate.kind === 'relation_create') return preflightRelation(tx, candidate, acceptedCandidateIds);
  if (candidate.kind === 'field_change') {
    const id = legacyIdentity(candidate, 'ChangeProposal');
    await assertProposalAcceptancePreflight(ctx, id, decision.newValue, tx, policy);
    return;
  }
  if (candidate.kind === 'evidence_create') return preflightEvidence(tx, candidate);
  if (candidate.kind === 'commitment_create') {
    commitmentCommand(candidate);
    const deterministicId = commitmentIdForReviewCandidate(candidate.tenantId, candidate.id);
    const existing = await tx.planAction.findFirst({
      where: { id: deterministicId, tenantId: candidate.tenantId }, select: { id: true },
    });
    if (existing) throw new ReviewBatchError('commitment_id_conflict');
    return;
  }
  throw new ReviewBatchError('candidate_kind_unsupported');
}

async function writeItemAudit(
  tx: Prisma.TransactionClient,
  ctx: CommandContext,
  candidateId: string,
  result: ReviewBatchItemResult,
  batchId: string,
  interactionId: string | null,
): Promise<void> {
  await tx.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: result.status === 'accepted'
      ? 'review_batch_candidate_accepted' : 'review_batch_candidate_rejected',
    entityKind: 'candidate',
    entityId: candidateId,
    requestId: ctx.requestId ?? null,
    sourceRef: interactionId ?? batchId,
    changedFields: JSON.stringify(['status', 'reviewBatchId', 'interactionId', 'formalResult']),
    metadata: JSON.stringify({
      reviewBatchId: batchId,
      interactionId,
      formalKind: result.formalKind,
      formalId: result.formalId,
    }),
  } });
}

async function terminalizeCommitmentCandidate(
  tx: Prisma.TransactionClient,
  candidate: FullCandidate,
  status: 'accepted' | 'rejected',
): Promise<void> {
  const changed = await tx.candidate.updateMany({
    where: {
      id: candidate.id,
      tenantId: candidate.tenantId,
      status: 'pending',
      version: candidate.version,
      aclVersion: candidate.aclVersion,
    },
    data: {
      status,
      dedupeKey: terminalDedupeKey(candidate.id),
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1) throw new ReviewBatchError('candidate_apply_conflict');
}

async function rejectCandidate(
  tx: Prisma.TransactionClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  candidate: FullCandidate,
): Promise<void> {
  const review = { actorId: ctx.actorId, actorRole: ctx.actorRole, capabilityPolicy: policy };
  let rejected = false;
  if (candidate.kind === 'person_create') {
    rejected = await rejectPersonCandidate(tx, {
      tenantId: ctx.tenantId, id: legacyIdentity(candidate, 'PersonSuggestion'), review,
    });
  } else if (candidate.kind === 'relation_create') {
    rejected = await rejectRelationCandidate(tx, {
      tenantId: ctx.tenantId, id: legacyIdentity(candidate, 'RelSuggestion'), review,
    });
  } else if (candidate.kind === 'field_change') {
    rejected = (await rejectProposalInTransaction(
      ctx, legacyIdentity(candidate, 'ChangeProposal'), tx, policy,
    )) === 'ok';
  } else if (candidate.kind === 'evidence_create') {
    rejected = await reviewEvidenceCandidate(tx, {
      tenantId: ctx.tenantId,
      id: legacyIdentity(candidate, 'EvidenceEvent'),
      decision: 'reject',
      reviewedBy: ctx.actorId,
      reviewedAt: businessYmd(),
      review,
    });
  } else if (candidate.kind === 'commitment_create') {
    await terminalizeCommitmentCandidate(tx, candidate, 'rejected');
    rejected = true;
  }
  if (!rejected) throw new ReviewBatchError('candidate_apply_conflict');
}

async function acceptCandidate(
  tx: Prisma.TransactionClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  candidate: FullCandidate,
  decision: ReviewDecisionInput,
  interactionId: string,
): Promise<{ result: ReviewBatchItemResult; effect: PostCommitEffect }> {
  const review = { actorId: ctx.actorId, actorRole: ctx.actorRole, capabilityPolicy: policy };
  if (candidate.kind === 'person_create') {
    const created = await materializePerson(
      tx,
      ctx.tenantId,
      legacyIdentity(candidate, 'PersonSuggestion'),
      review,
      {
        override: decision.person,
        allowAcceptedReuse: false,
        formalPersonId: personIdForReviewCandidate(ctx.tenantId, candidate.id),
      },
    );
    return {
      result: {
        candidateId: candidate.id, decision: 'accept', status: 'accepted',
        formalKind: 'person', formalId: created.personId,
      },
      effect: undefined,
    };
  }
  if (candidate.kind === 'relation_create') {
    const accepted = await acceptRelationSuggestionInTransaction(
      tx,
      ctx.tenantId,
      legacyIdentity(candidate, 'RelSuggestion'),
      review,
      {
        ...decision.relation,
        formalEdgeId: edgeIdForReviewCandidate(ctx.tenantId, candidate.id),
      },
    );
    return {
      result: {
        candidateId: candidate.id, decision: 'accept', status: 'accepted',
        formalKind: 'relation', formalId: accepted.edge.id,
      },
      effect: undefined,
    };
  }
  if (candidate.kind === 'field_change') {
    const accepted = await acceptProposalInTransaction(
      ctx,
      legacyIdentity(candidate, 'ChangeProposal'),
      decision.newValue,
      tx,
      policy,
    );
    if (accepted.result !== 'ok') throw new ReviewBatchError('candidate_apply_conflict');
    return {
      result: {
        candidateId: candidate.id, decision: 'accept', status: 'accepted',
        formalKind: candidate.targetKind, formalId: candidate.targetId,
      },
      effect: accepted.effect,
    };
  }
  if (candidate.kind === 'evidence_create') {
    const evidenceId = legacyIdentity(candidate, 'EvidenceEvent');
    const accepted = await reviewEvidenceCandidate(tx, {
      tenantId: ctx.tenantId,
      id: evidenceId,
      decision: 'accept',
      reviewedBy: ctx.actorId,
      reviewedAt: businessYmd(),
      direction: decision.evidence?.direction,
      tier: decision.evidence?.tier,
      review,
    }, async (inner, evidence) => {
      await createPdeSnapshot(inner, ctx.tenantId, evidence.opportunityId, 'evidence_review', ctx.actorId);
    });
    if (!accepted) throw new ReviewBatchError('candidate_apply_conflict');
    return {
      result: {
        candidateId: candidate.id, decision: 'accept', status: 'accepted',
        formalKind: 'evidence', formalId: evidenceId,
      },
      effect: undefined,
    };
  }
  if (candidate.kind === 'commitment_create') {
    const command = commitmentCommand(candidate, interactionId);
    const receipt = await executeCommitmentCommand(ctx, command, tx);
    await terminalizeCommitmentCandidate(tx, candidate, 'accepted');
    return {
      result: {
        candidateId: candidate.id, decision: 'accept', status: 'accepted',
        formalKind: 'commitment', formalId: receipt.commitmentId,
      },
      effect: undefined,
    };
  }
  throw new ReviewBatchError('candidate_kind_unsupported');
}

function parseStoredReceipt(raw: string): Omit<ReviewBatchAcceptanceReceipt, 'businessReplayed'> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ReviewBatchError('review_batch_receipt_invalid'); }
  if (!storedReviewBatchReceiptIsValid(value)) {
    throw new ReviewBatchError('review_batch_receipt_invalid');
  }
  return value as Omit<ReviewBatchAcceptanceReceipt, 'businessReplayed'>;
}

export async function acceptReviewBatch(
  tx: Prisma.TransactionClient,
  rawCtx: ReviewBatchContext,
  policy: CapabilityPolicy,
  batchId: string,
  input: AcceptReviewBatchInput,
): Promise<ReviewBatchAcceptanceReceipt> {
  const ctx = await currentContext(tx, rawCtx);
  const readable = await readableReviewBatchById(tx, ctx, policy, batchId, 'review');
  if (!readable) throw new ReviewBatchError('review_batch_not_found', 404, true);
  const { batch } = readable;
  if (input.decisions.length < 1 || input.decisions.length > 100
    || !input.accountId.trim() || !input.activityKind.trim()
    || !Number.isFinite(input.occurredAt.getTime())) {
    throw new ReviewBatchError('review_batch_input_invalid', 400);
  }
  const normalized = normalizedRequest(input);
  const requestHash = reviewAcceptanceHash(normalized);
  if (batch.lastAcceptanceVersion === input.expectedAcceptanceVersion) {
    if (batch.lastAcceptanceHash !== requestHash) {
      throw new ReviewBatchConflictError(input.decisions.map((decision) => ({
        candidateId: decision.candidateId,
        status: 'conflict',
        reason: 'acceptance_version_reused',
      })));
    }
    const stored = parseStoredReceipt(batch.lastAcceptanceResult);
    return { ...stored, businessReplayed: true };
  }
  if (batch.version !== input.expectedVersion
    || batch.acceptanceVersion !== input.expectedAcceptanceVersion
    || batch.accountId !== input.accountId
    || batch.matterId !== input.matterId) {
    throw new ReviewBatchConflictError(input.decisions.map((decision) => ({
      candidateId: decision.candidateId,
      status: 'conflict',
      reason: 'batch_version_conflict',
    })));
  }
  const decisionById = new Map<string, ReviewDecisionInput>();
  for (const decision of input.decisions) {
    if (!decision.candidateId.trim()
      || !Number.isSafeInteger(decision.expectedVersion) || decision.expectedVersion < 0
      || !Number.isSafeInteger(decision.expectedAclVersion) || decision.expectedAclVersion < 1
      || decisionById.has(decision.candidateId)) {
      throw new ReviewBatchError('review_batch_input_invalid', 400);
    }
    decisionById.set(decision.candidateId, decision);
  }
  const metadataById = new Map(readable.candidates.map((candidate) => [candidate.id, candidate]));
  const fullRows = await tx.candidate.findMany({
    where: {
      tenantId: ctx.tenantId,
      reviewBatchId: batch.id,
      sourceArtifactId: batch.sourceArtifactId,
      id: { in: [...decisionById.keys()] },
    },
    orderBy: { id: 'asc' },
    select: fullCandidateSelect,
  });
  const fullById = new Map(fullRows.map((candidate) => [candidate.id, candidate]));
  const conflicts = new Map<string, string>();
  for (const decision of input.decisions) {
    const candidate = fullById.get(decision.candidateId);
    const metadata = metadataById.get(decision.candidateId);
    if (!candidate || !metadata) {
      conflicts.set(decision.candidateId, 'candidate_not_in_batch');
    } else if (candidate.status !== 'pending') {
      conflicts.set(decision.candidateId, 'candidate_already_processed');
    } else if (candidate.version !== decision.expectedVersion) {
      conflicts.set(decision.candidateId, 'candidate_version_conflict');
    } else if (candidate.aclVersion !== decision.expectedAclVersion) {
      conflicts.set(decision.candidateId, 'candidate_acl_conflict');
    }
  }
  const acceptedCandidateIds = new Set(input.decisions
    .filter((decision) => decision.decision === 'accept')
    .map((decision) => decision.candidateId));
  for (const decision of input.decisions) {
    if (conflicts.has(decision.candidateId)) continue;
    const candidate = fullById.get(decision.candidateId)!;
    try {
      await preflightCandidate(tx, ctx, policy, candidate, decision, acceptedCandidateIds);
    } catch (error) {
      conflicts.set(decision.candidateId, errorReason(error));
    }
  }
  if (conflicts.size > 0) throw new ReviewBatchConflictError(conflictItems(input.decisions, conflicts));

  const hasAccept = acceptedCandidateIds.size > 0;
  let interactionId = batch.interactionId;
  if (hasAccept) {
    const activityKind = input.activityKind.trim();
    if (interactionId) {
      const interaction = await tx.interaction.findFirst({ where: {
        id: interactionId,
        tenantId: ctx.tenantId,
        accountId: batch.accountId,
        matterId: batch.matterId,
        sourceArtifactId: batch.sourceArtifactId,
        activityKind,
        occurredAt: input.occurredAt,
        createdByUserId: batch.createdByUserId,
      }, select: { id: true } });
      if (!interaction) {
        throw new ReviewBatchConflictError(conflictItems(
          input.decisions,
          new Map(input.decisions.map((decision) => [decision.candidateId, 'interaction_changed'])),
        ));
      }
    } else if (input.existingInteractionId) {
      const interaction = await tx.interaction.findFirst({ where: {
        id: input.existingInteractionId,
        tenantId: ctx.tenantId,
        accountId: batch.accountId,
        matterId: batch.matterId,
        sourceArtifactId: batch.sourceArtifactId,
        activityKind,
        occurredAt: input.occurredAt,
        createdByUserId: batch.createdByUserId,
      }, select: { id: true } });
      if (!interaction) throw new ReviewBatchError('interaction_not_found', 404, true);
      interactionId = interaction.id;
    } else {
      interactionId = interactionIdForReviewBatch(ctx.tenantId, batch.id);
      const collision = await tx.interaction.findFirst({
        where: { id: interactionId, tenantId: ctx.tenantId }, select: { id: true },
      });
      if (collision) {
        throw new ReviewBatchConflictError(conflictItems(
          input.decisions,
          new Map(input.decisions.map((decision) => [decision.candidateId, 'interaction_id_conflict'])),
        ));
      }
      await tx.interaction.create({ data: {
        id: interactionId,
        tenantId: ctx.tenantId,
        accountId: batch.accountId,
        matterId: batch.matterId,
        sourceArtifactId: batch.sourceArtifactId,
        activityKind,
        occurredAt: input.occurredAt,
        title: '',
        createdByUserId: batch.createdByUserId,
        confirmedByUserId: ctx.actorId,
      } });
      await tx.auditEvent.create({ data: {
        id: `audit_${randomUUID()}`,
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        channel: ctx.channel,
        action: 'interaction_created',
        entityKind: 'interaction',
        entityId: interactionId,
        requestId: ctx.requestId ?? null,
        sourceRef: batch.sourceArtifactId,
        changedFields: JSON.stringify(['activityKind', 'occurredAt', 'accountId', 'matterId']),
        metadata: JSON.stringify({ reviewBatchId: batch.id }),
      } });
    }
  }

  const results: ReviewBatchItemResult[] = [];
  const effects: PostCommitEffect[] = [];
  const ordered = [...input.decisions].sort((left, right) => {
    const rank = (decision: ReviewDecisionInput) => {
      if (decision.decision === 'reject') return 5;
      return fullById.get(decision.candidateId)?.kind === 'person_create' ? 0
        : fullById.get(decision.candidateId)?.kind === 'relation_create' ? 4 : 2;
    };
    return rank(left) - rank(right) || left.candidateId.localeCompare(right.candidateId);
  });
  for (const decision of ordered) {
    const candidate = fullById.get(decision.candidateId)!;
    try {
      if (decision.decision === 'reject') {
        await rejectCandidate(tx, ctx, policy, candidate);
        const result: ReviewBatchItemResult = {
          candidateId: candidate.id,
          decision: 'reject',
          status: 'rejected',
          formalKind: null,
          formalId: null,
        };
        results.push(result);
        await writeItemAudit(tx, ctx, candidate.id, result, batch.id, interactionId);
      } else {
        if (!interactionId) throw new ReviewBatchError('interaction_required');
        const accepted = await acceptCandidate(tx, ctx, policy, candidate, decision, interactionId);
        results.push(accepted.result);
        if (accepted.effect) effects.push(accepted.effect);
        await writeItemAudit(tx, ctx, candidate.id, accepted.result, batch.id, interactionId);
      }
    } catch (error) {
      throw new ReviewBatchConflictError(conflictItems(
        input.decisions,
        new Map([[decision.candidateId, errorReason(error)]]),
      ));
    }
  }

  const pending = await tx.candidate.count({ where: {
    tenantId: ctx.tenantId, reviewBatchId: batch.id, status: 'pending',
  } });
  const status = pending > 0 ? 'pending' : interactionId ? 'accepted' : 'rejected';
  const receiptWithoutReplay: Omit<ReviewBatchAcceptanceReceipt, 'businessReplayed'> = {
    batchId: batch.id,
    status,
    interactionId,
    version: batch.version + 1,
    acceptanceVersion: batch.acceptanceVersion + 1,
    items: [...results].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    effects,
  };
  const storedReceipt = { ...receiptWithoutReplay, effects: [] };
  const changed = await tx.reviewBatch.updateMany({
    where: {
      id: batch.id,
      tenantId: ctx.tenantId,
      version: input.expectedVersion,
      acceptanceVersion: input.expectedAcceptanceVersion,
      aclVersion: batch.aclVersion,
    },
    data: {
      status,
      activityKind: interactionId ? input.activityKind.trim() : batch.activityKind,
      occurredAt: interactionId ? input.occurredAt : batch.occurredAt,
      interactionId,
      acceptanceVersion: { increment: 1 },
      version: { increment: 1 },
      lastAcceptanceVersion: input.expectedAcceptanceVersion,
      lastAcceptanceHash: requestHash,
      lastAcceptanceResult: JSON.stringify(storedReceipt),
      reviewedByUserId: ctx.actorId,
      reviewedAt: new Date(),
    },
  });
  if (changed.count !== 1) {
    throw new ReviewBatchConflictError(conflictItems(
      input.decisions,
      new Map(input.decisions.map((decision) => [decision.candidateId, 'batch_version_conflict'])),
    ));
  }
  await tx.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'review_batch_accepted',
    entityKind: 'review_batch',
    entityId: batch.id,
    requestId: ctx.requestId ?? null,
    sourceRef: interactionId ?? batch.sourceArtifactId,
    changedFields: JSON.stringify(['status', 'acceptanceVersion', 'interactionId', 'candidateResults']),
    metadata: JSON.stringify({
      accepted: results.filter((result) => result.status === 'accepted').length,
      rejected: results.filter((result) => result.status === 'rejected').length,
      pending,
    }),
  } });
  return { ...receiptWithoutReplay, businessReplayed: false };
}
