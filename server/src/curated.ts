// AI 梳理层（P3）：把实体原始(笔记/拜访纪要/录音转写/人物动态)梳理成「AI 整理·待核」现状综述。
// 铁律：① 不覆盖原始(只加一层) ② 不写分(趋赢力恒由 g64111 算，prompt 禁止打分) ③ tenantId 隔离。
// 懒生成+按实体缓存：basedOnAt=梳理所基于的原始最新时间，与当前原始最新时间比较决定是否重梳理；
// human-wins：editedByHuman=true(人改过)→锁定，AI 不再重生成覆盖。无 AI key→不梳理(前端只显原始)。

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { loadAiConfig, callLLM } from './ai.js';
import { visiblePersonLogs } from './visibility.js';
import { activePersonWhere } from './activePerson.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';

type EntityKind = 'account' | 'opportunity';

const CURATE_SYSTEM = `你是 B2B 大客户销售情报梳理助手。把零散的原始记录(笔记/拜访纪要/录音转写/关键人动态)整理成一段有条理的「现状综述」。
要求：
- 只整理已有信息，绝不编造、不补充原文没提到的事实；拿不准就不写。
- 客观叙述当前态势/进展/关键人动向/待跟进线索，分 2-4 小段，简洁。
- 不要打分、不要给趋赢力或任何百分比数字(分数由系统另算)。
- 简洁中文，不超过 400 字。这是给销售看的「AI 整理·待核」摘要。`;

/** 收集实体原始层 → 拼接文本 + 最新时间戳(用于懒生成判过期)。 */
async function collectRaw(tenantId: string, kind: EntityKind, entityId: string): Promise<{ text: string; latestAt: Date | null; name: string }> {
  let latest: Date | null = null;
  const bump = (d?: Date | null) => { if (d && (!latest || d > latest)) latest = d; };
  const parts: string[] = [];

  const where = kind === 'account' ? { tenantId, accountId: entityId } : { tenantId, opportunityId: entityId };
  const notes = await prisma.note.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
  const visits = await prisma.visitNote.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 });
  notes.forEach((n) => bump(n.createdAt));
  visits.forEach((vn) => bump(vn.createdAt));
  if (visits.length) parts.push('【拜访纪要】\n' + visits.map((vn) => `- ${vn.date || '?'} ${vn.topic || '拜访'}：${vn.summary}`).join('\n'));
  if (notes.length) parts.push('【笔记】\n' + notes.map((n) => `- ${n.content}`).join('\n'));

  let name = '';
  if (kind === 'account') {
    const acc = await prisma.account.findFirst({ where: { id: entityId, tenantId }, include: { persons: { where: activePersonWhere } } });
    if (!acc) return { text: '', latestAt: null, name: '' };
    name = acc.name;
    const logLines: string[] = [];
    for (const p of acc.persons) {
      // CuratedSummary 是实体级共享缓存，因此 AI 上下文只能使用 org 动态；
      // self/team 动态若进入共享摘要，会绕过读取 ACL。
      const logs = visiblePersonLogs(p.logs, { tenantId, userId: '', role: 'viewer' });
      for (const l of logs.slice(-5)) if (typeof l.content === 'string' && l.content) logLines.push(`${p.name}：${l.content}`);
    }
    if (logLines.length) parts.push('【关键人动态】\n' + logLines.map((l) => `- ${l}`).join('\n'));
  } else {
    const opp = await prisma.opportunity.findFirst({ where: { id: entityId, tenantId } });
    if (!opp) return { text: '', latestAt: null, name: '' };
    name = opp.name;
  }
  return { text: parts.join('\n\n'), latestAt: latest, name };
}

export interface CuratedResult { content: string; status: string; editedByHuman: boolean; updatedAt?: Date; error?: string }

/** 懒生成综述：human 锁定/缓存命中直接返回；过期或强制则调 LLM 重梳理并缓存。 */
export async function getCuratedSummary(tenantId: string, kind: EntityKind, entityId: string, force = false): Promise<CuratedResult> {
  const cur = await prisma.curatedSummary.findUnique({ where: { tenantId_entityKind_entityId: { tenantId, entityKind: kind, entityId } } });
  // 旧 AI 缓存无法证明是否混入 self/team 动态；人工编辑内容仍是明确的团队共享产物。
  const safeCur = cur && (cur.editedByHuman || cur.aclVersion >= 1) ? cur : null;
  // human-wins：人改过且非强制 → 返回锁定缓存，不重生成覆盖
  if (safeCur?.editedByHuman && !force) return { content: safeCur.content, status: 'human', editedByHuman: true, updatedAt: safeCur.updatedAt };

  const raw = await collectRaw(tenantId, kind, entityId);
  if (!raw.text.trim()) return { content: safeCur?.content || '', status: 'empty', editedByHuman: false };

  // 缓存新鲜(basedOnAt 覆盖最新原始) 或 无时间戳信号(只有 logs)时，非强制则用缓存(零 LLM)
  const fresh = !!(safeCur?.basedOnAt && raw.latestAt && safeCur.basedOnAt >= raw.latestAt);
  const noSignal = !!safeCur && !raw.latestAt;
  if (safeCur && !force && (fresh || noSignal)) return { content: safeCur.content, status: 'cached', editedByHuman: false, updatedAt: safeCur.updatedAt };

  const ai = await loadAiConfig(tenantId);
  if (!ai || ai.provider === 'mock' || !ai.baseUrl || !ai.model) return { content: safeCur?.content || '', status: 'needConfig', editedByHuman: false };

  let content = '';
  try {
    const raw0 = await callLLM({ baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }, CURATE_SYSTEM, `【${raw.name}】的原始记录：\n\n${raw.text}\n\n请整理成现状综述。`, 2000);
    content = raw0.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```\w*|```/g, '').trim();
  } catch (e: any) { return { content: safeCur?.content || '', status: 'error', editedByHuman: false, error: e?.message || '模型返回异常' }; }
  if (!content) return { content: safeCur?.content || '', status: 'error', editedByHuman: false, error: '模型无返回' };

  await prisma.curatedSummary.upsert({
    where: { tenantId_entityKind_entityId: { tenantId, entityKind: kind, entityId } },
    update: { content, model: ai.model, basedOnAt: raw.latestAt, editedByHuman: false, aclVersion: 1 },
    create: { id: 'cs_' + randomUUID().replaceAll('-', ''), tenantId, entityKind: kind, entityId, content, model: ai.model, basedOnAt: raw.latestAt, aclVersion: 1 },
  });
  return { content, status: 'generated', editedByHuman: false };
}

// 校验实体属本租户（隔离）
async function entityOwned(tenantId: string, kind: EntityKind, entityId: string): Promise<boolean> {
  if (kind === 'account') return !!(await prisma.account.findFirst({ where: { id: entityId, tenantId }, select: { id: true } }));
  return !!(await prisma.opportunity.findFirst({ where: { id: entityId, tenantId }, select: { id: true } }));
}

export function curatedRoutes(app: FastifyInstance): void {
  // 懒生成获取综述（打开作战档案时调）
  app.get('/api/curated', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const kind = req.query?.entityKind;
    const eid = typeof req.query?.entityId === 'string' ? req.query.entityId : '';
    if ((kind !== 'account' && kind !== 'opportunity') || !eid) return reply.code(400).send({ error: '参数错误' });
    const scope = await resolveEffectiveResourceScope(prisma, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
    });
    const canRead = kind === 'account'
      ? scope.canReadAccountData(eid)
      : scope.canReadMatter(eid);
    if (!canRead) return reply.code(404).send({ error: '实体不存在' });
    // viewer 归属校验（契约 v1.0 §四）+ 只读缓存：不触发懒生成（不花租户 AI 额度、不写缓存行）
    if (scope.actorRole === 'viewer') {
      // 历史共享摘要可能由旧版本把 team/self 动态纳入；无法证明字段级来源时 fail closed。
      return { content: '', status: 'restricted', editedByHuman: false };
    }
    return getCuratedSummary(req.user.tenantId, kind, eid);
  });

  // 人编辑综述 → 锁定(human-wins)，AI 不再覆盖
  app.put('/api/curated', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可编辑' });
    const p = z.object({ entityKind: z.enum(['account', 'opportunity']), entityId: z.string().min(1), content: z.string() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数错误' });
    if (!(await entityOwned(req.user.tenantId, p.data.entityKind, p.data.entityId))) return reply.code(404).send({ error: '实体不存在' });
    await prisma.curatedSummary.upsert({
      where: { tenantId_entityKind_entityId: { tenantId: req.user.tenantId, entityKind: p.data.entityKind, entityId: p.data.entityId } },
      update: { content: p.data.content, editedByHuman: true, editedBy: req.user.userId || '' },
      create: { id: 'cs_' + randomUUID().replaceAll('-', ''), tenantId: req.user.tenantId, entityKind: p.data.entityKind, entityId: p.data.entityId, content: p.data.content, editedByHuman: true, editedBy: req.user.userId || '' },
    });
    return { ok: true };
  });

  // 强制重新梳理（清 human 锁定、忽略缓存，重新调 LLM）
  app.post('/api/curated/regenerate', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可操作' });
    const p = z.object({ entityKind: z.enum(['account', 'opportunity']), entityId: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数错误' });
    if (!(await entityOwned(req.user.tenantId, p.data.entityKind, p.data.entityId))) return reply.code(404).send({ error: '实体不存在' });
    return getCuratedSummary(req.user.tenantId, p.data.entityKind, p.data.entityId, true);
  });
}
