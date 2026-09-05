import { randomUUID } from 'node:crypto';
import {
  CommandContextSchema,
  IntelligenceItemListQuerySchema,
  RelationshipWorkspaceResponseSchema,
  ReviewHypothesisVerificationCommandSchema,
  SalesHypothesisDetailQuerySchema,
  SalesHypothesisListQuerySchema,
  StakeholderFocusListQuerySchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
  type PostMeetingPersonEndpoint,
  type PostMeetingReviewItem,
  type RelationshipCandidateEndpoint,
  type RelationshipWorkspaceResponse,
  type ReviewHypothesisVerificationCommand,
  type ReviewHypothesisVerificationReceipt,
} from '@jianghu/domain-contracts';
import { buildCrmContextSnapshot } from '../crmContext.js';
import { commitmentFromPlanAction } from '../commitment/view.js';
import {
  listIntelligenceItems,
  listStakeholderFocuses,
} from '../intelligenceFocus/service.js';
import {
  listSalesHypotheses,
  salesHypothesisDetail,
  executeSalesHypothesisCommand,
} from '../hypotheses/service.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { readableReviewBatchTransport } from '../postMeeting/review.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import { readableReviewBatches } from '../reviewBatches/service.js';
import { verificationReadiness } from './model.js';

export class RelationshipWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly scopedNotFound = false,
  ) {
    super(code);
    this.name = 'RelationshipWorkspaceError';
  }
}

function notFound(): never {
  throw new RelationshipWorkspaceError('relationship_workspace_not_found', 404, true);
}

function storageInvalid(): never {
  throw new RelationshipWorkspaceError('relationship_workspace_storage_invalid', 409);
}

function requireCapability(policy: CapabilityPolicy): void {
  if (!capabilityPolicyAllows(policy, { entitlement: 'crm.core' })
    && !capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new RelationshipWorkspaceError('capability_denied', 403);
  }
}

type PendingPersonCandidate = Extract<PostMeetingReviewItem, { kind: 'person' }>;
type PendingRelationCandidate = Extract<PostMeetingReviewItem, { kind: 'relation' }>;

function isPendingPersonCandidate(item: PostMeetingReviewItem): item is PendingPersonCandidate {
  return item.kind === 'person' && item.status === 'pending';
}

function isPendingRelationCandidate(item: PostMeetingReviewItem): item is PendingRelationCandidate {
  return item.kind === 'relation' && item.status === 'pending';
}

function currentPrincipal(ctx: CommandContext, role: CommandContext['actorRole']) {
  return { tenantId: ctx.tenantId, userId: ctx.actorId, role };
}

async function formalProjection(
  db: DbClient,
  ctx: CommandContext,
  customerId: string,
  matterId: string,
) {
  const scope = await resolveEffectiveResourceScope(db, currentPrincipal(ctx, ctx.actorRole));
  if (!scope.valid || !scope.canReadMatter(matterId)) notFound();
  const snapshot = await buildCrmContextSnapshot(
    currentPrincipal(ctx, scope.actorRole),
    new Date(),
    db,
  );
  const customer = snapshot.customers.find((item) => item.id === customerId);
  const matter = snapshot.matters.find((item) => item.id === matterId && item.customerId === customerId);
  if (!customer || !matter) notFound();

  const includeCustomerRelations = scope.canReadAccountData(customerId);
  const relations = snapshot.relations.filter((relation) => (
    relation.customerId === customerId
    && (relation.matterId === matterId || (includeCustomerRelations && relation.matterId === null))
  ));
  const participants = snapshot.matterParticipants.filter((participant) => (
    participant.customerId === customerId && participant.matterId === matterId
  ));
  const [rawRelationCount, rawParticipantCount] = await Promise.all([
    db.edge.count({ where: {
      tenantId: ctx.tenantId,
      accountId: customerId,
      account: { tenantId: ctx.tenantId, archivedAt: null },
      OR: [
        { opportunityId: matterId },
        ...(includeCustomerRelations ? [{ opportunityId: null }] : []),
      ],
    } }),
    db.matterParticipant.count({ where: {
      tenantId: ctx.tenantId,
      accountId: customerId,
      opportunityId: matterId,
    } }),
  ]);
  if (rawRelationCount !== relations.length || rawParticipantCount !== participants.length) {
    storageInvalid();
  }

  const personIds = new Set(participants.map((participant) => participant.personId));
  for (const relation of relations) {
    personIds.add(relation.sourcePersonId);
    personIds.add(relation.targetPersonId);
  }
  const people = snapshot.people
    .filter((person) => person.customerId === customerId && personIds.has(person.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (people.length !== personIds.size || people.length > 200 || relations.length > 400) storageInvalid();

  return {
    scope,
    customer,
    matter,
    people,
    formalRelations: relations
      .map((relation) => ({ ...relation, rendering: 'solid' as const }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

async function candidateProjection(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  customerId: string,
  matterId: string,
  people: readonly RelationshipWorkspaceResponse['people'][number][],
) {
  try {
    const listed = await readableReviewBatches(db, ctx, policy, { limit: 100 });
    const batches = listed.items.filter((batch) => (
      batch.accountId === customerId && batch.matterId === matterId && batch.status === 'pending'
    ));
    const personById = new Map(people.map((person) => [person.id, person]));
    const projected: RelationshipWorkspaceResponse['candidateRelations'] = [];

    for (const batch of batches) {
      let transport;
      try {
        transport = await readableReviewBatchTransport(db, ctx, policy, batch.id);
      } catch {
        continue;
      }
      if (!transport || transport.kind !== 'post_meeting') continue;
      const detail = transport.view;
      if (detail.customerId !== customerId || detail.matterId !== matterId || detail.status !== 'pending') continue;
      const pendingPeople = new Map(detail.items
        .filter(isPendingPersonCandidate)
        .map((item) => [item.itemRef, item]));
      const relationItems = detail.items.filter(isPendingRelationCandidate);
      const candidateIds = [...new Set([
        ...relationItems.map((item) => item.candidateId),
        ...[...pendingPeople.values()].map((item) => item.candidateId),
      ])];
      const rows = candidateIds.length === 0 ? [] : await db.candidate.findMany({
        where: {
          tenantId: ctx.tenantId,
          reviewBatchId: batch.id,
          sourceArtifactId: detail.source.id,
          status: 'pending',
          id: { in: candidateIds },
        },
        select: { id: true, createdAt: true },
      });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const endpoint = (value: PostMeetingPersonEndpoint): RelationshipCandidateEndpoint | null => {
        if (value.kind === 'existing_person') {
          const person = personById.get(value.personId);
          return person ? {
            kind: 'person', personId: person.id, label: person.name, title: person.title,
          } : null;
        }
        const candidate = pendingPeople.get(value.itemRef);
        if (!candidate || !rowById.has(candidate.candidateId)) return null;
        return {
          kind: 'candidate_person',
          candidateId: candidate.candidateId,
          itemRef: candidate.itemRef,
          label: candidate.after.name,
          title: candidate.after.title,
        };
      };

      for (const item of relationItems) {
        const row = rowById.get(item.candidateId);
        const sourceEndpoint = endpoint(item.after.sourcePerson);
        const targetEndpoint = endpoint(item.after.targetPerson);
        if (!row || !sourceEndpoint || !targetEndpoint) continue;
        projected.push({
          candidateId: item.candidateId,
          reviewBatchId: detail.id,
          sourceArtifactId: detail.source.id,
          sourceEndpoint,
          targetEndpoint,
          layer: item.after.layer,
          label: item.after.label,
          directed: true,
          confidence: item.confidence,
          source: {
            artifactKind: detail.source.kind,
            title: detail.source.title,
            externalRef: null,
            occurredAtUtc: detail.source.occurredAt,
            locator: item.sourceLocator,
            quote: item.sourceQuote,
          },
          candidateCreatedAtUtc: row.createdAt.toISOString(),
          rendering: 'muted_dashed_question',
        });
      }
    }
    return projected
      .sort((left, right) => left.candidateCreatedAtUtc.localeCompare(right.candidateCreatedAtUtc)
        || left.candidateId.localeCompare(right.candidateId))
      .slice(0, 100);
  } catch {
    return [];
  }
}

async function hypothesisProjection(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  customerId: string,
  matterId: string,
  peopleIds: ReadonlySet<string>,
) {
  const listed = await listSalesHypotheses(db, ctx, policy, SalesHypothesisListQuerySchema.parse({
    customerId,
    matterId,
    includeRetired: false,
    cursor: null,
    limit: 50,
  }));
  const details = [];
  for (const hypothesis of listed.items) {
    const detail = await salesHypothesisDetail(
      db,
      ctx,
      policy,
      hypothesis.id,
      SalesHypothesisDetailQuerySchema.parse({ beforeRevisionNumber: null, limit: 20 }),
    );
    if (!detail || detail.item.customerId !== customerId || detail.item.matterId !== matterId) storageInvalid();
    if (detail.item.personId !== null && !peopleIds.has(detail.item.personId)) storageInvalid();
    details.push(detail);
  }
  const hypothesisIds = details.map((detail) => detail.item.id);
  const rows = hypothesisIds.length === 0 ? [] : await db.planAction.findMany({
    where: {
      tenantId: ctx.tenantId,
      accountId: customerId,
      opportunityId: matterId,
      archivedAt: null,
      hypothesisId: { in: hypothesisIds },
    },
    orderBy: { id: 'asc' },
  });
  const revisionIds = [...new Set(rows.flatMap((row) => row.hypothesisRevisionId ? [row.hypothesisRevisionId] : []))];
  const revisions = revisionIds.length === 0 ? [] : await db.salesHypothesisRevision.findMany({
    where: { tenantId: ctx.tenantId, id: { in: revisionIds } },
    select: { id: true, hypothesisId: true },
  });
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  const userIds = [...new Set(rows.flatMap((row) => [
    row.ownerUserId,
    row.completionResultRecordedByUserId,
    row.verificationReviewedByUserId,
  ].filter((value): value is string => value !== null)))];
  const users = userIds.length === 0 ? [] : await db.user.findMany({
    where: { tenantId: ctx.tenantId, id: { in: userIds } }, select: { id: true },
  });
  if (users.length !== userIds.length) storageInvalid();

  const rowsByHypothesis = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.hypothesisId || !row.hypothesisRevisionId
      || revisionById.get(row.hypothesisRevisionId)?.hypothesisId !== row.hypothesisId
      || (row.personId !== null && !peopleIds.has(row.personId))) storageInvalid();
    const grouped = rowsByHypothesis.get(row.hypothesisId) ?? [];
    grouped.push(row);
    rowsByHypothesis.set(row.hypothesisId, grouped);
  }

  return details
    .sort((left, right) => left.item.id.localeCompare(right.item.id))
    .map((detail) => {
      const current = detail.revisions.find(
        (entry) => entry.revision.id === detail.item.currentRevisionId,
      );
      if (!current) storageInvalid();
      const evidenceLinks = [...current.evidenceLinks].sort((left, right) => (
        left.linkedAt.localeCompare(right.linkedAt) || left.id.localeCompare(right.id)
      ));
      const commitmentRows = rowsByHypothesis.get(detail.item.id) ?? [];
      const commitments = commitmentRows.map((row) => {
        const commitment = commitmentFromPlanAction(row);
        if (!commitment || commitment.hypothesisId !== detail.item.id) storageInvalid();
        const linkedEvidenceIds = evidenceLinks
          .filter((link) => link.verificationCommitmentId === commitment.id)
          .map((link) => link.evidenceId);
        return {
          commitment,
          linkedEvidenceIds,
          readiness: verificationReadiness(
            commitment,
            detail.item.currentRevisionId,
            linkedEvidenceIds.length,
          ),
        };
      });
      for (const link of evidenceLinks) {
        if (link.verificationCommitmentId
          && !commitments.some((entry) => entry.commitment.id === link.verificationCommitmentId)) {
          storageInvalid();
        }
      }
      return {
        hypothesis: detail.item,
        evidenceLinks,
        verificationCommitments: commitments,
        rendering: 'dotted_annotation' as const,
      };
    });
}

export async function relationshipWorkspace(
  db: DbClient,
  rawContext: CommandContext,
  policy: CapabilityPolicy,
  query: { customerId: string; matterId: string },
  now = new Date(),
): Promise<RelationshipWorkspaceResponse> {
  const ctx = CommandContextSchema.parse(rawContext);
  requireCapability(policy);
  const formal = await formalProjection(db, ctx, query.customerId, query.matterId);
  const effectiveContext = { ...ctx, actorRole: formal.scope.actorRole };
  const peopleIds = new Set(formal.people.map((person) => person.id));
  const [candidateRelations, intelligence, focusList, hypotheses] = await Promise.all([
    candidateProjection(db, effectiveContext, policy, query.customerId, query.matterId, formal.people),
    listIntelligenceItems(db, effectiveContext, policy, IntelligenceItemListQuerySchema.parse({
      customerId: query.customerId,
      matterId: query.matterId,
      includeArchived: false,
      cursor: null,
      limit: 50,
    })).then((result) => [...result.items].sort((left, right) => left.id.localeCompare(right.id))),
    listStakeholderFocuses(db, effectiveContext, policy, StakeholderFocusListQuerySchema.parse({
      customerId: query.customerId,
      matterId: query.matterId,
      includeRetired: false,
      cursor: null,
      limit: 2,
    }), now),
    hypothesisProjection(db, effectiveContext, policy, query.customerId, query.matterId, peopleIds),
  ]);
  if (focusList.items.length > 1) storageInvalid();
  const parsed = RelationshipWorkspaceResponseSchema.safeParse({
    generatedAtUtc: now.toISOString(),
    customer: formal.customer,
    matter: formal.matter,
    people: formal.people,
    formalRelations: formal.formalRelations,
    candidateRelations,
    intelligence,
    focus: focusList.items[0] ?? null,
    hypotheses,
  });
  if (!parsed.success) storageInvalid();
  return parsed.data;
}

type ReviewReceiptWithoutReplay = Omit<ReviewHypothesisVerificationReceipt, 'replayed'>;

export async function assertHypothesisVerificationReviewAccess(
  db: DbClient,
  rawContext: CommandContext,
  policy: CapabilityPolicy,
  rawCommand: ReviewHypothesisVerificationCommand,
): Promise<void> {
  const ctx = CommandContextSchema.parse(rawContext);
  const command = ReviewHypothesisVerificationCommandSchema.parse(rawCommand);
  requireCapability(policy);
  if (ctx.assertionMode !== 'user_asserted') {
    throw new RelationshipWorkspaceError('human_confirmation_required', 403);
  }
  const scope = await resolveEffectiveResourceScope(db, currentPrincipal(ctx, ctx.actorRole));
  if (!scope.valid || !scope.canReadMatter(command.matterId)) notFound();
  if (scope.actorRole === 'viewer') {
    throw new RelationshipWorkspaceError('viewer_write_denied', 403);
  }
  const actor = await db.user.updateMany({
    where: { id: ctx.actorId, tenantId: ctx.tenantId, role: scope.actorRole },
    data: { role: scope.actorRole },
  });
  if (actor.count !== 1) notFound();
  const [customer, matter, commitment, hypothesis] = await Promise.all([
    db.account.findFirst({
      where: { id: command.customerId, tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true },
    }),
    db.opportunity.findFirst({
      where: {
        id: command.matterId,
        tenantId: ctx.tenantId,
        accountId: command.customerId,
        archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: { id: true },
    }),
    db.planAction.findFirst({
      where: {
        id: command.commitmentId,
        tenantId: ctx.tenantId,
        accountId: command.customerId,
        opportunityId: command.matterId,
        hypothesisId: command.salesHypothesisId,
        archivedAt: null,
      },
      select: { hypothesisRevisionId: true },
    }),
    db.salesHypothesis.findFirst({
      where: {
        id: command.salesHypothesisId,
        tenantId: ctx.tenantId,
        customerId: command.customerId,
        matterId: command.matterId,
      },
      select: { currentRevisionId: true },
    }),
  ]);
  if (!customer || !matter || !commitment || !hypothesis
    || commitment.hypothesisRevisionId !== command.expectedCurrentRevisionId) notFound();
  const replayRevision = command.disposition === 'revise'
    ? command.revision.id
    : command.expectedCurrentRevisionId;
  if (hypothesis.currentRevisionId !== command.expectedCurrentRevisionId
    && hypothesis.currentRevisionId !== replayRevision) notFound();
}

export async function executeHypothesisVerificationReview(
  db: DbClient,
  rawContext: CommandContext,
  policy: CapabilityPolicy,
  rawCommand: ReviewHypothesisVerificationCommand,
  now = new Date(),
): Promise<ReviewReceiptWithoutReplay> {
  const ctx = CommandContextSchema.parse(rawContext);
  const command = ReviewHypothesisVerificationCommandSchema.parse(rawCommand);
  await assertHypothesisVerificationReviewAccess(db, ctx, policy, command);
  const [commitment, hypothesis] = await Promise.all([
    db.planAction.findFirst({
      where: {
        id: command.commitmentId,
        tenantId: ctx.tenantId,
        accountId: command.customerId,
        opportunityId: command.matterId,
        hypothesisId: command.salesHypothesisId,
        hypothesisRevisionId: command.expectedCurrentRevisionId,
        archivedAt: null,
      },
    }),
    db.salesHypothesis.findFirst({
      where: {
        id: command.salesHypothesisId,
        tenantId: ctx.tenantId,
        customerId: command.customerId,
        matterId: command.matterId,
      },
      select: {
        id: true,
        customerId: true,
        matterId: true,
        version: true,
        currentRevisionId: true,
      },
    }),
  ]);
  if (!commitment || !hypothesis) notFound();
  if (commitment.verificationReviewDisposition.length > 0
    || commitment.verificationReviewedAtUtc
    || commitment.verificationReviewedByUserId) {
    throw new RelationshipWorkspaceError('hypothesis_verification_already_reviewed', 409);
  }
  if (commitment.version !== command.expectedCommitmentVersion
    || commitment.scheduleVersion !== command.expectedCommitmentScheduleVersion
    || hypothesis.version !== command.expectedHypothesisVersion
    || hypothesis.currentRevisionId !== command.expectedCurrentRevisionId) {
    throw new RelationshipWorkspaceError('hypothesis_verification_version_conflict', 409);
  }
  if (commitment.kind !== 'verification' || commitment.executionStatus !== 'completed') {
    throw new RelationshipWorkspaceError('hypothesis_verification_not_completed', 409);
  }
  const hasResult = commitment.completionResult.length > 0;
  const hasResultMetadata = Boolean(
    commitment.completionResultRecordedAtUtc && commitment.completionResultRecordedByUserId,
  );
  if (hasResult !== hasResultMetadata) storageInvalid();
  if (commitment.completionResultRecordedByUserId) {
    const recorder = await db.user.findFirst({
      where: { id: commitment.completionResultRecordedByUserId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!recorder) storageInvalid();
  }
  const links = await db.hypothesisEvidenceLink.findMany({
    where: {
      tenantId: ctx.tenantId,
      hypothesisId: command.salesHypothesisId,
      hypothesisRevisionId: command.expectedCurrentRevisionId,
      verificationCommitmentId: command.commitmentId,
    },
    select: { evidenceId: true, evidenceVersion: true },
  });
  const evidenceIds = [...new Set(links.map((link) => link.evidenceId))];
  const approvedEvidence = evidenceIds.length === 0 ? [] : await db.evidenceEvent.findMany({
    where: {
      tenantId: ctx.tenantId,
      accountId: command.customerId,
      opportunityId: command.matterId,
      status: 'approved',
      id: { in: evidenceIds },
    },
    select: { id: true },
  });
  if (links.some((link) => link.evidenceVersion !== 0)
    || approvedEvidence.length !== evidenceIds.length) storageInvalid();
  if (!hasResult && links.length === 0) {
    throw new RelationshipWorkspaceError('hypothesis_verification_proof_required', 409);
  }
  const locked = await db.planAction.updateMany({
    where: {
      id: commitment.id,
      tenantId: ctx.tenantId,
      accountId: command.customerId,
      opportunityId: command.matterId,
      hypothesisId: command.salesHypothesisId,
      hypothesisRevisionId: command.expectedCurrentRevisionId,
      archivedAt: null,
      kind: 'verification',
      executionStatus: 'completed',
      version: command.expectedCommitmentVersion,
      scheduleVersion: command.expectedCommitmentScheduleVersion,
      verificationReviewDisposition: '',
      verificationReviewedAtUtc: null,
      verificationReviewedByUserId: null,
    },
    data: { version: { increment: 0 } },
  });
  if (locked.count !== 1) {
    throw new RelationshipWorkspaceError('hypothesis_verification_version_conflict', 409);
  }

  const hypothesisCommand = command.disposition === 'keep'
    ? {
        type: 'UPDATE_SALES_HYPOTHESIS_REVIEW' as const,
        salesHypothesisId: command.salesHypothesisId,
        expectedVersion: command.expectedHypothesisVersion,
        ownerUserId: command.ownerUserId,
        nextReviewAt: command.nextReviewAt,
      }
    : command.disposition === 'revise'
      ? {
          type: 'REVISE_SALES_HYPOTHESIS' as const,
          salesHypothesisId: command.salesHypothesisId,
          expectedVersion: command.expectedHypothesisVersion,
          expectedCurrentRevisionId: command.expectedCurrentRevisionId,
          nextReviewAt: command.nextReviewAt,
          revision: command.revision,
        }
      : {
          type: 'SET_SALES_HYPOTHESIS_STATUS' as const,
          salesHypothesisId: command.salesHypothesisId,
          expectedVersion: command.expectedHypothesisVersion,
          status: 'retired' as const,
        };
  const hypothesisReceipt = await executeSalesHypothesisCommand(
    db,
    ctx,
    policy,
    hypothesisCommand,
    now,
  );
  const disposition = command.disposition === 'keep'
    ? 'kept' as const
    : command.disposition === 'revise' ? 'revised' as const : 'retired' as const;
  const reviewed = await db.planAction.updateMany({
    where: {
      id: commitment.id,
      tenantId: ctx.tenantId,
      accountId: command.customerId,
      opportunityId: command.matterId,
      hypothesisId: command.salesHypothesisId,
      hypothesisRevisionId: command.expectedCurrentRevisionId,
      version: command.expectedCommitmentVersion,
      scheduleVersion: command.expectedCommitmentScheduleVersion,
      verificationReviewDisposition: '',
      verificationReviewedAtUtc: null,
      verificationReviewedByUserId: null,
    },
    data: {
      verificationReviewDisposition: disposition,
      verificationReviewedAtUtc: now,
      verificationReviewedByUserId: ctx.actorId,
      version: { increment: 1 },
    },
  });
  if (reviewed.count !== 1) {
    throw new RelationshipWorkspaceError('hypothesis_verification_version_conflict', 409);
  }
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'hypothesis_verification_reviewed',
    entityKind: 'commitment',
    entityId: commitment.id,
    requestId: ctx.requestId,
    sourceRef: command.salesHypothesisId,
    changedFields: JSON.stringify([
      'verificationReviewDisposition',
      'verificationReviewedAtUtc',
      'verificationReviewedByUserId',
      'version',
    ]),
    metadata: JSON.stringify({
      customerId: command.customerId,
      matterId: command.matterId,
      salesHypothesisId: command.salesHypothesisId,
      previousRevisionId: command.expectedCurrentRevisionId,
      currentRevisionId: hypothesisReceipt.currentRevisionId,
      disposition,
      proof: hasResult ? 'result' : 'approved_evidence',
      approvedEvidenceCount: approvedEvidence.length,
      fromCommitmentVersion: command.expectedCommitmentVersion,
      toCommitmentVersion: command.expectedCommitmentVersion + 1,
      fromHypothesisVersion: command.expectedHypothesisVersion,
      toHypothesisVersion: hypothesisReceipt.version,
    }),
  } });
  return {
    type: 'REVIEW_HYPOTHESIS_VERIFICATION',
    customerId: command.customerId,
    matterId: command.matterId,
    commitmentId: command.commitmentId,
    salesHypothesisId: command.salesHypothesisId,
    previousRevisionId: command.expectedCurrentRevisionId,
    currentRevisionId: hypothesisReceipt.currentRevisionId,
    disposition,
    commitmentVersion: command.expectedCommitmentVersion + 1,
    hypothesisVersion: hypothesisReceipt.version,
    undoable: false,
  };
}
