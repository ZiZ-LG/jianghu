import type { FastifyInstance } from 'fastify';
import { Prisma, type RelSuggestion } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { denyViewer, viewerCanReadAccount, viewerCanReadOpp } from './scope.js';
import { loadAiConfig, callLLM } from './ai.js';
import { nextFreeSlot } from './layout.js';
import { getPatrolInfo } from './patrol.js';
import {
  requireAccount,
  requireEdgeEndpoints,
  requireOpportunity,
  requirePerson,
  ScopedNotFoundError,
} from './mutation/scopeGuards.js';
import { resolveScopedRelSuggestions } from './suggestionScope.js';
import { createPdeSnapshot } from './pde/routes.js';

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const parseForm = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const ORIGIN_LABEL: Record<string, string> = { mcp: 'AI 调研·待核实', ai: 'AI 推测·待核实', qcc: '企查查导入' };

class SuggestionConflictError extends Error {
  readonly suggestionConflict = true;

  constructor() {
    super('该候选已被处理，请刷新后重试');
    this.name = 'SuggestionConflictError';
  }
}

class EvidenceReviewNotFoundError extends Error {}

const EVIDENCE_REVIEW_TX_ATTEMPTS = 3;

const prismaErrorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

async function approveEvidenceWithSnapshot(
  tenantId: string,
  evidenceId: string,
  reviewedBy: string,
  reviewedAt: string,
  override: { direction?: -1 | 0 | 1; tier?: 'weak' | 'mid' | 'strong' },
): Promise<void> {
  for (let attempt = 1; attempt <= EVIDENCE_REVIEW_TX_ATTEMPTS; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const evidence = await tx.evidenceEvent.findFirst({
          where: { id: evidenceId, tenantId, status: 'pending_review' },
        });
        if (!evidence) throw new EvidenceReviewNotFoundError();
        const approved = await tx.evidenceEvent.updateMany({
          where: { id: evidence.id, tenantId, status: 'pending_review' },
          data: {
            status: 'approved',
            ...(override.direction !== undefined ? { direction: override.direction } : {}),
            ...(override.tier ? { tier: override.tier } : {}),
            reviewedBy,
            reviewedAt,
          },
        });
        if (!approved.count) throw new EvidenceReviewNotFoundError();
        await createPdeSnapshot(tx, tenantId, evidence.opportunityId, 'evidence_review', reviewedBy);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000,
      });
      return;
    } catch (error) {
      if (error instanceof EvidenceReviewNotFoundError) throw error;
      if (prismaErrorCode(error) !== 'P2034' || attempt === EVIDENCE_REVIEW_TX_ATTEMPTS) throw error;
    }
  }
}

interface MaterializePersonOptions {
  expectedAccountId?: string;
  override?: { name?: string; title?: string };
  allowAcceptedReuse?: boolean;
}

/**
 * 从候选人物落一个正式 Person（在传入的事务客户端内执行）。幂等：若候选已 accepted 且有 resolvedPersonId 则直接复用。
 * 返回 { personId, createdPerson? }，createdPerson 用于前端 dispatch ADD_PERSON。
 */
async function materializePerson(
  tx: any,
  tenantId: string,
  suggId: string,
  options: MaterializePersonOptions = {},
): Promise<{ personId: string; accountId: string; createdPerson?: any }> {
  const ps = await tx.personSuggestion.findFirst({ where: { id: suggId, tenantId } });
  if (!ps) throw new ScopedNotFoundError();
  await requireAccount(tx, tenantId, ps.accountId);
  if (options.expectedAccountId !== undefined && ps.accountId !== options.expectedAccountId) throw new ScopedNotFoundError();
  if (ps.opportunityId) await requireOpportunity(tx, tenantId, ps.accountId, ps.opportunityId);
  if (ps.status === 'rejected') throw new Error(`候选干系人「${ps.name}」已被否决，无法作为关系端点`);
  if (ps.status === 'accepted') {
    if (!ps.resolvedPersonId) throw new SuggestionConflictError();
    await requirePerson(tx, tenantId, ps.accountId, ps.resolvedPersonId);
    if (options.allowAcceptedReuse === false) throw new SuggestionConflictError();
    return { personId: ps.resolvedPersonId, accountId: ps.accountId };
  }
  if (ps.status !== 'pending' || ps.resolvedPersonId) throw new SuggestionConflictError();

  // 原子 claim 必须先于任何正式写入。事务失败会把临时 accepted 自动回滚为 pending，外部不可见半完成状态。
  const claim = await tx.personSuggestion.updateMany({
    where: { id: ps.id, tenantId, status: 'pending', resolvedPersonId: null },
    data: {
      status: 'accepted',
      ...(options.override?.name !== undefined ? { name: options.override.name } : {}),
      ...(options.override?.title !== undefined ? { title: options.override.title } : {}),
    },
  });
  if (claim.count !== 1) throw new SuggestionConflictError();
  const candidate = { ...ps, ...options.override };

  const others = await tx.person.findMany({ where: { tenantId, accountId: candidate.accountId, isCompetitor: false }, select: { x: true, y: true } });
  const { x, y } = nextFreeSlot(others);
  const today = new Date().toISOString().slice(0, 10);
  const logs = [{ date: today, content: `📥 ${ORIGIN_LABEL[candidate.origin] || '外部导入'}（${candidate.evidence || '无备注'}）${candidate.sourceUrl ? ' · ' + candidate.sourceUrl : ''}`, visibility: 'team' }];
  const personId = 'p_' + randomUUID().slice(0, 12);
  await tx.person.create({ data: { id: personId, tenantId, accountId: candidate.accountId, name: candidate.name, title: candidate.title, orgLevel: candidate.orgLevel, isCompetitor: false, x, y, form: '{}', logs: JSON.stringify(logs) } });
  // 候选挂在 memberScoped 商机 → 新建的人加入该商机成员（可见性）
  if (candidate.opportunityId) {
    const mo = await tx.opportunity.findFirst({ where: { id: candidate.opportunityId, tenantId, accountId: candidate.accountId }, select: { memberScoped: true } });
    if (mo?.memberScoped) await tx.opportunityMember.upsert({ where: { tenantId_opportunityId_personId: { tenantId, opportunityId: candidate.opportunityId, personId } }, create: { tenantId, opportunityId: candidate.opportunityId, personId }, update: {} });
  }
  // WorkBuddy 提议时带了建议角色 + 关联商机 → 采纳时一并落 OppRole（守"角色只对正式 Person"）
  if (candidate.suggestedRole && candidate.opportunityId) {
    const opp = await tx.opportunity.findFirst({ where: { id: candidate.opportunityId, tenantId, accountId: candidate.accountId } });
    if (opp) {
      await tx.oppRole.upsert({
        where: { tenantId_opportunityId_personId: { tenantId, opportunityId: candidate.opportunityId, personId } },
        create: { tenantId, opportunityId: candidate.opportunityId, personId, role: candidate.suggestedRole, sentiment: candidate.suggestedSentiment || 'unknown', confidence: '推理' },
        update: {},
      });
    }
  }
  const finalized = await tx.personSuggestion.updateMany({
    where: { id: ps.id, tenantId, status: 'accepted', resolvedPersonId: null },
    data: { resolvedPersonId: personId },
  });
  if (finalized.count !== 1) throw new SuggestionConflictError();
  // key 收敛：把仍 pending、引用该候选的其它关系端点改写为 person/resolvedPersonId（防重复边）
  const accountOpportunities = await tx.opportunity.findMany({
    where: { tenantId, accountId: candidate.accountId },
    select: { id: true },
  });
  const opportunityIds = accountOpportunities.map((opportunity: { id: string }) => opportunity.id);
  if (opportunityIds.length) {
    await tx.relSuggestion.updateMany({ where: { tenantId, opportunityId: { in: opportunityIds }, status: 'pending', sourceKind: 'suggestion', sourcePersonId: suggId }, data: { sourceKind: 'person', sourcePersonId: personId } });
    await tx.relSuggestion.updateMany({ where: { tenantId, opportunityId: { in: opportunityIds }, status: 'pending', targetKind: 'suggestion', targetPersonId: suggId }, data: { targetKind: 'person', targetPersonId: personId } });
  }
  const createdPerson = { id: personId, name: candidate.name, title: candidate.title, orgLevel: candidate.orgLevel, isCompetitor: false, x, y, form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} }, logs };
  return { personId, accountId: candidate.accountId, createdPerson };
}

interface Cand { source: string; target: string; layer: string; label: string; confidence: number; origin: string; evidence: string; }

const LlmCandidateSchema = z.object({
  from: z.string(),
  to: z.string(),
  layer: z.enum(['L1', 'L2', 'L3', 'L4']).optional(),
  label: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
}).strict();

// ── 图算法：共同邻居 → 疑似关联 ──
function graphCandidates(persons: any[], edges: any[], nameOf: (id: string) => string): Cand[] {
  const adj = new Map<string, Set<string>>();
  persons.forEach((p) => adj.set(p.id, new Set()));
  edges.forEach((e) => { adj.get(e.source)?.add(e.target); adj.get(e.target)?.add(e.source); });
  const connected = new Set(edges.map((e) => pairKey(e.source, e.target)));
  const nonComp = persons.filter((p) => !p.isCompetitor);
  const out: Cand[] = [];
  for (let i = 0; i < nonComp.length; i++) {
    for (let j = i + 1; j < nonComp.length; j++) {
      const a = nonComp[i], b = nonComp[j];
      if (connected.has(pairKey(a.id, b.id))) continue;
      const common = [...(adj.get(a.id) || [])].filter((x) => adj.get(b.id)?.has(x));
      if (common.length >= 2) {
        out.push({
          source: a.id, target: b.id, layer: 'L3', label: '疑似同盟/共同圈子',
          confidence: Math.min(0.85, 0.4 + 0.12 * common.length), origin: 'graph',
          evidence: `共有 ${common.length} 位共同联系人：${common.slice(0, 4).map(nameOf).join('、')}`,
        });
      }
    }
  }
  return out.sort((x, y) => y.confidence - x.confidence).slice(0, 8);
}

// ── mock 启发式：共享籍贯=老乡 / 共享院校=校友 ──
function mockLlmCandidates(persons: any[], connected: Set<string>): Cand[] {
  const out: Cand[] = [];
  const nonComp = persons.filter((p) => !p.isCompetitor);
  const field = (p: any, k: string) => (parseForm(p.form).family7?.[k] || '').trim();
  for (let i = 0; i < nonComp.length; i++) {
    for (let j = i + 1; j < nonComp.length; j++) {
      const a = nonComp[i], b = nonComp[j];
      if (connected.has(pairKey(a.id, b.id))) continue;
      const xiang = field(a, '籍贯'); const yuan = field(a, '毕业院校');
      if (xiang && xiang === field(b, '籍贯'))
        out.push({ source: a.id, target: b.id, layer: 'L3', label: '老乡', confidence: 0.6, origin: 'llm', evidence: `同为 ${xiang} 籍贯` });
      else if (yuan && yuan === field(b, '毕业院校'))
        out.push({ source: a.id, target: b.id, layer: 'L3', label: '校友', confidence: 0.65, origin: 'llm', evidence: `同为 ${yuan} 校友` });
    }
  }
  return out.slice(0, 6);
}

// ── 真实 LLM：读 FORM/日志推断关系，要求 JSON ──
async function llmCandidates(cfg: any, persons: any[], edges: any[], nameOf: (id: string) => string): Promise<Cand[]> {
  const idByName = new Map(persons.map((p) => [p.name, p.id]));
  const profile = persons.filter((p) => !p.isCompetitor).map((p) => {
    const f = parseForm(p.form);
    const logs = (f && Array.isArray(p.logsArr) ? p.logsArr : []);
    return { 姓名: p.name, 职务: p.title, 籍贯: f.family7?.籍贯, 院校: f.family7?.毕业院校, 事业: f.occupation, 动机: f.moneyMotivation };
  });
  const rels = edges.map((e) => `${nameOf(e.source)}-${nameOf(e.target)}(${e.label})`);
  const system = '你是销售情报分析助手。根据干系人资料，推断他们之间「可能存在但尚未记录」的人际关系（校友/老乡/师徒/同盟/亲属/利益关联等）。只输出 JSON 数组，每项 {from,to,layer,label,confidence,evidence}；layer 取 L1/L2/L3/L4；from/to 必须用给定姓名；只给有依据的，最多 6 条；不要输出 JSON 以外内容。';
  const user = `干系人：\n${JSON.stringify(profile, null, 1)}\n\n已知关系：${rels.join('；') || '无'}`;
  let text = '';
  try { text = await callLLM({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, system, user, 700); } catch { return []; }
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: z.infer<typeof LlmCandidateSchema>[];
  try { arr = z.array(LlmCandidateSchema).parse(JSON.parse(m[0])); } catch { return []; }
  const out: Cand[] = [];
  for (const r of Array.isArray(arr) ? arr : []) {
    const s = idByName.get(String(r.from)), t = idByName.get(String(r.to));
    if (!s || !t || s === t) continue;
    out.push({ source: s, target: t, layer: r.layer ?? 'L3', label: String(r.label || '疑似关联').slice(0, 20), confidence: r.confidence ?? 0.5, origin: 'llm', evidence: String(r.evidence || '').slice(0, 120) });
  }
  return out.slice(0, 6);
}

async function loadGraph(tenantId: string, oppId: string) {
  const opp = await prisma.opportunity.findFirst({ where: { id: oppId, tenantId } });
  if (!opp) return null;
  const persons = await prisma.person.findMany({ where: { tenantId, accountId: opp.accountId } });
  const edges = await prisma.edge.findMany({ where: { tenantId, accountId: opp.accountId, OR: [{ opportunityId: null }, { opportunityId: oppId }] } });
  return { opp, persons, edges };
}

/**
 * 生成某商机的关系候选（图算法共同邻居 + LLM/mock 启发）→ 写 RelSuggestion（pending，走人审，铁律②）。
 * 路由 /api/suggest/generate 与后台 suggest_relations job 共用此核心。返回 { added, total } 或 null（商机不存在）。
 * 效率护栏：非竞品干系人 < 2 时无可推断，直接返回（避免空图也烧 LLM token）。
 */
export async function generateRelSuggestions(tenantId: string, opportunityId: string): Promise<{ added: number; total: number } | null> {
  const g = await loadGraph(tenantId, opportunityId);
  if (!g) return null;
  const nameOf = (id: string) => g.persons.find((x) => x.id === id)?.name || id;
  const connected = new Set(g.edges.map((e) => pairKey(e.source, e.target)));

  let added = 0;
  if (g.persons.filter((p) => !p.isCompetitor).length >= 2) {
    // 去重：排除已连接 + 该商机下所有历史候选（含已采纳/已忽略，避免重复打扰）
    const existing = await prisma.relSuggestion.findMany({ where: { opportunityId, tenantId } });
    const seen = new Set<string>([...connected, ...existing.map((s) => pairKey(s.sourcePersonId, s.targetPersonId))]);
    let cands: Cand[] = graphCandidates(g.persons, g.edges, nameOf);
    const cfg = await loadAiConfig(tenantId);
    if (cfg) cands = cands.concat(cfg.provider === 'mock' || !cfg.baseUrl || !cfg.model ? mockLlmCandidates(g.persons, connected) : await llmCandidates(cfg, g.persons, g.edges, nameOf));
    const fresh = cands.filter((c) => { const k = pairKey(c.source, c.target); if (c.source === c.target || seen.has(k)) return false; seen.add(k); return true; });
    if (fresh.length) {
      await prisma.relSuggestion.createMany({ data: fresh.map((c) => ({ id: 'rs_' + randomUUID().slice(0, 12), tenantId, opportunityId, sourcePersonId: c.source, targetPersonId: c.target, layer: c.layer, label: c.label, confidence: c.confidence, origin: c.origin, evidence: c.evidence })) });
    }
    added = fresh.length;
  }
  const total = await prisma.relSuggestion.count({ where: { opportunityId, tenantId, status: 'pending' } });
  return { added, total };
}

export function suggestRoutes(app: FastifyInstance) {
  // 先按每行 Opportunity Account 校验两端点，再输出姓名/ID；历史脏行只隐藏，不修复或删除。
  const withNames = async (tenantId: string, rows: RelSuggestion[]) => {
    const scoped = await resolveScopedRelSuggestions(prisma, tenantId, rows);
    return scoped.map(({ row, sourceName, targetName }) => ({
      id: row.id,
      opportunityId: row.opportunityId,
      source: row.sourcePersonId,
      target: row.targetPersonId,
      sourceKind: row.sourceKind,
      targetKind: row.targetKind,
      sourceName,
      targetName,
      layer: row.layer,
      label: row.label,
      confidence: row.confidence,
      origin: row.origin,
      evidence: row.evidence,
    }));
  };

  app.get('/api/suggest', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const oppId = String(req.query?.opportunityId || '');
    if (!oppId) return reply.code(400).send({ error: '缺少 opportunityId' });
    if (!(await viewerCanReadOpp(req, reply, oppId))) return; // viewer 归属校验（契约 v1.0 §四）
    const g = await loadGraph(req.user.tenantId, oppId);
    if (!g) return reply.code(404).send({ error: '商机不存在' });
    const rows = await prisma.relSuggestion.findMany({ where: { opportunityId: oppId, tenantId: req.user.tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    return { suggestions: await withNames(req.user.tenantId, rows) };
  });

  app.post('/api/suggest/generate', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const p = z.object({ opportunityId: z.string() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 opportunityId' });
    const tenantId = req.user.tenantId;
    const r = await generateRelSuggestions(tenantId, p.data.opportunityId);
    if (!r) return reply.code(404).send({ error: '商机不存在' });
    const all = await prisma.relSuggestion.findMany({ where: { opportunityId: p.data.opportunityId, tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    return { added: r.added, suggestions: await withNames(tenantId, all) };
  });

  // 采纳候选关系：级联事务——若端点是候选人物先落正式 Person，再建 Edge。
  // 返回 { edge, createdPersons }：前端须先 dispatch 这些 ADD_PERSON 再 ADD_EDGE，否则画布找不到端点。
  app.post('/api/suggest/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const tenantId = req.user.tenantId;
    // P10 改后采纳：可选 override（层级/标签），采纳时以改后值建边并写回候选留审计
    const ov = z.object({ layer: z.enum(['L1', 'L2', 'L3', 'L4']).optional(), label: z.string().trim().min(1).max(30).optional() }).safeParse(req.body ?? {});
    if (!ov.success) return reply.code(400).send({ error: '改后采纳参数无效' });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const s = await tx.relSuggestion.findFirst({ where: { id: req.params.id, tenantId } });
        if (!s) throw new ScopedNotFoundError();
        if (s.status !== 'pending') throw new SuggestionConflictError();
        const opp = await tx.opportunity.findFirst({
          where: { id: s.opportunityId, tenantId },
          select: { accountId: true },
        });
        if (!opp) throw new ScopedNotFoundError();
        await requireAccount(tx, tenantId, opp.accountId);
        await requireOpportunity(tx, tenantId, opp.accountId, s.opportunityId);
        const claim = await tx.relSuggestion.updateMany({
          where: { id: s.id, tenantId, status: 'pending' },
          data: { status: 'accepted' },
        });
        if (claim.count !== 1) throw new SuggestionConflictError();
        const layer = ov.data.layer ?? s.layer;
        const label = ov.data.label ?? s.label;
        const createdPersons: any[] = [];
        // 解析两端点为真实 Person.id（候选则级联落库）
        const resolveEnd = async (kind: string, id: string) => {
          if (kind === 'suggestion') {
            const r = await materializePerson(tx, tenantId, id, { expectedAccountId: opp.accountId });
            if (r.createdPerson) createdPersons.push(r.createdPerson);
            return r.personId;
          }
          if (kind !== 'person') throw new ScopedNotFoundError();
          await requirePerson(tx, tenantId, opp.accountId, id);
          return id;
        };
        const sourceId = await resolveEnd(s.sourceKind, s.sourcePersonId);
        const targetId = await resolveEnd(s.targetKind, s.targetPersonId);
        await requireEdgeEndpoints(tx, tenantId, opp.accountId, sourceId, targetId);

        const edgeId = 'e_' + randomUUID().slice(0, 12);
        const color = LAYER_COLOR[layer] || '#16a34a';
        await tx.edge.create({ data: { id: edgeId, tenantId, accountId: opp.accountId, opportunityId: s.opportunityId, source: sourceId, target: targetId, layer, label, color, style: 'solid', width: null, directed: false, origin: 'ai' } });
        const finalized = await tx.relSuggestion.updateMany({
          where: { id: s.id, tenantId, status: 'accepted' },
          data: { layer, label, sourceKind: 'person', sourcePersonId: sourceId, targetKind: 'person', targetPersonId: targetId },
        });
        if (finalized.count !== 1) throw new SuggestionConflictError();
        return { edge: { id: edgeId, source: sourceId, target: targetId, layer, label, color, style: 'solid', directed: false, origin: 'ai' }, createdPersons };
      });
      return result;
    } catch (e: any) {
      if (e instanceof ScopedNotFoundError || e?.scopedNotFound) return reply.code(404).send({ error: '资源不存在' });
      if (e instanceof SuggestionConflictError || e?.suggestionConflict) return reply.code(409).send({ error: '该候选已被处理，请刷新后重试' });
      return reply.code(400).send({ error: e?.message || '采纳失败' });
    }
  });

  app.post('/api/suggest/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const r = await prisma.relSuggestion.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'pending' }, data: { status: 'rejected' } });
    if (!r.count) return reply.code(404).send({ error: '资源不存在' });
    return { ok: true };
  });

  // ── 候选干系人（PersonSuggestion）评审 ──
  app.get('/api/suggest/persons', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const accountId = String(req.query?.accountId || '');
    if (!accountId) return reply.code(400).send({ error: '缺少 accountId' });
    if (!(await viewerCanReadAccount(req, reply, accountId))) return; // viewer 归属校验
    const acc = await prisma.account.findFirst({ where: { id: accountId, tenantId: req.user.tenantId } });
    if (!acc) return reply.code(404).send({ error: '客户不存在' });
    const rows = await prisma.personSuggestion.findMany({ where: { accountId, tenantId: req.user.tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    // 标注是否已有同名正式干系人（供前端给"合并/新建"选择）
    const persons = await prisma.person.findMany({ where: { tenantId: req.user.tenantId, accountId }, select: { id: true, name: true } });
    const nameToId = new Map(persons.map((p) => [p.name, p.id]));
    return { suggestions: rows.map((r) => ({ id: r.id, accountId: r.accountId, name: r.name, title: r.title, orgLevel: r.orgLevel, origin: r.origin, evidence: r.evidence, sourceUrl: r.sourceUrl ?? undefined, confidence: r.confidence, existingPersonId: nameToId.get(r.name) ?? undefined })) };
  });

  // 采纳候选干系人 → 建正式 Person（带溯源日志）。返回 { person } 供前端 dispatch ADD_PERSON。
  app.post('/api/suggest/persons/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const tenantId = req.user.tenantId;
    // P10 改后采纳：可选 override（名字/职务），与原子 claim 一起写入并在同一事务内物化。
    const ov = z.object({ name: z.string().trim().min(1).max(40).optional(), title: z.string().trim().max(60).optional() }).safeParse(req.body ?? {});
    if (!ov.success) return reply.code(400).send({ error: '改后采纳参数无效' });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const r = await materializePerson(tx, tenantId, req.params.id, {
          override: ov.data,
          allowAcceptedReuse: false,
        });
        return { person: r.createdPerson, accId: r.accountId, accountId: r.accountId, account: { id: r.accountId } };
      });
      return result;
    } catch (e: any) {
      if (e instanceof ScopedNotFoundError || e?.scopedNotFound) return reply.code(404).send({ error: '资源不存在' });
      if (e instanceof SuggestionConflictError || e?.suggestionConflict) return reply.code(409).send({ error: '该候选已被处理，请刷新后重试' });
      return reply.code(400).send({ error: e?.message || '采纳失败' });
    }
  });

  app.post('/api/suggest/persons/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const r = await prisma.personSuggestion.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'pending' }, data: { status: 'rejected' } });
    if (!r.count) return reply.code(404).send({ error: '资源不存在' });
    return { ok: true };
  });

  // ── Hub 级审核收件箱：聚合当前租户所有 pending 候选（关系 + 人物），带 account/opp 上下文 ──
  // 「机器写初稿·人审」主线 v1：零 schema，复用 RelSuggestion/PersonSuggestion 表 + withNames。
  // 多租户红线：全程 tenantId 过滤（参考 state.ts 的 assembleState）。采纳/驳回沿用现有 /api/suggest[/persons]/:id/accept|reject。
  app.get('/api/inbox', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const tenantId = req.user.tenantId;
    const [relRows, psRows, cpRows, remRows, evRows, sigRows, persons, opps, accounts] = await Promise.all([
      prisma.relSuggestion.findMany({ where: { tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } }),
      prisma.personSuggestion.findMany({ where: { tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } }),
      prisma.changeProposal.findMany({ where: { tenantId, status: 'pending' }, orderBy: { createdAt: 'desc' } }), // v2.0 字段更新提案
      prisma.reminder.findMany({ where: { tenantId, status: 'pending' }, orderBy: { createdAt: 'desc' } }), // 巡检提醒（提醒型，自带 account/opp 名免 join）
      prisma.evidenceEvent.findMany({ where: { tenantId, status: 'pending_review' }, orderBy: { createdAt: 'desc' } }), // M3 第5类：机器抽取证据待人审
      prisma.signalCatalog.findMany({ where: { tenantId }, select: { signalKey: true, label: true, tier: true } }),
      prisma.person.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      prisma.opportunity.findMany({ where: { tenantId }, select: { id: true, name: true, accountId: true } }),
      prisma.account.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const accName = new Map(accounts.map((a) => [a.id, a.name]));
    const oppById = new Map(opps.map((o) => [o.id, o]));
    const personName = new Map(persons.map((p) => [p.id, p.name]));
    const named = await withNames(tenantId, relRows); // 复用：补端点人名（含候选人「（候选）」）
    const rels = named.map((r) => {
      const o = oppById.get(r.opportunityId);
      return { ...r, oppName: o?.name ?? '?', accountId: o?.accountId ?? '', accountName: o ? (accName.get(o.accountId) ?? '?') : '?' };
    });
    const personsOut = psRows.map((r) => ({ id: r.id, accountId: r.accountId, accountName: accName.get(r.accountId) ?? '?', name: r.name, title: r.title, orgLevel: r.orgLevel, origin: r.origin, evidence: r.evidence, sourceUrl: r.sourceUrl ?? undefined, confidence: r.confidence }));
    const proposals = cpRows.map((cp) => ({
      id: cp.id, accountId: cp.accountId, accountName: accName.get(cp.accountId) ?? '?',
      opportunityId: cp.opportunityId ?? undefined, oppName: cp.opportunityId ? (oppById.get(cp.opportunityId)?.name ?? '?') : '',
      entityKind: cp.entityKind, entityId: cp.entityId,
      entityName: cp.entityKind === 'oppRole' ? (personName.get(cp.entityId) ?? cp.entityId) : cp.entityId,
      field: cp.field, oldValue: cp.oldValue, newValue: cp.newValue, origin: cp.origin, evidence: cp.evidence, confidence: cp.confidence,
    }));
    const reminders = remRows.map((r) => ({ id: r.id, accountId: r.accountId, accountName: r.accountName, opportunityId: r.opportunityId ?? undefined, oppName: r.oppName, kind: r.kind, title: r.title, detail: r.detail, severity: r.severity, entityId: r.entityId ?? undefined }));
    // M3 第5类 · 证据待审：机器抽取的行为信号（人批准才进 E2 燃料池；label 取自信号库）
    const sigByKey = new Map(sigRows.map((s) => [s.signalKey, s]));
    const evidences = evRows.map((e) => {
      const o = oppById.get(e.opportunityId);
      return {
        id: e.id, accountId: e.accountId, accountName: accName.get(e.accountId) ?? '?',
        opportunityId: e.opportunityId, oppName: o?.name ?? '?',
        personId: e.personId, personName: personName.get(e.personId) ?? '?',
        signalKey: e.signalKey, signalLabel: sigByKey.get(e.signalKey)?.label ?? e.signalKey,
        direction: e.direction, tier: e.tier, rawContent: e.rawContent, occurredAt: e.occurredAt, origin: e.origin,
      };
    });
    return {
      rels, persons: personsOut, proposals, reminders, evidences,
      total: rels.length + personsOut.length + proposals.length + reminders.length + evidences.length,
      patrol: getPatrolInfo(tenantId), // P2 心跳：本租户最近一轮巡检统计（服务刚重启未跑完首轮时为 null）
    };
  });

  // M3 · 证据审核（第5类卡三按钮：approve 采纳 / 带 direction·tier 覆盖=修改后采纳 / reject 拒绝）。
  // approve → pending CAS、PDE 重算与 EVSnapshot 写入同一 Serializable 事务；任一步失败整体回滚并明确报错；
  // reject → 不参与任何计算（留库审计）。tenantId 隔离 + 只审 pending_review 防重复处理。无静默生效路径（铁律②）。
  app.post('/api/evidence/:id/review', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const p = z.object({
      action: z.enum(['approve', 'reject']),
      direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(), // 修改后采纳：中性信号人工定向
      tier: z.enum(['weak', 'mid', 'strong']).optional(),
    }).safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const today = new Date().toISOString().slice(0, 10);
    const reviewedBy = req.user.userId ?? '';
    if (p.data.action === 'approve') {
      try {
        await approveEvidenceWithSnapshot(tenantId, req.params.id, reviewedBy, today, {
          direction: p.data.direction,
          tier: p.data.tier,
        });
        return { ok: true, status: 'approved' };
      } catch (error) {
        if (error instanceof EvidenceReviewNotFoundError) {
          return reply.code(404).send({ error: '证据不存在或已处理' });
        }
        req.log.warn(error, 'evidence review transaction failed');
        return reply.code(503).send({ error: '证据快照未落库，审核未生效，请重试' });
      }
    }

    const resolved = await prisma.evidenceEvent.updateMany({
      where: { id: req.params.id, tenantId, status: 'pending_review' },
      data: {
        status: 'rejected',
        reviewedBy, reviewedAt: today,
      },
    });
    if (!resolved.count) return reply.code(404).send({ error: '证据不存在或已处理' });
    return { ok: true, status: 'rejected' };
  });

  // 忽略一条巡检提醒（提醒型提案：只读，人「忽略」→ dismissed；绝不改业务库）。tenantId 隔离 + status=pending 防重复处理。
  app.post('/api/reminders/:id/dismiss', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const r = await prisma.reminder.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'pending' }, data: { status: 'dismissed' } });
    if (!r.count) return reply.code(404).send({ error: '提醒不存在或已处理' });
    return { ok: true };
  });
}
