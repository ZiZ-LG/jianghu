import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActorRoleSchema,
  type CapabilityPolicy,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import {
  listResearchBriefSnapshots,
  researchBriefSnapshotDetail,
  ResearchBriefError,
  type ResearchBriefReadContext,
} from './service.js';

const id = z.string().trim().min(1).max(200);
const paramsSchema = z.object({ id }).strict();
const querySchema = z.object({
  customerId: id,
  matterId: id.optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

function context(req: any): ResearchBriefReadContext {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
  };
}

function failure(reply: any, error: unknown) {
  if (error instanceof ResearchBriefError) {
    if (error.scopedNotFound || error.statusCode === 404) {
      return reply.code(404).send({ error: '研究简报不存在', code: 'research_brief_not_found' });
    }
    return reply.code(error.statusCode).send({
      error: error.statusCode === 403 ? '能力未启用' : '研究简报查询失败',
      code: error.code,
    });
  }
  throw error;
}

export function researchBriefRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.get('/api/research-briefs', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const query = querySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: '研究简报查询参数无效', code: 'research_brief_query_invalid' });
    }
    try {
      return await prisma.$transaction((tx) => listResearchBriefSnapshots(
        tx, context(req), policy, query.data,
      ), { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/research-briefs/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: '研究简报参数无效', code: 'research_brief_query_invalid' });
    }
    try {
      const result = await prisma.$transaction((tx) => researchBriefSnapshotDetail(
        tx, context(req), policy, params.data.id,
      ), { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
      return result ?? reply.code(404).send({
        error: '研究简报不存在', code: 'research_brief_not_found',
      });
    } catch (error) {
      return failure(reply, error);
    }
  });
}
