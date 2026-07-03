// P8 参谋会话历史：右栏参谋 tab 问答流的落库与回放（原阅后即焚）。
// 会话按 商机×焦点人 分桶；纯分析文本不参与计算，团队同租户可见（沉淀结论另走 ADD_LOG 挂人动态）。
// 多租户红线：全部按 tenantId 过滤，商机归属校验后才读写。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';

const MAX_KEEP = 200; // 每个 商机×人 会话保留上限（超出丢最旧——防止无限膨胀）

export function advisorRoutes(app: FastifyInstance) {
  // 读会话（按时间升序，最近 100 条）
  app.get('/api/advisor/messages', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({ opportunityId: z.string().min(1), personId: z.string().min(1) }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const opp = await prisma.opportunity.findFirst({ where: { id: p.data.opportunityId, tenantId }, select: { id: true } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    const rows = await prisma.advisorMsg.findMany({
      where: { tenantId, opportunityId: p.data.opportunityId, personId: p.data.personId },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    return { messages: rows.reverse().map((r) => ({ id: r.id, role: r.role, text: r.text, createdAt: r.createdAt })) };
  });

  // 追加消息（一次可批量：一问一答两条）
  app.post('/api/advisor/messages', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({
      opportunityId: z.string().min(1),
      personId: z.string().min(1),
      entries: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(8000) })).min(1).max(4),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const opp = await prisma.opportunity.findFirst({ where: { id: p.data.opportunityId, tenantId }, select: { id: true, accountId: true } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    const now = Date.now();
    for (let i = 0; i < p.data.entries.length; i++) {
      const e = p.data.entries[i];
      await prisma.advisorMsg.create({
        data: {
          id: 'adv_' + randomUUID().slice(0, 12), tenantId, accountId: opp.accountId,
          opportunityId: p.data.opportunityId, personId: p.data.personId,
          role: e.role, text: e.text, createdAt: new Date(now + i), // +i 保证同批次内顺序稳定
        },
      });
    }
    // 超上限丢最旧（保守清理，不阻塞响应）
    const count = await prisma.advisorMsg.count({ where: { tenantId, opportunityId: p.data.opportunityId, personId: p.data.personId } });
    if (count > MAX_KEEP) {
      const olds = await prisma.advisorMsg.findMany({
        where: { tenantId, opportunityId: p.data.opportunityId, personId: p.data.personId },
        orderBy: { createdAt: 'asc' }, take: count - MAX_KEEP, select: { id: true },
      });
      await prisma.advisorMsg.deleteMany({ where: { id: { in: olds.map((o) => o.id) } } });
    }
    return { ok: true };
  });

  // 清空该 商机×人 的会话
  app.delete('/api/advisor/messages', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({ opportunityId: z.string().min(1), personId: z.string().min(1) }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const opp = await prisma.opportunity.findFirst({ where: { id: p.data.opportunityId, tenantId }, select: { id: true } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    await prisma.advisorMsg.deleteMany({ where: { tenantId, opportunityId: p.data.opportunityId, personId: p.data.personId } });
    return { ok: true };
  });
}
