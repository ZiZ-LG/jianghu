// 商机相关端点：新建商机（空白 / 从已有商机克隆选定的人物 + 角色 + 可选关系线）。
// 人物是客户级共享，"克隆"只复制商机级数据：成员可见性(OpportunityMember) + 角色(OppRole) + 增量边(opp.edges)。
// 新商机一律 memberScoped=true（白板/选定成员）；改新商机的角色/关系不影响源商机（按 opportunityId 分库）。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import type { DbClient } from './mutate.js';
import { ScopedNotFoundError } from './mutation/scopeGuards.js';
import { activePersonWhere } from './activePerson.js';

export const CloneOpportunitySchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(100),
  fromOppId: z.string().optional(),
  personIds: z.array(z.string()).max(100).default([]),
  withEdges: z.boolean().default(false),
}).strict();
export type CloneOpportunityInput = z.infer<typeof CloneOpportunitySchema>;

export async function cloneOpportunityInTransaction(
  ctx: CommandContext,
  input: CloneOpportunityInput,
  db: DbClient,
): Promise<{ opportunityId: string; memberCount: number }> {
  const { accountId, name, fromOppId, personIds, withEdges } = input;
  const tenantId = ctx.tenantId;
  const acc = await db.account.findFirst({ where: { id: accountId, tenantId } });
  if (!acc) throw new ScopedNotFoundError();
  const validIds = personIds.length
    ? (await db.person.findMany({ where: { tenantId, accountId, id: { in: personIds }, ...activePersonWhere }, select: { id: true } })).map((x) => x.id)
    : [];
  const sel = new Set(validIds);
  const oppId = 'opp_' + randomUUID().slice(0, 12);
  await db.opportunity.create({ data: {
    id: oppId, tenantId, accountId, name: name.slice(0, 100), customerType: acc.customerType,
    pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true,
  } });
  for (const pid of validIds) await db.opportunityMember.create({ data: { tenantId, opportunityId: oppId, personId: pid } });
  if (fromOppId && validIds.length) {
    const source = await db.opportunity.findFirst({ where: { id: fromOppId, tenantId, accountId }, select: { id: true } });
    if (!source) throw new ScopedNotFoundError();
    const roles = await db.oppRole.findMany({ where: { tenantId, opportunityId: fromOppId, personId: { in: validIds } } });
    for (const r of roles) await db.oppRole.create({ data: {
      tenantId, opportunityId: oppId, personId: r.personId, role: r.role, sentiment: r.sentiment,
      sentimentValue: r.sentimentValue, confidence: r.confidence, isKeyInfluencer: r.isKeyInfluencer,
      procurementType: r.procurementType, procurementStatus: r.procurementStatus,
    } });
    if (withEdges) {
      const edges = await db.edge.findMany({ where: { tenantId, opportunityId: fromOppId } });
      for (const e of edges) if (sel.has(e.source) && sel.has(e.target)) await db.edge.create({ data: {
        id: 'e_' + randomUUID().slice(0, 12), tenantId, accountId, opportunityId: oppId,
        source: e.source, target: e.target, layer: e.layer, label: e.label, color: e.color,
        style: e.style, width: e.width, directed: e.directed, origin: e.origin, shape: e.shape, bend: e.bend,
      } });
    }
  }
  return { opportunityId: oppId, memberCount: validIds.length };
}

export function opportunityRoutes(app: FastifyInstance) {
  app.post('/api/opportunity/clone', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const tenantId = req.user.tenantId;
    const p = CloneOpportunitySchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数不完整' });
    try {
      const ctx: CommandContext = {
        tenantId, actorId: req.user.userId, actorRole: ActorRoleSchema.parse(req.user.role),
        channel: 'web', requestId: req.id, assertionMode: 'user_asserted',
      };
      return await prisma.$transaction((tx) => cloneOpportunityInTransaction(ctx, p.data, tx));
    } catch (error: any) {
      if (error instanceof ScopedNotFoundError || error?.scopedNotFound) return reply.code(404).send({ error: '资源不存在' });
      throw error;
    }
  });
}
