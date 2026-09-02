import {
  AgentManualRunRequestSchema,
  AgentRunViewSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import { readableReviewBatchById } from '../reviewBatches/service.js';
import {
  authorizeAgentRequest,
  loadAgentAuthorizationResources,
  type AgentAuthorizationResources,
} from './authorization.js';
import type { AgentJobHandlers } from './model.js';
import { exactAgentDefinition } from './repository.js';
import { hashAgentDefinition } from './registry.js';
import { agentRunSelect, agentRunView, type AgentRunRow } from './runner.js';

function parsedRequest(row: AgentRunRow) {
  try {
    return AgentManualRunRequestSchema.safeParse({
      jobVersion: row.jobVersion,
      customerId: row.customerId,
      matterId: row.matterId,
      sourceArtifactId: row.sourceArtifactId,
      inputRefs: JSON.parse(row.inputRefs) as unknown,
    });
  } catch {
    return { success: false as const };
  }
}

async function readableRun(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  row: AgentRunRow,
  resources?: AgentAuthorizationResources,
) {
  let definition;
  try {
    definition = exactAgentDefinition(row.jobKey, row.jobVersion);
  } catch {
    return null;
  }
  if (row.definitionHash !== hashAgentDefinition(definition)
    || row.actionMode !== definition.actionMode
    || row.trigger !== 'manual') return null;
  const request = parsedRequest(row);
  if (!request.success) return null;
  try {
    await authorizeAgentRequest(
      db, ctx, policy, handlers, definition, request.data, { execution: false, resources },
    );
  } catch {
    return null;
  }
  let view;
  try {
    view = AgentRunViewSchema.parse(agentRunView(row));
  } catch {
    return null;
  }
  if (definition.actionMode === 'candidate' && view.status === 'succeeded') {
    for (const output of view.outputRefs) {
      if (output.kind !== 'review_batch') return null;
      const batch = await readableReviewBatchById(db, {
        ...ctx,
        actorRole: ctx.actorRole,
      }, policy, output.id, 'read');
      if (!batch
        || batch.batch.version !== output.version
        || batch.batch.accountId !== row.customerId
        || batch.batch.matterId !== row.matterId
        || batch.batch.sourceArtifactId !== row.sourceArtifactId) return null;
    }
  }
  return view;
}

export async function readableAgentRunById(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  id: string,
) {
  const row = await db.agentRun.findFirst({
    where: { id, tenantId: ctx.tenantId }, select: agentRunSelect,
  });
  return row ? readableRun(db, ctx, policy, handlers, row) : null;
}

export async function readableAgentRuns(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  input: { cursor?: string; limit: number },
) {
  if (input.cursor) {
    const cursor = await db.agentRun.findFirst({
      where: { id: input.cursor, tenantId: ctx.tenantId }, select: { id: true },
    });
    if (!cursor) return { items: [], nextCursor: null };
  }
  const scanLimit = Math.min(500, input.limit * 5 + 1);
  const rows = await db.agentRun.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: scanLimit,
    select: agentRunSelect,
  });
  const requests = rows.flatMap((row) => {
    const request = parsedRequest(row);
    return request.success ? [request.data] : [];
  });
  const resources = requests.length > 0
    ? await loadAgentAuthorizationResources(db, ctx, policy, requests)
    : undefined;
  const items = [];
  let lastScanned: string | null = null;
  for (const row of rows) {
    lastScanned = row.id;
    const view = await readableRun(db, ctx, policy, handlers, row, resources);
    if (view) items.push(view);
    if (items.length === input.limit) break;
  }
  const hasMore = rows.length === scanLimit
    || (items.length === input.limit && lastScanned !== rows.at(-1)?.id);
  return { items, nextCursor: hasMore ? lastScanned : null };
}
