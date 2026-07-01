// 策略沙盘 · AI 顺推/倒推（P2）。复用 callLLM + loadAiConfig，mock 兜底。
// 只返回候选数据，绝不写库——前端本地暂存，人审采纳后才 dispatch 落库（守硬规则②）。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { loadAiConfig, callLLM } from './ai.js';

// G64111 分项标签/满分（后端自持小映射，不依赖前端 lib；同 docs/G64111-评分规格.md）
const ITEM_LABEL: Record<string, string> = {
  C1: 'C1 组织图+D的FORM', C2: 'C2 拍板人BI', C3: 'C3 立项材料+排序', C4: 'C4 介入阶段',
  C5: 'C5 招采事项', C6: 'C6 UCV解决度', P1: 'P1 多数人支持', P2: 'P2 招采关键人',
  P3: 'P3 与D密谋/支持', P4: 'P4 关键影响人', '1K': '1K 与A密谋/支持',
};
const ITEM_MAX: Record<string, number> = { C1: 10, C2: 5, C3: 5, C4: 5, C5: 5, C6: 5, P1: 5, P2: 10, P3: 20, P4: 10, '1K': 20 };

interface StrategyCand { gapItem: string; title: string; basis: string; }
interface MilestoneCand { title: string; offsetDays: number; }

// ── 顺推 mock：从缺口生成补分打法（无 Key 兜底，用真实 items 数据）──
const FWD_TMPL: Record<string, string> = {
  P3: '约拍板人 D 单独深谈，摸清 BI 与政绩诉求，争取"密谋级"支持',
  '1K': '通过 D 引荐触达批准人 A，用可上报的降本/样板数据换 A 背书',
  P2: '锁定招采关键人（采购/代理/甲方代表），至少做到口头承诺',
  P4: '识别并争取关键影响人，把态度从中立推到明确支持',
  P1: '盘点多数干系人态度，把摇摆者逐个转为明确支持',
  C2: '挖出拍板人的燃眉之急 BI 并记录到"明确"级',
  C6: '针对 BI 提炼独特价值 UCV 并争取客户认可',
  C5: '补齐招采五事项（家数/参数/规则/甲方代表/代理）',
  C3: '补齐立项七项材料并确认项目排序',
  C1: '补全组织图与 D 的 FORM 家庭七问',
  C4: '推动尽早介入（需求调研立项阶段最主动）',
};
function mockForward(ctx: any): StrategyCand[] {
  const items = ctx?.winTendency?.items || {};
  return Object.keys(ITEM_MAX)
    .filter((k) => typeof items[k] === 'number' && items[k] < ITEM_MAX[k])
    .sort((a, b) => (ITEM_MAX[b] - items[b]) - (ITEM_MAX[a] - items[a]))
    .slice(0, 4)
    .map((k) => ({ gapItem: k, title: FWD_TMPL[k] || `补强 ${ITEM_LABEL[k]}`, basis: `当前 ${ITEM_LABEL[k]} = ${items[k]}/${ITEM_MAX[k]}，是趋赢力短板` }));
}

// ── 倒推 mock：从终局倒排标准里程碑序列 ──
function mockBackward(_ctx: any): MilestoneCand[] {
  const base = ['需求调研立项', '方案可研获认可', '预算批复', '招标挂网', '开标评标', '商务谈判', '合同双签'];
  return base.map((t, i) => ({ title: t, offsetDays: (i + 1) * 14 }));
}

const grabJsonArray = (text: string): any[] => {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch { return []; }
};

async function llmForward(cfg: any, ctx: any): Promise<StrategyCand[]> {
  const system = '你是 B2B 大客户销售策略顾问，精通 G64111 趋赢力方法论（6必清 C1-C6 / 4优势 P1-P4 / 1决胜 1K）。基于商机现状（含各分项得分、干系人格局、局势），为"补强趋赢力短板"生成 3-5 条可执行的策略打法，每条挂靠一个 G64111 低分项。只输出 JSON 数组，每项 {gapItem,title,basis}；gapItem 取 C1..C6|P1..P4|1K 之一；title 是具体打法(≤30字)；basis 是依据(≤50字)；不要输出 JSON 以外内容。';
  const text = await callLLM(cfg, system, `# 商机现状快照\n${JSON.stringify(ctx, null, 1)}`, 800);
  return grabJsonArray(text).slice(0, 5)
    .map((r) => ({ gapItem: ITEM_LABEL[r?.gapItem] ? String(r.gapItem) : '', title: String(r?.title || '').slice(0, 40), basis: String(r?.basis || '').slice(0, 80) }))
    .filter((c) => c.title);
}

async function llmBackward(cfg: any, ctx: any): Promise<MilestoneCand[]> {
  const system = '你是 B2B 大客户销售策略顾问。基于商机的终局目标(singleSalesGoal)与预计签约日(expectedSignDate)，从终局倒排出 4-7 个关键里程碑（如立项评审/方案认可/预算批复/招标挂网/开标/商务谈判/签约）。只输出 JSON 数组，每项 {title,offsetDays}；title 是里程碑名(≤20字)；offsetDays 是距今天的天数(正整数，越靠后越大)；不要输出 JSON 以外内容。';
  const text = await callLLM(cfg, system, `# 商机快照\n${JSON.stringify(ctx, null, 1)}`, 600);
  return grabJsonArray(text).slice(0, 7)
    .map((r) => ({ title: String(r?.title || '').slice(0, 30), offsetDays: Math.max(1, Math.round(Number(r?.offsetDays)) || 14) }))
    .filter((c) => c.title);
}

// ── 参谋出牌（P2④b）：针对右栏焦点人产「行动牌候选」（六要素之 目的/资源/注意）。只返回候选，人审采纳才落 PlanAction（守硬规则②）。──
interface ActionCand { title: string; purpose: string; resources: string; cautions: string; }

// mock 兜底：按 竞品/态度/角色/BI 用真实格局产 2-3 张针对该人的行动牌。
function mockActions(ctx: any, focus: { name: string; title?: string }): ActionCand[] {
  const people: any[] = ctx?.people || [];
  const me = people.find((p) => p.name === focus.name) || {};
  const role: string = me.role || '';
  const sent: string = me.sentiment || '';
  const bis: any[] = (ctx?.bis || []).filter((b: any) => b.person === focus.name);
  const nm = focus.name;
  const out: ActionCand[] = [];

  // ① 主攻牌：按 竞品/态度 定调
  if (me.isCompetitor) {
    out.push({ title: `拆解「${nm}」的绑定关系`, purpose: '削弱竞品在关键人处的影响力，找到可撬动的松动点', resources: '内线教练情报、竞品短板对比材料', cautions: '用事实对比，不正面攻击竞品' });
  } else if (sent === 'x' || sent === 'minus') {
    out.push({ title: `借共同熟人重建与「${nm}」的信任`, purpose: '把倒戈/抗拒态度先拉回中立，止住失血', resources: '共同熟人引荐、一次非正式场合', cautions: '先修复关系、暂不谈单，避免逼反' });
  } else if (sent === 'star' || sent === 'plus') {
    out.push({ title: `把「${nm}」发展为教练`, purpose: '巩固支持，让他持续输送决策链情报', resources: '定期沟通节奏、可交换的人情/信息', cautions: '保护他不被暴露，别让他过度背书' });
  } else {
    out.push({ title: `深度拜访「${nm}」摸清真实诉求`, purpose: '补齐 FORM 与燃点 BI，找到价值切入口', resources: '行业洞察、同类样板案例', cautions: '多听少讲，先问出痛点再给方案' });
  }

  // ② 角色牌：按 A/D/U/R/C 补一张关键动作
  const ROLE_CARD: Record<string, ActionCand> = {
    D: { title: `约「${nm}」单独深谈争取密谋级支持`, purpose: '推动 P3（与 D 密谋），把拍板人变盟友', resources: '他的政绩诉求分析、可上报的成果口径', cautions: '给政绩不抢功，别越级触达其上级' },
    A: { title: `谋求由 D 引荐触达「${nm}」`, purpose: '推动 1K（与 A 密谋），拿到批准人背书', resources: '可对标上报的降本/样板数据', cautions: '走引荐不越级，避免让 D 觉得被架空' },
    R: { title: `用 POC 说服「${nm}」锁定选型`, purpose: '让技术把关人倾向我方参数（P2/P4）', resources: '定制 POC、技术方案对比表', cautions: '盯紧招采参数口径，防被设卡' },
    U: { title: `收集「${nm}」的使用痛点转化推力`, purpose: '把使用者痛点变成推动立项的需求证据', resources: '使用场景清单、痛点问卷', cautions: '使用者话语权有限，别高估其决策力' },
    C: { title: `请教练「${nm}」帮你摸清决策链`, purpose: '通过教练补全格局与 A/D 的真实关注点', resources: '一次深聊、可交换的信息', cautions: '交叉核实教练情报，避免被单方误导' },
  };
  if (role && ROLE_CARD[role] && out.length < 3) out.push(ROLE_CARD[role]);

  // ③ BI 牌：有明确燃点 → 补一张针对性方案
  if (bis.length && out.length < 3) {
    const b = bis[0];
    out.push({ title: `针对「${nm}」的${b.category || '燃点'}给方案`, purpose: `直击他的燃点：${String(b.description || '').slice(0, 24)}`, resources: '对应案例、可量化收益测算', cautions: '方案对齐他的 KPI，不泛泛而谈' });
  }

  return out.slice(0, 3);
}

async function llmActions(cfg: any, ctx: any, focus: { name: string; title?: string }, note: string): Promise<ActionCand[]> {
  const system = '你是 B2B 大客户销售策略顾问，精通 G64111 趋赢力方法论（6必清 C1-C6 / 4优势 P1-P4 / 1决胜 1K）。针对指定的「焦点干系人」，结合商机现状（趋赢力各分项、干系人格局、该人的角色/态度/BI 燃点），生成 2-3 张可立即执行的「行动牌」——每张是攻坚这个人的一个具体下一步。只输出 JSON 数组，每项 {title,purpose,resources,cautions}：title=行动名(动词开头,≤20字)；purpose=目的(为什么做/预期推动哪个分项,≤40字)；resources=所需资源(≤30字)；cautions=注意要点/避坑(≤30字)。不要输出 JSON 以外内容。';
  const user = `# 商机现状快照\n${JSON.stringify(ctx, null, 1)}\n\n# 焦点干系人\n${focus.name}（${focus.title || '职务未知'}）\n\n# 用户此刻的诉求（承接对话）\n${note || '给出攻坚这个人的下一步行动'}`;
  const text = await callLLM(cfg, system, user, 800);
  return grabJsonArray(text).slice(0, 3)
    .map((r) => ({ title: String(r?.title || '').slice(0, 30), purpose: String(r?.purpose || '').slice(0, 60), resources: String(r?.resources || '').slice(0, 50), cautions: String(r?.cautions || '').slice(0, 50) }))
    .filter((c) => c.title);
}

export function strategyRoutes(app: FastifyInstance) {
  app.post('/api/strategy/suggest', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({ opportunityId: z.string(), mode: z.enum(['forward', 'backward']), context: z.any() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const opp = await prisma.opportunity.findFirst({ where: { id: p.data.opportunityId, tenantId }, select: { id: true } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    const cfg = await loadAiConfig(tenantId);
    if (!cfg) return reply.code(400).send({ error: '请先在「AI 模型」里配置模型（或选择内置演示模式）', needConfig: true });

    const { mode, context } = p.data;
    const useMock = cfg.provider === 'mock' || !cfg.baseUrl || !cfg.model;
    try {
      const candidates = mode === 'forward'
        ? (useMock ? mockForward(context) : await llmForward(cfg, context))
        : (useMock ? mockBackward(context) : await llmBackward(cfg, context));
      return { mode, candidates, provider: useMock ? 'mock' : cfg.model };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || 'AI 推演失败，请检查模型配置' });
    }
  });

  // 参谋出牌（P2④b）：右栏焦点人 → AI 产行动牌候选。只返回候选，前端本地暂存、人审采纳才 dispatch ADD_PLAN_ACTION（守硬规则②）。
  app.post('/api/strategy/actions', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({
      opportunityId: z.string(),
      focus: z.object({ name: z.string().min(1), title: z.string().optional() }),
      context: z.any(),
      note: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const tenantId = req.user.tenantId;
    const opp = await prisma.opportunity.findFirst({ where: { id: p.data.opportunityId, tenantId }, select: { id: true } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    const cfg = await loadAiConfig(tenantId);
    if (!cfg) return reply.code(400).send({ error: '请先在「AI 模型」里配置模型（或选择内置演示模式）', needConfig: true });

    const { focus, context, note = '' } = p.data;
    const useMock = cfg.provider === 'mock' || !cfg.baseUrl || !cfg.model;
    try {
      const candidates = useMock ? mockActions(context, focus) : await llmActions(cfg, context, focus, note);
      return { candidates, provider: useMock ? 'mock' : cfg.model };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || 'AI 出牌失败，请检查模型配置' });
    }
  });
}
