// SAAS-205 compatibility input: human-authored summaries remain editable, while
// legacy AI rows are read-only, explicitly non-authoritative cache. New AI
// generation belongs exclusively to the encrypted ResearchBriefSnapshot flow.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import type { ReadPrincipal } from './visibility.js';

type EntityKind = 'account' | 'opportunity';
type CuratedStatus = 'human' | 'compatibility_cache' | 'empty' | 'restricted';

export interface CuratedResult {
  content: string;
  status: CuratedStatus;
  editedByHuman: boolean;
  updatedAt?: Date;
}

export async function getCuratedSummary(
  tenantId: string,
  kind: EntityKind,
  entityId: string,
): Promise<CuratedResult> {
  const row = await prisma.curatedSummary.findUnique({
    where: {
      tenantId_entityKind_entityId: { tenantId, entityKind: kind, entityId },
    },
  });
  if (!row || !row.content.trim()) {
    return { content: '', status: 'empty', editedByHuman: false };
  }
  if (row.editedByHuman) {
    return {
      content: row.content,
      status: 'human',
      editedByHuman: true,
      updatedAt: row.updatedAt,
    };
  }
  if (row.aclVersion >= 1 && row.model.trim()) {
    return {
      content: row.content,
      status: 'compatibility_cache',
      editedByHuman: false,
      updatedAt: row.updatedAt,
    };
  }
  return { content: '', status: 'empty', editedByHuman: false };
}

async function currentCuratedAccess(
  principal: ReadPrincipal,
  kind: EntityKind,
  entityId: string,
) {
  const scope = await resolveEffectiveResourceScope(prisma, principal);
  return {
    scope,
    canRead: kind === 'account'
      ? scope.canReadAccountData(entityId)
      : scope.canReadMatter(entityId),
  };
}

const querySchema = z.object({
  entityKind: z.enum(['account', 'opportunity']),
  entityId: z.string().trim().min(1).max(500),
}).strict();
const editSchema = querySchema.extend({
  content: z.string().max(50_000),
}).strict();

export function curatedRoutes(app: FastifyInstance): void {
  app.get('/api/curated', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const query = querySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: '参数错误' });
    const access = await currentCuratedAccess({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
    }, query.data.entityKind, query.data.entityId);
    if (!access.canRead) return reply.code(404).send({ error: '实体不存在' });
    if (access.scope.actorRole === 'viewer') {
      return { content: '', status: 'restricted', editedByHuman: false };
    }
    return getCuratedSummary(
      req.user.tenantId,
      query.data.entityKind,
      query.data.entityId,
    );
  });

  // Human edits remain an attributable compatibility input. They explicitly
  // clear the legacy model/basis authority and advance the ACL generation.
  app.put('/api/curated', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const input = editSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: '参数错误' });
    const access = await currentCuratedAccess({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
    }, input.data.entityKind, input.data.entityId);
    if (!access.canRead) return reply.code(404).send({ error: '实体不存在' });
    if (access.scope.actorRole === 'viewer') {
      return reply.code(403).send({ error: '只读成员不可编辑' });
    }
    await prisma.curatedSummary.upsert({
      where: {
        tenantId_entityKind_entityId: {
          tenantId: req.user.tenantId,
          entityKind: input.data.entityKind,
          entityId: input.data.entityId,
        },
      },
      update: {
        content: input.data.content,
        model: '',
        basedOnAt: null,
        editedByHuman: true,
        editedBy: req.user.userId,
        aclVersion: { increment: 1 },
      },
      create: {
        id: `cs_${randomUUID().replaceAll('-', '')}`,
        tenantId: req.user.tenantId,
        entityKind: input.data.entityKind,
        entityId: input.data.entityId,
        content: input.data.content,
        model: '',
        basedOnAt: null,
        editedByHuman: true,
        editedBy: req.user.userId,
        aclVersion: 1,
      },
    });
    return { ok: true };
  });

  // Kept only so old clients receive a stable explicit retirement response.
  // Scope and role checks happen first to preserve non-disclosure and viewer RBAC.
  app.post('/api/curated/regenerate', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const input = querySchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: '参数错误' });
    const access = await currentCuratedAccess({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
    }, input.data.entityKind, input.data.entityId);
    if (!access.canRead) return reply.code(404).send({ error: '实体不存在' });
    if (access.scope.actorRole === 'viewer') {
      return reply.code(403).send({ error: '只读成员不可操作' });
    }
    return reply.code(410).send({
      error: '旧版 AI 梳理已退役，请使用拜访前简报',
      code: 'curated_ai_generation_retired',
    });
  });
}
