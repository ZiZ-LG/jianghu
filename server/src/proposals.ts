// 统一变更提案（机器写初稿·人审 v2.0）：机器对【已有实体字段】的更新先进 ChangeProposal（非静默覆盖），
// 人在收件箱审；采纳走既有 applyAction 落库（origin/溯源/乐观锁自动）。全程 tenantId 隔离。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { prisma } from './prisma.js';
import { applyAction } from './mutate.js';

/** 建字段更新提案（去重：同 实体+字段 已有 pending 则覆盖最新值，避免堆叠重复打扰）。供 voice/MCP 等机器写源调用。 */
export async function createFieldProposal(tenantId: string, p: {
  accountId: string; opportunityId?: string; entityKind: string; entityId: string;
  field: string; oldValue: string; newValue: string; origin?: string; evidence?: string; confidence?: number; proposedBy?: string;
}): Promise<void> {
  if (p.oldValue === p.newValue) return; // 无变化不提
  const existing = await prisma.changeProposal.findFirst({ where: { tenantId, accountId: p.accountId, entityKind: p.entityKind, entityId: p.entityId, field: p.field, status: 'pending' } });
  if (existing) {
    await prisma.changeProposal.update({ where: { id: existing.id }, data: { oldValue: p.oldValue, newValue: p.newValue, evidence: p.evidence ?? '', confidence: p.confidence ?? 0.5, origin: p.origin ?? 'voice' } });
    return;
  }
  await prisma.changeProposal.create({ data: { id: 'cp_' + randomUUID().slice(0, 12), tenantId, accountId: p.accountId, opportunityId: p.opportunityId ?? null, entityKind: p.entityKind, entityId: p.entityId, field: p.field, oldValue: p.oldValue, newValue: p.newValue, origin: p.origin ?? 'voice', evidence: p.evidence ?? '', confidence: p.confidence ?? 0.5, proposedBy: p.proposedBy ?? '' } });
}

/** 采纳：据 entityKind/field 走既有 applyAction 落库（v2.0 = oppRole.sentiment）。value 为最终值（改后采纳时是覆盖值）。 */
async function applyProposal(tenantId: string, cp: { accountId: string; opportunityId: string | null; entityKind: string; entityId: string; field: string }, value: string): Promise<void> {
  if (cp.entityKind === 'oppRole' && cp.opportunityId && cp.field === 'sentiment') {
    await applyAction(tenantId, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { sentiment: value } } as any);
    return;
  }
  throw new Error(`暂不支持的提案类型：${cp.entityKind}.${cp.field}`);
}

export function proposalRoutes(app: FastifyInstance) {
  // 采纳 / 改后采纳（body.overrideValue 给则用它落库）
  app.post('/api/proposals/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const tenantId = req.user.tenantId;
    const cp = await prisma.changeProposal.findFirst({ where: { id: req.params.id, tenantId } });
    if (!cp) return reply.code(404).send({ error: '提案不存在' });
    if (cp.status !== 'pending') return reply.code(400).send({ error: '该提案已处理' });
    const value = typeof req.body?.overrideValue === 'string' && req.body.overrideValue ? req.body.overrideValue : cp.newValue;
    try {
      await applyProposal(tenantId, cp, value);
      await prisma.changeProposal.update({ where: { id: cp.id }, data: { status: 'accepted', newValue: value } });
      return { ok: true };
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '采纳失败' }); }
  });
  app.post('/api/proposals/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const r = await prisma.changeProposal.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'pending' }, data: { status: 'rejected' } });
    if (!r.count) return reply.code(404).send({ error: '提案不存在或已处理' });
    return { ok: true };
  });
}
