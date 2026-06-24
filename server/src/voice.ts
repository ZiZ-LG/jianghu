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
import { createFieldProposal } from './proposals.js';
import { nextFreeSlot } from './layout.js';

const PIPELINE = ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'];
const VALID_ROLE = ['A', 'D', 'U', 'R', 'C'];
const VALID_SENT = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'];
const VALID_UCV_STATUS = ['建议', '获认可', '已解决'];

const S = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const N = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);
const clampLevel = (v: unknown) => Math.min(4, Math.max(1, Math.round(N(v) ?? 3)));
// explicit 判定：未标 inferred 且置信度≥0.6 才直落正式库，否则进候选
const isExplicit = (item: any) => item?.kind !== 'inferred' && (N(item?.confidence) ?? 1) >= 0.6;
// 实体去重提示（跨库可移植，纯 JS）：精确同名已各自处理，这里找"相似但不全等"（含包含关系，如「李处」≈「李处长」）
const stripCompany = (s: string) => s.trim().replace(/(集团)?(股份)?(有限)?(责任)?公司$/, '').replace(/集团$/, '').trim() || s.trim();
const isSimilarName = (a: string, b: string): boolean => {
  const x = a.trim(), y = b.trim();
  if (!x || !y || x === y) return false; // 全等是精确匹配，不算"相似提示"
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short); // 短串≥2 且被长串包含
};

const EXTRACT_SYSTEM = `你是销售情报结构化助手，精通 G64111 销售罗盘。把销售口述的拜访记录整理成结构化 JSON。

【最高铁律】只整理文本中【明确说出】的人、关系、事实。绝不补充、推断、脑补、联想任何文本未提及的内容。
- 凡是你"推测/猜测/根据常识补充"的项，必须标 "kind":"inferred"；销售明说的标 "kind":"explicit"。
- 销售明说的人就建，没提到的人绝不凭空造。

【术语】角色 A批准人 D拍板人 U使用者 R影响者/技术选型/招采把关 C教练（竞争对手不是角色）。
支持度 star排他支持 plus明确支持 neutral中立 unknown未知 minus负面 x倒向对手。
关系分层 L1组织架构 L2决策权力 L3情感阵营 L4战略本质。
燃眉之急 BI=干系人最迫切的难题/压力；独特价值 UCV=我方能解决该 BI 而竞品给不了的差异化价值（必对应某条 BI）。

【只输出 JSON】不要任何解释文字。结构：
{
  "account": {"name":"客户全称或简称","customerType":1或2或3或4,"region":"大区","kind":"explicit|inferred","evidence":"原话片段"} 或 null,
  "opportunity": {"name":"商机名","pipelineStage":"七阶段之一","competitor":"主要友商","kind":"...","evidence":"..."} 或 null,
  "persons": [{"name":"姓名","title":"职务","orgLevel":1到4,"suggestedRole":"A|D|U|R|C","suggestedSentiment":"star|plus|neutral|unknown|minus|x","kind":"explicit|inferred","confidence":0到1,"evidence":"原话"}],
  "relationships": [{"source":"人名","target":"人名","layer":"L1|L2|L3|L4","label":"关系描述","kind":"...","confidence":0到1,"evidence":"..."}],
  "burningIssues": [{"person":"姓名","description":"燃眉之急","category":"类别","kind":"..."}],
  "ucvs": [{"person":"该价值针对谁的BI","biCategory":"对应BI的类别","description":"我方独特价值","competitorCannot":"竞品给不了什么","status":"建议|获认可|已解决","kind":"explicit|inferred","evidence":"原话"}],
  "rawNote": "把整段口述原样保留作为拜访纪要"
}
- pipelineStage 只能取：线索/需求引导/方案认可/客户立项/招投标/合同谈判/合同双签。
- relationships 的 source/target 必须是 persons 里出现过的人名或上下文已知干系人；端点是隐含的第三方（如"竞争对手"）时标 inferred。
- ucvs 必须对应 burningIssues 中某人的 BI（同 person + biCategory）；销售没明说"我方能解决而对手给不了"就别造 UCV。
- 若给了【前文】，用它消解本次口述里的指代（"他""那位副总"等指向前文的人）；但只抽取【本次补充】里新增或变更的人/关系/事实，不要重复输出前文已处理过的。
- 没提到的部分填 null 或空数组 []。绝不编造。`;

interface Extracted {
  account?: any; opportunity?: any;
  persons?: any[]; relationships?: any[]; burningIssues?: any[]; ucvs?: any[];
  rawNote?: string;
}

async function extractIntel(ai: { baseUrl: string; model: string; apiKey: string }, text: string, ctx: { accountName?: string; personNames: string[]; priorText?: string }): Promise<Extracted> {
  const prior = ctx.priorText ? `\n\n【本次拜访·前文（仅供理解"他/她/那位"等指代，请勿重复抽取前文已提到的人/关系）】\n${ctx.priorText}` : '';
  const user = `【已知上下文】当前客户：${ctx.accountName || '（无，可能需新建）'}；已有干系人：${ctx.personNames.join('、') || '无'}${prior}\n\n【本次补充口述】\n${text}`;
  // 8000 token：推理模型(MiniMax-M3 / DeepSeek-R1 等)会先输出 <think> 思考，token 给足才轮到 JSON
  const raw = await callLLM(ai, EXTRACT_SYSTEM, user, 8000);
  // 剥离推理模型的 <think>…</think> 与 markdown 代码块围栏，再提取 JSON（普通模型无 think，剥离无害）
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json|```/gi, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型未返回结构化结果');
  return JSON.parse(m[0]);
}

export function voiceRoutes(app: FastifyInstance) {
  app.post('/api/voice/extract', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const tenantId = req.user.tenantId;
    const userId = req.user.id || '';
    const p = z.object({ text: z.string().min(1), accountId: z.string().optional(), opportunityId: z.string().optional(), priorText: z.string().optional(), sourceVisitId: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入要录入的文字' });
    const text = p.data.text.slice(0, 8000);
    const priorText = (p.data.priorText ?? '').slice(0, 8000); // 多轮增量：上一轮口述，供 LLM 指代消解
    // 从「已存在的拜访纪要」抽取(M1 焊接缝)：源本身就是一条纪要，跳过末尾的纪要存档，避免重复落库
    const skipVisitNote = Boolean(p.data.sourceVisitId);

    // 上下文：当前客户（含 persons 用于去重、opportunities 用于定位）
    let acc = p.data.accountId
      ? await prisma.account.findFirst({ where: { id: p.data.accountId, tenantId }, include: { persons: true, opportunities: true } })
      : null;

    const ai = await loadAiConfig(tenantId);
    const today = new Date().toISOString().slice(0, 10);

    // 无可用模型 → 退化：仅把原文存为拜访纪要（无 key 也有基本价值，引导配模型）
    if (!ai || ai.provider === 'mock' || !ai.baseUrl || !ai.model) {
      // 从已有纪要抽取(skipVisitNote)：源就是纪要本身，无模型时无可抽取、也绝不再复制一条纪要
      if (skipVisitNote) return { needConfig: true, account: acc ? { id: acc.id, name: acc.name, status: 'matched' } : null, visitNote: false, note: '未配置 AI 模型，无法从这条纪要抽取结构化情报。请先在「🧠 AI 模型」里配置模型。' };
      if (acc) {
        const oppId = p.data.opportunityId && acc.opportunities.some((o) => o.id === p.data.opportunityId) ? p.data.opportunityId : null;
        const vid = 'visit_' + randomUUID().slice(0, 12);
        await applyAction(tenantId, { type: 'ADD_VISIT', accId: acc.id, visit: { id: vid, accountId: acc.id, opportunityId: oppId, date: today, topic: '口述录入', summary: text, origin: 'voice', createdBy: userId } });
        return { needConfig: true, account: { id: acc.id, name: acc.name, status: 'matched' }, visitNote: true, note: '未配置 AI 模型，已先把口述存为拜访纪要。配置模型后即可自动抽取客户/商机/干系人/关系。' };
      }
      return reply.code(400).send({ error: '请先在「AI 模型」配置模型，才能自动抽取情报', needConfig: true });
    }

    let ex: Extracted;
    try { ex = await extractIntel({ baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }, text, { accountName: acc?.name, personNames: (acc?.persons ?? []).map((x) => x.name), priorText }); }
    catch (e: any) { return reply.code(400).send({ error: '情报抽取失败：' + (e?.message || '模型返回异常') }); }

    const receipt: any = { account: null, opportunity: null, personsCreated: [], personsReused: [], rolesSet: [], edgesCreated: [], burningIssues: [], ucvs: [], dupWarnings: [], candidates: { persons: [], relationships: [] }, notes: [], visitNote: false, skipped: [] };

    // ── 1) 客户（业务实体，明说直落；命中现有则补字段）──
    if (ex.account && S(ex.account.name)) {
      const name = S(ex.account.name, 100);
      if (!acc) acc = await prisma.account.findFirst({ where: { tenantId, name }, include: { persons: true, opportunities: true } });
      if (acc) {
        if (isExplicit(ex.account) && S(ex.account.region)) await applyAction(tenantId, { type: 'UPDATE_ACCOUNT', accId: acc.id, patch: { region: S(ex.account.region, 40) } });
        receipt.account = { id: acc.id, name: acc.name, status: 'matched' };
      } else {
        // 即将新建客户 → 先查 tenant 内相似名（命中则回执提示疑似重复，不打断、仍新建）
        const others = await prisma.account.findMany({ where: { tenantId }, select: { name: true } });
        const sim = others.find((o) => isSimilarName(stripCompany(o.name), stripCompany(name)));
        const id = 'acc_' + randomUUID().slice(0, 12);
        const ct = [1, 2, 3].includes(N(ex.account.customerType) as number) ? (N(ex.account.customerType) as number) : 2;
        await applyAction(tenantId, { type: 'ADD_ACCOUNT', account: { id, name, customerType: ct, region: S(ex.account.region, 40) } });
        acc = await prisma.account.findFirst({ where: { id, tenantId }, include: { persons: true, opportunities: true } });
        receipt.account = { id, name, status: 'created' };
        if (sim) receipt.dupWarnings.push({ kind: 'account', name, similarTo: sim.name });
      }
    }
    if (!acc) return { ...receipt, note: '未能确定客户：请在某个客户/商机里录入，或在口述中说明客户名称。', raw: S(ex.rawNote, 4000) || text };

    // ── 2) 商机（明说直落；命中现有则关联）──
    let opp = p.data.opportunityId ? acc.opportunities.find((o) => o.id === p.data.opportunityId) ?? null : null;
    if (!opp && ex.opportunity && S(ex.opportunity.name)) {
      const oname = S(ex.opportunity.name, 100);
      opp = acc.opportunities.find((o) => o.name === oname) ?? null;
      if (!opp) {
        const simOpp = acc.opportunities.find((o) => isSimilarName(o.name, oname)); // 同客户内相似商机名
        const id = 'opp_' + randomUUID().slice(0, 12);
        const stage = PIPELINE.includes(S(ex.opportunity.pipelineStage)) ? S(ex.opportunity.pipelineStage) : '线索';
        await applyAction(tenantId, { type: 'ADD_OPP', accId: acc.id, opp: { id, name: oname, customerType: acc.customerType, pipelineStage: stage, engageStage: '需求调研立项', competitor: S(ex.opportunity.competitor, 200) } });
        opp = { id, name: oname } as any;
        receipt.opportunity = { id, name: oname, status: 'created' };
        if (simOpp) receipt.dupWarnings.push({ kind: 'opportunity', name: oname, similarTo: simOpp.name });
      } else receipt.opportunity = { id: opp.id, name: opp.name, status: 'matched' };
    } else if (opp) receipt.opportunity = { id: opp.id, name: opp.name, status: 'matched' };

    // ── 3) 干系人（explicit 直落正式 Person / inferred 候选）──
    const formalId = new Map<string, string>(); // name → 正式 personId
    const suggId = new Map<string, string>();   // name → 候选 suggestionId
    for (const per of acc.persons) formalId.set(per.name, per.id);
    const occupied = acc.persons.filter((pp) => !pp.isCompetitor).map((pp) => ({ x: pp.x, y: pp.y })); // 新节点避让：已有非竞品节点坐标

    const setRoleIf = async (personId: string, per: any, name: string, isExisting = false) => {
      if (!opp || !VALID_ROLE.includes(S(per.suggestedRole))) return;
      const newSent = VALID_SENT.includes(S(per.suggestedSentiment)) ? S(per.suggestedSentiment) : 'unknown';
      // v2.0 提案层：机器改【已有干系人的已有支持度】→ 进 ChangeProposal 待人审（不静默改分，守差距分析红线）；
      // 新建/首次设角色 → 直写（无"覆盖人改"问题）。role 不在 v2.0 提案范围，已有角色保持不动。
      if (isExisting && newSent !== 'unknown') {
        const cur = await prisma.oppRole.findUnique({ where: { opportunityId_personId: { opportunityId: opp.id, personId } } });
        if (cur && cur.sentiment !== newSent) {
          await createFieldProposal(tenantId, { accountId: acc!.id, opportunityId: opp.id, entityKind: 'oppRole', entityId: personId, field: 'sentiment', oldValue: cur.sentiment, newValue: newSent, origin: 'voice', evidence: `口述纪要推断：${name} 的支持度疑似变化`, confidence: 0.6, proposedBy: userId });
          receipt.proposals = (receipt.proposals ?? 0) + 1;
          return;
        }
      }
      await applyAction(tenantId, { type: 'SET_ROLE', accId: acc!.id, oppId: opp.id, personId, patch: { role: S(per.suggestedRole), sentiment: newSent, confidence: '推理' } });
      receipt.rolesSet.push({ name, role: S(per.suggestedRole) });
    };

    for (const per of ex.persons ?? []) {
      const name = S(per.name, 40);
      if (!name) continue;
      const existingId = formalId.get(name);
      if (existingId) { // 已存在正式干系人 → 复用（销售自己说的，默认同一人）
        receipt.personsReused.push({ id: existingId, name });
        if (isExplicit(per)) await setRoleIf(existingId, per, name, true); // 已有干系人：支持度变化走提案而非直写
        continue;
      }
      if (isExplicit(per)) { // 明说 → 直落正式 Person（form 留空：敏感隐私不落；logs 带🎙️溯源）
        // 同客户内相似名（如「李处」≈「李处长」，含本次已建）→ 回执提示疑似重复，不打断、仍新建
        const simName = [...formalId.keys()].find((k) => isSimilarName(k, name));
        const pid = 'p_' + randomUUID().slice(0, 12);
        const { x, y } = nextFreeSlot(occupied); occupied.push({ x, y });
        const logs = [{ date: today, content: `🎙️ 口述录入：${S(per.evidence, 80) || name}`, visibility: 'team' }];
        await applyAction(tenantId, { type: 'ADD_PERSON', accId: acc.id, person: { id: pid, name, title: S(per.title, 60), orgLevel: clampLevel(per.orgLevel), x, y, logs } });
        formalId.set(name, pid);
        if (opp?.memberScoped) await applyAction(tenantId, { type: 'ADD_OPP_MEMBER', accId: acc.id, oppId: opp.id, personId: pid }); // memberScoped 商机 → 新人加入成员
        receipt.personsCreated.push({ id: pid, name, title: S(per.title, 60) });
        if (simName) receipt.dupWarnings.push({ kind: 'person', name, similarTo: simName });
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
      if (!sEnd || !tEnd) {
        // 一端是已识别的正式干系人、另一端是未识别第三方(如"竞争对手") → 记为该干系人的待核实备注，不丢情报
        const knownName = formalId.has(sName) ? sName : formalId.has(tName) ? tName : null;
        if (knownName) {
          const otherName = knownName === sName ? tName : sName;
          const clue = label.includes(otherName) ? label : `与「${otherName}」${label}`;
          await applyAction(tenantId, { type: 'ADD_LOG', accId: acc.id, personId: formalId.get(knownName)!, log: { date: today, content: `🎙️ 口述线索·待核实：${clue}`, visibility: 'team' } });
          receipt.notes.push({ person: knownName, content: clue });
        } else {
          receipt.skipped.push({ rel: `${sName}→${tName}`, reason: '端点未识别' });
        }
        continue;
      }
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
    const bisByPerson = new Map<string, { biId: string; category: string }[]>(); // person → 本次建的 BI（供 UCV 挂靠）
    for (const bi of ex.burningIssues ?? []) {
      const personName = S(bi.person, 40);
      const pid = formalId.get(personName);
      if (pid && opp && isExplicit(bi) && S(bi.description)) {
        const bid = 'bi_' + randomUUID().slice(0, 12);
        const category = S(bi.category, 40) || '其他';
        await applyAction(tenantId, { type: 'ADD_BI', accId: acc.id, oppId: opp.id, bi: { id: bid, personId: pid, description: S(bi.description, 500), category, isPrivate: true, confidence: '推理' } });
        const arr = bisByPerson.get(personName) ?? []; arr.push({ biId: bid, category }); bisByPerson.set(personName, arr);
        receipt.burningIssues.push({ person: personName, category });
      }
    }

    // ── 5.5) 独特价值 UCV（explicit，须挂到本次识别的 BI；供 G64111 C6 决胜计分）──
    for (const u of ex.ucvs ?? []) {
      const personName = S(u.person, 40);
      const desc = S(u.description, 500);
      if (!desc || !opp || !isExplicit(u)) continue;
      const cands = bisByPerson.get(personName) ?? [];
      // 该人本次只一条 BI → 直接挂；多条 → 按 biCategory 匹配，匹配不到挂第一条；无 BI → 跳过（UCV 必依附 BI）
      const targetBiId = cands.length === 1 ? cands[0].biId
        : cands.length > 1 ? (cands.find((c) => c.category === (S(u.biCategory, 40) || '其他')) ?? cands[0]).biId
        : null;
      if (!targetBiId) { receipt.skipped.push({ ucv: desc.slice(0, 24), reason: 'UCV 未匹配到对应 BI（需先明说该人的燃眉之急）' }); continue; }
      const status = VALID_UCV_STATUS.includes(S(u.status)) ? S(u.status) : '建议';
      const uid = 'ucv_' + randomUUID().slice(0, 12);
      await applyAction(tenantId, { type: 'ADD_UCV', accId: acc.id, oppId: opp.id, ucv: { id: uid, targetBiId, description: desc, competitorCannot: S(u.competitorCannot, 500), status } });
      receipt.ucvs.push({ person: personName, status });
    }

    // ── 6) 拜访纪要存档（原文 → VisitNote）。从已有纪要抽取(skipVisitNote)时跳过，避免重复 ──
    const rawNote = S(ex.rawNote, 5000) || text;
    if (rawNote && !skipVisitNote) {
      const vid = 'visit_' + randomUUID().slice(0, 12);
      await applyAction(tenantId, { type: 'ADD_VISIT', accId: acc.id, visit: { id: vid, accountId: acc.id, opportunityId: opp?.id ?? null, date: today, topic: '口述录入', summary: rawNote, origin: 'voice', createdBy: userId } });
      receipt.visitNote = true;
    }

    return receipt;
  });
}
