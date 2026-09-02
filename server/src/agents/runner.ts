import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AgentOutputRefSchema,
  AgentPreparedAuditSchema,
  AgentRunReceiptSchema,
  AgentRunViewSchema,
  PostMeetingCandidateBatchSchema,
  RelationshipRadarSnapshotPayloadSchema,
  ResearchBriefPreparedPayloadSchema,
  type AgentJobDefinition,
  type AgentManualRunRequest,
  type AgentOutputRef,
  type AgentPreparedAudit,
  type AgentRunReceipt,
  type AgentRunView,
  type CapabilityPolicy,
  type CommandContext,
  type PostMeetingCandidateBatch,
  type RelationshipRadarSnapshotPayload,
  type ResearchBriefPreparedPayload,
} from '@jianghu/domain-contracts';
import { hashIdempotencyKey } from '../idempotency.js';
import {
  failReservedCommand,
  IdempotencyConflictError,
  reserveCommand,
  runCommand,
} from '../mutation/commandRunner.js';
import { readableReviewBatchById } from '../reviewBatches/service.js';
import {
  agentRequestHash,
  authorizeAgentRequest,
  validatePreparedEvidence,
  type AgentAuthorizationSnapshot,
} from './authorization.js';
import { AgentJobError } from './errors.js';
import {
  AgentPreparationError,
  registeredAgentHandler,
  type AgentCandidateCommitAdapter,
  type AgentJobHandler,
  type AgentJobHandlers,
  type AgentPreparationResult,
  type AgentRelationshipRadarCommitAdapter,
  type AgentRelationshipRadarCommitInput,
  type AgentResearchBriefCommitAdapter,
  type AgentResearchBriefCommitInput,
} from './model.js';
import { validatePreparedAgentAudit } from './policy.js';
import { hashAgentDefinition } from './registry.js';

const AGENT_LEASE_FLOOR_MS = 3 * 60_000;

export const agentRunSelect = {
  id: true,
  tenantId: true,
  definitionId: true,
  jobKey: true,
  jobVersion: true,
  definitionHash: true,
  definitionControlVersion: true,
  actionMode: true,
  trigger: true,
  status: true,
  customerId: true,
  matterId: true,
  sourceArtifactId: true,
  actorId: true,
  idempotencyKey: true,
  requestHash: true,
  attemptCount: true,
  maxAttempts: true,
  leaseToken: true,
  leaseExpiresAt: true,
  budgetLimit: true,
  costUsed: true,
  timeoutMs: true,
  authorizationFingerprint: true,
  inputRefs: true,
  evidenceRefs: true,
  outputRefs: true,
  modelRef: true,
  connectorRefs: true,
  failureCode: true,
  startedAt: true,
  completedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AgentRunRow = Prisma.AgentRunGetPayload<{ select: typeof agentRunSelect }>;

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function agentRunView(row: AgentRunRow): AgentRunView {
  return AgentRunViewSchema.parse({
    id: row.id,
    jobKey: row.jobKey,
    jobVersion: row.jobVersion,
    actionMode: row.actionMode,
    trigger: row.trigger,
    status: row.status,
    customerId: row.customerId,
    matterId: row.matterId,
    sourceArtifactId: row.sourceArtifactId,
    actorId: row.actorId,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    budgetLimit: row.budgetLimit,
    costUsed: row.costUsed,
    timeoutMs: row.timeoutMs,
    authorizationFingerprint: row.authorizationFingerprint,
    modelRef: row.modelRef,
    connectorRefs: parseJsonArray(row.connectorRefs),
    inputRefs: parseJsonArray(row.inputRefs),
    evidenceRefs: parseJsonArray(row.evidenceRefs),
    outputRefs: parseJsonArray(row.outputRefs),
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    version: row.version,
  });
}

async function auditRun(
  db: Prisma.TransactionClient,
  ctx: CommandContext,
  row: Pick<AgentRunRow, 'id' | 'jobKey' | 'jobVersion' | 'status' | 'attemptCount' | 'costUsed' | 'failureCode'>,
  action: string,
): Promise<void> {
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action,
    entityKind: 'agent_run',
    entityId: row.id,
    requestId: ctx.requestId ?? null,
    sourceRef: `${row.jobKey}@${row.jobVersion}`,
    changedFields: JSON.stringify(['status', 'attemptCount', 'costUsed', 'failureCode']),
    metadata: JSON.stringify({
      jobKey: row.jobKey,
      jobVersion: row.jobVersion,
      status: row.status,
      attemptCount: row.attemptCount,
      costUsed: row.costUsed,
      failureCode: row.failureCode,
    }),
  } });
}

function controlMatchesRun(row: AgentRunRow, authorization: AgentAuthorizationSnapshot): boolean {
  return Boolean(authorization.control)
    && authorization.control!.id === row.definitionId
    && authorization.control!.version === row.definitionControlVersion
    && hashAgentDefinition(authorization.definition) === row.definitionHash
    && authorization.limits.maxAttempts === row.maxAttempts
    && authorization.limits.maxCostUnits === row.budgetLimit
    && authorization.limits.timeoutMs === row.timeoutMs;
}

async function reserveAgentRun(
  db: PrismaClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
  request: AgentManualRunRequest,
  idempotencyKey: string,
) {
  const requestHash = agentRequestHash(request);
  const hashedKey = hashIdempotencyKey(idempotencyKey);
  return db.$transaction(async (tx) => {
    const authorization = await authorizeAgentRequest(
      tx, ctx, policy, handlers, definition, request, { execution: true },
    );
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(
      AGENT_LEASE_FLOOR_MS,
      authorization.limits.timeoutMs + 30_000,
    ));
    const existing = await tx.agentRun.findFirst({
      where: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        jobKey: definition.jobKey,
        jobVersion: definition.jobVersion,
        idempotencyKey: hashedKey,
      },
      select: agentRunSelect,
    });
    if (existing?.requestHash !== undefined && existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    if (existing && existing.status !== 'running') {
      return { replayed: true as const, row: existing, leaseToken: '' };
    }
    if (existing?.leaseExpiresAt && existing.leaseExpiresAt > now) {
      throw new AgentJobError('agent_run_in_progress', 409);
    }
    if (existing && !controlMatchesRun(existing, authorization)) {
      const discarded = await tx.agentRun.update({
        where: { id: existing.id },
        data: {
          status: 'discarded',
          failureCode: 'agent_control_changed',
          leaseToken: '',
          leaseExpiresAt: null,
          completedAt: now,
          version: { increment: 1 },
        },
        select: agentRunSelect,
      });
      await auditRun(tx, ctx, discarded, 'agent_run_discarded');
      return { replayed: true as const, row: discarded, leaseToken: '' };
    }
    let row: AgentRunRow;
    if (existing) {
      row = await tx.agentRun.update({
        where: { id: existing.id },
        data: {
          leaseToken,
          leaseExpiresAt,
          authorizationFingerprint: authorization.fingerprint,
          failureCode: '',
          completedAt: null,
          version: { increment: 1 },
        },
        select: agentRunSelect,
      });
    } else {
      if (!authorization.control) throw new AgentJobError('agent_control_invalid', 409);
      row = await tx.agentRun.create({
        data: {
          id: `agent_run_${randomUUID().replaceAll('-', '')}`,
          tenantId: ctx.tenantId,
          definitionId: authorization.control.id,
          jobKey: definition.jobKey,
          jobVersion: definition.jobVersion,
          definitionHash: hashAgentDefinition(definition),
          definitionControlVersion: authorization.control.version,
          actionMode: definition.actionMode,
          trigger: 'manual',
          customerId: request.customerId,
          matterId: request.matterId,
          sourceArtifactId: request.sourceArtifactId,
          actorId: ctx.actorId,
          idempotencyKey: hashedKey,
          requestHash,
          maxAttempts: authorization.limits.maxAttempts,
          leaseToken,
          leaseExpiresAt,
          budgetLimit: authorization.limits.maxCostUnits,
          timeoutMs: authorization.limits.timeoutMs,
          authorizationFingerprint: authorization.fingerprint,
          inputRefs: JSON.stringify(request.inputRefs),
          modelRef: definition.modelRef,
          connectorRefs: JSON.stringify(definition.connectorRefs),
        },
        select: agentRunSelect,
      });
      await auditRun(tx, ctx, row, 'agent_run_reserved');
    }
    return { replayed: false as const, row, leaseToken };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

async function beginAttempt(
  db: PrismaClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
  request: AgentManualRunRequest,
  run: AgentRunRow,
  leaseToken: string,
) {
  return db.$transaction(async (tx) => {
    const authorization = await authorizeAgentRequest(
      tx, ctx, policy, handlers, definition, request, { execution: true },
    );
    if (!controlMatchesRun(run, authorization)) {
      throw new AgentJobError('agent_control_changed', 409);
    }
    if (authorization.fingerprint !== run.authorizationFingerprint) {
      throw new AgentJobError('agent_authorization_changed', 409);
    }
    const changed = await tx.agentRun.updateMany({
      where: {
        id: run.id,
        tenantId: ctx.tenantId,
        status: 'running',
        leaseToken,
        version: run.version,
        attemptCount: { lt: run.maxAttempts },
      },
      data: {
        attemptCount: { increment: 1 },
        startedAt: run.startedAt ?? new Date(),
        authorizationFingerprint: authorization.fingerprint,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new AgentJobError('agent_run_conflict', 409);
    const row = await tx.agentRun.findFirstOrThrow({
      where: { id: run.id, tenantId: ctx.tenantId }, select: agentRunSelect,
    });
    return { authorization, row };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

async function terminalRun(
  db: PrismaClient,
  ctx: CommandContext,
  run: AgentRunRow,
  leaseToken: string,
  status: 'failed' | 'discarded',
  failureCode: string,
  costUsed = run.costUsed,
): Promise<AgentRunRow> {
  return db.$transaction(async (tx) => {
    const changed = await tx.agentRun.updateMany({
      where: {
        id: run.id,
        tenantId: ctx.tenantId,
        status: 'running',
        leaseToken,
      },
      data: {
        status,
        failureCode,
        costUsed,
        leaseToken: '',
        leaseExpiresAt: null,
        completedAt: new Date(),
        evidenceRefs: '[]',
        outputRefs: '[]',
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new AgentJobError('agent_run_conflict', 409);
    const row = await tx.agentRun.findFirstOrThrow({
      where: { id: run.id, tenantId: ctx.tenantId }, select: agentRunSelect,
    });
    await auditRun(tx, ctx, row, status === 'failed' ? 'agent_run_failed' : 'agent_run_discarded');
    return row;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

async function addAttemptCost(
  db: PrismaClient,
  ctx: CommandContext,
  run: AgentRunRow,
  leaseToken: string,
  costUnits: number,
): Promise<AgentRunRow> {
  const next = run.costUsed + costUnits;
  if (!Number.isSafeInteger(next) || next > run.budgetLimit) return run;
  const changed = await db.agentRun.updateMany({
    where: { id: run.id, tenantId: ctx.tenantId, status: 'running', leaseToken },
    data: { costUsed: next, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new AgentJobError('agent_run_conflict', 409);
  return db.agentRun.findFirstOrThrow({
    where: { id: run.id, tenantId: ctx.tenantId }, select: agentRunSelect,
  });
}

async function prepareWithTimeout(
  handler: AgentJobHandler,
  context: Omit<Parameters<AgentJobHandler['prepare']>[0], 'signal'>,
  timeoutMs: number,
): Promise<AgentPreparationResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preparation = Promise.resolve().then(() => handler.prepare({ ...context, signal: controller.signal }));
  preparation.catch(() => undefined);
  try {
    return await Promise.race([
      preparation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AgentPreparationError('agent_timeout', { retryable: true }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ParsedPreparation {
  audit: AgentPreparedAudit;
  privateState?: unknown;
}

function parsePreparation(raw: AgentPreparationResult): ParsedPreparation | null {
  const legacy = AgentPreparedAuditSchema.safeParse(raw);
  if (legacy.success) return { audit: legacy.data };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'audit' || keys[1] !== 'privateState'
    || record.privateState === undefined) return null;
  const audit = AgentPreparedAuditSchema.safeParse(record.audit);
  return audit.success ? { audit: audit.data, privateState: record.privateState } : null;
}

function samePrepared(left: AgentPreparedAudit, right: AgentPreparedAudit): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOutputRef(left: AgentOutputRef, right: AgentOutputRef): boolean {
  return left.kind === right.kind && left.id === right.id && left.version === right.version;
}

async function commitWithDeadline(
  handler: AgentJobHandler,
  context: Omit<Parameters<AgentJobHandler['commit']>[0], 'signal'>,
  prepared: AgentPreparedAudit,
  privateState: unknown,
  deadlineAt: number,
): Promise<AgentPreparedAudit> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new AgentJobError('agent_timeout', 409);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const committing = Promise.resolve().then(() => handler.commit({
    ...context,
    signal: controller.signal,
  }, prepared, privateState));
  committing.catch(() => undefined);
  try {
    return await Promise.race([
      committing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AgentJobError('agent_timeout', 409));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function validateOutputs(
  db: Prisma.TransactionClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  authorization: AgentAuthorizationSnapshot,
  request: AgentManualRunRequest,
  prepared: AgentPreparedAudit,
): Promise<void> {
  if (authorization.definition.actionMode !== 'candidate') return;
  for (const output of prepared.outputRefs) {
    if (output.kind !== 'review_batch') throw new AgentJobError('agent_output_forbidden', 409);
    const readable = await readableReviewBatchById(db, {
      ...ctx,
      actorRole: authorization.actorRole,
    }, policy, output.id, 'review');
    if (!readable
      || readable.batch.version !== output.version
      || readable.batch.accountId !== request.customerId
      || readable.batch.matterId !== request.matterId
      || readable.batch.sourceArtifactId !== request.sourceArtifactId) {
      throw new AgentJobError('agent_output_invalid', 409);
    }
  }
}

async function commitPrepared(
  db: PrismaClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
  request: AgentManualRunRequest,
  handler: AgentJobHandler,
  run: AgentRunRow,
  leaseToken: string,
  prepared: AgentPreparedAudit,
  privateState: unknown,
  totalCost: number,
  deadlineAt: number,
  candidateCommitAdapter?: AgentCandidateCommitAdapter,
  researchBriefCommitAdapter?: AgentResearchBriefCommitAdapter,
  relationshipRadarCommitAdapter?: AgentRelationshipRadarCommitAdapter,
): Promise<AgentRunRow> {
  return db.$transaction(async (tx) => {
    const authorization = await authorizeAgentRequest(
      tx, ctx, policy, handlers, definition, request, { execution: true },
    );
    if (!controlMatchesRun(run, authorization)) {
      throw new AgentJobError('agent_control_changed', 409);
    }
    if (authorization.fingerprint !== run.authorizationFingerprint) {
      throw new AgentJobError('agent_authorization_changed', 409);
    }
    const normalized = AgentPreparedAuditSchema.parse({ ...prepared, costUnits: totalCost });
    const policyResult = validatePreparedAgentAudit(definition, normalized, authorization.limits);
    if (!policyResult.ok) throw new AgentJobError(policyResult.code, 409);
    validatePreparedEvidence(authorization, normalized);
    if (definition.actionMode !== 'candidate') {
      await validateOutputs(tx, ctx, policy, authorization, request, normalized);
    }

    const commitIdentity = {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      requestId: ctx.requestId ?? null,
      runId: run.id,
      definition,
      customerId: request.customerId,
      matterId: request.matterId,
      sourceArtifactId: request.sourceArtifactId,
      inputRefs: request.inputRefs,
      authorizationFingerprint: authorization.fingerprint,
    };
    let candidateCommitCalls = 0;
    let candidatePortMisused = false;
    let candidatePortOutput: AgentOutputRef | null = null;
    const commitCandidateBatch = async (raw: PostMeetingCandidateBatch): Promise<AgentOutputRef> => {
      if (definition.actionMode !== 'candidate' || candidateCommitCalls !== 0) {
        candidatePortMisused = true;
        throw new AgentJobError('agent_candidate_port_misuse', 409);
      }
      candidateCommitCalls += 1;
      if (!candidateCommitAdapter) {
        throw new AgentJobError('agent_candidate_commit_unavailable', 409);
      }
      if (Date.now() > deadlineAt) throw new AgentJobError('agent_timeout', 409);
      const batch = PostMeetingCandidateBatchSchema.safeParse(raw);
      if (!batch.success
        || batch.data.customerId !== request.customerId
        || batch.data.matterId !== request.matterId
        || batch.data.sourceArtifactId !== request.sourceArtifactId) {
        throw new AgentJobError('agent_candidate_batch_invalid', 409);
      }
      const currentSource = request.sourceArtifactId
        ? authorization.sources.get(request.sourceArtifactId)
        : undefined;
      const evidenceByLocator = new Map(normalized.evidenceRefs.map((ref) => [ref.locatorId, ref]));
      if (!currentSource
        || normalized.evidenceRefs.length !== batch.data.items.length
        || evidenceByLocator.size !== normalized.evidenceRefs.length
        || normalized.evidenceRefs.some((ref) => (
          ref.sourceArtifactId !== request.sourceArtifactId
          || ref.sourceFingerprint !== currentSource.sourceFingerprint
        ))
        || batch.data.items.some((item) => !evidenceByLocator.has(item.sourceLocator))) {
        throw new AgentJobError('agent_candidate_evidence_mismatch', 409);
      }
      const output = AgentOutputRefSchema.safeParse(await candidateCommitAdapter({
        tx,
        ...commitIdentity,
        sourceFingerprint: currentSource.sourceFingerprint,
        sourceAclVersion: currentSource.aclVersion,
      }, batch.data));
      if (!output.success || output.data.kind !== 'review_batch'
        || normalized.outputRefs.length !== 1
        || !sameOutputRef(output.data, normalized.outputRefs[0]!)) {
        throw new AgentJobError('agent_candidate_output_mismatch', 409);
      }
      candidatePortOutput = output.data;
      return output.data;
    };

    const usesResearchBriefPort = handler.commitPort === 'research_brief';
    const researchBriefPortAllowed = definition.jobKey === 'pre_meeting_brief'
      && definition.jobVersion === 'core-206.v1'
      && definition.actionMode === 'read_only';
    let researchBriefCommitCalls = 0;
    let researchBriefPortMisused = false;
    let researchBriefPortOutput: AgentOutputRef | null = null;
    const commitResearchBrief = async (raw: AgentResearchBriefCommitInput): Promise<AgentOutputRef> => {
      if (!usesResearchBriefPort || !researchBriefPortAllowed || researchBriefCommitCalls !== 0) {
        researchBriefPortMisused = true;
        throw new AgentJobError('agent_research_brief_port_misuse', 409);
      }
      researchBriefCommitCalls += 1;
      if (!researchBriefCommitAdapter) {
        throw new AgentJobError('agent_research_brief_commit_unavailable', 409);
      }
      if (Date.now() > deadlineAt) throw new AgentJobError('agent_timeout', 409);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).sort().join(',') !== 'generatedAt,payload'
        || typeof raw.generatedAt !== 'string') {
        throw new AgentJobError('agent_research_brief_payload_invalid', 409);
      }
      const generatedAt = new Date(raw.generatedAt);
      const payload = ResearchBriefPreparedPayloadSchema.safeParse(raw.payload);
      if (!Number.isFinite(generatedAt.getTime())
        || generatedAt.toISOString() !== raw.generatedAt
        || !payload.success
        || payload.data.subject.crmCustomerId !== request.customerId) {
        throw new AgentJobError('agent_research_brief_payload_invalid', 409);
      }
      const currentSource = request.sourceArtifactId
        ? authorization.sources.get(request.sourceArtifactId)
        : undefined;
      if (!currentSource
        || normalized.evidenceRefs.length !== 1
        || normalized.evidenceRefs[0]?.sourceArtifactId !== request.sourceArtifactId
        || normalized.evidenceRefs[0]?.sourceFingerprint !== currentSource.sourceFingerprint) {
        throw new AgentJobError('agent_research_brief_evidence_mismatch', 409);
      }
      const commitInput: AgentResearchBriefCommitInput = {
        generatedAt: raw.generatedAt,
        payload: payload.data as ResearchBriefPreparedPayload,
      };
      const output = AgentOutputRefSchema.safeParse(await researchBriefCommitAdapter({
        tx,
        ...commitIdentity,
        actorRole: authorization.actorRole,
        sourceFingerprint: currentSource.sourceFingerprint,
        sourceAclVersion: currentSource.aclVersion,
      }, commitInput));
      if (!output.success || output.data.kind !== 'research_brief'
        || normalized.outputRefs.length !== 1
        || !sameOutputRef(output.data, normalized.outputRefs[0]!)) {
        throw new AgentJobError('agent_research_brief_output_mismatch', 409);
      }
      const persisted = await tx.researchBriefSnapshot.findFirst({
        where: {
          id: output.data.id,
          tenantId: ctx.tenantId,
          createdByUserId: ctx.actorId,
          customerId: request.customerId,
          matterId: request.matterId,
          version: output.data.version,
        },
        select: { id: true },
      });
      if (!persisted) throw new AgentJobError('agent_research_brief_output_invalid', 409);
      researchBriefPortOutput = output.data;
      return output.data;
    };

    if (usesResearchBriefPort && !researchBriefPortAllowed) {
      throw new AgentJobError('agent_research_brief_port_forbidden', 409);
    }

    const usesRelationshipRadarPort = handler.commitPort === 'relationship_radar';
    const relationshipRadarPortAllowed = definition.jobKey === 'relationship_radar'
      && definition.jobVersion === 'saas-212.v1'
      && definition.actionMode === 'draft';
    let relationshipRadarCommitCalls = 0;
    let relationshipRadarPortMisused = false;
    let relationshipRadarPortOutputs: readonly AgentOutputRef[] | null = null;
    const commitRelationshipRadar = async (
      raw: AgentRelationshipRadarCommitInput,
    ): Promise<readonly AgentOutputRef[]> => {
      if (!usesRelationshipRadarPort
        || !relationshipRadarPortAllowed
        || relationshipRadarCommitCalls !== 0) {
        relationshipRadarPortMisused = true;
        throw new AgentJobError('agent_relationship_radar_port_misuse', 409);
      }
      relationshipRadarCommitCalls += 1;
      if (!relationshipRadarCommitAdapter) {
        throw new AgentJobError('agent_relationship_radar_commit_unavailable', 409);
      }
      if (Date.now() > deadlineAt) throw new AgentJobError('agent_timeout', 409);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).sort().join(',') !== 'generatedAt,payload,sourceSetHash'
        || typeof raw.generatedAt !== 'string'
        || typeof raw.sourceSetHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(raw.sourceSetHash)) {
        throw new AgentJobError('agent_relationship_radar_payload_invalid', 409);
      }
      const generatedAt = new Date(raw.generatedAt);
      const payload = RelationshipRadarSnapshotPayloadSchema.safeParse(raw.payload);
      if (!Number.isFinite(generatedAt.getTime())
        || generatedAt.toISOString() !== raw.generatedAt
        || !payload.success
        || request.matterId === null
        || payload.data.customerId !== request.customerId
        || payload.data.matterId !== request.matterId
        || payload.data.generatedAtUtc !== raw.generatedAt
        || normalized.evidenceRefs.length !== 0) {
        throw new AgentJobError('agent_relationship_radar_payload_invalid', 409);
      }
      const expectedRefs: AgentOutputRef[] = [
        ...payload.data.signals.map((item) => ({
          kind: 'relationship_signal' as const, id: item.id, version: 1,
        })),
        ...payload.data.interventions.map((item) => ({
          kind: 'intervention_item' as const, id: item.id, version: 1,
        })),
        ...payload.data.drafts.map((item) => ({
          kind: 'draft_action' as const, id: item.id, version: 1,
        })),
      ];
      if (JSON.stringify(normalized.outputRefs) !== JSON.stringify(expectedRefs)) {
        throw new AgentJobError('agent_relationship_radar_output_mismatch', 409);
      }
      const commitInput: AgentRelationshipRadarCommitInput = {
        generatedAt: raw.generatedAt,
        payload: payload.data as RelationshipRadarSnapshotPayload,
        sourceSetHash: raw.sourceSetHash,
      };
      const rawOutputs = await relationshipRadarCommitAdapter({
        tx,
        ...commitIdentity,
        actorRole: authorization.actorRole,
      }, commitInput);
      if (!Array.isArray(rawOutputs)) {
        throw new AgentJobError('agent_relationship_radar_output_mismatch', 409);
      }
      const outputs = rawOutputs.map((output) => AgentOutputRefSchema.safeParse(output));
      if (outputs.some((output) => !output.success)) {
        throw new AgentJobError('agent_relationship_radar_output_mismatch', 409);
      }
      const parsedOutputs = outputs.map((output) => output.data!);
      if (JSON.stringify(parsedOutputs) !== JSON.stringify(expectedRefs)) {
        throw new AgentJobError('agent_relationship_radar_output_mismatch', 409);
      }
      const persisted = await tx.relationshipRadarSnapshot.findFirst({
        where: {
          tenantId: ctx.tenantId,
          agentRunId: run.id,
          createdByUserId: ctx.actorId,
          customerId: request.customerId,
          matterId: request.matterId,
          version: 1,
        },
        select: { id: true },
      });
      if (!persisted) throw new AgentJobError('agent_relationship_radar_output_invalid', 409);
      relationshipRadarPortOutputs = parsedOutputs;
      return parsedOutputs;
    };

    if (usesRelationshipRadarPort && !relationshipRadarPortAllowed) {
      throw new AgentJobError('agent_relationship_radar_port_forbidden', 409);
    }

    const committedRaw = await commitWithDeadline(handler, {
      ...commitIdentity,
      ...(definition.actionMode === 'candidate' ? { commitCandidateBatch } : {}),
      ...(usesResearchBriefPort && researchBriefPortAllowed ? { commitResearchBrief } : {}),
      ...(usesRelationshipRadarPort && relationshipRadarPortAllowed
        ? { commitRelationshipRadar }
        : {}),
    }, normalized, privateState, deadlineAt);
    if (Date.now() > deadlineAt) throw new AgentJobError('agent_timeout', 409);
    const committed = AgentPreparedAuditSchema.parse(committedRaw);
    if (!samePrepared(normalized, committed)) throw new AgentJobError('agent_commit_contract_invalid', 409);
    if (candidatePortMisused || (candidateCommitCalls > 0 && candidatePortOutput === null)) {
      throw new AgentJobError('agent_candidate_port_misuse', 409);
    }
    if (usesResearchBriefPort && (
      researchBriefPortMisused
      || researchBriefCommitCalls !== 1
      || researchBriefPortOutput === null
    )) {
      throw new AgentJobError('agent_research_brief_port_misuse', 409);
    }
    if (usesRelationshipRadarPort && (
      relationshipRadarPortMisused
      || relationshipRadarCommitCalls !== 1
      || relationshipRadarPortOutputs === null
    )) {
      throw new AgentJobError('agent_relationship_radar_port_misuse', 409);
    }
    await validateOutputs(tx, ctx, policy, authorization, request, committed);
    const changed = await tx.agentRun.updateMany({
      where: {
        id: run.id,
        tenantId: ctx.tenantId,
        status: 'running',
        leaseToken,
      },
      data: {
        status: 'succeeded',
        costUsed: totalCost,
        authorizationFingerprint: authorization.fingerprint,
        evidenceRefs: JSON.stringify(committed.evidenceRefs),
        outputRefs: JSON.stringify(committed.outputRefs),
        failureCode: '',
        leaseToken: '',
        leaseExpiresAt: null,
        completedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new AgentJobError('agent_run_conflict', 409);
    const row = await tx.agentRun.findFirstOrThrow({
      where: { id: run.id, tenantId: ctx.tenantId }, select: agentRunSelect,
    });
    await auditRun(tx, ctx, row, 'agent_run_succeeded');
    return row;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

function authorizationFailure(error: unknown): boolean {
  return error instanceof AgentJobError && [
    'agent_actor_invalid',
    'viewer_write_denied',
    'capability_denied',
    'agent_resource_not_found',
    'agent_job_disabled',
    'agent_job_unavailable',
    'agent_control_invalid',
    'agent_control_changed',
    'agent_authorization_changed',
    'agent_scope_version_conflict',
  ].includes(error.code);
}

async function executeAgentRun(
  db: PrismaClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
  request: AgentManualRunRequest,
  initial: AgentRunRow,
  leaseToken: string,
  candidateCommitAdapter?: AgentCandidateCommitAdapter,
  researchBriefCommitAdapter?: AgentResearchBriefCommitAdapter,
  relationshipRadarCommitAdapter?: AgentRelationshipRadarCommitAdapter,
): Promise<AgentRunRow> {
  const handler = registeredAgentHandler(handlers, definition);
  if (!handler) return terminalRun(db, ctx, initial, leaseToken, 'discarded', 'agent_job_unavailable');
  let run = initial;
  while (run.attemptCount < run.maxAttempts) {
    let begun: Awaited<ReturnType<typeof beginAttempt>>;
    try {
      begun = await beginAttempt(db, ctx, policy, handlers, definition, request, run, leaseToken);
      run = begun.row;
    } catch (error) {
      return terminalRun(db, ctx, run, leaseToken, 'discarded', 'agent_authorization_revoked');
    }

    const deadlineAt = Date.now() + run.timeoutMs;
    let prepared: AgentPreparationResult;
    try {
      prepared = await prepareWithTimeout(handler, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        requestId: ctx.requestId ?? null,
        runId: run.id,
        definition,
        limits: begun.authorization.limits,
        customerId: request.customerId,
        matterId: request.matterId,
        sourceArtifactId: request.sourceArtifactId,
        inputRefs: request.inputRefs,
        attempt: run.attemptCount,
        budgetRemaining: Math.max(0, run.budgetLimit - run.costUsed),
      }, run.timeoutMs);
    } catch (error) {
      const safe = error instanceof AgentPreparationError
        ? error
        : new AgentPreparationError('agent_preparation_failed');
      if (run.costUsed + safe.costUnits > run.budgetLimit) {
        return terminalRun(db, ctx, run, leaseToken, 'failed', 'agent_budget_exceeded', run.costUsed);
      }
      if (safe.costUnits > 0) run = await addAttemptCost(db, ctx, run, leaseToken, safe.costUnits);
      if (safe.retryable && run.attemptCount < run.maxAttempts) continue;
      return terminalRun(db, ctx, run, leaseToken, 'failed', safe.code, run.costUsed);
    }

    const parsed = parsePreparation(prepared);
    if (!parsed) {
      return terminalRun(db, ctx, run, leaseToken, 'failed', 'agent_output_invalid', run.costUsed);
    }
    const totalCost = run.costUsed + parsed.audit.costUnits;
    if (!Number.isSafeInteger(totalCost) || totalCost > run.budgetLimit) {
      return terminalRun(db, ctx, run, leaseToken, 'failed', 'agent_budget_exceeded', run.costUsed);
    }
    try {
      return await commitPrepared(
        db, ctx, policy, handlers, definition, request, handler,
        run, leaseToken, parsed.audit, parsed.privateState, totalCost, deadlineAt,
        candidateCommitAdapter, researchBriefCommitAdapter,
        relationshipRadarCommitAdapter,
      );
    } catch (error) {
      if (authorizationFailure(error)) {
        return terminalRun(db, ctx, run, leaseToken, 'discarded', 'agent_authorization_revoked', run.costUsed);
      }
      const code = error instanceof AgentJobError ? error.code : 'agent_commit_failed';
      return terminalRun(db, ctx, run, leaseToken, 'failed', code, run.costUsed);
    }
  }
  return terminalRun(db, ctx, run, leaseToken, 'failed', 'agent_attempts_exhausted', run.costUsed);
}

export async function runManualAgentJob(
  db: PrismaClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
  request: AgentManualRunRequest,
  idempotencyKey: string,
  candidateCommitAdapter?: AgentCandidateCommitAdapter,
  researchBriefCommitAdapter?: AgentResearchBriefCommitAdapter,
  relationshipRadarCommitAdapter?: AgentRelationshipRadarCommitAdapter,
): Promise<AgentRunReceipt> {
  const commandInput = {
    kind: `agent-job-run:${definition.jobKey}:${definition.jobVersion}`,
    idempotencyKey,
    payload: request,
    authorizeReplay: async (tx: Prisma.TransactionClient) => {
      await authorizeAgentRequest(tx, ctx, policy, handlers, definition, request, { execution: true });
    },
  };
  // This read-only preflight is intentionally before CommandRun reservation so
  // viewers and hidden resources produce no transport, run, or audit row.
  await db.$transaction(
    (tx) => authorizeAgentRequest(tx, ctx, policy, handlers, definition, request, { execution: true }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 30_000 },
  );
  const reservation = await reserveCommand<AgentRunReceipt>(ctx, commandInput, db);
  if (reservation.replayed) {
    return AgentRunReceiptSchema.parse({ ...reservation.result, replayed: true });
  }

  let reserved: Awaited<ReturnType<typeof reserveAgentRun>>;
  try {
    reserved = await reserveAgentRun(db, ctx, policy, handlers, definition, request, idempotencyKey);
  } catch (error) {
    await failReservedCommand(ctx, commandInput, reservation.reservationToken, error, db);
    throw error;
  }
  const finalRow = reserved.replayed
    ? reserved.row
    : await executeAgentRun(
        db, ctx, policy, handlers, definition, request, reserved.row, reserved.leaseToken,
        candidateCommitAdapter, researchBriefCommitAdapter,
        relationshipRadarCommitAdapter,
      );
  const receipt = AgentRunReceiptSchema.parse({ run: agentRunView(finalRow), replayed: false });
  const completed = await runCommand(ctx, {
    ...commandInput,
    reservationToken: reservation.reservationToken,
  }, async () => receipt, db);
  return AgentRunReceiptSchema.parse({
    ...completed.result,
    replayed: completed.replayed || reserved.replayed,
  });
}
