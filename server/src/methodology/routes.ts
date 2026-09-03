import type { FastifyInstance } from 'fastify';
import { ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import {
  buildG64111MethodologyReadModel,
  G64111MethodologyReadError,
} from './readModel.js';

const serializable = {
  isolationLevel: 'Serializable' as const,
  maxWait: 5_000,
  timeout: 30_000,
};

function context(req: any): CommandContext {
  return {
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
    channel: 'web',
    requestId: req.id,
    assertionMode: 'user_asserted',
  };
}

export function methodologyReadRoutes(app: FastifyInstance): void {
  app.get('/api/methodology/g64111', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await prisma.$transaction(
        (tx) => buildG64111MethodologyReadModel(tx, context(req)),
        serializable,
      );
    } catch (error) {
      if (error instanceof G64111MethodologyReadError) {
        return reply.code(error.statusCode).send({
          error: error.scopedNotFound ? '资源不存在或无权限' : '方法论安装或绑定状态已变化',
          code: error.code,
        });
      }
      req.log.warn(error);
      return reply.code(500).send({
        error: '方法论状态暂不可用',
        code: 'methodology_read_failed',
      });
    }
  });
}
