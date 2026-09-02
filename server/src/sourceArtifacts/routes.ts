import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { runCommand } from '../mutation/commandRunner.js';
import {
  buildSourceArtifactViews,
  canRegisterExternalSourceArtifact,
  canManageSourceArtifactById,
  degradeSourceArtifact,
  deleteSourceArtifact,
  mountSourceArtifact,
  readableSourceArtifactById,
  readableSourceArtifactMetadata,
  registerExternalSourceArtifact,
  setSourceArtifactVisibility,
  SourceArtifactError,
} from './service.js';

const id = z.string().trim().min(1).max(200);
const optionalId = id.nullable().optional();
const expectedAclVersion = z.number().int().min(1);
const paramsSchema = z.object({ id }).strict();
const listQuerySchema = z.object({
  accountId: id.optional(),
  matterId: id.optional(),
  unclassified: z.enum(['1', 'true']).optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const externalSchema = z.object({
  source: z.string().trim().min(1).max(80),
  externalRef: z.string().trim().min(1).max(500),
  title: z.string().trim().max(200).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  accountId: optionalId,
  matterId: optionalId,
  personId: optionalId,
}).strict();
const mountSchema = z.object({
  accountId: optionalId,
  matterId: optionalId,
  personId: optionalId,
  expectedAclVersion,
}).strict();
const visibilitySchema = z.object({
  visibility: z.enum(['private', 'matter_shared']),
  expectedAclVersion,
}).strict();
const lifecycleSchema = z.object({ expectedAclVersion }).strict();

function commandContext(req: any): CommandContext {
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
  const trimmed = value.trim();
  return trimmed.length >= 8 && trimmed.length <= 200 ? trimmed : null;
}

function mutationPreflight(req: any, reply: any): string | null {
  if (req.user.role === 'viewer') {
    reply.code(403).send({ error: '只读成员不可操作', code: 'viewer_write_denied' });
    return null;
  }
  const key = idempotencyKey(req);
  if (!key) {
    reply.code(400).send({ error: '缺少有效的 Idempotency-Key', code: 'idempotency_key_required' });
    return null;
  }
  return key;
}

function mutationFailure(reply: any, error: unknown) {
  if (error instanceof SourceArtifactError) {
    const message = error.statusCode === 404 ? '来源资料不存在' : '来源资料操作失败';
    return reply.code(error.statusCode).send({ error: message, code: error.code });
  }
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof error.statusCode === 'number') {
    return reply.code(error.statusCode).send({
      error: error instanceof Error ? error.message : '命令执行失败',
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    });
  }
  throw error;
}

async function mutationArtifactVisible(req: any, reply: any, policy: CapabilityPolicy, artifactId: string) {
  const allowed = await canManageSourceArtifactById(prisma, {
    tenantId: req.user.tenantId,
    userId: req.user.userId,
    role: ActorRoleSchema.parse(req.user.role),
  }, policy, artifactId);
  if (allowed) return true;
  reply.code(404).send({ error: '来源资料不存在', code: 'source_artifact_not_found' });
  return false;
}

export function sourceArtifactRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.get('/api/source-artifacts', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: '来源资料查询参数无效' });
    const principal = {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: ActorRoleSchema.parse(req.user.role),
    };
    const result = await prisma.$transaction(async (tx) => {
      const page = await readableSourceArtifactMetadata(tx, principal, policy, {
        accountId: query.data.accountId,
        matterId: query.data.matterId,
        unclassified: Boolean(query.data.unclassified),
        cursor: query.data.cursor,
        limit: query.data.limit,
      });
      return {
        items: await buildSourceArtifactViews(tx, page.rows, principal, policy),
        nextCursor: page.nextCursor,
      };
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
    return result;
  });

  app.get('/api/source-artifacts/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: '来源资料参数无效' });
    const principal = {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: ActorRoleSchema.parse(req.user.role),
    };
    const view = await prisma.$transaction(async (tx) => {
      const row = await readableSourceArtifactById(tx, principal, policy, params.data.id);
      if (!row) return null;
      return (await buildSourceArtifactViews(tx, [row], principal, policy))[0] ?? null;
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
    return view ?? reply.code(404).send({ error: '来源资料不存在', code: 'source_artifact_not_found' });
  });

  app.post('/api/source-artifacts/external', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const body = externalSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '外部来源参数无效' });
    const payload = body.data;
    try {
      if (!await canRegisterExternalSourceArtifact(
        prisma, commandContext(req), policy, payload,
      )) {
        return reply.code(404).send({
          error: '来源资料不存在', code: 'source_artifact_not_found',
        });
      }
      const command = await runCommand(commandContext(req), {
        kind: 'source-artifact-register-external', idempotencyKey: key, payload,
      }, (tx) => registerExternalSourceArtifact(tx, commandContext(req), policy, {
        ...payload,
        occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : null,
      }));
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });

  app.patch('/api/source-artifacts/:id/mount', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const params = paramsSchema.safeParse(req.params);
    const body = mountSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '挂载参数无效' });
    if (!await mutationArtifactVisible(req, reply, policy, params.data.id)) return;
    const payload = { id: params.data.id, ...body.data };
    try {
      const command = await runCommand(commandContext(req), {
        kind: 'source-artifact-mount', idempotencyKey: key, payload,
      }, (tx) => mountSourceArtifact(tx, commandContext(req), policy, params.data.id, body.data));
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });

  app.put('/api/source-artifacts/:id/visibility', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const params = paramsSchema.safeParse(req.params);
    const body = visibilitySchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '可见性参数无效' });
    if (!await mutationArtifactVisible(req, reply, policy, params.data.id)) return;
    const payload = { id: params.data.id, ...body.data };
    try {
      const command = await runCommand(commandContext(req), {
        kind: 'source-artifact-visibility', idempotencyKey: key, payload,
      }, (tx) => setSourceArtifactVisibility(tx, commandContext(req), policy, params.data.id, body.data));
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });

  app.post('/api/source-artifacts/:id/degrade', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const params = paramsSchema.safeParse(req.params);
    const body = lifecycleSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '降解参数无效' });
    if (!await mutationArtifactVisible(req, reply, policy, params.data.id)) return;
    const payload = { id: params.data.id, ...body.data };
    try {
      const command = await runCommand(commandContext(req), {
        kind: 'source-artifact-degrade', idempotencyKey: key, payload,
      }, (tx) => degradeSourceArtifact(
        tx, commandContext(req), policy, params.data.id, body.data.expectedAclVersion,
      ));
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });

  app.delete('/api/source-artifacts/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const key = mutationPreflight(req, reply);
    if (!key) return;
    const params = paramsSchema.safeParse(req.params);
    const body = lifecycleSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '删除参数无效' });
    if (!await mutationArtifactVisible(req, reply, policy, params.data.id)) return;
    const payload = { id: params.data.id, ...body.data };
    try {
      const command = await runCommand(commandContext(req), {
        kind: 'source-artifact-delete', idempotencyKey: key, payload,
      }, (tx) => deleteSourceArtifact(
        tx, commandContext(req), policy, params.data.id, body.data.expectedAclVersion,
      ));
      return { ...command.result, replayed: command.replayed };
    } catch (error) {
      return mutationFailure(reply, error);
    }
  });
}
