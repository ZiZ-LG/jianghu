// 录入情报 —— 销售口述（Typeless 转文字）→ LLM 严格解析 → 双轨落库。
// 双轨（见 docs/录入情报-设计方案.md §2）：
//   🟢 explicit（销售明说）= 用户主动录入，直落正式库（带🎙️口述录入溯源），不属铁律②的"AI 推断"。
//   🔴 inferred（LLM 补充/脑补/低置信/敏感）→ 候选层(PersonSuggestion/RelSuggestion)，进荐关系待人审。
// LLM 只做"解析/结构化"，绝不"推断/脑补"——靠系统提示死命约束 + kind/confidence 兜底。
// 落库全程复用 mutate.ts 的 applyAction，按 tenantId 隔离。

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActionSchema, ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import { loadAiConfig, callLLM } from './ai.js';
import { enqueueEnrichJob, enqueueSuggestJob, enqueueProfileJob } from './jobs.js';
import { applyAction, type DbClient } from './mutate.js';
import { createFieldProposal } from './proposals.js';
import { nextFreeSlot } from './layout.js';
import { activePersonWhere } from './activePerson.js';
import { canWriteFormal, hasExplicitTrustMetadata } from './ingestTrust.js';
import { businessYmd } from './businessDate.js';
import { failReservedCommand, reserveCommand, runCommand } from './mutation/commandRunner.js';
import {
  ScopedNotFoundError,
  requireAccount,
  requireOpportunity,
  requirePerson,
} from './mutation/scopeGuards.js';

const applyIngestActionWithDb = async (ctx: CommandContext, input: unknown, db: DbClient): Promise<void> => {
  await applyAction(ctx, ActionSchema.parse(input), db);
};

const PIPELINE = ['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'];
const VALID_ROLE = ['A', 'D', 'U', 'R', 'C'];
const VALID_SENT = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'];
const VALID_UCV_STATUS = ['建议', '获认可', '已解决'];

const S = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const N = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);
const clampLevel = (v: unknown) => Math.min(4, Math.max(1, Math.round(N(v) ?? 3)));
// explicit 判定：kind/confidence 均须存在且合法；缺失或异常一律降级候选。
const isExplicit = hasExplicitTrustMetadata;

type IngestContextSelection =
  | { kind: 'structured'; source: 'voice' | 'recording'; item: unknown }
  | { kind: 'raw' }
  | { kind: 'machine' };

/** 入口来源和当前抽取项共同决定信任级别；不继承调用方传入的 assertionMode。 */
export function deriveIngestCommandContext(baseCtx: CommandContext, selection: IngestContextSelection): CommandContext {
  const assertionMode = selection.kind === 'raw'
    ? 'raw_append'
    : selection.kind === 'machine' || selection.source === 'recording' || !isExplicit(selection.item)
      ? 'machine_proposed'
      : 'user_asserted';
  return { ...baseCtx, assertionMode };
}
// 实体去重提示（跨库可移植，纯 JS）：精确同名已各自处理，这里找"相似但不全等"（含包含关系，如「李处」≈「李处长」）
const stripCompany = (s: string) => s.trim().replace(/(集团)?(股份)?(有限)?(责任)?公司$/, '').replace(/集团$/, '').trim() || s.trim();
const isSimilarName = (a: string, b: string): boolean => {
  const x = a.trim(), y = b.trim();
  if (!x || !y || x === y) return false; // 全等是精确匹配，不算"相似提示"
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short); // 短串≥2 且被长串包含
};

// 家庭七问键，对齐 G64111 方法论（与 g64111.ts / 前端 types 同源、固定不变）。
const FAMILY_7Q = ['籍贯', '年纪', '生日', '毕业院校', '配偶', '子女', '父母'] as const;
// 从抽取的 form 构建 Person.form（只收销售明说的非空字段）。FORM 是 G64111 C1（D 的 FORM 表）计分项。
function buildForm(raw: any): { family: string; occupation: string; recreation: string; moneyMotivation: string; family7: Record<string, string> } | null {
  if (!raw || typeof raw !== 'object') return null;
  const f7raw = raw.family7 && typeof raw.family7 === 'object' ? raw.family7 : {};
  const family7: Record<string, string> = {};
  for (const q of FAMILY_7Q) { const v = S(f7raw[q], 60); if (v) family7[q] = v; }
  const family = S(raw.family, 200), occupation = S(raw.occupation, 300), recreation = S(raw.recreation, 200), moneyMotivation = S(raw.moneyMotivation, 200);
  if (!family && !occupation && !recreation && !moneyMotivation && !Object.keys(family7).length) return null;
  return { family, occupation, recreation, moneyMotivation, family7 };
}
// 合并 FORM：新抽到的非空字段覆盖、family7 逐键并入，不丢已填。
function mergeForm(cur: any, add: NonNullable<ReturnType<typeof buildForm>>): any {
  const c = cur && typeof cur === 'object' ? cur : {};
  return {
    family: add.family || c.family || '',
    occupation: add.occupation || c.occupation || '',
    recreation: add.recreation || c.recreation || '',
    moneyMotivation: add.moneyMotivation || c.moneyMotivation || '',
    family7: { ...(c.family7 || {}), ...add.family7 },
  };
}

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
  "account": {"name":"客户全称或简称","customerType":1或2或3或4,"region":"大区","kind":"explicit|inferred","confidence":0到1,"evidence":"原话片段"} 或 null,
  "opportunity": {"name":"商机名","pipelineStage":"七阶段之一","competitor":"主要友商","kind":"...","confidence":0到1,"evidence":"..."} 或 null,
  "persons": [{"name":"姓名","title":"职务","orgLevel":1到4,"suggestedRole":"A|D|U|R|C","suggestedSentiment":"star|plus|neutral|unknown|minus|x","kind":"explicit|inferred","confidence":0到1,"evidence":"原话","form":{"family7":{"籍贯":"","年纪":"","生日":"","毕业院校":"","配偶":"","子女":"","父母":""},"occupation":"职业经历/晋升序列","recreation":"爱好/志趣","moneyMotivation":"金钱观/核心动机/价值观","family":"家庭情况补充"}}],
  "relationships": [{"source":"人名","target":"人名","layer":"L1|L2|L3|L4","label":"关系描述","kind":"...","confidence":0到1,"evidence":"..."}],
  "burningIssues": [{"person":"姓名","description":"燃眉之急","category":"类别","kind":"...","confidence":0到1,"evidence":"原话"}],
  "ucvs": [{"person":"该价值针对谁的BI","biCategory":"对应BI的类别","description":"我方独特价值","competitorCannot":"竞品给不了什么","status":"建议|获认可|已解决","kind":"explicit|inferred","confidence":0到1,"evidence":"原话"}],
  "evidences": [{"person":"姓名","signalKey":"下方信号键之一","direction":1或-1或0,"evidence":"原话片段"}],
  "rawNote": "把整段口述原样保留作为拜访纪要"
}
- pipelineStage 只能取：线索/需求引导/方案认可/客户立项/招投标/合同谈判/合同双签。
- relationships 的 source/target 必须是 persons 里出现过的人名或上下文已知干系人；端点是隐含的第三方（如"竞争对手"）时标 inferred。
- ucvs 必须对应 burningIssues 中某人的 BI（同 person + biCategory）；销售没明说"我方能解决而对手给不了"就别造 UCV。
- persons 的 form：把销售提到的该人「家庭/事业/爱好/动机」FORM 情报填进去——子女/配偶/父母/籍贯/年纪/生日/毕业院校填 family7 对应键；爱好志趣（钓鱼、爬山等）填 recreation；职业经历/晋升填 occupation；金钱观/核心诉求填 moneyMotivation。只填销售明说的，没提的字段留空字符串，整个人都没提 FORM 就给 form:{}。这些是 G64111 C1（D 的 FORM 表）计分项，务必抽全。
- suggestedRole：销售对某人的角色判断要抽出来，哪怕是"可能是/应该是真正的拍板人/这个项目真正的 D"这类推测——给对应 A/D/U/R/C，evidence 保留原话，kind 标 inferred、confidence 给中低值；别因为"可能"就丢掉。
- 若给了【前文】，用它消解本次口述里的指代（"他""那位副总"等指向前文的人）；但只抽取【本次补充】里新增或变更的人/关系/事实，不要重复输出前文已处理过的。
- evidences：销售提到的【干系人行为信号】——某人帮我们/卡我们【做了什么行为事实】（帮忙、设卡、引荐、透露信息、表态、拖延等），选下列最贴切的信号键，找不到贴切的就不输出该条（宁缺勿滥）。direction 按该行为对我方 利好+1 / 不利-1 / 方向不明0。只记行为事实不记主观判断（"他人不错"不是信号；"他把评标办法草稿发给我们"是 provide_insider_info）。
  信号键：co_plan_budget共同策划预算 provide_insider_info提供内幕 co_draft_tender_docs共制招标文件 share_competitor_intel给竞对情报 referral_to_1k_or_4p引荐高层 help_control_schedule帮控进度 guide_next_steps指导下一步 set_favorable_requirements定有利条款 exclusive_recommendation排他推荐 set_favorable_procurement_form定有利采购形式 pricing_guidance指导报价 help_solve_ab_bi助解燃眉 proc_strategy_alignment密谋评标策略 proc_verbal_commitment招采口头承诺 intro_referral动用政治资本引荐 spec_alignment条款向我方收敛 attendance_upgrade出席级别提升 verbal_positive口头积极表态 reply_latency_up回复显著变慢 meeting_cancel会议取消降级 competitor_quote_request索要竞品对比 internal_blocker_hint透露内部反对 bi_identified摸清燃眉之急 ucv_acknowledged价值获认可 ucv_delivered价值已落地
- 没提到的部分填 null 或空数组 []。绝不编造。`;

// 信任字段故意接受 unknown：格式异常不让整次抽取崩溃，而由 hasExplicitTrustMetadata 失败关闭。
const TrustFieldsSchema = {
  kind: z.unknown().optional(),
  confidence: z.unknown().optional(),
  evidence: z.string().optional(),
};
const FormSchema = z.object({
  family7: z.object({
    籍贯: z.string().optional(), 年纪: z.string().optional(), 生日: z.string().optional(),
    毕业院校: z.string().optional(), 配偶: z.string().optional(), 子女: z.string().optional(), 父母: z.string().optional(),
  }).strict().optional(),
  family: z.string().optional(), occupation: z.string().optional(), recreation: z.string().optional(), moneyMotivation: z.string().optional(),
}).strict();
const ExtractedSchema = z.object({
  account: z.object({ name: z.string(), customerType: z.number().optional(), region: z.string().optional(), ...TrustFieldsSchema }).strict().nullable().optional(),
  opportunity: z.object({ name: z.string(), pipelineStage: z.string().optional(), competitor: z.string().optional(), ...TrustFieldsSchema }).strict().nullable().optional(),
  persons: z.array(z.object({
    name: z.string(), title: z.string().optional(), orgLevel: z.number().optional(), suggestedRole: z.string().optional(),
    suggestedSentiment: z.string().optional(), form: FormSchema.optional(), ...TrustFieldsSchema,
  }).strict()).nullable().optional(),
  relationships: z.array(z.object({ source: z.string(), target: z.string(), layer: z.string().optional(), label: z.string().optional(), ...TrustFieldsSchema }).strict()).nullable().optional(),
  burningIssues: z.array(z.object({ person: z.string(), description: z.string(), category: z.string().optional(), ...TrustFieldsSchema }).strict()).nullable().optional(),
  ucvs: z.array(z.object({ person: z.string(), biCategory: z.string().optional(), description: z.string(), competitorCannot: z.string().optional(), status: z.string().optional(), ...TrustFieldsSchema }).strict()).nullable().optional(),
  evidences: z.array(z.object({ person: z.string(), signalKey: z.string(), direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]), evidence: z.string().optional() }).strict()).nullable().optional(),
  rawNote: z.string().nullable().optional(),
}).strict();
type Extracted = z.infer<typeof ExtractedSchema>;

async function extractIntel(ai: { baseUrl: string; model: string; apiKey: string }, text: string, ctx: { accountName?: string; personNames: string[]; priorText?: string }): Promise<Extracted> {
  const prior = ctx.priorText ? `\n\n【本次拜访·前文（仅供理解"他/她/那位"等指代，请勿重复抽取前文已提到的人/关系）】\n${ctx.priorText}` : '';
  const user = `【已知上下文】当前客户：${ctx.accountName || '（无，可能需新建）'}；已有干系人：${ctx.personNames.join('、') || '无'}${prior}\n\n【本次补充口述】\n${text}`;
  // 8000 token：推理模型(MiniMax-M3 / DeepSeek-R1 等)会先输出 <think> 思考，token 给足才轮到 JSON
  const raw = await callLLM(ai, EXTRACT_SYSTEM, user, 8000);
  // 剥离推理模型的 <think>…</think> 与 markdown 代码块围栏，再提取 JSON（普通模型无 think，剥离无害）
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json|```/gi, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型未返回结构化结果');
  return ExtractedSchema.parse(JSON.parse(m[0]));
}

// 口述/录音转写溯源标签：一处切换 origin 字段值与日志文案，让录音转写与手动口述可区分溯源。
const SRC = {
  voice:     { origin: 'voice',     emoji: '🎙️', word: '口述',     topic: '口述录入', from: '纪要' },
  recording: { origin: 'recording', emoji: '🎧', word: '录音转写', topic: '拜访录音', from: '录音' },
} as const;

export interface IngestInput {
  text: string;
  accountId?: string;
  opportunityId?: string;
  personId?: string;
  priorText?: string;
  sourceVisitId?: string;
  source?: keyof typeof SRC; // 'voice'(默认·手动口述) | 'recording'(录音转写)
}
export type IngestResult = { ok: true; receipt: any } | { ok: false; status: number; body: any };
export type PreparedVoiceIngest = { extracted?: unknown; failure?: Extract<IngestResult, { ok: false }> };

export class IngestCommandError extends Error {
  constructor(readonly result: Extract<IngestResult, { ok: false }>) {
    super(result.body?.error || '情报录入失败');
    this.name = 'IngestCommandError';
  }
}

/** Validate explicit capture ownership without disclosing whether a referenced ID exists elsewhere. */
export async function requireVoiceCaptureContext(
  ctx: CommandContext,
  input: IngestInput,
  db: DbClient = prisma,
): Promise<void> {
  if (!input.accountId) {
    if (input.opportunityId || input.personId) throw new ScopedNotFoundError();
    return;
  }
  await requireAccount(db, ctx.tenantId, input.accountId);
  if (input.opportunityId) {
    await requireOpportunity(db, ctx.tenantId, input.accountId, input.opportunityId);
  }
  if (input.personId) {
    await requirePerson(db, ctx.tenantId, input.accountId, input.personId);
  }
}

/** 模型网络调用在事务外完成；事务内只重读作用域并持久化已验证的结构化结果。 */
export async function prepareVoiceIngest(baseCtx: CommandContext, input: IngestInput, db: DbClient = prisma): Promise<PreparedVoiceIngest> {
  const acc = input.accountId
    ? await db.account.findFirst({ where: { id: input.accountId, tenantId: baseCtx.tenantId }, include: { persons: { where: activePersonWhere } } })
    : null;
  const ai = await loadAiConfig(baseCtx.tenantId, db);
  if (!ai || ai.provider === 'mock' || !ai.baseUrl || !ai.model) return {};
  try {
    const extracted = await extractIntel(
      { baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey },
      input.text.slice(0, 8000),
      {
        accountName: acc?.name,
        personNames: (acc?.persons ?? []).map((person) => person.name),
        priorText: (input.priorText ?? '').slice(0, 8000),
      },
    );
    return { extracted };
  } catch (error: any) {
    return { failure: { ok: false, status: 400, body: { error: '情报抽取失败：' + (error?.message || '模型返回异常') } } };
  }
}

/**
 * 文字情报抽取 + 双轨落库（手动口述 / 录音转写共用核心）。转写文字与口述文字同构，复用同一抽取链路。
 * 不碰 reply：返回 {ok:true,receipt}=正常；{ok:false,status,body}=路由应返回的错误码——供 recording.ts 复用。
 * source 切换溯源：voice=🎙️口述 / recording=🎧录音转写（origin 字段、日志前缀、拜访纪要 topic 一处统一）。
 */
export async function ingestVoiceText(
  baseCtx: CommandContext,
  input: IngestInput,
  db: DbClient = prisma,
  testOptions?: { extracted?: unknown; failAfterWrite?: number },
): Promise<IngestResult> {
  const { tenantId, actorId: userId } = baseCtx;
  const source = input.source ?? 'voice';
  const src = SRC[source];
  const structuredCtxFor = (item: unknown): CommandContext =>
    deriveIngestCommandContext(baseCtx, { kind: 'structured', source, item });
  const mayWriteFormal = (item: unknown, entityKind: string): boolean =>
    isExplicit(item) && canWriteFormal(structuredCtxFor(item), entityKind);
  const rawCtx = deriveIngestCommandContext(baseCtx, { kind: 'raw' });
  const machineCtx = deriveIngestCommandContext(baseCtx, { kind: 'machine' });
  const text = input.text.slice(0, 8000);
  const priorText = (input.priorText ?? '').slice(0, 8000); // 多轮增量：上一轮口述，供 LLM 指代消解
  // 从「已存在的拜访纪要」抽取(M1 焊接缝)：源本身就是一条纪要，跳过末尾的纪要存档，避免重复落库
  const skipVisitNote = Boolean(input.sourceVisitId);
  let writeStep = 0;
  const applyIngestAction = async (ctx: CommandContext, action: unknown, client: DbClient): Promise<void> => {
    await applyIngestActionWithDb(ctx, action, client);
    writeStep += 1;
    if (testOptions?.failAfterWrite === writeStep) throw new Error(`injected voice failure after write ${writeStep}`);
  };

  // 上下文：当前客户（含 persons 用于去重、opportunities 用于定位）
  let acc = input.accountId
    ? await db.account.findFirst({ where: { id: input.accountId, tenantId }, include: { persons: { where: activePersonWhere }, opportunities: true } })
    : null;

  const today = businessYmd();

  let ex: Extracted;
  if (testOptions?.extracted !== undefined) {
    ex = ExtractedSchema.parse(testOptions.extracted);
  } else {
    const ai = await loadAiConfig(tenantId, db);

    // 无可用模型 → 退化：仅把原文存为拜访纪要（无 key 也有基本价值，引导配模型）
    if (!ai || ai.provider === 'mock' || !ai.baseUrl || !ai.model) {
      // 从已有纪要抽取(skipVisitNote)：源就是纪要本身，无模型时无可抽取、也绝不再复制一条纪要
      if (skipVisitNote) return { ok: true, receipt: { needConfig: true, account: acc ? { id: acc.id, name: acc.name, status: 'matched' } : null, visitNote: false, note: `未配置 AI 模型，无法从这条${src.from}抽取结构化情报。请先在「🧠 AI 模型」里配置模型。` } };
      if (acc) {
        const oppId = input.opportunityId && acc.opportunities.some((o) => o.id === input.opportunityId) ? input.opportunityId : null;
        const vid = 'visit_' + randomUUID().replaceAll('-', '');
        await applyIngestAction(rawCtx, { type: 'ADD_VISIT', accId: acc.id, visit: { id: vid, opportunityId: oppId ?? undefined, date: today, topic: src.topic, summary: text, origin: src.origin } }, db);
        return { ok: true, receipt: { needConfig: true, account: { id: acc.id, name: acc.name, status: 'matched' }, visitNote: true, note: `未配置 AI 模型，已先把${src.word}存为拜访纪要。配置模型后即可自动抽取客户/商机/干系人/关系。` } };
      }
      return { ok: false, status: 400, body: { error: '请先在「AI 模型」配置模型，才能自动抽取情报', needConfig: true } };
    }

    try { ex = await extractIntel({ baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }, text, { accountName: acc?.name, personNames: (acc?.persons ?? []).map((x) => x.name), priorText }); }
    catch (e: any) { return { ok: false, status: 400, body: { error: '情报抽取失败：' + (e?.message || '模型返回异常') } }; }
  }

  const receipt: any = { account: null, opportunity: null, personsCreated: [], personsReused: [], rolesSet: [], edgesCreated: [], burningIssues: [], ucvs: [], dupWarnings: [], candidates: { persons: [], relationships: [] }, notes: [], visitNote: false, skipped: [] };

  // ── 1) 客户（业务实体，明说直落；命中现有则补字段）──
  if (ex.account && S(ex.account.name)) {
    const name = S(ex.account.name, 100);
    if (!acc) acc = await db.account.findFirst({ where: { tenantId, name }, include: { persons: { where: activePersonWhere }, opportunities: true } });
    if (acc) {
      if (isExplicit(ex.account) && S(ex.account.region)) await applyIngestAction(structuredCtxFor(ex.account), { type: 'UPDATE_ACCOUNT', accId: acc.id, patch: { region: S(ex.account.region, 40) } }, db);
      receipt.account = { id: acc.id, name: acc.name, status: 'matched' };
    } else {
      // 即将新建客户 → 先查 tenant 内相似名（命中则回执提示疑似重复，不打断、仍新建）
      const others = await db.account.findMany({ where: { tenantId }, select: { name: true } });
      const sim = others.find((o) => isSimilarName(stripCompany(o.name), stripCompany(name)));
      const id = 'acc_' + randomUUID().replaceAll('-', '');
      const ct = [1, 2, 3].includes(N(ex.account.customerType) as number) ? (N(ex.account.customerType) as number) : 2;
      await applyIngestAction(structuredCtxFor(ex.account), { type: 'ADD_ACCOUNT', account: { id, name, customerType: ct, region: S(ex.account.region, 40) } }, db);
      acc = await db.account.findFirst({ where: { id, tenantId }, include: { persons: { where: activePersonWhere }, opportunities: true } });
      receipt.account = { id, name, status: 'created' };
      if (sim) receipt.dupWarnings.push({ kind: 'account', name, similarTo: sim.name });
      // 江湖自算：语音建客户后后台入队 enrich（企查查/AI 补充发现关键干系人 → 候选进收件箱人审）。
      // 与口述明说的干系人互补、按名去重；不阻塞回执、失败不影响建客户。
      // 后台任务须等事务提交后再入队；路由根据 receipt 统一触发。
    }
  }
  if (!acc) return { ok: true, receipt: { ...receipt, note: '未能确定客户：请在某个客户/商机里录入，或在口述中说明客户名称。', raw: S(ex.rawNote, 4000) || text } };

  // ── 2) 商机（明说直落；命中现有则关联）──
  let opp = input.opportunityId ? acc.opportunities.find((o) => o.id === input.opportunityId) ?? null : null;
  if (!opp && ex.opportunity && S(ex.opportunity.name)) {
    const oname = S(ex.opportunity.name, 100);
    opp = acc.opportunities.find((o) => o.name === oname) ?? null;
    if (!opp) {
      const simOpp = acc.opportunities.find((o) => isSimilarName(o.name, oname)); // 同客户内相似商机名
      const id = 'opp_' + randomUUID().replaceAll('-', '');
      const stage = PIPELINE.includes(S(ex.opportunity.pipelineStage)) ? S(ex.opportunity.pipelineStage) : '线索';
      await applyIngestAction(structuredCtxFor(ex.opportunity), { type: 'ADD_OPP', accId: acc.id, opp: { id, name: oname, customerType: acc.customerType, pipelineStage: stage, engageStage: '需求调研立项', competitor: S(ex.opportunity.competitor, 200) } }, db);
      opp = { id, name: oname } as any;
      receipt.opportunity = { id, name: oname, status: 'created' };
      if (simOpp) receipt.dupWarnings.push({ kind: 'opportunity', name: oname, similarTo: simOpp.name });
      // 江湖自算：语音建商机后后台入队关系推断（worker 数秒后跑，届时本次口述的人/边已落库，图已完整）。
      // 关系推断同样由路由在事务提交后触发。
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
    // 已有角色的 role/sentiment 变化统一进 ChangeProposal；首次设角色才直写。
    if (isExisting) {
      const cur = await db.oppRole.findUnique({ where: { tenantId_opportunityId_personId: { tenantId, opportunityId: opp.id, personId } } });
      if (cur) {
        const changes = [
          ['role', cur.role, S(per.suggestedRole)],
          ...(newSent !== 'unknown' ? [['sentiment', cur.sentiment, newSent] as const] : []),
        ] as const;
        for (const [field, oldValue, newValue] of changes) {
          if (oldValue === newValue) continue;
          await createFieldProposal(tenantId, { accountId: acc!.id, opportunityId: opp.id, entityKind: 'oppRole', entityId: personId, field, oldValue, newValue, origin: src.origin, evidence: `${src.word}推断：${name} 的 ${field} 疑似变化`, confidence: N(per.confidence) ?? 0.5, proposedBy: userId }, db);
          receipt.proposals = (receipt.proposals ?? 0) + 1;
        }
        return;
      }
    }
    await applyIngestAction(structuredCtxFor(per), { type: 'SET_ROLE', accId: acc!.id, oppId: opp.id, personId, patch: { role: S(per.suggestedRole), sentiment: newSent, confidence: '推理' } }, db);
    receipt.rolesSet.push({ name, role: S(per.suggestedRole) });
  };

  for (const per of ex.persons ?? []) {
    const name = S(per.name, 40);
    if (!name) continue;
    const existingId = formalId.get(name);
    if (existingId) { // 已存在正式干系人 → 复用（销售自己说的，默认同一人）
      receipt.personsReused.push({ id: existingId, name });
      if (mayWriteFormal(per, 'person')) {
        await setRoleIf(existingId, per, name, true); // 已有干系人：支持度变化走提案而非直写
        const nf = buildForm(per.form); // 抽到 FORM 情报 → 合并补充到已有 form（非空覆盖，不丢已填）
        if (nf) {
          const exist = acc.persons.find((pp) => pp.id === existingId);
          let curForm: any = {}; try { curForm = JSON.parse((exist as any)?.form || '{}'); } catch { /* 容错 */ }
          await applyIngestAction(structuredCtxFor(per), { type: 'UPDATE_PERSON', accId: acc.id, personId: existingId, patch: { form: mergeForm(curForm, nf) } }, db);
          receipt.formsFilled = (receipt.formsFilled ?? 0) + 1;
        }
      } else if (isExplicit(per)) {
        await setRoleIf(existingId, per, name, true);
        const nf = buildForm(per.form);
        if (nf) {
          const exist = acc.persons.find((pp) => pp.id === existingId);
          let curForm: any = {}; try { curForm = JSON.parse((exist as any)?.form || '{}'); } catch { /* 容错 */ }
          await createFieldProposal(tenantId, {
            accountId: acc.id, opportunityId: opp?.id, entityKind: 'person', entityId: existingId, field: 'form',
            oldValue: JSON.stringify(curForm), newValue: JSON.stringify(mergeForm(curForm, nf)), origin: src.origin,
            evidence: `${src.word}抽取到 ${name} 的 FORM 信息`, confidence: N(per.confidence) ?? 0.5, proposedBy: userId,
          }, db);
          receipt.proposals = (receipt.proposals ?? 0) + 1;
        }
      }
      continue;
    }
    if (mayWriteFormal(per, 'person')) { // 仅认证 Web 人工明说可直落正式 Person
      // 同客户内相似名（如「李处」≈「李处长」，含本次已建）→ 回执提示疑似重复，不打断、仍新建
      const simName = [...formalId.keys()].find((k) => isSimilarName(k, name));
      const pid = 'p_' + randomUUID().replaceAll('-', '');
      const { x, y } = nextFreeSlot(occupied); occupied.push({ x, y });
      const logs = [{ date: today, content: `${src.emoji} ${src.word}：${S(per.evidence, 80) || name}`, visibility: 'team' }];
      const form = buildForm(per.form); // 家庭七问/职业/爱好/动机随抽随落
      await applyIngestAction(structuredCtxFor(per), { type: 'ADD_PERSON', accId: acc.id, person: { id: pid, name, title: S(per.title, 60), orgLevel: clampLevel(per.orgLevel), x, y, logs, ...(form ? { form } : {}) } }, db);
      if (form) receipt.formsFilled = (receipt.formsFilled ?? 0) + 1;
      formalId.set(name, pid);
      if (opp?.memberScoped) await applyIngestAction(structuredCtxFor(per), { type: 'ADD_OPP_MEMBER', accId: acc.id, oppId: opp.id, personId: pid }, db); // memberScoped 商机 → 新人加入成员
      receipt.personsCreated.push({ id: pid, name, title: S(per.title, 60) });
      if (simName) receipt.dupWarnings.push({ kind: 'person', name, similarTo: simName });
      await setRoleIf(pid, per, name);
    } else { // AI 补充 → 候选 PersonSuggestion
      const sid = 'ps_' + randomUUID().replaceAll('-', '');
      await db.personSuggestion.create({ data: { id: sid, tenantId, accountId: acc.id, opportunityId: opp?.id ?? null, name, title: S(per.title, 60), orgLevel: clampLevel(per.orgLevel), origin: src.origin, evidence: S(per.evidence, 500), confidence: N(per.confidence) ?? 0.5, status: 'pending', proposedBy: userId, suggestedRole: VALID_ROLE.includes(S(per.suggestedRole)) ? S(per.suggestedRole) : null, suggestedSentiment: VALID_SENT.includes(S(per.suggestedSentiment)) ? S(per.suggestedSentiment) : null } });
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
        const personId = formalId.get(knownName)!;
        const log = { date: today, content: `${src.emoji} ${src.word}线索·待核实：${clue}`, visibility: 'team' as const };
        if (mayWriteFormal(rel, 'person')) {
          await applyIngestAction(structuredCtxFor(rel), { type: 'ADD_LOG', accId: acc.id, personId, log }, db);
        } else {
          const exist = acc.persons.find((pp) => pp.id === personId);
          await createFieldProposal(tenantId, {
            accountId: acc.id, opportunityId: opp?.id, entityKind: 'personLog', entityId: personId, field: 'append',
            oldValue: '', newValue: JSON.stringify(log), origin: src.origin,
            evidence: `${src.word}抽取到 ${knownName} 的关系线索`, confidence: N(rel.confidence) ?? 0.5, proposedBy: userId,
          }, db);
          receipt.proposals = (receipt.proposals ?? 0) + 1;
        }
        receipt.notes.push({ person: knownName, content: clue });
      } else {
        receipt.skipped.push({ rel: `${sName}→${tName}`, reason: '端点未识别' });
      }
      continue;
    }
    const bothFormal = sEnd.kind === 'person' && tEnd.kind === 'person';
    if (bothFormal && mayWriteFormal(rel, 'edge')) { // 仅认证 Web 人工明说 + 两端正式 → 直落正式 Edge
      const eid = 'e_' + randomUUID().replaceAll('-', '');
      await applyIngestAction(structuredCtxFor(rel), { type: 'ADD_EDGE', accId: acc.id, oppId: opp?.id, edge: { id: eid, source: sEnd.id, target: tEnd.id, layer, label, origin: src.origin, style: 'solid', directed: false } }, db);
      receipt.edgesCreated.push({ source: sName, target: tName, label });
    } else { // 含候选端点 / inferred 关系 → 候选（须有商机，RelSuggestion 挂 opportunityId）
      if (!opp) { receipt.skipped.push({ rel: `${sName}→${tName}`, reason: '无商机上下文，候选关系跳过' }); continue; }
      const rid = 'rs_' + randomUUID().replaceAll('-', '');
      await db.relSuggestion.create({ data: { id: rid, tenantId, opportunityId: opp.id, sourcePersonId: sEnd.id, sourceKind: sEnd.kind, targetPersonId: tEnd.id, targetKind: tEnd.kind, layer, label, confidence: N(rel.confidence) ?? 0.5, origin: src.origin, evidence: S(rel.evidence, 500), status: 'pending' } });
      receipt.candidates.relationships.push({ source: sName, target: tName, label });
    }
  }

  // ── 5) 燃眉之急 BI（explicit，挂正式 Person + 商机）──
  const bisByPerson = new Map<string, { biId: string; category: string }[]>(); // person → 本次建的 BI（供 UCV 挂靠）
  for (const bi of ex.burningIssues ?? []) {
    const personName = S(bi.person, 40);
    const pid = formalId.get(personName);
    if (pid && opp && mayWriteFormal(bi, 'bi') && S(bi.description)) {
      const bid = 'bi_' + randomUUID().replaceAll('-', '');
      const category = S(bi.category, 40) || '其他';
      await applyIngestAction(structuredCtxFor(bi), { type: 'ADD_BI', accId: acc.id, oppId: opp.id, bi: { id: bid, personId: pid, description: S(bi.description, 500), category, isPrivate: true, confidence: '推理' } }, db);
      const arr = bisByPerson.get(personName) ?? []; arr.push({ biId: bid, category }); bisByPerson.set(personName, arr);
      receipt.burningIssues.push({ person: personName, category });
    }
  }

  // ── 5.5) 独特价值 UCV（explicit，须挂到本次识别的 BI；供 G64111 C6 决胜计分）──
  for (const u of ex.ucvs ?? []) {
    const personName = S(u.person, 40);
    const desc = S(u.description, 500);
    if (!desc || !opp || !mayWriteFormal(u, 'ucv')) continue;
    const cands = bisByPerson.get(personName) ?? [];
    // 该人本次只一条 BI → 直接挂；多条 → 按 biCategory 匹配，匹配不到挂第一条；无 BI → 跳过（UCV 必依附 BI）
    const targetBiId = cands.length === 1 ? cands[0].biId
      : cands.length > 1 ? (cands.find((c) => c.category === (S(u.biCategory, 40) || '其他')) ?? cands[0]).biId
      : null;
    if (!targetBiId) { receipt.skipped.push({ ucv: desc.slice(0, 24), reason: 'UCV 未匹配到对应 BI（需先明说该人的燃眉之急）' }); continue; }
    const status = VALID_UCV_STATUS.includes(S(u.status)) ? S(u.status) : '建议';
    const uid = 'ucv_' + randomUUID().replaceAll('-', '');
    await applyIngestAction(structuredCtxFor(u), { type: 'ADD_UCV', accId: acc.id, oppId: opp.id, ucv: { id: uid, targetBiId, description: desc, competitorCannot: S(u.competitorCannot, 500), status } }, db);
    receipt.ucvs.push({ person: personName, status });
  }

  // ── 5.6) 行为信号证据（M3 审核流：机器抽取 → pending_review 待人审进收件箱，人批准才进 E2 燃料池，守铁律②）──
  if ((ex.evidences ?? []).length && opp) {
    const sigCatalog = new Map((await db.signalCatalog.findMany({ where: { tenantId } })).map((s) => [s.signalKey, s]));
    for (const evd of ex.evidences ?? []) {
      const pid = formalId.get(S(evd.person, 40));
      const sig = sigCatalog.get(S(evd.signalKey));
      if (!pid || !sig) continue; // 信号键不在库/人不是正式干系人 → 弃（宁缺勿滥，不造野信号）
      const dir = evd.direction === -1 || evd.direction === 1 || evd.direction === 0 ? evd.direction : sig.direction;
      const eid = 'ev_' + randomUUID().replaceAll('-', '');
      await applyIngestAction(machineCtx, { type: 'ADD_EVIDENCE', accId: acc.id, oppId: opp.id, evidence: {
        id: eid, personId: pid,
        signalKey: sig.signalKey, direction: dir, tier: sig.tier, // tier 以信号库固有档位为准，不信 LLM
        rawContent: S(evd.evidence, 500), occurredAt: today,
        status: 'pending_review', origin: src.origin,
      } }, db);
      receipt.evidences = (receipt.evidences ?? 0) + 1;
    }
  }

  // ── 6) 拜访纪要存档（原文 → VisitNote）。从已有纪要抽取(skipVisitNote)时跳过，避免重复 ──
  const rawNote = S(ex.rawNote, 5000) || text;
  if (rawNote && !skipVisitNote) {
    const vid = 'visit_' + randomUUID().replaceAll('-', '');
    await applyIngestAction(rawCtx, { type: 'ADD_VISIT', accId: acc.id, visit: { id: vid, opportunityId: opp?.id, date: today, topic: src.topic, summary: rawNote, origin: src.origin } }, db);
    receipt.visitNote = true;
  }

  // 派生任务与业务落库同事务入队，避免命令完成后进程崩溃造成永久漏任务。
  if (receipt?.account?.status === 'created') {
    try { await enqueueEnrichJob(tenantId, receipt.account.id, 'auto', db); } catch { /* 超上限时保留主要录入结果 */ }
    try { await enqueueProfileJob(tenantId, receipt.account.id, db); } catch { /* 同上 */ }
  }
  if (receipt?.opportunity?.status === 'created' && receipt?.account?.id) {
    try { await enqueueSuggestJob(tenantId, receipt.account.id, receipt.opportunity.id, db); } catch { /* 同上 */ }
  }
  return { ok: true, receipt };
}

export async function executePreparedVoiceIngest(
  ctx: CommandContext,
  input: IngestInput,
  db: DbClient,
  prepared: PreparedVoiceIngest,
): Promise<Extract<IngestResult, { ok: true }>> {
  if (prepared.failure) throw new IngestCommandError(prepared.failure);
  const result = await ingestVoiceText(ctx, input, db, prepared.extracted === undefined ? undefined : { extracted: prepared.extracted });
  if (!result.ok) throw new IngestCommandError(result);
  return result;
}

export function voiceRoutes(app: FastifyInstance) {
  // 手动口述录入（Typeless 转文字）→ 抽取落库。录音转写走 recording.ts，复用同一 ingestVoiceText。
  app.post('/api/voice/extract', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可拍板/操作
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) return reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    const p = z.object({ text: z.string().min(1), accountId: z.string().optional(), opportunityId: z.string().optional(), personId: z.string().optional(), priorText: z.string().optional(), sourceVisitId: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入要录入的文字' });
    const ctx: CommandContext = {
      tenantId: req.user.tenantId,
      actorId: req.user.userId,
      actorRole: ActorRoleSchema.parse(req.user.role),
      channel: 'web',
      requestId: req.id,
      assertionMode: 'user_asserted',
    };
    const commandInput = { kind: 'voice-ingest', idempotencyKey: key, payload: p.data } as const;
    let command: Awaited<ReturnType<typeof runCommand<Extract<IngestResult, { ok: true }>>>>;
    try {
      // Preflight before reservation/model access prevents invalid cross-tree context from leaving command side effects.
      await requireVoiceCaptureContext(ctx, p.data);
      const reservation = await reserveCommand<Extract<IngestResult, { ok: true }>>(ctx, commandInput);
      if (reservation.replayed) return { ...reservation.result.receipt, replayed: true };
      let prepared: PreparedVoiceIngest;
      try {
        prepared = await prepareVoiceIngest(ctx, p.data);
      } catch (error) {
        await failReservedCommand(ctx, commandInput, reservation.reservationToken, error);
        throw error;
      }
      command = await runCommand(ctx, {
        ...commandInput,
        reservationToken: reservation.reservationToken,
        discardReservationOnScopedError: true,
      }, async (tx) => {
        // Recheck inside the write transaction so a parent-tree change cannot race the preflight.
        await requireVoiceCaptureContext(ctx, p.data, tx);
        return executePreparedVoiceIngest(ctx, p.data, tx, prepared);
      });
    } catch (error) {
      if (error instanceof ScopedNotFoundError || (error as any)?.scopedNotFound === true) {
        return reply.code(404).send({ error: '资源不存在' });
      }
      if (error instanceof IngestCommandError) return reply.code(error.result.status).send(error.result.body);
      throw error;
    }
    const r = command.result;
    return { ...r.receipt, replayed: command.replayed };
  });
}
