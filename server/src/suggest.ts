import type { FastifyInstance } from 'fastify';
import type { Prisma, RelSuggestion } from '@prisma/client';
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
import { activePersonWhere } from './activePerson.js';
import type { DbClient } from './mutation/scopeGuards.js';
import { businessYmd } from './businessDate.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import {
  claimPersonCandidate,
  claimRelationCandidate,
  createRelationCandidate,
  finalizePersonCandidate,
  finalizeRelationCandidate,
  redirectCandidatePersonReferences,
  rejectPersonCandidate,
  rejectRelationCandidate,
  relationCandidateDedupeKey,
} from './candidates/personRelation.js';
import {
  dismissReminderCandidate,
  reviewEvidenceCandidate,
} from './candidates/reviewItems.js';
import { CANDIDATE_BACKFILL_MARKER } from './candidates/migration.js';

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const parseForm = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const ORIGIN_LABEL: Record<string, string> = { mcp: 'AI 调研·待核实', ai: 'AI 推测·待核实', qcc: '企查查导入' };
const SuggestedRoleSchema = z.enum(['A', 'D', 'U', 'R', 'C']);

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
      const reviewed = await reviewEvidenceCandidate(prisma, {
        tenantId,
        id: evidenceId,
        decision: 'accept',
        reviewedBy,
        reviewedAt,
        direction: override.direction,
        tier: override.tier,
      }, async (tx, evidence) => {
        await createPdeSnapshot(tx, tenantId, evidence.opportunityId, 'evidence_review', reviewedBy);
      });
      if (!reviewed) throw new EvidenceReviewNotFoundError();
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
export async function materializePerson(
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
    if (ps.opportunityId) {
      await tx.matterParticipant.upsert({
        where: {
          tenantId_opportunityId_personId: {
            tenantId,
            opportunityId: ps.opportunityId,
            personId: ps.resolvedPersonId,
          },
        },
        create: {
          tenantId,
          accountId: ps.accountId,
          opportunityId: ps.opportunityId,
          personId: ps.resolvedPersonId,
        },
        update: {},
      });
    }
    return { personId: ps.resolvedPersonId, accountId: ps.accountId };
  }
  if (ps.status !== 'pending' || ps.resolvedPersonId) throw new SuggestionConflictError();
  const suggestedRole = ps.suggestedRole ? SuggestedRoleSchema.safeParse(ps.suggestedRole) : null;
  if (suggestedRole && !suggestedRole.success) {
    throw new Error('候选建议角色已失效，请重新分类为 A/D/U/R/C 后再采纳');
  }

  // 原子 claim 必须先于任何正式写入。事务失败会把临时 accepted 自动回滚为 pending，外部不可见半完成状态。
  const claimed = await claimPersonCandidate(tx, {
    tenantId,
    id: ps.id,
    override: options.override,
  });
  const candidate = claimed.row;

  const others = await tx.person.findMany({ where: { tenantId, accountId: candidate.accountId, isCompetitor: false, ...activePersonWhere }, select: { x: true, y: true } });
  const { x, y } = nextFreeSlot(others);
  const today = businessYmd();
  const logs = [{ date: today, content: `📥 ${ORIGIN_LABEL[candidate.origin] || '外部导入'}（${candidate.evidence || '无备注'}）${candidate.sourceUrl ? ' · ' + candidate.sourceUrl : ''}`, visibility: 'team' }];
  const personId = 'p_' + randomUUID().replaceAll('-', '');
  await tx.person.create({ data: { id: personId, tenantId, accountId: candidate.accountId, name: candidate.name, title: candidate.title, orgLevel: candidate.orgLevel, isCompetitor: false, x, y, form: '{}', logs: JSON.stringify(logs) } });
  // 人审采纳后建立通用参与关系；只有 memberScoped 商机才另写 legacy 可见性成员。
  if (candidate.opportunityId) {
    await tx.matterParticipant.upsert({
      where: {
        tenantId_opportunityId_personId: {
          tenantId,
          opportunityId: candidate.opportunityId,
          personId,
        },
      },
      create: {
        tenantId,
        accountId: candidate.accountId,
        opportunityId: candidate.opportunityId,
        personId,
      },
      update: {},
    });
    const mo = await tx.opportunity.findFirst({ where: { id: candidate.opportunityId, tenantId, accountId: candidate.accountId }, select: { memberScoped: true } });
    if (mo?.memberScoped) await tx.opportunityMember.upsert({ where: { tenantId_opportunityId_personId: { tenantId, opportunityId: candidate.opportunityId, personId } }, create: { tenantId, opportunityId: candidate.opportunityId, personId }, update: {} });
  }
  // WorkBuddy 提议时带了建议角色 + 关联商机 → 采纳时一并落 OppRole（守"角色只对正式 Person"）
  if (suggestedRole?.success && candidate.opportunityId) {
    const opp = await tx.opportunity.findFirst({ where: { id: candidate.opportunityId, tenantId, accountId: candidate.accountId } });
    if (opp) {
      await tx.oppRole.upsert({
        where: { tenantId_opportunityId_personId: { tenantId, opportunityId: candidate.opportunityId, personId } },
        create: { tenantId, opportunityId: candidate.opportunityId, personId, role: suggestedRole.data, sentiment: candidate.suggestedSentiment || 'unknown', confidence: '推理' },
        update: {},
      });
    }
  }
  await finalizePersonCandidate(tx, {
    tenantId,
    id: ps.id,
    expectedVersion: claimed.candidateVersion,
    resolvedPersonId: personId,
  });
  // key 收敛：把仍 pending、引用该候选的其它关系端点改写为 person/resolvedPersonId（防重复边）
  await redirectCandidatePersonReferences(tx, {
    tenantId,
    accountId: candidate.accountId,
    from: { kind: 'suggestion', id: suggId },
    toPersonId: personId,
  });
  const createdPerson = { id: personId, name: candidate.name, title: candidate.title, orgLevel: candidate.orgLevel, isCompetitor: false, x, y, form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} }, logs };
  return { personId, accountId: candidate.accountId, createdPerson };
}

export async function acceptRelationSuggestionInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  override: { layer?: 'L1' | 'L2' | 'L3' | 'L4'; label?: string } = {},
): Promise<{ edge: any; createdPersons: any[] }> {
  const suggestion = await tx.relSuggestion.findFirst({ where: { id, tenantId } });
  if (!suggestion) throw new ScopedNotFoundError();
  if (suggestion.status !== 'pending') throw new SuggestionConflictError();
  const opportunity = await tx.opportunity.findFirst({ where: { id: suggestion.opportunityId, tenantId }, select: { accountId: true } });
  if (!opportunity) throw new ScopedNotFoundError();
  await requireAccount(tx, tenantId, opportunity.accountId);
  await requireOpportunity(tx, tenantId, opportunity.accountId, suggestion.opportunityId);
  const claimed = await claimRelationCandidate(tx, { id, tenantId });

  const createdPersons: any[] = [];
  const resolveEnd = async (kind: string, endpointId: string) => {
    if (kind === 'suggestion') {
      const resolved = await materializePerson(tx, tenantId, endpointId, { expectedAccountId: opportunity.accountId });
      if (resolved.createdPerson) createdPersons.push(resolved.createdPerson);
      return resolved.personId;
    }
    if (kind !== 'person') throw new ScopedNotFoundError();
    await requirePerson(tx, tenantId, opportunity.accountId, endpointId);
    return endpointId;
  };
  const source = await resolveEnd(suggestion.sourceKind, suggestion.sourcePersonId);
  const target = await resolveEnd(suggestion.targetKind, suggestion.targetPersonId);
  await requireEdgeEndpoints(tx, tenantId, opportunity.accountId, source, target);
  const layer = override.layer ?? suggestion.layer;
  const label = override.label ?? suggestion.label;
  const edgeId = 'e_' + randomUUID().replaceAll('-', '');
  const color = LAYER_COLOR[layer] || '#16a34a';
  await tx.edge.create({ data: {
    id: edgeId, tenantId, accountId: opportunity.accountId, opportunityId: suggestion.opportunityId,
    source, target, layer, label, color, style: 'solid', width: null, directed: false, origin: 'ai',
  } });
  await finalizeRelationCandidate(tx, {
    id,
    tenantId,
    expectedVersion: claimed.candidateVersion,
    sourcePersonId: source,
    targetPersonId: target,
    layer,
    label,
  });
  return { edge: { id: edgeId, source, target, layer, label, color, style: 'solid', directed: false, origin: 'ai' }, createdPersons };
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
  const persons = await prisma.person.findMany({ where: { tenantId, accountId: opp.accountId, ...activePersonWhere } });
  const edges = await prisma.edge.findMany({ where: { tenantId, accountId: opp.accountId, OR: [{ opportunityId: null }, { opportunityId: oppId }] } });
  return { opp, persons, edges };
}

/**
 * 生成某商机的关系候选（图算法共同邻居 + LLM/mock 启发）→ 写 RelSuggestion（pending，走人审，铁律②）。
 * 路由 /api/suggest/generate 与后台 suggest_relations job 共用此核心。返回 { added, total } 或 null（商机不存在）。
 * 效率护栏：非竞品干系人 < 2 时无可推断，直接返回（避免空图也烧 LLM token）。
 */
export async function generateRelSuggestions(
  tenantId: string,
  opportunityId: string,
  commitWrite?: <T>(write: (db: DbClient) => Promise<T>) => Promise<T>,
  createdByUserId: string | null = null,
): Promise<{ added: number; total: number } | null> {
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
      const write = async (db: DbClient) => {
        let created = 0;
        for (const c of fresh) {
          const source = { kind: 'person' as const, id: c.source };
          const target = { kind: 'person' as const, id: c.target };
          const dedupeKey = relationCandidateDedupeKey(opportunityId, source, target);
          const receipt = await createRelationCandidate(db, {
            id: 'rs_' + randomUUID().replaceAll('-', ''),
            tenantId,
            matterId: opportunityId,
            source,
            target,
            layer: c.layer,
            label: c.label,
            sourceType: c.origin,
            sourceRef: `suggest:${c.origin}:${dedupeKey}`,
            evidence: c.evidence || '关系推断未返回具体依据，必须由人工核实',
            confidence: c.confidence,
            createdByUserId,
            dedupeKey,
          });
          if (receipt.created) created += 1;
        }
        return created;
      };
      added = commitWrite ? await commitWrite(write) : await write(prisma);
    }
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
    const r = await generateRelSuggestions(tenantId, p.data.opportunityId, undefined, req.user.userId ?? null);
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
      const result = await prisma.$transaction((tx) => acceptRelationSuggestionInTransaction(tx, tenantId, req.params.id, ov.data));
      return result;
    } catch (e: any) {
      if (e instanceof ScopedNotFoundError || e?.scopedNotFound) return reply.code(404).send({ error: '资源不存在' });
      if (e instanceof SuggestionConflictError || e?.suggestionConflict || e?.candidateConflict) return reply.code(409).send({ error: '该候选已被处理，请刷新后重试' });
      return reply.code(400).send({ error: e?.message || '采纳失败' });
    }
  });

  app.post('/api/suggest/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const rejected = await rejectRelationCandidate(prisma, { id: req.params.id, tenantId: req.user.tenantId });
    if (!rejected) return reply.code(404).send({ error: '资源不存在' });
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
    const persons = await prisma.person.findMany({ where: { tenantId: req.user.tenantId, accountId, ...activePersonWhere }, select: { id: true, name: true } });
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
      if (e instanceof SuggestionConflictError || e?.suggestionConflict || e?.candidateConflict) return reply.code(409).send({ error: '该候选已被处理，请刷新后重试' });
      return reply.code(400).send({ error: e?.message || '采纳失败' });
    }
  });

  app.post('/api/suggest/persons/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const rejected = await rejectPersonCandidate(prisma, { id: req.params.id, tenantId: req.user.tenantId });
    if (!rejected) return reply.code(404).send({ error: '资源不存在' });
    return { ok: true };
  });

  // ── Hub 级审核收件箱：Candidate 是五类待审项的唯一读取权威，旧表不读、不 fallback。──
  // 全程 tenantId + EffectiveResourceScope 过滤；正式父树或 Candidate payload 漂移时整箱 fail closed。
  app.get('/api/inbox', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const tenantId = req.user.tenantId;
    const scope = await resolveEffectiveResourceScope(prisma, {
      tenantId,
      userId: req.user.userId,
      role: req.user.role,
    });
    if (scope.actorRole === 'viewer') return reply.code(403).send({ error: '只读成员不可操作' });
    const matterIds = [...scope.matterIds];
    const marker = await prisma.dataMigrationState.findUnique({
      where: { key: CANDIDATE_BACKFILL_MARKER }, select: { key: true },
    });
    if (!marker) {
      return reply.code(503).send({
        error: 'Candidate 回填未完成，收件箱已停止服务',
        code: 'candidate_backfill_required',
      });
    }
    const candidateRows = await prisma.candidate.findMany({
      where: {
        tenantId,
        status: 'pending',
        legacySourceKind: {
          in: ['PersonSuggestion', 'RelSuggestion', 'ChangeProposal', 'Reminder', 'EvidenceEvent'],
        },
        legacySourceId: { not: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const parsedRows: Array<{ row: typeof candidateRows[number]; payload: Record<string, unknown> }> = [];
    try {
      for (const row of candidateRows) {
        const payload: unknown = JSON.parse(row.payload || '{}');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid payload');
        parsedRows.push({ row, payload: payload as Record<string, unknown> });
      }
    } catch {
      return reply.code(503).send({
        error: 'Candidate 数据不完整，收件箱已停止服务',
        code: 'candidate_payload_invalid',
      });
    }
    const visibleRows = parsedRows.filter(({ row }) => {
      if (row.legacySourceKind === 'PersonSuggestion') return scope.fullAccountIds.has(row.accountId);
      if (row.legacySourceKind === 'RelSuggestion' || row.legacySourceKind === 'EvidenceEvent') {
        return !!row.matterId && scope.matterIds.has(row.matterId);
      }
      return scope.fullAccountIds.has(row.accountId)
        || (!!row.matterId && scope.matterIds.has(row.matterId));
    });
    const referencedPersonIds = new Set<string>();
    const referencedBurningIssueIds = new Set<string>();
    const referencedUcvIds = new Set<string>();
    const referencedCommitmentIds = new Set<string>();
    for (const { row, payload } of visibleRows) {
      if (row.legacySourceKind === 'RelSuggestion') {
        if (payload.sourceKind === 'person' && typeof payload.sourcePersonId === 'string') {
          referencedPersonIds.add(payload.sourcePersonId);
        }
        if (payload.targetKind === 'person' && typeof payload.targetPersonId === 'string') {
          referencedPersonIds.add(payload.targetPersonId);
        }
      }
      if (row.legacySourceKind === 'ChangeProposal' && row.targetKind === 'oppRole' && row.targetId) {
        referencedPersonIds.add(row.targetId);
      }
      if (row.legacySourceKind === 'ChangeProposal'
        && (row.targetKind === 'person' || row.targetKind === 'personLog') && row.targetId) {
        referencedPersonIds.add(row.targetId);
      }
      if (row.legacySourceKind === 'ChangeProposal' && row.targetKind === 'bi' && row.targetId) {
        referencedBurningIssueIds.add(row.targetId);
      }
      if (row.legacySourceKind === 'ChangeProposal' && row.targetKind === 'ucv' && row.targetId) {
        referencedUcvIds.add(row.targetId);
      }
      if (row.legacySourceKind === 'Reminder' && row.targetKind === 'person' && row.targetId) {
        referencedPersonIds.add(row.targetId);
      }
      if (row.legacySourceKind === 'Reminder' && row.targetKind === 'commitment' && row.targetId) {
        referencedCommitmentIds.add(row.targetId);
      }
      if (row.legacySourceKind === 'EvidenceEvent' && row.targetKind === 'person' && row.targetId) {
        referencedPersonIds.add(row.targetId);
      }
    }
    const [sigRows, opps, accounts, formalPersons, burningIssues, ucvs, commitments] = await Promise.all([
      prisma.signalCatalog.findMany({ where: { tenantId }, select: { signalKey: true, label: true, tier: true } }),
      prisma.opportunity.findMany({
        where: { tenantId, archivedAt: null, id: { in: matterIds } },
        select: { id: true, name: true, accountId: true },
      }),
      prisma.account.findMany({
        where: { tenantId, archivedAt: null, id: { in: [...scope.accountIds] } },
        select: { id: true, name: true },
      }),
      prisma.person.findMany({
        where: { tenantId, ...activePersonWhere, id: { in: [...referencedPersonIds] } },
        select: { id: true, name: true, accountId: true },
      }),
      prisma.burningIssue.findMany({
        where: { tenantId, id: { in: [...referencedBurningIssueIds] } },
        select: { id: true, opportunityId: true },
      }),
      prisma.uCV.findMany({
        where: { tenantId, id: { in: [...referencedUcvIds] } },
        select: { id: true, opportunityId: true },
      }),
      prisma.planAction.findMany({
        where: { tenantId, archivedAt: null, id: { in: [...referencedCommitmentIds] } },
        select: { id: true, accountId: true, opportunityId: true },
      }),
    ]);
    const accName = new Map(accounts.map((a) => [a.id, a.name]));
    const oppById = new Map(opps.map((o) => [o.id, o]));
    const formalPersonById = new Map(formalPersons.map((person) => [person.id, person]));
    const personName = new Map(formalPersons.map((person) => [person.id, person.name]));
    const burningIssueById = new Map(burningIssues.map((issue) => [issue.id, issue]));
    const ucvById = new Map(ucvs.map((ucv) => [ucv.id, ucv]));
    const commitmentById = new Map(commitments.map((commitment) => [commitment.id, commitment]));
    const candidatePersonById = new Map(parsedRows
      .filter(({ row, payload }) => row.legacySourceKind === 'PersonSuggestion'
        && typeof payload.name === 'string' && !!row.legacySourceId)
      .map(({ row, payload }) => [row.legacySourceId!, { row, payload }]));
    const endpointName = (kind: unknown, id: unknown): string => {
      if (typeof id !== 'string') return '?';
      return kind === 'suggestion'
        ? candidatePersonById.has(id)
          ? `${candidatePersonById.get(id)!.payload.name as string}（候选）`
          : '?'
        : personName.get(id) ?? '?';
    };
    const formalPersonValid = (id: unknown, accountId: string): id is string =>
      typeof id === 'string' && formalPersonById.get(id)?.accountId === accountId;
    const endpointValid = (
      kind: unknown, id: unknown, accountId: string, matterId: string,
    ): boolean => {
      if (kind === 'person') return formalPersonValid(id, accountId);
      if (kind !== 'suggestion' || typeof id !== 'string') return false;
      const endpoint = candidatePersonById.get(id);
      return !!endpoint
        && endpoint.row.kind === 'person_create'
        && endpoint.row.accountId === accountId
        && (!endpoint.row.matterId || endpoint.row.matterId === matterId)
        && endpoint.row.targetKind === 'person'
        && endpoint.row.targetId === null
        && typeof endpoint.payload.name === 'string'
        && endpoint.payload.name.length > 0
        && typeof endpoint.payload.title === 'string'
        && typeof endpoint.payload.orgLevel === 'number';
    };
    const parentValid = visibleRows.every(({ row, payload }) => {
      if (!accName.has(row.accountId)) return false;
      if (row.matterId && oppById.get(row.matterId)?.accountId !== row.accountId) return false;
      if (row.legacySourceKind === 'PersonSuggestion') {
        return row.kind === 'person_create' && row.targetKind === 'person' && row.targetId === null
          && typeof payload.name === 'string' && payload.name.length > 0
          && typeof payload.title === 'string' && typeof payload.orgLevel === 'number';
      }
      if (row.legacySourceKind === 'RelSuggestion') {
        return row.kind === 'relation_create' && !!row.matterId && row.targetKind === 'relation'
          && endpointValid(payload.sourceKind, payload.sourcePersonId, row.accountId, row.matterId)
          && endpointValid(payload.targetKind, payload.targetPersonId, row.accountId, row.matterId)
          && typeof payload.layer === 'string' && typeof payload.label === 'string';
      }
      if (row.legacySourceKind === 'ChangeProposal') {
        if (row.kind !== 'field_change' || !row.targetId || !row.fieldKey) return false;
        if (row.targetKind === 'person' || row.targetKind === 'personLog' || row.targetKind === 'oppRole') {
          return formalPersonValid(row.targetId, row.accountId)
            && (row.targetKind !== 'oppRole' || !!row.matterId);
        }
        if (row.targetKind === 'opportunity') return !!row.matterId && row.targetId === row.matterId;
        if (row.targetKind === 'bi') {
          return !!row.matterId && burningIssueById.get(row.targetId)?.opportunityId === row.matterId;
        }
        if (row.targetKind === 'ucv') {
          return !!row.matterId && ucvById.get(row.targetId)?.opportunityId === row.matterId;
        }
        return false;
      }
      if (row.legacySourceKind === 'Reminder') {
        if (row.kind !== 'reminder' || !row.targetId
          || typeof payload.reminderKind !== 'string'
          || typeof payload.title !== 'string'
          || typeof payload.detail !== 'string'
          || typeof payload.severity !== 'string') return false;
        if (row.targetKind === 'person') return formalPersonValid(row.targetId, row.accountId);
        if (row.targetKind === 'matter') return !!row.matterId && row.targetId === row.matterId;
        if (row.targetKind === 'commitment') {
          const commitment = commitmentById.get(row.targetId);
          return !!commitment && commitment.accountId === row.accountId
            && commitment.opportunityId === row.matterId;
        }
        return false;
      }
      if (row.legacySourceKind === 'EvidenceEvent') {
        return row.kind === 'evidence_create' && !!row.matterId
          && row.targetKind === 'person' && formalPersonValid(row.targetId, row.accountId)
          && typeof payload.signalKey === 'string' && typeof payload.direction === 'number'
          && typeof payload.tier === 'string' && typeof payload.occurredAt === 'string';
      }
      return false;
    });
    if (!parentValid) {
      return reply.code(503).send({
        error: 'Candidate 父级闭包校验失败，收件箱已停止服务',
        code: 'candidate_parent_invalid',
      });
    }
    const bySource = (sourceKind: string) => visibleRows.filter(({ row }) => row.legacySourceKind === sourceKind);
    const rels = bySource('RelSuggestion').map(({ row, payload }) => {
      const opportunityId = row.matterId!;
      const sourcePersonId = typeof payload.sourcePersonId === 'string' ? payload.sourcePersonId : '';
      const targetPersonId = typeof payload.targetPersonId === 'string' ? payload.targetPersonId : '';
      const sourceKind = typeof payload.sourceKind === 'string' ? payload.sourceKind : '';
      const targetKind = typeof payload.targetKind === 'string' ? payload.targetKind : '';
      return {
        id: row.legacySourceId!, opportunityId,
        source: sourcePersonId, target: targetPersonId, sourceKind, targetKind,
        layer: typeof payload.layer === 'string' ? payload.layer : '',
        label: typeof payload.label === 'string' ? payload.label : '',
        confidence: row.confidence, origin: row.source, evidence: row.evidence,
        sourceName: endpointName(sourceKind, sourcePersonId),
        targetName: endpointName(targetKind, targetPersonId),
        oppName: oppById.get(opportunityId)?.name ?? '?',
        accountId: row.accountId, accountName: accName.get(row.accountId) ?? '?',
      };
    }).sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
    const personsOut = bySource('PersonSuggestion').map(({ row, payload }) => ({
      id: row.legacySourceId!, accountId: row.accountId, accountName: accName.get(row.accountId) ?? '?',
      name: typeof payload.name === 'string' ? payload.name : '',
      title: typeof payload.title === 'string' ? payload.title : '',
      orgLevel: typeof payload.orgLevel === 'number' ? payload.orgLevel : 3,
      origin: row.source, evidence: row.evidence,
      ...(typeof payload.sourceUrl === 'string' ? { sourceUrl: payload.sourceUrl } : {}),
      confidence: row.confidence,
    })).sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
    const proposals = bySource('ChangeProposal').map(({ row }) => ({
      id: row.legacySourceId!, accountId: row.accountId, accountName: accName.get(row.accountId) ?? '?',
      opportunityId: row.matterId ?? undefined,
      oppName: row.matterId ? (oppById.get(row.matterId)?.name ?? '?') : '',
      entityKind: row.targetKind, entityId: row.targetId ?? '',
      entityName: row.targetKind === 'oppRole' && row.targetId
        ? (personName.get(row.targetId) ?? row.targetId) : row.targetId ?? '',
      field: row.fieldKey ?? '', oldValue: row.oldValue ?? '', newValue: row.newValue ?? '',
      origin: row.source, evidence: row.evidence, confidence: row.confidence,
    }));
    const reminders = bySource('Reminder').map(({ row, payload }) => ({
      id: row.legacySourceId!, accountId: row.accountId,
      accountName: typeof payload.accountName === 'string' ? payload.accountName : accName.get(row.accountId) ?? '?',
      opportunityId: row.matterId ?? undefined,
      oppName: row.matterId ? (oppById.get(row.matterId)?.name ?? '?') : '',
      kind: typeof payload.reminderKind === 'string' ? payload.reminderKind : '',
      title: typeof payload.title === 'string' ? payload.title : '',
      detail: typeof payload.detail === 'string' ? payload.detail : '',
      severity: typeof payload.severity === 'string' ? payload.severity : 'info',
      entityId: row.targetId ?? undefined,
    }));
    const sigByKey = new Map(sigRows.map((s) => [s.signalKey, s]));
    const evidences = bySource('EvidenceEvent').map(({ row, payload }) => {
      const opportunityId = row.matterId!;
      const personId = row.targetId ?? '';
      const signalKey = typeof payload.signalKey === 'string' ? payload.signalKey : '';
      return {
        id: row.legacySourceId!, accountId: row.accountId, accountName: accName.get(row.accountId) ?? '?',
        opportunityId, oppName: oppById.get(opportunityId)?.name ?? '?',
        personId, personName: personName.get(personId) ?? '?',
        signalKey, signalLabel: sigByKey.get(signalKey)?.label ?? signalKey,
        direction: typeof payload.direction === 'number' ? payload.direction : 0,
        tier: typeof payload.tier === 'string' ? payload.tier : 'mid',
        rawContent: row.evidence,
        occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : '',
        origin: row.source,
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
    const today = businessYmd();
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

    const resolved = await reviewEvidenceCandidate(prisma, {
      tenantId,
      id: req.params.id,
      decision: 'reject',
      reviewedBy,
      reviewedAt: today,
    });
    if (!resolved) return reply.code(404).send({ error: '证据不存在或已处理' });
    return { ok: true, status: 'rejected' };
  });

  // 忽略一条巡检提醒（提醒型提案：只读，人「忽略」→ dismissed；绝不改业务库）。tenantId 隔离 + status=pending 防重复处理。
  app.post('/api/reminders/:id/dismiss', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const dismissed = await dismissReminderCandidate(prisma, {
      id: req.params.id, tenantId: req.user.tenantId,
    });
    if (!dismissed) return reply.code(404).send({ error: '提醒不存在或已处理' });
    return { ok: true };
  });
}
