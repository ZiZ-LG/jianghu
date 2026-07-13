// 统一变更提案（机器写初稿·人审 v2.0）：机器对【已有实体字段】的更新先进 ChangeProposal（非静默覆盖），
// 人在收件箱审；采纳走既有 applyAction 落库（origin/溯源/乐观锁自动）。全程 tenantId 隔离。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ActionSchema, ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import { applyAction, runPostCommitEffect, type DbClient, type PostCommitEffect } from './mutate.js';

/** 建字段更新提案（去重：同 实体+字段 已有 pending 则覆盖最新值，避免堆叠重复打扰）。供 voice/MCP 等机器写源调用。 */
export async function createFieldProposal(tenantId: string, p: {
  accountId: string; opportunityId?: string; entityKind: string; entityId: string;
  field: string; oldValue: string; newValue: string; origin?: string; evidence?: string; confidence?: number; proposedBy?: string;
}): Promise<void> {
  if (p.oldValue === p.newValue) return; // 无变化不提
  const dedupeKey = JSON.stringify([tenantId, p.accountId, p.entityKind, p.entityId, p.field]);
  const existing = await prisma.changeProposal.findUnique({ where: { dedupeKey } })
    ?? await prisma.changeProposal.findFirst({
      where: { tenantId, accountId: p.accountId, entityKind: p.entityKind, entityId: p.entityId, field: p.field, status: 'pending', dedupeKey: null },
    });
  if (existing) {
    await prisma.changeProposal.update({ where: { id: existing.id }, data: { opportunityId: p.opportunityId ?? null, oldValue: p.oldValue, newValue: p.newValue, evidence: p.evidence ?? '', confidence: p.confidence ?? 0.5, origin: p.origin ?? 'voice', proposedBy: p.proposedBy ?? '', dedupeKey } });
    return;
  }
  const cpId = 'cp_' + randomUUID().slice(0, 12);
  try {
    await prisma.changeProposal.create({ data: { id: cpId, tenantId, accountId: p.accountId, opportunityId: p.opportunityId ?? null, entityKind: p.entityKind, entityId: p.entityId, field: p.field, oldValue: p.oldValue, newValue: p.newValue, origin: p.origin ?? 'voice', evidence: p.evidence ?? '', confidence: p.confidence ?? 0.5, proposedBy: p.proposedBy ?? '', dedupeKey } });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
    await prisma.changeProposal.updateMany({ where: { dedupeKey, status: 'pending' }, data: { opportunityId: p.opportunityId ?? null, oldValue: p.oldValue, newValue: p.newValue, evidence: p.evidence ?? '', confidence: p.confidence ?? 0.5, origin: p.origin ?? 'voice', proposedBy: p.proposedBy ?? '' } });
    return;
  }
  // 场景 B：新提案推企微模板卡（一键采纳）。fire-and-forget + 动态 import 破 proposals↔wecom 循环依赖。
  void import('./wecom.js').then((w) => w.pushProposalCard(tenantId, cpId)).catch(() => {});
}

// P13 提案值域校验：非法值直接抛错（改后采纳的兜底），SET_ROLE.patch 精确对齐已有字段类型
const SentimentSchema = z.enum(['star', 'plus', 'neutral', 'unknown', 'minus', 'x']);
const ConfidenceSchema = z.enum(['共识', '明确', '推理', '不清']);
const BooleanTextSchema = z.enum(['true', 'false']);
const RoleSchema = z.enum(['A', 'D', 'U', 'R', 'C']);
const ProcurementTypeSchema = z.enum(['purchasing', 'agency', 'ownerRep']);
const ProcurementStatusSchema = z.enum(['collude', 'verbal', 'none']);

async function proposalCurrentValue(
  db: DbClient,
  tenantId: string,
  cp: { accountId: string; opportunityId: string | null; entityKind: string; entityId: string; field: string },
): Promise<unknown> {
  if (cp.entityKind === 'oppRole' && cp.opportunityId) {
    const row = await db.oppRole.findFirst({ where: { tenantId, opportunityId: cp.opportunityId, personId: cp.entityId } });
    return row ? (row as unknown as Record<string, unknown>)[cp.field] : undefined;
  }
  if (cp.entityKind === 'person') {
    const row = await db.person.findFirst({ where: { id: cp.entityId, tenantId, accountId: cp.accountId } });
    return row ? (row as unknown as Record<string, unknown>)[cp.field] : undefined;
  }
  if (cp.entityKind === 'personLog' && cp.field === 'append') return '';
  if (cp.entityKind === 'opportunity' && cp.opportunityId) {
    const row = await db.opportunity.findFirst({ where: { id: cp.entityId, tenantId, accountId: cp.accountId } });
    return row ? (row as unknown as Record<string, unknown>)[cp.field] : undefined;
  }
  if (cp.entityKind === 'bi' && cp.opportunityId) {
    const row = await db.burningIssue.findFirst({ where: { id: cp.entityId, tenantId, opportunityId: cp.opportunityId } });
    return row ? (row as unknown as Record<string, unknown>)[cp.field] : undefined;
  }
  if (cp.entityKind === 'ucv' && cp.opportunityId) {
    const row = await db.uCV.findFirst({ where: { id: cp.entityId, tenantId, opportunityId: cp.opportunityId } });
    return row ? (row as unknown as Record<string, unknown>)[cp.field] : undefined;
  }
  return undefined;
}

function proposalValueMatches(current: unknown, expected: string): boolean {
  if (current === undefined) return false;
  const encoded = typeof current === 'string' ? current : JSON.stringify(current ?? null);
  return encoded === expected || (current == null ? '' : String(current)) === expected;
}

/** 采纳：据 entityKind/field 走既有 applyAction 落库。P13 扩：sentiment/confidence/isKeyInfluencer 三种 oppRole 字段。 */
async function applyProposal(ctx: CommandContext, cp: { accountId: string; opportunityId: string | null; entityKind: string; entityId: string; field: string; oldValue: string }, value: string, db: DbClient): Promise<PostCommitEffect> {
  if (cp.entityKind === 'personLog' && cp.field === 'append') {
    const log = (() => { try { return JSON.parse(value); } catch { return null; } })();
    const parsed = ActionSchema.safeParse({ type: 'ADD_LOG', accId: cp.accountId, personId: cp.entityId, log });
    if (!parsed.success) throw new Error('person log proposal is invalid');
    return applyAction(ctx, parsed.data, db);
  }
  // 兼容 INT-107 之前已入库的 person.logs 提案：只允许严格的单条头部 append，禁止整体替换/伪造 createdBy。
  if (cp.entityKind === 'person' && cp.field === 'logs') {
    let before: unknown; let after: unknown;
    try { before = JSON.parse(cp.oldValue); after = JSON.parse(value); } catch { throw new Error('legacy log proposal is invalid'); }
    if (!Array.isArray(before) || !Array.isArray(after) || after.length !== before.length + 1
      || JSON.stringify(after.slice(1)) !== JSON.stringify(before)) throw new Error('legacy log proposal is not a single append');
    const parsed = ActionSchema.safeParse({ type: 'ADD_LOG', accId: cp.accountId, personId: cp.entityId, log: after[0] });
    if (!parsed.success) throw new Error('legacy log proposal is invalid');
    return applyAction(ctx, parsed.data, db);
  }
  if (cp.entityKind === 'oppRole' && cp.opportunityId) {
    if (cp.field === 'sentiment') {
      const parsed = SentimentSchema.safeParse(value);
      if (!parsed.success) throw new Error(`sentiment 值非法：${value}`);
      return applyAction(ctx, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { sentiment: parsed.data } }, db);
    }
    if (cp.field === 'confidence') {
      const parsed = ConfidenceSchema.safeParse(value);
      if (!parsed.success) throw new Error(`confidence 值非法：${value}`);
      return applyAction(ctx, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { confidence: parsed.data } }, db);
    }
    if (cp.field === 'isKeyInfluencer') {
      const parsed = BooleanTextSchema.safeParse(value);
      if (!parsed.success) throw new Error(`isKeyInfluencer 值非法：${value}`);
      return applyAction(ctx, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { isKeyInfluencer: parsed.data === 'true' } }, db);
    }
    if (cp.field === 'role') {
      const parsed = RoleSchema.safeParse(value);
      if (!parsed.success) throw new Error(`role 值非法：${value}`);
      return applyAction(ctx, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { role: parsed.data } }, db);
    }
    if (cp.field === 'procurementType') {
      const parsed = ProcurementTypeSchema.safeParse(value);
      if (!parsed.success) throw new Error(`procurementType 值非法：${value}`);
      return applyAction(ctx, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { procurementType: parsed.data } }, db);
    }
    if (cp.field === 'procurementStatus') {
      const parsed = ProcurementStatusSchema.safeParse(value);
      if (!parsed.success) throw new Error(`procurementStatus 值非法：${value}`);
      return applyAction(ctx, { type: 'SET_ROLE', accId: cp.accountId, oppId: cp.opportunityId, personId: cp.entityId, patch: { procurementStatus: parsed.data } }, db);
    }
  }
  const decoded = (() => { try { return JSON.parse(value); } catch { return value; } })();
  const candidate = cp.entityKind === 'person'
    ? { type: 'UPDATE_PERSON', accId: cp.accountId, personId: cp.entityId, patch: { [cp.field]: decoded } }
    : cp.entityKind === 'opportunity' && cp.opportunityId
      ? { type: 'UPDATE_OPP', accId: cp.accountId, oppId: cp.opportunityId, patch: { [cp.field]: decoded } }
      : cp.entityKind === 'bi' && cp.opportunityId
        ? { type: 'UPDATE_BI', accId: cp.accountId, oppId: cp.opportunityId, biId: cp.entityId, patch: { [cp.field]: decoded } }
        : cp.entityKind === 'ucv' && cp.opportunityId
          ? { type: 'UPDATE_UCV', accId: cp.accountId, oppId: cp.opportunityId, ucvId: cp.entityId, patch: { [cp.field]: decoded } }
          : null;
  const parsed = candidate ? ActionSchema.safeParse(candidate) : null;
  if (parsed?.success) {
    return applyAction(ctx, parsed.data, db);
  }
  throw new Error(`暂不支持的提案类型：${cp.entityKind}.${cp.field}`);
}

/** 采纳一条提案（HTTP 路由与企微一键采纳共用）。'missing'=不存在(本租户)，'already'=已处理过。 */
export async function acceptProposal(ctx: CommandContext, id: string, overrideValue?: string): Promise<'ok' | 'already' | 'missing'> {
  const { tenantId } = ctx;
  const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cp = await tx.changeProposal.findFirst({ where: { id, tenantId } });
    if (!cp) return { result: 'missing' as const, effect: undefined };
    if (cp.status !== 'pending') return { result: 'already' as const, effect: undefined };
    const claim = await tx.changeProposal.updateMany({
      where: { id: cp.id, tenantId, status: 'pending' },
      data: { status: 'applying' },
    });
    if (claim.count !== 1) return { result: 'already' as const, effect: undefined };
    const value = overrideValue ?? cp.newValue;
    const currentValue = await proposalCurrentValue(tx, tenantId, cp);
    if (!proposalValueMatches(currentValue, cp.oldValue)) {
      throw new Error('正式字段已被人工更新，请刷新后重新审阅提案');
    }
    const effect = await applyProposal(ctx, cp, value, tx);
    const finalized = await tx.changeProposal.updateMany({
      where: { id: cp.id, tenantId, status: 'applying' },
      data: { status: 'accepted', newValue: value, dedupeKey: null },
    });
    if (finalized.count !== 1) throw new Error('proposal acceptance lost claim');
    return { result: 'ok' as const, effect };
  });
  if (outcome.result === 'ok') await runPostCommitEffect(outcome.effect);
  return outcome.result;
}

/** 驳回一条提案（幂等：非 pending 视为已处理）。 */
export async function rejectProposal(tenantId: string, id: string): Promise<'ok' | 'already'> {
  const r = await prisma.changeProposal.updateMany({ where: { id, tenantId, status: 'pending' }, data: { status: 'rejected', dedupeKey: null } });
  return r.count ? 'ok' : 'already';
}

/** WeCom 专用审批边界：身份复核与 proposal CAS/正式写入在同一 Serializable transaction 内。 */
export async function reviewProposalFromWecom(
  tenantId: string,
  wecomUserid: string,
  proposalId: string,
  decision: 'accept' | 'reject',
): Promise<'ok' | 'already' | 'missing' | 'unauthorized'> {
  const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const binds = await tx.weComUserBind.findMany({ where: { tenantId, wecomUserid }, take: 2 });
    if (binds.length !== 1) return { result: 'unauthorized' as const, effect: undefined };
    const actor = await tx.user.findFirst({ where: { id: binds[0].userId, tenantId }, select: { id: true, role: true } });
    const actorRole = ActorRoleSchema.safeParse(actor?.role);
    if (!actor || !actorRole.success || actorRole.data === 'viewer') return { result: 'unauthorized' as const, effect: undefined };
    const cp = await tx.changeProposal.findFirst({ where: { id: proposalId, tenantId } });
    if (!cp) return { result: 'missing' as const, effect: undefined };
    if (cp.status !== 'pending') return { result: 'already' as const, effect: undefined };
    if (decision === 'reject') {
      const rejected = await tx.changeProposal.updateMany({ where: { id: cp.id, tenantId, status: 'pending' }, data: { status: 'rejected', dedupeKey: null } });
      return { result: rejected.count === 1 ? 'ok' as const : 'already' as const, effect: undefined };
    }
    const claim = await tx.changeProposal.updateMany({ where: { id: cp.id, tenantId, status: 'pending' }, data: { status: 'applying' } });
    if (claim.count !== 1) return { result: 'already' as const, effect: undefined };
    const currentValue = await proposalCurrentValue(tx, tenantId, cp);
    if (!proposalValueMatches(currentValue, cp.oldValue)) throw new Error('正式字段已被人工更新');
    const effect = await applyProposal({
      tenantId, actorId: actor.id, actorRole: actorRole.data, channel: 'web',
      requestId: `wecom:${randomUUID()}`, assertionMode: 'user_asserted',
    }, cp, cp.newValue, tx);
    const finalized = await tx.changeProposal.updateMany({ where: { id: cp.id, tenantId, status: 'applying' }, data: { status: 'accepted', dedupeKey: null } });
    if (finalized.count !== 1) throw new Error('proposal acceptance lost claim');
    return { result: 'ok' as const, effect };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (outcome.result === 'ok') await runPostCommitEffect(outcome.effect);
  return outcome.result;
}

export function proposalRoutes(app: FastifyInstance) {
  // 采纳 / 改后采纳（body.overrideValue 给则用它落库）
  app.post('/api/proposals/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const override = typeof req.body?.overrideValue === 'string' && req.body.overrideValue ? req.body.overrideValue : undefined;
    try {
      const r = await acceptProposal({
        tenantId: req.user.tenantId,
        actorId: req.user.userId,
        actorRole: ActorRoleSchema.parse(req.user.role),
        channel: 'web',
        requestId: req.id,
        assertionMode: 'user_asserted',
      }, req.params.id, override);
      if (r === 'missing') return reply.code(404).send({ error: '提案不存在' });
      if (r === 'already') return reply.code(400).send({ error: '该提案已处理' });
      return { ok: true };
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '采纳失败' }); }
  });
  app.post('/api/proposals/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const r = await rejectProposal(req.user.tenantId, req.params.id);
    if (r === 'already') return reply.code(404).send({ error: '提案不存在或已处理' });
    return { ok: true };
  });
}
