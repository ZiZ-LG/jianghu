import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { loadAiConfig, callLLM } from './ai.js';

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const parseForm = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

interface Cand { source: string; target: string; layer: string; label: string; confidence: number; origin: string; evidence: string; }

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
  let arr: any[]; try { arr = JSON.parse(m[0]); } catch { return []; }
  const out: Cand[] = [];
  for (const r of Array.isArray(arr) ? arr : []) {
    const s = idByName.get(String(r.from)), t = idByName.get(String(r.to));
    if (!s || !t || s === t) continue;
    out.push({ source: s, target: t, layer: ['L1', 'L2', 'L3', 'L4'].includes(r.layer) ? r.layer : 'L3', label: String(r.label || '疑似关联').slice(0, 20), confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)), origin: 'llm', evidence: String(r.evidence || '').slice(0, 120) });
  }
  return out.slice(0, 6);
}

export function suggestRoutes(app: FastifyInstance) {
  async function loadGraph(tenantId: string, oppId: string) {
    const opp = await prisma.opportunity.findFirst({ where: { id: oppId, tenantId } });
    if (!opp) return null;
    const persons = await prisma.person.findMany({ where: { tenantId, accountId: opp.accountId } });
    const edges = await prisma.edge.findMany({ where: { tenantId, accountId: opp.accountId, OR: [{ opportunityId: null }, { opportunityId: oppId }] } });
    return { opp, persons, edges };
  }
  const withNames = (rows: any[], persons: any[]) => {
    const nm = new Map(persons.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ id: r.id, source: r.sourcePersonId, target: r.targetPersonId, sourceName: nm.get(r.sourcePersonId) || '?', targetName: nm.get(r.targetPersonId) || '?', layer: r.layer, label: r.label, confidence: r.confidence, origin: r.origin, evidence: r.evidence }));
  };

  app.get('/api/suggest', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const oppId = String(req.query?.opportunityId || '');
    if (!oppId) return reply.code(400).send({ error: '缺少 opportunityId' });
    const g = await loadGraph(req.user.tenantId, oppId);
    if (!g) return reply.code(404).send({ error: '商机不存在' });
    const rows = await prisma.relSuggestion.findMany({ where: { opportunityId: oppId, tenantId: req.user.tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    return { suggestions: withNames(rows, g.persons) };
  });

  app.post('/api/suggest/generate', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = z.object({ opportunityId: z.string() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 opportunityId' });
    const tenantId = req.user.tenantId;
    const g = await loadGraph(tenantId, p.data.opportunityId);
    if (!g) return reply.code(404).send({ error: '商机不存在' });
    const nameOf = (id: string) => g.persons.find((x) => x.id === id)?.name || id;
    const connected = new Set(g.edges.map((e) => pairKey(e.source, e.target)));

    // 去重：排除已连接的边 + 该商机下所有历史候选（含已采纳/已忽略，避免重复打扰）
    const existing = await prisma.relSuggestion.findMany({ where: { opportunityId: p.data.opportunityId, tenantId } });
    const seen = new Set<string>([...connected, ...existing.map((s) => pairKey(s.sourcePersonId, s.targetPersonId))]);

    let cands: Cand[] = graphCandidates(g.persons, g.edges, nameOf);
    const cfg = await loadAiConfig(tenantId);
    if (cfg) cands = cands.concat(cfg.provider === 'mock' || !cfg.baseUrl || !cfg.model ? mockLlmCandidates(g.persons, connected) : await llmCandidates(cfg, g.persons, g.edges, nameOf));

    const fresh = cands.filter((c) => { const k = pairKey(c.source, c.target); if (c.source === c.target || seen.has(k)) return false; seen.add(k); return true; });
    if (fresh.length) {
      await prisma.relSuggestion.createMany({ data: fresh.map((c) => ({ id: 'rs_' + randomUUID().slice(0, 12), tenantId, opportunityId: p.data.opportunityId, sourcePersonId: c.source, targetPersonId: c.target, layer: c.layer, label: c.label, confidence: c.confidence, origin: c.origin, evidence: c.evidence })) });
    }
    const all = await prisma.relSuggestion.findMany({ where: { opportunityId: p.data.opportunityId, tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    return { added: fresh.length, suggestions: withNames(all, g.persons) };
  });

  app.post('/api/suggest/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const s = await prisma.relSuggestion.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!s) return reply.code(404).send({ error: '候选不存在' });
    const opp = await prisma.opportunity.findFirst({ where: { id: s.opportunityId, tenantId: req.user.tenantId } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    const id = 'e_' + randomUUID().slice(0, 12);
    await prisma.edge.create({ data: { id, tenantId: req.user.tenantId, accountId: opp.accountId, opportunityId: s.opportunityId, source: s.sourcePersonId, target: s.targetPersonId, layer: s.layer, label: s.label, color: LAYER_COLOR[s.layer] || '#16a34a', style: 'solid', width: null, directed: false, origin: 'ai' } });
    await prisma.relSuggestion.update({ where: { id: s.id }, data: { status: 'accepted' } });
    return { edge: { id, source: s.sourcePersonId, target: s.targetPersonId, layer: s.layer, label: s.label, color: LAYER_COLOR[s.layer] || '#16a34a', style: 'solid', directed: false, origin: 'ai' } };
  });

  app.post('/api/suggest/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const r = await prisma.relSuggestion.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId }, data: { status: 'rejected' } });
    if (!r.count) return reply.code(404).send({ error: '候选不存在' });
    return { ok: true };
  });
}
