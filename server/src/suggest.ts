import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { loadAiConfig, callLLM } from './ai.js';
import { nextFreeSlot } from './layout.js';
import { getPatrolInfo } from './patrol.js';

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const parseForm = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

// 候选关系端点的规范化键（含 kind，避免候选/正式同 id 混淆）
const endKey = (kind: string, id: string) => `${kind}:${id}`;
const ORIGIN_LABEL: Record<string, string> = { mcp: 'AI 调研·待核实', ai: 'AI 推测·待核实', qcc: '企查查导入' };

/**
 * 从候选人物落一个正式 Person（在传入的事务客户端内执行）。幂等：若候选已 accepted 且有 resolvedPersonId 则直接复用。
 * 返回 { personId, createdPerson? }，createdPerson 用于前端 dispatch ADD_PERSON。
 */
async function materializePerson(tx: any, tenantId: string, suggId: string): Promise<{ personId: string; createdPerson?: any }> {
  const ps = await tx.personSuggestion.findFirst({ where: { id: suggId, tenantId } });
  if (!ps) throw new Error('候选干系人不存在');
  if (ps.status === 'rejected') throw new Error(`候选干系人「${ps.name}」已被否决，无法作为关系端点`);
  if (ps.status === 'accepted' && ps.resolvedPersonId) return { personId: ps.resolvedPersonId };

  const others = await tx.person.findMany({ where: { tenantId, accountId: ps.accountId, isCompetitor: false }, select: { x: true, y: true } });
  const { x, y } = nextFreeSlot(others);
  const today = new Date().toISOString().slice(0, 10);
  const logs = [{ date: today, content: `📥 ${ORIGIN_LABEL[ps.origin] || '外部导入'}（${ps.evidence || '无备注'}）${ps.sourceUrl ? ' · ' + ps.sourceUrl : ''}`, visibility: 'team' }];
  const personId = 'p_' + randomUUID().slice(0, 12);
  await tx.person.create({ data: { id: personId, tenantId, accountId: ps.accountId, name: ps.name, title: ps.title, orgLevel: ps.orgLevel, isCompetitor: false, x, y, form: '{}', logs: JSON.stringify(logs) } });
  // 候选挂在 memberScoped 商机 → 新建的人加入该商机成员（可见性）
  if (ps.opportunityId) {
    const mo = await tx.opportunity.findFirst({ where: { id: ps.opportunityId, tenantId }, select: { memberScoped: true } });
    if (mo?.memberScoped) await tx.opportunityMember.upsert({ where: { opportunityId_personId: { opportunityId: ps.opportunityId, personId } }, create: { tenantId, opportunityId: ps.opportunityId, personId }, update: {} });
  }
  // WorkBuddy 提议时带了建议角色 + 关联商机 → 采纳时一并落 OppRole（守"角色只对正式 Person"）
  if (ps.suggestedRole && ps.opportunityId) {
    const opp = await tx.opportunity.findFirst({ where: { id: ps.opportunityId, tenantId } });
    if (opp) {
      await tx.oppRole.upsert({
        where: { opportunityId_personId: { opportunityId: ps.opportunityId, personId } },
        create: { tenantId, opportunityId: ps.opportunityId, personId, role: ps.suggestedRole, sentiment: ps.suggestedSentiment || 'unknown', confidence: '推理' },
        update: {},
      });
    }
  }
  await tx.personSuggestion.update({ where: { id: ps.id }, data: { status: 'accepted', resolvedPersonId: personId } });
  // key 收敛：把仍 pending、引用该候选的其它关系端点改写为 person/resolvedPersonId（防重复边）
  await tx.relSuggestion.updateMany({ where: { tenantId, status: 'pending', sourceKind: 'suggestion', sourcePersonId: suggId }, data: { sourceKind: 'person', sourcePersonId: personId } });
  await tx.relSuggestion.updateMany({ where: { tenantId, status: 'pending', targetKind: 'suggestion', targetPersonId: suggId }, data: { targetKind: 'person', targetPersonId: personId } });
  const createdPerson = { id: personId, name: ps.name, title: ps.title, orgLevel: ps.orgLevel, isCompetitor: false, x, y, form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} }, logs };
  return { personId, createdPerson };
}

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
  // 解析候选关系端点名（正式人从 persons 取，候选人从 PersonSuggestion 取），并带上 kind 供前端区分。
  const withNames = async (tenantId: string, rows: any[], persons: any[]) => {
    const nm = new Map(persons.map((p) => [p.id, p.name]));
    const suggIds = new Set<string>();
    for (const r of rows) {
      if (r.sourceKind === 'suggestion') suggIds.add(r.sourcePersonId);
      if (r.targetKind === 'suggestion') suggIds.add(r.targetPersonId);
    }
    if (suggIds.size) {
      const ss = await prisma.personSuggestion.findMany({ where: { tenantId, id: { in: [...suggIds] } }, select: { id: true, name: true } });
      for (const s of ss) nm.set(s.id, s.name + '（候选）');
    }
    return rows.map((r) => ({ id: r.id, source: r.sourcePersonId, target: r.targetPersonId, sourceKind: r.sourceKind, targetKind: r.targetKind, sourceName: nm.get(r.sourcePersonId) || '?', targetName: nm.get(r.targetPersonId) || '?', layer: r.layer, label: r.label, confidence: r.confidence, origin: r.origin, evidence: r.evidence }));
  };

  app.get('/api/suggest', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const oppId = String(req.query?.opportunityId || '');
    if (!oppId) return reply.code(400).send({ error: '缺少 opportunityId' });
    const g = await loadGraph(req.user.tenantId, oppId);
    if (!g) return reply.code(404).send({ error: '商机不存在' });
    const rows = await prisma.relSuggestion.findMany({ where: { opportunityId: oppId, tenantId: req.user.tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    return { suggestions: await withNames(req.user.tenantId, rows, g.persons) };
  });

  app.post('/api/suggest/generate', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = z.object({ opportunityId: z.string() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 opportunityId' });
    const tenantId = req.user.tenantId;
    const r = await generateRelSuggestions(tenantId, p.data.opportunityId);
    if (!r) return reply.code(404).send({ error: '商机不存在' });
    const g = await loadGraph(tenantId, p.data.opportunityId);
    const all = await prisma.relSuggestion.findMany({ where: { opportunityId: p.data.opportunityId, tenantId, status: 'pending' }, orderBy: { confidence: 'desc' } });
    return { added: r.added, suggestions: await withNames(tenantId, all, g!.persons) };
  });

  // 采纳候选关系：级联事务——若端点是候选人物先落正式 Person，再建 Edge。
  // 返回 { edge, createdPersons }：前端须先 dispatch 这些 ADD_PERSON 再 ADD_EDGE，否则画布找不到端点。
  app.post('/api/suggest/:id/accept', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const tenantId = req.user.tenantId;
    // P10 改后采纳：可选 override（层级/标签），采纳时以改后值建边并写回候选留审计
    const ov = z.object({ layer: z.enum(['L1', 'L2', 'L3', 'L4']).optional(), label: z.string().trim().min(1).max(30).optional() }).safeParse(req.body ?? {});
    if (!ov.success) return reply.code(400).send({ error: '改后采纳参数无效' });
    const s = await prisma.relSuggestion.findFirst({ where: { id: req.params.id, tenantId } });
    if (!s) return reply.code(404).send({ error: '候选不存在' });
    if (s.status !== 'pending') return reply.code(400).send({ error: '该候选已处理' });
    const opp = await prisma.opportunity.findFirst({ where: { id: s.opportunityId, tenantId } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    const layer = ov.data.layer ?? s.layer;
    const label = ov.data.label ?? s.label;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const createdPersons: any[] = [];
        // 解析两端点为真实 Person.id（候选则级联落库）
        const resolveEnd = async (kind: string, id: string, role: string) => {
          if (kind === 'suggestion') {
            const r = await materializePerson(tx, tenantId, id);
            if (r.createdPerson) createdPersons.push(r.createdPerson);
            return r.personId;
          }
          const p = await tx.person.findFirst({ where: { id, tenantId } });
          if (!p) throw new Error(`${role}端点（正式干系人）不存在`);
          return id;
        };
        const sourceId = await resolveEnd(s.sourceKind, s.sourcePersonId, 'source');
        const targetId = await resolveEnd(s.targetKind, s.targetPersonId, 'target');

        const edgeId = 'e_' + randomUUID().slice(0, 12);
        const color = LAYER_COLOR[layer] || '#16a34a';
        await tx.edge.create({ data: { id: edgeId, tenantId, accountId: opp.accountId, opportunityId: s.opportunityId, source: sourceId, target: targetId, layer, label, color, style: 'solid', width: null, directed: false, origin: 'ai' } });
        await tx.relSuggestion.update({ where: { id: s.id }, data: { status: 'accepted', layer, label, sourceKind: 'person', sourcePersonId: sourceId, targetKind: 'person', targetPersonId: targetId } });
        return { edge: { id: edgeId, source: sourceId, target: targetId, layer, label, color, style: 'solid', directed: false, origin: 'ai' }, createdPersons };
      });
      return result;
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '采纳失败' });
    }
  });

  app.post('/api/suggest/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const r = await prisma.relSuggestion.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId }, data: { status: 'rejected' } });
    if (!r.count) return reply.code(404).send({ error: '候选不存在' });
    return { ok: true };
  });

  // ── 候选干系人（PersonSuggestion）评审 ──
  app.get('/api/suggest/persons', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const accountId = String(req.query?.accountId || '');
    if (!accountId) return reply.code(400).send({ error: '缺少 accountId' });
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
    const tenantId = req.user.tenantId;
    // P10 改后采纳：可选 override（名字/职务），先写回候选（留审计+物化读的就是改后值）再物化
    const ov = z.object({ name: z.string().trim().min(1).max(40).optional(), title: z.string().trim().max(60).optional() }).safeParse(req.body ?? {});
    if (!ov.success) return reply.code(400).send({ error: '改后采纳参数无效' });
    const ps = await prisma.personSuggestion.findFirst({ where: { id: req.params.id, tenantId } });
    if (!ps) return reply.code(404).send({ error: '候选不存在' });
    if (ps.status !== 'pending') return reply.code(400).send({ error: '该候选已处理' });
    if (ov.data.name !== undefined || ov.data.title !== undefined) {
      await prisma.personSuggestion.update({
        where: { id: ps.id },
        data: { ...(ov.data.name !== undefined ? { name: ov.data.name } : {}), ...(ov.data.title !== undefined ? { title: ov.data.title } : {}) },
      });
    }
    try {
      const r = await prisma.$transaction((tx) => materializePerson(tx, tenantId, ps.id));
      const acc = await prisma.account.findFirst({ where: { id: ps.accountId, tenantId } });
      return { person: r.createdPerson, accId: ps.accountId, accountId: ps.accountId, account: acc ? { id: acc.id } : undefined };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '采纳失败' });
    }
  });

  app.post('/api/suggest/persons/:id/reject', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const r = await prisma.personSuggestion.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'pending' }, data: { status: 'rejected' } });
    if (!r.count) return reply.code(404).send({ error: '候选不存在或已处理' });
    return { ok: true };
  });

  // ── Hub 级审核收件箱：聚合当前租户所有 pending 候选（关系 + 人物），带 account/opp 上下文 ──
  // 「机器写初稿·人审」主线 v1：零 schema，复用 RelSuggestion/PersonSuggestion 表 + withNames。
  // 多租户红线：全程 tenantId 过滤（参考 state.ts 的 assembleState）。采纳/驳回沿用现有 /api/suggest[/persons]/:id/accept|reject。
  app.get('/api/inbox', { preHandler: [app.authenticate] }, async (req: any, reply) => {
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
    const named = await withNames(tenantId, relRows, persons); // 复用：补端点人名（含候选人「（候选）」）
    const rels = named.map((r, i) => {
      const o = oppById.get(relRows[i].opportunityId);
      return { ...r, opportunityId: relRows[i].opportunityId, oppName: o?.name ?? '?', accountId: o?.accountId ?? '', accountName: o ? (accName.get(o.accountId) ?? '?') : '?' };
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
  // approve → 证据进 E2 燃料池（前端 adapter 过滤放行）+ fire-and-forget 落 EVSnapshot(trigger=evidence_review) 留痕；
  // reject → 不参与任何计算（留库审计）。tenantId 隔离 + 只审 pending_review 防重复处理。无静默生效路径（铁律②）。
  app.post('/api/evidence/:id/review', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({
      action: z.enum(['approve', 'reject']),
      direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(), // 修改后采纳：中性信号人工定向
      tier: z.enum(['weak', 'mid', 'strong']).optional(),
    }).safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const ev = await prisma.evidenceEvent.findFirst({ where: { id: req.params.id, tenantId, status: 'pending_review' } });
    if (!ev) return reply.code(404).send({ error: '证据不存在或已处理' });
    const today = new Date().toISOString().slice(0, 10);
    await prisma.evidenceEvent.update({
      where: { id: ev.id },
      data: {
        status: p.data.action === 'approve' ? 'approved' : 'rejected',
        ...(p.data.action === 'approve' && p.data.direction !== undefined ? { direction: p.data.direction } : {}),
        ...(p.data.action === 'approve' && p.data.tier ? { tier: p.data.tier } : {}),
        reviewedBy: req.user.userId ?? '', reviewedAt: today,
      },
    });
    if (p.data.action === 'approve') {
      // 审核通过=局面燃料变化 → 落快照留痕（K7 evidence_review 触发；失败静默不阻塞审核）
      const { takePdeSnapshot } = await import('./pde/routes.js');
      void takePdeSnapshot(tenantId, ev.opportunityId, 'evidence_review', req.user.userId ?? '').catch(() => {});
    }
    return { ok: true, status: p.data.action === 'approve' ? 'approved' : 'rejected' };
  });

  // 忽略一条巡检提醒（提醒型提案：只读，人「忽略」→ dismissed；绝不改业务库）。tenantId 隔离 + status=pending 防重复处理。
  app.post('/api/reminders/:id/dismiss', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const r = await prisma.reminder.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'pending' }, data: { status: 'dismissed' } });
    if (!r.count) return reply.code(404).send({ error: '提醒不存在或已处理' });
    return { ok: true };
  });
}
