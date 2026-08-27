import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  AgentJobControlRequestSchema,
  AgentJobKeySchema,
  AgentManualRunRequestSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import { AgentJobError } from './errors.js';
import { readableAgentRunById, readableAgentRuns } from './history.js';
import type {
  AgentCandidateCommitAdapter,
  AgentJobHandlers,
  AgentResearchBriefCommitAdapter,
} from './model.js';
import {
  assertAgentControlReplay,
  exactAgentDefinition,
  listAgentJobCards,
  updateAgentControl,
} from './repository.js';
import { runManualAgentJob } from './runner.js';

const id = z.string().trim().min(1).max(500);
const jobParamsSchema = z.object({ jobKey: AgentJobKeySchema }).strict();
const runParamsSchema = z.object({ id }).strict();
const runListSchema = z.object({
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function context(req: any): CommandContext & { actorRole: 'owner' | 'admin' | 'member' | 'viewer' } {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
    channel: 'web',
    requestId: req.id,
    assertionMode: 'user_asserted',
  };
}

function idempotencyKey(req: any): string | null {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= 8 && normalized.length <= 200 ? normalized : null;
}

function writePreflight(req: any, reply: any, roles: readonly string[]): string | null {
  if (!roles.includes(req.user.role)) {
    reply.code(403).send({
      error: req.user.role === 'viewer' ? '只读成员不可操作' : '权限不足',
      code: req.user.role === 'viewer' ? 'viewer_write_denied' : 'agent_control_forbidden',
    });
    return null;
  }
  const key = idempotencyKey(req);
  if (!key) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key', code: 'idempotency_key_required' });
    return null;
  }
  return key;
}

function failure(reply: any, error: unknown) {
  if (error instanceof AgentJobError) {
    return reply.code(error.statusCode).send({
      error: error.statusCode === 404 ? 'Agent 资源不存在' : 'Agent 操作失败',
      code: error.code,
    });
  }
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof error.statusCode === 'number') {
    return reply.code(error.statusCode).send({
      error: error instanceof Error ? error.message : 'Agent 命令执行失败',
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    });
  }
  throw error;
}

export function agentJobRoutes(
  app: FastifyInstance,
  policy: CapabilityPolicy,
  handlers: AgentJobHandlers,
  candidateCommitAdapter?: AgentCandidateCommitAdapter,
  researchBriefCommitAdapter?: AgentResearchBriefCommitAdapter,
): void {
  app.get('/api/agent-jobs', { preHandler: [app.authenticate] }, async (req: any) => ({
    items: await listAgentJobCards(prisma, req.user.tenantId, handlers),
  }));

  app.put('/api/agent-jobs/:jobKey/control', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = writePreflight(req, reply, ['owner', 'admin']);
    if (!key) return;
    const params = jobParamsSchema.safeParse(req.params);
    const body = AgentJobControlRequestSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Agent 控制参数无效', code: 'agent_control_input_invalid' });
    }
    const ctx = context(req);
    const commandInput = {
      kind: `agent-job-control:${params.data.jobKey}:${body.data.jobVersion}`,
      idempotencyKey: key,
      payload: { jobKey: params.data.jobKey, ...body.data },
      authorizeReplay: (tx: Parameters<typeof assertAgentControlReplay>[0]) => (
        assertAgentControlReplay(tx, ctx, policy, handlers, params.data.jobKey, body.data)
      ),
    };
    try {
      const result = await runCommand(ctx, commandInput, (tx) => (
        updateAgentControl(tx, ctx, policy, handlers, params.data.jobKey, body.data)
      ));
      return { ...result.result, replayed: result.replayed };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/agent-jobs/:jobKey/runs', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = writePreflight(req, reply, ['owner', 'admin', 'member']);
    if (!key) return;
    const params = jobParamsSchema.safeParse(req.params);
    const body = AgentManualRunRequestSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Agent 运行参数无效', code: 'agent_run_input_invalid' });
    }
    try {
      const definition = exactAgentDefinition(params.data.jobKey, body.data.jobVersion);
      return await runManualAgentJob(
        prisma, context(req), policy, handlers, definition, body.data, key,
        candidateCommitAdapter, researchBriefCommitAdapter,
      );
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/agent-runs', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const query = runListSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'Agent 运行查询参数无效' });
    return prisma.$transaction(
      (tx) => readableAgentRuns(tx, context(req), policy, handlers, query.data),
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
    );
  });

  app.get('/api/agent-runs/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Agent 运行参数无效' });
    const run = await prisma.$transaction(
      (tx) => readableAgentRunById(tx, context(req), policy, handlers, params.data.id),
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
    );
    return run ?? reply.code(404).send({
      error: 'Agent 运行不存在', code: 'agent_run_not_found',
    });
  });
}
