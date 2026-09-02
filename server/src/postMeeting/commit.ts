import { createHash } from 'node:crypto';
import { ActorRoleSchema, type CapabilityPolicy } from '@jianghu/domain-contracts';
import type { Prisma } from '@prisma/client';
import { createPersonCandidate, createRelationCandidate } from '../candidates/personRelation.js';
import { createEvidenceCandidate, createFieldCandidate } from '../candidates/reviewItems.js';
import { AgentJobError } from '../agents/errors.js';
import type {
  AgentCandidateCommitAdapter,
  AgentCandidateCommitAdapterContext,
} from '../agents/model.js';
import {
  authorizeSensitiveResource,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import {
  createCommitmentReviewCandidate,
  personIdForReviewCandidate,
} from '../reviewBatches/model.js';
import { createReviewBatch } from '../reviewBatches/service.js';
import {
  SOURCE_ARTIFACT_METADATA_SELECT,
  sourceArtifactMetadataIsValid,
} from '../sourceArtifacts/service.js';
import { postMeetingReviewBatchId } from './handler.js';

type Tx = Prisma.TransactionClient;

interface Dependencies {
  policy: CapabilityPolicy;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function stableId(prefix: string, context: AgentCandidateCommitAdapterContext, itemRef: string): string {
  return `${prefix}_${sha256(JSON.stringify([
    context.tenantId,
    context.runId,
    context.sourceArtifactId,
    itemRef,
  ])).slice(0, 32)}`;
}

function sourceRef(
  context: AgentCandidateCommitAdapterContext,
  sourceLocator: string,
): string {
  return `post-meeting:${context.runId}@${sourceLocator}`;
}

function dedupeKey(context: AgentCandidateCommitAdapterContext, itemRef: string): string {
  return `post-meeting-run-v1:${context.runId}:${itemRef}`;
}

function encoded(value: string | null): string {
  return JSON.stringify(value);
}

function fail(code: string): never {
  throw new AgentJobError(code, 409);
}

async function loadCurrentSource(
  context: AgentCandidateCommitAdapterContext,
  policy: CapabilityPolicy,
) {
  if (context.definition.jobKey !== 'post_meeting_extract'
    || context.definition.jobVersion !== 'core-206.v1'
    || context.definition.actionMode !== 'candidate'
    || !context.sourceArtifactId
    || !context.sourceFingerprint
    || context.sourceAclVersion === null) {
    fail('post_meeting_commit_scope_invalid');
  }
  const actor = await context.tx.user.findFirst({
    where: { id: context.actorId, tenantId: context.tenantId },
    select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success) fail('post_meeting_source_not_found');
  if (role.data === 'viewer') throw new AgentJobError('viewer_write_denied', 403);

  const source = await context.tx.sourceArtifact.findFirst({
    where: { id: context.sourceArtifactId, tenantId: context.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!source
    || !sourceArtifactMetadataIsValid(source)
    || source.accountId !== context.customerId
    || source.matterId !== context.matterId
    || source.retentionState !== 'available'
    || !['transcript', 'uploaded_file', 'note'].includes(source.artifactKind)) {
    fail('post_meeting_source_not_found');
  }
  const inputRef = context.inputRefs.find((ref) => (
    ref.kind === 'source_artifact' && ref.id === source.id
  ));
  if (!inputRef
    || inputRef.version !== source.aclVersion
    || source.aclVersion !== context.sourceAclVersion
    || source.sourceFingerprint !== context.sourceFingerprint) {
    fail('post_meeting_source_stale');
  }
  const access = await authorizeSensitiveResource(context.tx, {
    tenantId: context.tenantId,
    userId: context.actorId,
    role: role.data,
  }, policy, sourceArtifactDescriptor(source), 'read');
  if (!access.allowed) fail('post_meeting_source_not_found');
  return { source, actorRole: role.data };
}

async function bindCandidate(
  tx: Tx,
  source: Awaited<ReturnType<typeof loadCurrentSource>>['source'],
  receipt: { candidateId: string; candidateVersion: number; created: boolean },
): Promise<{ id: string; expectedVersion: number; expectedAclVersion: number }> {
  if (!receipt.created) fail('post_meeting_candidate_conflict');
  const candidate = await tx.candidate.findFirst({
    where: { id: receipt.candidateId, tenantId: source.tenantId },
  });
  const initialVisibility = source.createdByUserId ? 'private' : 'owner_admin_only';
  if (!candidate
    || candidate.status !== 'pending'
    || candidate.version !== receipt.candidateVersion
    || candidate.reviewBatchId !== null
    || candidate.sourceArtifactId !== null
    || candidate.accountId !== source.accountId
    || candidate.matterId !== source.matterId
    || candidate.createdByUserId !== source.createdByUserId
    || candidate.visibility !== initialVisibility
    || candidate.aclVersion !== 1) {
    fail('post_meeting_candidate_conflict');
  }
  const changed = await tx.candidate.updateMany({
    where: {
      id: candidate.id,
      tenantId: source.tenantId,
      status: 'pending',
      version: candidate.version,
      reviewBatchId: null,
      sourceArtifactId: null,
      aclVersion: 1,
    },
    data: {
      sourceArtifactId: source.id,
      visibility: source.visibility,
      aclVersion: source.aclVersion,
    },
  });
  if (changed.count !== 1) fail('post_meeting_candidate_conflict');
  return {
    id: candidate.id,
    expectedVersion: candidate.version,
    expectedAclVersion: source.aclVersion,
  };
}

async function bindDirectCandidate(
  tx: Tx,
  candidate: Prisma.CandidateUncheckedCreateInput & { version: number; aclVersion: number },
): Promise<{ id: string; expectedVersion: number; expectedAclVersion: number }> {
  try {
    await tx.candidate.create({ data: candidate });
  } catch {
    fail('post_meeting_candidate_conflict');
  }
  return { id: candidate.id, expectedVersion: candidate.version, expectedAclVersion: candidate.aclVersion };
}

async function currentField(
  tx: Tx,
  context: AgentCandidateCommitAdapterContext,
  item: Extract<Parameters<AgentCandidateCommitAdapter>[1]['items'][number], { kind: 'field' }>,
): Promise<{ targetKind: 'customer' | 'matter'; targetId: string; oldValue: string }> {
  if (item.target.kind === 'customer') {
    const customer = await tx.account.findFirst({
      where: { id: context.customerId, tenantId: context.tenantId, archivedAt: null },
      select: { name: true, categoryKey: true },
    });
    if (!customer) fail('post_meeting_target_not_found');
    return {
      targetKind: 'customer',
      targetId: context.customerId,
      oldValue: encoded(customer[item.target.field]),
    };
  }
  if (!context.matterId) fail('post_meeting_target_not_found');
  const matter = await tx.opportunity.findFirst({
    where: {
      id: context.matterId,
      tenantId: context.tenantId,
      accountId: context.customerId,
      archivedAt: null,
      account: { tenantId: context.tenantId, archivedAt: null },
    },
    select: { name: true, kind: true, priority: true, targetDate: true },
  });
  if (!matter) fail('post_meeting_target_not_found');
  const value = item.target.field === 'title' ? matter.name : matter[item.target.field];
  return { targetKind: 'matter', targetId: context.matterId, oldValue: encoded(value) };
}

/**
 * The only production implementation of the Agent candidate port. It runs inside
 * the runner's Serializable transaction and can create only compatibility candidates
 * plus one ReviewBatch; no formal CRM writer is reachable from this module.
 */
export function createPostMeetingCandidateCommitAdapter(
  dependencies: Dependencies,
): AgentCandidateCommitAdapter {
  return async (context, batch) => {
    const { source, actorRole } = await loadCurrentSource(context, dependencies.policy);
    if (!source.accountId
      || batch.customerId !== source.accountId
      || batch.matterId !== source.matterId
      || batch.sourceArtifactId !== source.id) {
      fail('post_meeting_commit_scope_invalid');
    }

    const attachments: Array<{ id: string; expectedVersion: number; expectedAclVersion: number }> = [];
    const newPeople = new Map<string, {
      legacyId: string;
      candidateId: string;
      futurePersonId: string;
    }>();
    const createdByUserId = source.createdByUserId;

    for (const item of batch.items) {
      if (item.kind !== 'person') continue;
      const legacyId = stableId('ps', context, item.itemRef);
      const receipt = await createPersonCandidate(context.tx, {
        id: legacyId,
        tenantId: context.tenantId,
        accountId: source.accountId,
        matterId: source.matterId,
        name: item.person.name,
        title: item.person.title ?? '',
        source: 'post_meeting_extract',
        sourceRef: sourceRef(context, item.sourceLocator),
        evidence: item.sourceQuote,
        confidence: item.confidence,
        createdByUserId,
        dedupeKey: dedupeKey(context, item.itemRef),
      });
      const attachment = await bindCandidate(context.tx, source, receipt);
      attachments.push(attachment);
      newPeople.set(item.itemRef, {
        legacyId: receipt.row.id,
        candidateId: receipt.candidateId,
        futurePersonId: personIdForReviewCandidate(context.tenantId, receipt.candidateId),
      });
    }

    const endpoint = (value: Extract<typeof batch.items[number], { kind: 'relation' }>['sourcePerson']) => {
      if (value.kind === 'existing_person') return { kind: 'person' as const, id: value.personId };
      const person = newPeople.get(value.itemRef);
      if (!person) fail('post_meeting_candidate_endpoint_invalid');
      return { kind: 'suggestion' as const, id: person.legacyId };
    };

    for (const item of batch.items) {
      if (item.kind === 'person') continue;
      if (item.kind === 'relation') {
        if (!source.matterId) fail('post_meeting_target_not_found');
        const receipt = await createRelationCandidate(context.tx, {
          id: stableId('rs', context, item.itemRef),
          tenantId: context.tenantId,
          matterId: source.matterId,
          source: endpoint(item.sourcePerson),
          target: endpoint(item.targetPerson),
          layer: item.layer,
          label: item.label ?? '',
          sourceType: 'post_meeting_extract',
          sourceRef: sourceRef(context, item.sourceLocator),
          evidence: item.sourceQuote,
          confidence: item.confidence,
          createdByUserId,
          dedupeKey: dedupeKey(context, item.itemRef),
        });
        attachments.push(await bindCandidate(context.tx, source, receipt));
        continue;
      }
      if (item.kind === 'field') {
        const target = await currentField(context.tx, context, item);
        const nextValue = encoded(item.proposedValue);
        if (target.oldValue === nextValue) fail('post_meeting_candidate_no_change');
        const receipt = await createFieldCandidate(context.tx, {
          id: stableId('cp', context, item.itemRef),
          tenantId: context.tenantId,
          accountId: source.accountId,
          matterId: source.matterId,
          targetKind: target.targetKind,
          targetId: target.targetId,
          fieldKey: item.target.field,
          oldValue: target.oldValue,
          newValue: nextValue,
          source: 'post_meeting_extract',
          sourceRef: sourceRef(context, item.sourceLocator),
          evidence: item.sourceQuote,
          confidence: item.confidence,
          createdByUserId,
          dedupeKey: dedupeKey(context, item.itemRef),
        });
        attachments.push(await bindCandidate(context.tx, source, receipt));
        continue;
      }
      if (item.kind === 'evidence') {
        if (!source.matterId) fail('post_meeting_target_not_found');
        const pending = item.person.kind === 'new_person'
          ? newPeople.get(item.person.itemRef) ?? null
          : null;
        if (item.person.kind === 'new_person' && !pending) {
          fail('post_meeting_candidate_endpoint_invalid');
        }
        const personId = item.person.kind === 'existing_person'
          ? item.person.personId
          : pending!.futurePersonId;
        const receipt = await createEvidenceCandidate(context.tx, {
          id: stableId('ev', context, item.itemRef),
          tenantId: context.tenantId,
          accountId: source.accountId,
          matterId: source.matterId,
          personId,
          signalKey: item.signalKey,
          direction: item.direction,
          tier: item.tier,
          rawContent: item.sourceQuote,
          occurredAt: item.occurredAt,
          source: 'post_meeting_extract',
          sourceRef: sourceRef(context, item.sourceLocator),
          confidence: item.confidence,
          createdByUserId,
          pendingPersonCandidateId: pending?.candidateId ?? null,
        });
        attachments.push(await bindCandidate(context.tx, source, receipt));
        continue;
      }

      const commitment = item.command.commitment;
      const candidate = createCommitmentReviewCandidate({
        tenantId: context.tenantId,
        accountId: source.accountId,
        matterId: source.matterId,
        sourceArtifactId: source.id,
        reviewBatchId: null,
        createdByUserId,
        visibility: source.visibility as 'private' | 'matter_shared' | 'owner_admin_only',
        aclVersion: source.aclVersion,
        source: 'post_meeting_extract',
        sourceRef: sourceRef(context, item.sourceLocator),
        evidence: item.sourceQuote,
        confidence: item.confidence,
        commitment: {
          customerId: commitment.customerId,
          matterId: commitment.matterId,
          personId: commitment.personId,
          title: commitment.title,
          kind: commitment.kind,
          ownerUserId: commitment.ownerUserId,
          confirmationStatus: commitment.confirmationStatus,
          scheduledAtUtc: commitment.scheduledAtUtc,
          dueAtUtc: commitment.dueAtUtc,
          timeZone: commitment.timeZone,
          isAllDay: commitment.isAllDay,
          localDate: commitment.localDate,
          confirmationDueAtUtc: commitment.confirmationDueAtUtc,
        },
      });
      attachments.push(await bindDirectCandidate(context.tx, candidate));
    }

    if (attachments.length !== batch.items.length) fail('post_meeting_candidate_count_mismatch');
    const id = postMeetingReviewBatchId(context.tenantId, context.runId);
    const view = await createReviewBatch(context.tx, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      actorRole,
      channel: 'system',
      requestId: context.requestId ?? context.runId,
      assertionMode: 'machine_proposed',
    }, dependencies.policy, {
      id,
      sourceArtifactId: source.id,
      expectedSourceAclVersion: source.aclVersion,
      candidates: attachments,
    }, {
      sourceIntent: 'read',
      grantActorReviewer: true,
    });
    if (view.id !== id || view.version !== 0) fail('post_meeting_review_batch_mismatch');
    return { kind: 'review_batch', id, version: view.version };
  };
}
