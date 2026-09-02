import type { FastifyInstance } from 'fastify';
import {
  ActorRoleSchema,
  MatterPortfolioSourceRequestSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import {
  buildMatterPortfolioReadModel,
  matterPortfolioSourceView,
  MatterPortfolioReadError,
} from './service.js';

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

function sendError(req: any, reply: any, error: unknown) {
  if (error instanceof MatterPortfolioReadError) {
    return reply.code(error.statusCode).send({
      error: error.scopedNotFound ? '资源不存在或无权限' : '事项组合已变化',
      code: error.code,
    });
  }
  req.log.warn(error);
  return reply.code(500).send({ error: '事项组合暂不可用', code: 'matter_portfolio_failed' });
}

export function matterPortfolioRoutes(app: FastifyInstance, policy: CapabilityPolicy): void {
  app.get('/api/matter-portfolio', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await prisma.$transaction(
        (tx) => buildMatterPortfolioReadModel(tx, context(req), policy),
        serializable,
      );
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  app.post('/api/matter-portfolio/source', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = MatterPortfolioSourceRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: '事项组合来源参数无效', code: 'matter_portfolio_source_invalid',
      });
    }
    try {
      return await prisma.$transaction(
        (tx) => matterPortfolioSourceView(tx, context(req), policy, body.data),
        serializable,
      );
    } catch (error) {
      return sendError(req, reply, error);
    }
  });
}
