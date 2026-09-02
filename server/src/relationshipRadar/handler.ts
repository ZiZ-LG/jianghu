import type { PrismaClient } from '@prisma/client';
import {
  AgentPreparedAuditSchema,
  RelationshipRadarSnapshotPayloadSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { AgentJobError } from '../agents/errors.js';
import {
  AgentPreparationError,
  type AgentJobHandler,
  type AgentJobHandlers,
} from '../agents/model.js';
import { parseStoredIntelligenceTargets } from '../intelligenceFocus/model.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import {
  createSensitiveAccessEvaluator,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import type { RelationshipRadarFacts } from './model.js';
import { buildRelationshipRadarSnapshot } from './rules.js';

type ActorRole = 'owner' | 'admin' | 'member' | 'viewer';

export class RelationshipRadarError extends Error {
  readonly scopedNotFound: boolean;

  constructor(readonly code: string, readonly statusCode = 409, scopedNotFound = false) {
    super(code);
    this.name = 'RelationshipRadarError';
    this.scopedNotFound = scopedNotFound;
  }
}

function notFound(): never {
  throw new RelationshipRadarError('relationship_radar_not_found', 404, true);
}

function storageInvalid(): never {
  throw new RelationshipRadarError('relationship_radar_storage_invalid', 409);
}

function canonicalInstant(value: Date): string {
  if (!Number.isFinite(value.getTime())) storageInvalid();
  return value.toISOString();
}

function evidenceInstant(value: string, fallback: Date): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : canonicalInstant(fallback);
}

function commitmentInstant(row: {
  executionStatus: string;
  completionResultRecordedAtUtc: Date | null;
  scheduledAtUtc: Date | null;
  dueAtUtc: Date | null;
  createdAt: Date;
}): string {
  if (row.executionStatus === 'completed' && row.completionResultRecordedAtUtc) {
    return canonicalInstant(row.completionResultRecordedAtUtc);
  }
  return canonicalInstant(row.scheduledAtUtc ?? row.dueAtUtc ?? row.createdAt);
}

export async function loadRelationshipRadarFacts(
  db: DbClient,
  ctx: Pick<CommandContext, 'tenantId' | 'actorId' | 'actorRole'>,
  policy: CapabilityPolicy,
  customerId: string,
  matterId: string,
  generatedAt: Date,
): Promise<RelationshipRadarFacts> {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new RelationshipRadarError('capability_denied', 403);
  }
  const generatedAtUtc = canonicalInstant(generatedAt);
  const principal = {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole ?? 'viewer' as ActorRole,
  };
  const scope = await resolveEffectiveResourceScope(db, principal);
  if (!scope.valid || !scope.canReadMatter(matterId)) notFound();

  const [customer, matter] = await Promise.all([
    db.account.findFirst({
      where: { id: customerId, tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true, version: true },
    }),
    db.opportunity.findFirst({
      where: {
        id: matterId,
        tenantId: ctx.tenantId,
        accountId: customerId,
        archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: { id: true, accountId: true, version: true },
    }),
  ]);
  if (!customer || !matter || !scope.canReadAccountContainer(customer.id)) notFound();

  const participants = await db.matterParticipant.findMany({
    where: {
      tenantId: ctx.tenantId,
      accountId: customerId,
      opportunityId: matterId,
      account: { tenantId: ctx.tenantId, archivedAt: null },
      opportunity: {
        tenantId: ctx.tenantId,
        accountId: customerId,
        archivedAt: null,
      },
      person: {
        tenantId: ctx.tenantId,
        accountId: customerId,
        archivedAt: null,
        mergedIntoPersonId: null,
      },
    },
    orderBy: { id: 'asc' },
    select: { id: true, personId: true },
  });
  const participantIds = new Set(participants.map((item) => item.personId));

  const [rawRelations, rawInteractions, evidence, intelligence, focus, commitments] = await Promise.all([
    db.edge.findMany({
      where: {
        tenantId: ctx.tenantId,
        accountId: customerId,
        account: { tenantId: ctx.tenantId, archivedAt: null },
        OR: [{ opportunityId: matterId }, { opportunityId: null }],
      },
      orderBy: { id: 'asc' },
      select: { id: true, source: true, target: true, version: true, directed: true },
    }),
    db.interaction.findMany({
      where: { tenantId: ctx.tenantId, accountId: customerId, matterId },
      orderBy: { id: 'asc' },
      select: { id: true, version: true, occurredAt: true, sourceArtifactId: true },
    }),
    db.evidenceEvent.findMany({
      where: {
        tenantId: ctx.tenantId,
        accountId: customerId,
        opportunityId: matterId,
        status: 'approved',
      },
      orderBy: { id: 'asc' },
      select: { id: true, personId: true, occurredAt: true, createdAt: true },
    }),
    db.intelligenceItem.findMany({
      where: { tenantId: ctx.tenantId, customerId, matterId, archivedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, version: true, targetRefs: true, learnedAt: true },
    }),
    db.stakeholderFocus.findFirst({
      where: {
        tenantId: ctx.tenantId,
        customerId,
        matterId,
        activeMatterKey: matterId,
        retiredAt: null,
        validUntil: { gt: generatedAt },
      },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'asc' }],
      select: { id: true, personId: true, version: true, confirmedAt: true },
    }),
    db.planAction.findMany({
      where: {
        tenantId: ctx.tenantId,
        accountId: customerId,
        opportunityId: matterId,
        archivedAt: null,
        executionStatus: { in: ['planned', 'completed'] },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        personId: true,
        version: true,
        scheduleVersion: true,
        executionStatus: true,
        completionResultRecordedAtUtc: true,
        scheduledAtUtc: true,
        dueAtUtc: true,
        createdAt: true,
      },
    }),
  ]);

  if (focus && !participantIds.has(focus.personId)) storageInvalid();

  const artifactIds = [...new Set(rawInteractions.map((item) => item.sourceArtifactId))];
  const artifacts = artifactIds.length === 0 ? [] : await db.sourceArtifact.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: artifactIds },
      accountId: customerId,
      matterId,
      retentionState: { notIn: ['deleted', 'degraded'] },
    },
    select: {
      id: true,
      tenantId: true,
      accountId: true,
      matterId: true,
      personId: true,
      createdByUserId: true,
      visibility: true,
      aclVersion: true,
    },
  });
  const evaluator = await createSensitiveAccessEvaluator(db, principal, policy);
  const access = await evaluator.authorizeMany(artifacts.map(sourceArtifactDescriptor), 'read');
  const readableArtifactIds = new Set(artifacts
    .filter((_item, index) => access[index]?.allowed === true)
    .map((item) => item.id));

  const relations = rawRelations
    .filter((item) => participantIds.has(item.source) && participantIds.has(item.target))
    .map((item) => ({
      id: item.id,
      sourcePersonId: item.source,
      targetPersonId: item.target,
      version: item.version,
      directed: item.directed,
    }));
  const interactionFacts = rawInteractions
    .filter((item) => readableArtifactIds.has(item.sourceArtifactId))
    .map((item) => ({
      id: item.id,
      version: item.version,
      occurredAtUtc: canonicalInstant(item.occurredAt),
    }));
  const evidenceFacts = evidence.map((item) => ({
    id: item.id,
    personId: participantIds.has(item.personId) ? item.personId : null,
    occurredAtUtc: evidenceInstant(item.occurredAt, item.createdAt),
  }));
  const intelligenceFacts = intelligence.map((item) => {
    let targets;
    try {
      targets = parseStoredIntelligenceTargets(item.targetRefs);
    } catch {
      storageInvalid();
    }
    return {
      id: item.id,
      version: item.version,
      targetPersonIds: [...new Set(targets
        .filter((target) => target.kind === 'person' && participantIds.has(target.id))
        .map((target) => target.id))].sort(),
      learnedAtUtc: canonicalInstant(item.learnedAt),
    };
  });
  const commitmentFacts = commitments.map((item) => ({
    id: item.id,
    personId: item.personId && participantIds.has(item.personId) ? item.personId : null,
    version: item.version,
    scheduleVersion: item.scheduleVersion,
    executionStatus: item.executionStatus as 'planned' | 'completed',
    indicatorAtUtc: commitmentInstant(item),
  }));

  return {
    tenantId: ctx.tenantId,
    customerId: customer.id,
    customerVersion: customer.version,
    matterId: matter.id,
    matterVersion: matter.version,
    generatedAtUtc,
    interactions: interactionFacts,
    participants,
    relations,
    evidence: evidenceFacts,
    intelligence: intelligenceFacts,
    focus: focus ? {
      id: focus.id,
      personId: focus.personId,
      version: focus.version,
      confirmedAtUtc: canonicalInstant(focus.confirmedAt),
    } : null,
    commitments: commitmentFacts,
  };
}

export function createRelationshipRadarHandler(
  db: PrismaClient,
  policy: CapabilityPolicy,
  clock: () => Date = () => new Date(),
): AgentJobHandler {
  return {
    commitPort: 'relationship_radar',
    async prepare(context) {
      if (context.definition.jobKey !== 'relationship_radar'
        || context.definition.jobVersion !== 'saas-212.v1'
        || context.definition.actionMode !== 'draft'
        || context.matterId === null) {
        throw new AgentPreparationError('relationship_radar_handler_scope_invalid');
      }
      const generatedAt = clock();
      const facts = await loadRelationshipRadarFacts(db, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        actorRole: 'viewer',
      }, policy, context.customerId, context.matterId, generatedAt);
      if (context.signal.aborted) {
        throw new AgentPreparationError('agent_timeout', { retryable: true });
      }
      const built = buildRelationshipRadarSnapshot(facts);
      return {
        audit: AgentPreparedAuditSchema.parse({
          costUnits: 1,
          evidenceRefs: [],
          outputRefs: built.outputRefs,
        }),
        privateState: {
          generatedAt: facts.generatedAtUtc,
          payload: built.payload,
          sourceSetHash: built.sourceSetHash,
        },
      };
    },

    async commit(context, prepared, rawPrivateState) {
      if (!rawPrivateState || typeof rawPrivateState !== 'object' || Array.isArray(rawPrivateState)) {
        throw new AgentJobError('relationship_radar_commit_payload_invalid', 409);
      }
      const record = rawPrivateState as Record<string, unknown>;
      if (Object.keys(record).sort().join(',') !== 'generatedAt,payload,sourceSetHash'
        || typeof record.generatedAt !== 'string'
        || typeof record.sourceSetHash !== 'string') {
        throw new AgentJobError('relationship_radar_commit_payload_invalid', 409);
      }
      const generatedAt = new Date(record.generatedAt);
      const payload = RelationshipRadarSnapshotPayloadSchema.safeParse(record.payload);
      if (!Number.isFinite(generatedAt.getTime())
        || generatedAt.toISOString() !== record.generatedAt
        || !/^[a-f0-9]{64}$/.test(record.sourceSetHash)
        || !payload.success) {
        throw new AgentJobError('relationship_radar_commit_payload_invalid', 409);
      }
      if (!context.commitRelationshipRadar) {
        throw new AgentJobError('agent_relationship_radar_commit_unavailable', 409);
      }
      await context.commitRelationshipRadar({
        generatedAt: record.generatedAt,
        payload: payload.data,
        sourceSetHash: record.sourceSetHash,
      });
      return prepared;
    },
  };
}

export function productionRelationshipRadarHandlers(
  db: PrismaClient,
  policy: CapabilityPolicy,
  clock: () => Date = () => new Date(),
): AgentJobHandlers {
  return Object.freeze({
    'relationship_radar@saas-212.v1': createRelationshipRadarHandler(db, policy, clock),
  });
}
