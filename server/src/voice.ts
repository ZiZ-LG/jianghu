// 录入情报 —— 销售口述（Typeless 转文字）→ LLM 严格解析 → 双轨落库。
// 双轨（见 docs/录入情报-设计方案.md §2）：
//   🟢 explicit（销售明说）= 用户主动录入，直落正式库（带🎙️口述录入溯源），不属铁律②的"AI 推断"。
//   🔴 inferred（LLM 补充/脑补/低置信/敏感）→ 候选层(PersonSuggestion/RelSuggestion)，进荐关系待人审。
// LLM 只做"解析/结构化"，绝不"推断/脑补"——靠系统提示死命约束 + kind/confidence 兜底。
// 落库全程复用 mutate.ts 的 applyAction，按 tenantId 隔离。

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { loadAiConfig, callLLM } from './ai.js';
import { applyAction } from './mutate.js';

const PIPELINE = ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'];
const VALID_ROLE = ['A', 'D', 'U', 'TB', 'R'];
const VALID_SENT = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'];

const S = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const N = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);
const clampLevel = (v: unknown) => Math.min(4, Math.max(1, Math.round(N(v) ?? 3)));
// explicit 判定：未标 inferred 且置信度≥0.6 才直落正式库，否则进候选
const isExplicit = (item: any) => item?.kind !== 'inferred' && (N(item?.confidence) ?? 1) >= 0.6;
// 新节点错位排布（与 suggest.ts / App.importPersons 同口径）
const placeAt = (n: number) => ({ x: 220 + (n % 4) * 150, y: 150 + Math.floor(n / 4) * 135 });

const EXTRACT_SYSTEM = `你是销售情报结构化助手，精通 G64111 销售罗盘。把销售口述的拜访记录整理成结构化 JSON。

【最高铁律】只整理文本中【明确说出】的人、关系、事实。绝不补充、推断、脑补、联想任何文本未提及的内容。
- 凡是你"推测/猜测/根据常识补充"的项，必须标 "kind":"inferred"；销售明说的标 "kind":"explicit"。
- 销售明说的人就建，没提到的人绝不凭空造。

【术语】角色 A批准人 D拍板人 U使用者 TB技术选型/招采把关 R影响者/教练（竞争对手不是角色）。
支持度 star排他支持 plus明确支持 neutral中立 unknown未知 minus负面 x倒向对手。
关系分层 L1组织架构 L2决策权力 L3情感阵营 L4战略本质。

【只输出 JSON】不要任何解释文字。结构：
{
  "account": {"name":"客户全称或简称","customerType":1或2或3,"region":"大区","kind":"explicit|inferred","evidence":"原话片段"} 或 null,
  "opportunity": {"name":"商机名","pipelineStage":"七阶段之一","competitor":"主要友商","kind":"...","evidence":"..."} 或 null,
  "persons": [{"name":"姓名","title":"职务","orgLevel":1到4,"suggestedRole":"A|D|U|TB|R","suggestedSentiment":"star|plus|neutral|unknown|minus|x","kind":"explicit|inferred","confidence":0到1,"evidence":"原话"}],
  "relationships": [{"source":"人名","target":"人名","layer":"L1|L2|L3|L4","label":"关系描述","kind":"...","confidence":0到1,"evidence":"..."}],
  "burningIssues": [{"person":"姓名","description":"燃眉之急","category":"类别","kind":"..."}],
  "rawNote": "把整段口述原样保留作为拜访纪要"
}
- pipelineStage 只能取：线索/需求引导/方案认可/客户立项/招投标/合同谈判/合同双签。
- relationships 的 source/target 必须是 persons 里出现过的人名或上下文已知干系人；端点是隐含的第三方（如"竞争对手"）时标 inferred。
- 没提到的部分填 null 或空数组 []。绝不编造。`;

interface Extracted {
  account?: any; opportunity?: any;
  persons?: any[]; relationships?: any[]; burningIssues?: any[];
  rawNote?: string;
}

async function extractIntel(ai: { baseUrl: string; model: string; apiKey: string }, text: string, ctx: { accountName?: string; personNames: string[] }): Promise<Extracted> {
  const user = `【已知上下文】当前客户：${ctx.accountName || '（无，可能需新建）'}；已有干系人：${ctx.personNames.join('、') || '无'}\n\n【销售口述】\n${text}`;
  const raw = await callLLM(ai, EXTRACT_SYSTEM, user, 1400);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型未返回结构化结果');
  return JSON.parse(m[0]);
}

export function voiceRoutes(app: FastifyInstance) {
  app.post('/api/voice/extract', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const tenantId = req.user.tenantId;
    const userId = req.user.id || '';
    const p = z.object({ text: z.string().min(1), accountId: z.string().optional(), opportunityId: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入要录入的文字' });
    const text = p.data.text.slice(0, 8000);

    // 上下文：当前客户（含 persons 用于去重、opportunities 用于定位）
    let acc = p.data.accountId
      ? await prisma.account.findFirst({ where: { id: p.data.accountId, tenantId }, include: { persons: true, opportunities: true } })
      : null;

    const ai = await loadAiConfig(tenantId);
    const today = new Date().toISOString().slice(0, 10);

    // 无可用模型 → 退化：仅把原文存为拜访纪要（无 key 也有基本价值，引导配模型）
    if (!ai || ai.provider === 'mock' || !ai.baseUrl || !ai.model) {
      if (acc) {
        const oppId = p.data.opportunityId && acc.opportunities.some((o) => o.id === p.data.opportunityId) ? p.data.opportunityId : null;
        const vid = 'visit_' + randomUUID().slice(0, 12);
        await applyAction(tenantId, { type: 'ADD_VISIT', accId: acc.id, visit: { id: vid, accountId: acc.id, opportunityId: oppId, date: today, topic: '口述录入', summary: text, origin: 'voice', createdBy: userId } });
        return { needConfig: true, account: { id: acc.id, name: acc.name, status: 'matched' }, visitNote: true, note: '未配置 AI 模型，已先把口述存为拜访纪要。配置模型后即可自动抽取客户/商机/干系人/关系。' };
      }
      return reply.code(400).send({ error: '请先在「AI 模型」配置模型，才能自动抽取情报', needConfig: true });
    }

    let ex: Extracted;
    try { ex = await extractIntel({ baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }, text, { accountName: acc?.name, personNames: (acc?.persons ?? []).map((x) => x.name) }); }
    catch (e: any) { return reply.code(400).send({ error: '情报抽取失败：' + (e?.message || '模型返回异常') }); }

    const receipt: any = { account: null, opportunity: null, personsCreated: [], personsReused: [], rolesSet: [], edgesCreated: [], burningIssues: [], candidates: { persons: [], relationships: [] }, visitNote: false, skipped: [] };

    // ── 1) 客户（业务实体，明说直落；命中现有则补字段）──
    if (ex.account && S(ex.account.name)) {
      const name = S(ex.account.name, 100);
      if (!acc) acc = await prisma.account.findFirst({ where: { tenantId, name }, include: { persons: true, opportunities: true } });
      if (acc) {
        if (isExplicit(ex.account) && S(ex.account.region)) await applyAction(tenantId, { type: 'UPDATE_ACCOUNT', accId: acc.id, patch: { region: S(ex.account.region, 40) } });
        receipt.account = { id: acc.id, name: acc.name, status: 'matched' };
      } else {
        const id = 'acc_' + randomUUID().slice(0, 12);
        const ct = [1, 2, 3].includes(N(ex.account.customerType) as number) ? (N(ex.account.customerType) as number) : 2;
        await applyAction(tenantId, { type: 'ADD_ACCOUNT', account: { id, name, customerType: ct, region: S(ex.account.region, 40) } });
        acc = await prisma.account.findFirst({ where: { id, tenantId }, include: { persons: true, opportunities: true } });
        receipt.account = { id, name, status: 'created' };
      }
    }
    if (!acc) return { ...receipt, note: '未能确定客户：请在某个客户/商机里录入，或在口述中说明客户名称。', raw: S(ex.rawNote, 4000) || text };

    // ── 2) 商机（明说直落；命中现有则关联）──
    let opp = p.data.opportunityId ? acc.opportunities.find((o) => o.id === p.data.opportunityId) ?? null : null;
    if (!opp && ex.opportunity && S(ex.opportunity.name)) {
      const oname = S(ex.opportunity.name, 100);
      opp = acc.opportunities.find((o) => o.name === oname) ?? null;
      if (!opp) {
        const id = 'opp_' + randomUUID().slice(0, 12);
        const stage = PIPELINE.includes(S(ex.opportunity.pipelineStage)) ? S(ex.opportunity.pipelineStage) : '线索';
        await applyAction(tenantId, { type: 'ADD_OPP', accId: acc.id, opp: { id, name: oname, customerType: acc.customerType, pipelineStage: stage, engageStage: '需求调研立项', competitor: S(ex.opportunity.competitor, 200) } });
        opp = { id, name: oname } as any;
        receipt.opportunity = { id, name: oname, status: 'created' };
      } else receipt.opportunity = { id: opp.id, name: opp.name, status: 'matched' };
    } else if (opp) receipt.opportunity = { id: opp.id, name: opp.name, status: 'matched' };

    // ── 3) 干系人（explicit 直落正式 Person / inferred 候选）──
    const formalId = new Map<string, string>(); // name → 正式 personId
    const suggId = new Map<string, string>();   // name → 候选 suggestionId
    for (const per of acc.persons) formalId.set(per.name, per.id);
    let placeN = acc.persons.filter((x) => !x.isCompetitor).length;

    const setRoleIf = async (personId: string, per: any, name: string) => {
      if (opp && VALID_ROLE.includes(S(per.suggestedRole))) {
        await applyAction(tenantId, { type: 'SET_ROLE', accId: acc!.id, oppId: opp.id, personId, patch: { role: S(per.suggestedRole), sentiment: VALID_SENT.includes(S(per.suggestedSentiment)) ? S(per.suggestedSentiment) : 'unknown', confidence: '推理' } });
        receipt.rolesSet.push({ name, role: S(per.suggestedRole) });
      }
    };

    for (const per of ex.persons ?? []) {
      const name = S(per.name, 40);
      if (!name) continue;
      const existingId = formalId.get(name);
      if (existingId) { // 已存在正式干系人 → 复用（销售自己说的，默认同一人）
        receipt.personsReused.push({ id: existingId, name });
        if (isExplicit(per)) await setRoleIf(existingId, per, name);
        continue;
      }
      if (isExplicit(per)) { // 明说 → 直落正式 Person（form 留空：敏感隐私不落；logs 带🎙️溯源）
        const pid = 'p_' + randomUUID().slice(0, 12);
        const { x, y } = placeAt(placeN++);
        const logs = [{ date: today, content: `🎙️ 口述录入：${S(per.evidence, 80) || name}`, visibility: 'team' }];
        await applyAction(tenantId, { type: 'ADD_PERSON', accId: acc.id, person: { id: pid, name, title: S(per.title, 60), orgLevel: clampLevel(per.orgLevel), x, y, logs } });
        formalId.set(name, pid);
        receipt.personsCreated.push({ id: pid, name, title: S(per.title, 60) });
        await setRoleIf(pid, per, name);
      } else { // AI 补充 → 候选 PersonSuggestion
        const sid = 'ps_' + randomUUID().slice(0, 12);
        await prisma.personSuggestion.create({ data: { id: sid, tenantId, accountId: acc.id, opportunityId: opp?.id ?? null, name, title: S(per.title, 60), orgLevel: clampLevel(per.orgLevel), origin: 'voice', evidence: S(per.evidence, 500), confidence: N(per.confidence) ?? 0.5, status: 'pending', proposedBy: userId, suggestedRole: VALID_ROLE.includes(S(per.suggestedRole)) ? S(per.suggestedRole) : null, suggestedSentiment: VALID_SENT.includes(S(per.suggestedSentiment)) ? S(per.suggestedSentiment) : null } });
        suggId.set(name, sid);
        receipt.candidates.persons.push({ id: sid, name });
      }
    }

    // ── 4) 关系（两端皆正式 Person 且 explicit → 直落 Edge；否则候选 RelSuggestion）──
    for (const rel of ex.relationships ?? []) {
      const sName = S(rel.source, 40), tName = S(rel.target, 40);
      if (!sName || !tName || sName === tName) continue;
      const layer = ['L1', 'L2', 'L3', 'L4'].includes(S(rel.layer)) ? S(rel.layer) : 'L3';
      const label = S(rel.label, 40) || '关联';
      const sEnd = formalId.has(sName) ? { kind: 'person', id: formalId.get(sName)! } : suggId.has(sName) ? { kind: 'suggestion', id: suggId.get(sName)! } : null;
      const tEnd = formalId.has(tName) ? { kind: 'person', id: formalId.get(tName)! } : suggId.has(tName) ? { kind: 'suggestion', id: suggId.get(tName)! } : null;
      if (!sEnd || !tEnd) { receipt.skipped.push({ rel: `${sName}→${tName}`, reason: '端点未识别' }); continue; }
      const bothFormal = sEnd.kind === 'person' && tEnd.kind === 'person';
      if (bothFormal && isExplicit(rel)) { // 明说 + 两端正式 → 直落正式 Edge
        const eid = 'e_' + randomUUID().slice(0, 12);
        await applyAction(tenantId, { type: 'ADD_EDGE', accId: acc.id, oppId: opp?.id, edge: { id: eid, source: sEnd.id, target: tEnd.id, layer, label, origin: 'voice', style: 'solid', directed: false } });
        receipt.edgesCreated.push({ source: sName, target: tName, label });
      } else { // 含候选端点 / inferred 关系 → 候选（须有商机，RelSuggestion 挂 opportunityId）
        if (!opp) { receipt.skipped.push({ rel: `${sName}→${tName}`, reason: '无商机上下文，候选关系跳过' }); continue; }
        const rid = 'rs_' + randomUUID().slice(0, 12);
        await prisma.relSuggestion.create({ data: { id: rid, tenantId, opportunityId: opp.id, sourcePersonId: sEnd.id, sourceKind: sEnd.kind, targetPersonId: tEnd.id, targetKind: tEnd.kind, layer, label, confidence: N(rel.confidence) ?? 0.5, origin: 'voice', evidence: S(rel.evidence, 500), status: 'pending' } });
        receipt.candidates.relationships.push({ source: sName, target: tName, label });
      }
    }

    // ── 5) 燃眉之急 BI（explicit，挂正式 Person + 商机）──
    for (const bi of ex.burningIssues ?? []) {
      const pid = formalId.get(S(bi.person, 40));
      if (pid && opp && isExplicit(bi) && S(bi.description)) {
        const bid = 'bi_' + randomUUID().slice(0, 12);
        await applyAction(tenantId, { type: 'ADD_BI', accId: acc.id, oppId: opp.id, bi: { id: bid, personId: pid, description: S(bi.description, 500), category: S(bi.category, 40) || '其他', isPrivate: true, confidence: '推理' } });
        receipt.burningIssues.push({ person: S(bi.person, 40), category: S(bi.category, 40) || '其他' });
      }
    }

    // ── 6) 拜访纪要存档（原文 → VisitNote）──
    const rawNote = S(ex.rawNote, 5000) || text;
    if (rawNote) {
      const vid = 'visit_' + randomUUID().slice(0, 12);
      await applyAction(tenantId, { type: 'ADD_VISIT', accId: acc.id, visit: { id: vid, accountId: acc.id, opportunityId: opp?.id ?? null, date: today, topic: '口述录入', summary: rawNote, origin: 'voice', createdBy: userId } });
      receipt.visitNote = true;
    }

    return receipt;
  });
}
