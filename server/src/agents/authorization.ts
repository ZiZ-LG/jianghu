import { createHash } from 'node:crypto';
import {
  AgentManualRunRequestSchema,
  capabilityPolicyAllows,
  type AgentJobControlLimits,
  type AgentJobDefinition,
  type AgentManualRunRequest,
  type AgentPreparedAudit,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import type { Prisma } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import type { EffectiveResourceScope } from '../resourceScope.js';
import {
  createSensitiveAccessEvaluator,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import { sourceArtifactMetadataIsValid } from '../sourceArtifacts/service.js';
import { AgentJobError, agentScopedNotFound } from './errors.js';
import type { AgentJobHandlers } from './model.js';
import { registeredAgentHandler } from './model.js';
import { agentControlRow, type AgentControlRow } from './repository.js';
import { effectiveAgentControl } from './policy.js';
import { hashAgentDefinition } from './registry.js';

const sourceSelect = {
  id: true,
  tenantId: true,
  accountId: true,
  matterId: true,
  personId: true,
  backingKind: true,
  backingId: true,
  artifactKind: true,
  source: true,
  externalRef: true,
  idempotencyDomain: true,
  title: true,
  occurredAt: true,
  fingerprintKind: true,
  sourceFingerprint: true,
  retentionState: true,
  retentionUpdatedAt: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AgentSourceRow = Prisma.SourceArtifactGetPayload<{ select: typeof sourceSelect }>;

export interface AgentAuthorizationSnapshot {
  definition: AgentJobDefinition;
  control: AgentControlRow | null;
  limits: AgentJobControlLimits;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
  accountVersion: number;
  matterVersion: number | null;
  sources: ReadonlyMap<string, AgentSourceRow>;
  fingerprint: string;
}

type AgentAccountRow = { id: string; version: number };
type AgentMatterRow = { id: string; accountId: string; version: number };

/** Request-local, tenant-bound metadata cache used to avoid per-Run ACL query amplification. */
export interface AgentAuthorizationResources {
  tenantId: string;
  actorId: string;
  scope: EffectiveResourceScope;
  accounts: ReadonlyMap<string, AgentAccountRow>;
  matters: ReadonlyMap<string, AgentMatterRow>;
  sources: ReadonlyMap<string, AgentSourceRow>;
  readableSourceIds: ReadonlySet<string>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

export function agentRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function assertScopeManifest(
  definition: AgentJobDefinition,
  request: AgentManualRunRequest,
): void {
  const { scopeManifest } = definition;
  if ((scopeManifest.matter === 'required' && request.matterId === null)
    || (scopeManifest.matter === 'forbidden' && request.matterId !== null)
    || (scopeManifest.sourceArtifact === 'required' && request.sourceArtifactId === null)
    || (scopeManifest.sourceArtifact === 'forbidden' && request.sourceArtifactId !== null)
    || request.inputRefs.length > definition.budget.maxInputRefs
    || request.inputRefs.some((ref) => !scopeManifest.allowedInputRefKinds.includes(ref.kind))) {
    throw new AgentJobError('agent_scope_invalid', 400);
  }
  for (const ref of request.inputRefs) {
    if ((ref.kind === 'customer' && ref.id !== request.customerId)
      || (ref.kind === 'matter' && ref.id !== request.matterId)
      || (ref.kind === 'source_artifact'
        && scopeManifest.sourceArtifact === 'forbidden')) {
      throw new AgentJobError('agent_scope_invalid', 400);
    }
  }
  const sourceIds = request.inputRefs.filter((ref) => ref.kind === 'source_artifact').map((ref) => ref.id);
  // A candidate ReviewBatch has one immutable SourceArtifact authority. Mixing
  // additional sources would let extracted candidates claim the wrong source.
  if (definition.actionMode === 'candidate'
    && (sourceIds.length !== 1 || sourceIds[0] !== request.sourceArtifactId)) {
    throw new AgentJobError('agent_scope_invalid', 400);
  }
  if (request.sourceArtifactId !== null && !sourceIds.includes(request.sourceArtifactId)) {
    throw new AgentJobError('agent_scope_invalid', 400);
  }
}

function storedControl(row: AgentControlRow) {
  return {
    definitionJson: row.definitionJson,
    definitionHash: row.definitionHash,
    enabled: row.enabled,
    tenantLimitsJson: row.tenantLimitsJson,
    version: row.version,
  };
}

export async function loadAgentAuthorizationResources(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  rawRequests: readonly AgentManualRunRequest[],
): Promise<AgentAuthorizationResources> {
  const requests = rawRequests.map((request) => AgentManualRunRequestSchema.parse(request));
  const accountIds = [...new Set(requests.map((request) => request.customerId))];
  const matterIds = [...new Set(requests.flatMap((request) => (
    request.matterId ? [request.matterId] : []
  )))];
  const sourceIds = [...new Set(requests.flatMap((request) => (
    request.inputRefs.filter((ref) => ref.kind === 'source_artifact').map((ref) => ref.id)
  )))];
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  }, policy);
  if (!evaluator.scope.valid) {
    return {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      scope: evaluator.scope,
      accounts: new Map(),
      matters: new Map(),
      sources: new Map(),
      readableSourceIds: new Set(),
    };
  }
  const [accounts, matters, sources] = await Promise.all([
    accountIds.length === 0 ? [] : db.account.findMany({
      where: { id: { in: accountIds }, tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true, version: true },
    }),
    matterIds.length === 0 ? [] : db.opportunity.findMany({
      where: {
        id: { in: matterIds }, tenantId: ctx.tenantId, archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: { id: true, accountId: true, version: true },
    }),
    sourceIds.length === 0 ? [] : db.sourceArtifact.findMany({
      where: { tenantId: ctx.tenantId, id: { in: sourceIds } },
      orderBy: { id: 'asc' },
      select: sourceSelect,
    }),
  ]);
  const access = await evaluator.authorizeMany(sources.map(sourceArtifactDescriptor), 'read');
  return {
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    scope: evaluator.scope,
    accounts: new Map(accounts.map((row) => [row.id, row])),
    matters: new Map(matters.map((row) => [row.id, row])),
    sources: new Map(sources.map((row) => [row.id, row])),
    readableSourceIds: new Set(sources
      .filter((_source, index) => access[index]?.allowed === true)
      .map((source) => source.id)),
  };
}

export async function authorizeAgentRequest(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  definition: AgentJobDefinition,
  rawRequest: AgentManualRunRequest,
  options: { execution: boolean; resources?: AgentAuthorizationResources },
): Promise<AgentAuthorizationSnapshot> {
  const request = AgentManualRunRequestSchema.parse(rawRequest);
  assertScopeManifest(definition, request);
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new AgentJobError('capability_denied', 403);
  }
  const resources = options.resources
    ?? await loadAgentAuthorizationResources(db, ctx, policy, [request]);
  if (resources.tenantId !== ctx.tenantId || resources.actorId !== ctx.actorId) {
    throw new AgentJobError('agent_actor_invalid', 401);
  }
  const { scope } = resources;
  if (!scope.valid) throw new AgentJobError('agent_actor_invalid', 401);
  if (options.execution && scope.actorRole === 'viewer') {
    throw new AgentJobError('viewer_write_denied', 403);
  }
  if (!scope.canReadAccountData(request.customerId)) agentScopedNotFound();

  const account = resources.accounts.get(request.customerId);
  if (!account) agentScopedNotFound();
  const customerRef = request.inputRefs.find((ref) => ref.kind === 'customer');
  if (!customerRef || customerRef.version !== account.version) {
    throw new AgentJobError('agent_scope_version_conflict', 409);
  }

  let matterVersion: number | null = null;
  if (request.matterId) {
    if (!scope.canReadMatter(request.matterId)) agentScopedNotFound();
    const matter = resources.matters.get(request.matterId);
    if (!matter || matter.accountId !== request.customerId) agentScopedNotFound();
    matterVersion = matter.version;
    const matterRef = request.inputRefs.find((ref) => ref.kind === 'matter');
    if (!matterRef || matterRef.version !== matter.version) {
      throw new AgentJobError('agent_scope_version_conflict', 409);
    }
  }

  const sourceRefs = request.inputRefs.filter((ref) => ref.kind === 'source_artifact');
  const sourceIds = sourceRefs.map((ref) => ref.id);
  const sources = [...sourceIds].sort().map((sourceId) => resources.sources.get(sourceId));
  if (sources.some((source) => !source)) agentScopedNotFound();
  const sourceRows = sources as AgentSourceRow[];
  for (const source of sourceRows) {
    if (!resources.readableSourceIds.has(source.id)
      || !sourceArtifactMetadataIsValid(source)
      || source.retentionState === 'deleted'
      || source.accountId !== request.customerId
      || source.matterId !== request.matterId
      || !definition.scopeManifest.allowedSourceKinds.includes(source.artifactKind as never)) {
      agentScopedNotFound();
    }
    const ref = sourceRefs.find((candidate) => candidate.id === source.id);
    if (!ref || ref.version !== source.aclVersion) {
      throw new AgentJobError('agent_scope_version_conflict', 409);
    }
  }

  let control: AgentControlRow | null = null;
  let limits: AgentJobControlLimits = {
    maxCostUnits: definition.budget.maxCostUnits,
    timeoutMs: definition.timeoutMs,
    maxAttempts: definition.maxAttempts,
  };
  if (options.execution) {
    control = await agentControlRow(db, ctx.tenantId, definition);
    const handlerAvailable = registeredAgentHandler(handlers, definition) !== null;
    const effective = effectiveAgentControl(
      definition,
      control ? storedControl(control) : null,
      handlerAvailable,
    );
    if (effective.state === 'missing' || !control?.enabled) {
      throw new AgentJobError('agent_job_disabled', 409);
    }
    if (effective.state === 'invalid') throw new AgentJobError('agent_control_invalid', 409);
    if (!handlerAvailable) throw new AgentJobError('agent_job_unavailable', 409);
    if (!effective.enabled) throw new AgentJobError('agent_job_disabled', 409);
    limits = effective.limits;
  }

  const fingerprintPayload = {
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    actorRole: scope.actorRole,
    dataScopePolicy: scope.policy,
    jobKey: definition.jobKey,
    jobVersion: definition.jobVersion,
    definitionHash: hashAgentDefinition(definition),
    controlId: control?.id ?? null,
    controlVersion: control?.version ?? null,
    limits,
    customerId: request.customerId,
    accountVersion: account.version,
    matterId: request.matterId,
    matterVersion,
    sources: sourceRows.map((source) => ({
      id: source.id,
      accountId: source.accountId,
      matterId: source.matterId,
      personId: source.personId,
      backingKind: source.backingKind,
      backingId: source.backingId,
      artifactKind: source.artifactKind,
      createdByUserId: source.createdByUserId,
      aclVersion: source.aclVersion,
      sourceFingerprint: source.sourceFingerprint,
      retentionState: source.retentionState,
      visibility: source.visibility,
    })),
  };
  return {
    definition,
    control,
    limits,
    actorRole: scope.actorRole,
    accountVersion: account.version,
    matterVersion,
    sources: new Map(sourceRows.map((source) => [source.id, source])),
    fingerprint: agentRequestHash(fingerprintPayload),
  };
}

export function validatePreparedEvidence(
  authorization: AgentAuthorizationSnapshot,
  prepared: AgentPreparedAudit,
): void {
  for (const evidence of prepared.evidenceRefs) {
    const source = authorization.sources.get(evidence.sourceArtifactId);
    if (!source || source.sourceFingerprint !== evidence.sourceFingerprint) {
      throw new AgentJobError('agent_evidence_stale', 409);
    }
  }
}
