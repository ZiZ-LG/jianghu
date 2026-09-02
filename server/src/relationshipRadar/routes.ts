import type { FastifyInstance } from 'fastify';
import {
  ActorRoleSchema,
  RelationshipRadarQuerySchema,
  RelationshipRadarSourceRequestSchema,
  type CapabilityPolicy,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import {
  readableRelationshipRadar,
  relationshipRadarSourceView,
  RelationshipRadarReadError,
} from './service.js';

const serializable = {
  isolationLevel: 'Serializable' as const,
  maxWait: 5_000,
  timeout: 30_000,
};

function context(req: any) {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
  };
}

function sendError(req: any, reply: any, error: unknown) {
  if (error instanceof RelationshipRadarReadError) {
    return reply.code(error.statusCode).send({
      error: error.scopedNotFound ? '资源不存在' : '关系雷达暂不可用',
      code: error.code,
    });
  }
  req.log.warn(error);
  return reply.code(500).send({
    error: '关系雷达暂不可用', code: 'relationship_radar_failed',
  });
}

export function relationshipRadarRoutes(
  app: FastifyInstance,
  policy: CapabilityPolicy,
): void {
  app.get('/api/relationship-radar', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const query = RelationshipRadarQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        error: '关系雷达查询参数无效', code: 'relationship_radar_query_invalid',
      });
    }
    try {
      return await prisma.$transaction(
        (tx) => readableRelationshipRadar(tx, context(req), policy, query.data),
        serializable,
      );
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.post('/api/relationship-radar/source', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = RelationshipRadarSourceRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: '关系雷达来源参数无效', code: 'relationship_radar_source_invalid',
      });
    }
    try {
      return await prisma.$transaction(
        (tx) => relationshipRadarSourceView(tx, context(req), policy, body.data),
        serializable,
      );
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
