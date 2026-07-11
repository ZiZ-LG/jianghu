// 商机相关端点：新建商机（空白 / 从已有商机克隆选定的人物 + 角色 + 可选关系线）。
// 人物是客户级共享，"克隆"只复制商机级数据：成员可见性(OpportunityMember) + 角色(OppRole) + 增量边(opp.edges)。
// 新商机一律 memberScoped=true（白板/选定成员）；改新商机的角色/关系不影响源商机（按 opportunityId 分库）。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';

export function opportunityRoutes(app: FastifyInstance) {
  app.post('/api/opportunity/clone', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const tenantId = req.user.tenantId;
    const p = z.object({
      accountId: z.string(),
      name: z.string().min(1),
      fromOppId: z.string().optional(),       // 缺省=空白新建
      personIds: z.array(z.string()).default([]),
      withEdges: z.boolean().default(false),  // 是否连带克隆关系线
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数不完整' });
    const { accountId, name, fromOppId, personIds, withEdges } = p.data;

    const acc = await prisma.account.findFirst({ where: { id: accountId, tenantId } });
    if (!acc) return reply.code(404).send({ error: '客户不存在' });

    // 校验成员都是该客户下的正式人物（防跨客户/越权）
    const validIds = personIds.length
      ? (await prisma.person.findMany({ where: { tenantId, accountId, id: { in: personIds } }, select: { id: true } })).map((x) => x.id)
      : [];
    const sel = new Set(validIds);

    const oppId = 'opp_' + randomUUID().slice(0, 12);
    await prisma.$transaction(async (tx) => {
      await tx.opportunity.create({ data: {
        id: oppId, tenantId, accountId, name: name.slice(0, 100), customerType: acc.customerType,
        pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true,
      } });
      for (const pid of validIds) await tx.opportunityMember.create({ data: { tenantId, opportunityId: oppId, personId: pid } });

      if (fromOppId && validIds.length) {
        // 克隆选中人的角色/支持度（复制为新商机的独立 OppRole 记录）
        const roles = await tx.oppRole.findMany({ where: { tenantId, opportunityId: fromOppId, personId: { in: validIds } } });
        for (const r of roles) await tx.oppRole.create({ data: {
          tenantId, opportunityId: oppId, personId: r.personId, role: r.role, sentiment: r.sentiment,
          sentimentValue: r.sentimentValue, confidence: r.confidence, isKeyInfluencer: r.isKeyInfluencer,
          procurementType: r.procurementType, procurementStatus: r.procurementStatus,
        } });
        // 可选：克隆关系线（仅两端都在选中集内的增量边）
        if (withEdges) {
          const edges = await tx.edge.findMany({ where: { tenantId, opportunityId: fromOppId } });
          for (const e of edges) if (sel.has(e.source) && sel.has(e.target)) await tx.edge.create({ data: {
            id: 'e_' + randomUUID().slice(0, 12), tenantId, accountId, opportunityId: oppId,
            source: e.source, target: e.target, layer: e.layer, label: e.label, color: e.color,
            style: e.style, width: e.width, directed: e.directed, origin: e.origin, shape: e.shape, bend: e.bend,
          } });
        }
      }
    });
    return { opportunityId: oppId, memberCount: validIds.length };
  });
}
