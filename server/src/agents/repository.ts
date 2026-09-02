import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  ActorRoleSchema,
  AgentJobCardSchema,
  AgentJobControlLimitsSchema,
  capabilityPolicyAllows,
  type AgentJobCard,
  type AgentJobControlRequest,
  type AgentJobDefinition,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import { AgentJobError } from './errors.js';
import type { AgentJobHandlers } from './model.js';
import { registeredAgentHandler } from './model.js';
import {
  BUILT_IN_AGENT_DEFINITIONS,
  builtInAgentDefinition,
  canonicalAgentDefinition,
  hashAgentDefinition,
} from './registry.js';
import {
  defaultAgentControlLimits,
  effectiveAgentControl,
  type StoredAgentControl,
} from './policy.js';

const controlSelect = {
  id: true,
  tenantId: true,
  jobKey: true,
  jobVersion: true,
  definitionJson: true,
  definitionHash: true,
  enabled: true,
  tenantLimitsJson: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AgentControlRow = Prisma.AgentJobDefinitionGetPayload<{ select: typeof controlSelect }>;

function stored(row: AgentControlRow): StoredAgentControl {
  return {
    definitionJson: row.definitionJson,
    definitionHash: row.definitionHash,
    enabled: row.enabled,
    tenantLimitsJson: row.tenantLimitsJson,
    version: row.version,
  };
}

export function exactAgentDefinition(jobKey: string, jobVersion: string): AgentJobDefinition {
  const definition = BUILT_IN_AGENT_DEFINITIONS.find((candidate) => (
    candidate.jobKey === jobKey && candidate.jobVersion === jobVersion
  ));
  if (!definition) throw new AgentJobError('agent_job_not_found', 404, true);
  return definition;
}

export async function agentControlRow(
  db: DbClient,
  tenantId: string,
  definition: AgentJobDefinition,
): Promise<AgentControlRow | null> {
  return db.agentJobDefinition.findFirst({
    where: {
      tenantId,
      jobKey: definition.jobKey,
      jobVersion: definition.jobVersion,
    },
    select: controlSelect,
  });
}

export async function listAgentJobCards(
  db: DbClient,
  tenantId: string,
  handlers: AgentJobHandlers,
): Promise<AgentJobCard[]> {
  const rows = await db.agentJobDefinition.findMany({
    where: {
      tenantId,
      OR: BUILT_IN_AGENT_DEFINITIONS.map((definition) => ({
        jobKey: definition.jobKey,
        jobVersion: definition.jobVersion,
      })),
    },
    select: controlSelect,
  });
  const byKey = new Map(rows.map((row) => [`${row.jobKey}\0${row.jobVersion}`, row]));
  return BUILT_IN_AGENT_DEFINITIONS.map((definition) => {
    const row = byKey.get(`${definition.jobKey}\0${definition.jobVersion}`) ?? null;
    const available = registeredAgentHandler(handlers, definition) !== null;
    const control = effectiveAgentControl(definition, row ? stored(row) : null, available);
    return AgentJobCardSchema.parse({
      ...definition,
      available,
      enabled: control.enabled,
      controlState: control.state,
      controlVersion: control.version,
      limits: control.limits,
    });
  });
}

async function requireControlActor(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
): Promise<'owner' | 'admin'> {
  const actor = await db.user.findFirst({
    where: { id: ctx.actorId, tenantId: ctx.tenantId }, select: { role: true },
  });
  const role = ActorRoleSchema.safeParse(actor?.role);
  if (!role.success) throw new AgentJobError('agent_actor_invalid', 401);
  if (role.data !== 'owner' && role.data !== 'admin') {
    throw new AgentJobError('agent_control_forbidden', 403);
  }
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new AgentJobError('capability_denied', 403);
  }
  return role.data;
}

function requestedLimits(
  definition: AgentJobDefinition,
  request: AgentJobControlRequest,
) {
  const limits = AgentJobControlLimitsSchema.parse(
    request.limits ?? defaultAgentControlLimits(definition),
  );
  if (limits.maxCostUnits > definition.budget.maxCostUnits
    || limits.timeoutMs > definition.timeoutMs
    || limits.maxAttempts > definition.maxAttempts) {
    throw new AgentJobError('agent_control_widening_forbidden', 409);
  }
  return limits;
}

export async function assertAgentControlReplay(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  jobKey: string,
  request: AgentJobControlRequest,
): Promise<void> {
  await requireControlActor(db, ctx, policy);
  const definition = exactAgentDefinition(jobKey, request.jobVersion);
  const row = await agentControlRow(db, ctx.tenantId, definition);
  if (!row) throw new AgentJobError('agent_control_conflict', 409);
  const available = registeredAgentHandler(handlers, definition) !== null;
  const control = effectiveAgentControl(definition, stored(row), available);
  const limits = requestedLimits(definition, request);
  if (control.state !== 'valid'
    || row.enabled !== request.enabled
    || control.limits.maxCostUnits !== limits.maxCostUnits
    || control.limits.timeoutMs !== limits.timeoutMs
    || control.limits.maxAttempts !== limits.maxAttempts) {
    throw new AgentJobError('agent_control_conflict', 409);
  }
  if (request.enabled && !available) throw new AgentJobError('agent_job_unavailable', 409);
}

export async function updateAgentControl(
  db: Prisma.TransactionClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  jobKey: string,
  request: AgentJobControlRequest,
) {
  await requireControlActor(db, ctx, policy);
  const definition = exactAgentDefinition(jobKey, request.jobVersion);
  const available = registeredAgentHandler(handlers, definition) !== null;
  if (request.enabled && !available) throw new AgentJobError('agent_job_unavailable', 409);
  const limits = requestedLimits(definition, request);
  const current = await agentControlRow(db, ctx.tenantId, definition);
  if ((!current && request.expectedVersion !== 0)
    || (current && current.version !== request.expectedVersion)) {
    throw new AgentJobError('agent_control_conflict', 409);
  }
  if (current) {
    const effective = effectiveAgentControl(definition, stored(current), available);
    if (effective.state !== 'valid' && request.enabled) {
      throw new AgentJobError('agent_control_invalid', 409);
    }
  }

  const canonical = canonicalAgentDefinition(definition);
  const definitionHash = hashAgentDefinition(definition);
  const nextVersion = current ? current.version + 1 : 1;
  const data = {
    definitionJson: canonical,
    definitionHash,
    enabled: request.enabled,
    tenantLimitsJson: JSON.stringify(limits),
    version: nextVersion,
    updatedByUserId: ctx.actorId,
  };
  let row: AgentControlRow;
  if (current) {
    const changed = await db.agentJobDefinition.updateMany({
      where: {
        id: current.id,
        tenantId: ctx.tenantId,
        jobKey: definition.jobKey,
        jobVersion: definition.jobVersion,
        version: request.expectedVersion,
      },
      data,
    });
    if (changed.count !== 1) throw new AgentJobError('agent_control_conflict', 409);
    row = await db.agentJobDefinition.findFirstOrThrow({
      where: { id: current.id, tenantId: ctx.tenantId }, select: controlSelect,
    });
  } else {
    row = await db.agentJobDefinition.create({
      data: {
        id: `agent_job_${randomUUID().replaceAll('-', '')}`,
        tenantId: ctx.tenantId,
        jobKey: definition.jobKey,
        jobVersion: definition.jobVersion,
        ...data,
        createdByUserId: ctx.actorId,
      },
      select: controlSelect,
    });
  }
  await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: request.enabled ? 'agent_job_enabled' : 'agent_job_disabled',
    entityKind: 'agent_job_definition',
    entityId: row.id,
    requestId: ctx.requestId ?? null,
    sourceRef: `${definition.jobKey}@${definition.jobVersion}`,
    changedFields: JSON.stringify(['enabled', 'limits', 'version']),
    metadata: JSON.stringify({
      jobKey: definition.jobKey,
      jobVersion: definition.jobVersion,
      enabled: request.enabled,
      controlVersion: row.version,
      limits,
    }),
  } });
  return {
    jobKey: definition.jobKey,
    jobVersion: definition.jobVersion,
    enabled: row.enabled && available,
    controlVersion: row.version,
    limits,
  };
}

export function registryDefinition(jobKey: string, jobVersion: string) {
  const parsed = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.jobKey === jobKey);
  return parsed ? builtInAgentDefinition(parsed.jobKey, jobVersion) : null;
}
