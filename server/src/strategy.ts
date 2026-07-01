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

// ── 参谋出牌（P2④b→扩展多类型）：针对右栏焦点人产「可落地候选」，混合三类——action 行动牌 / card 策略卡 / risk 风险登记。
// 只返回候选，人审采纳才 dispatch 落库（ADD_PLAN_ACTION / ADD_STRATEGY_CARD / ADD_STRATEGY_RISK，守硬规则②）。──
type AdvCand =
  | { kind: 'action'; title: string; purpose: string; resources: string; cautions: string }
  | { kind: 'card'; title: string; basis: string; gapItem?: string }
  | { kind: 'risk'; title: string; severity: 'low' | 'mid' | 'high' };

// mock 兜底：按 竞品/态度/角色 用真实格局产 行动牌 + 策略卡 + 风险 各一。
function mockAdvisorCands(ctx: any, focus: { name: string; title?: string }): AdvCand[] {
  const people: any[] = ctx?.people || [];
  const me = people.find((p) => p.name === focus.name) || {};
  const role: string = me.role || '';
  const sent: string = me.sentiment || '';
  const nm = focus.name;
  const out: AdvCand[] = [];

  // ① 行动牌：按 竞品/态度 定主攻下一步
  if (me.isCompetitor) {
    out.push({ kind: 'action', title: `拆解「${nm}」的绑定关系`, purpose: '削弱竞品在关键人处的影响力，找可撬动的松动点', resources: '内线教练情报、竞品短板对比材料', cautions: '用事实对比，不正面攻击竞品' });
  } else if (sent === 'x' || sent === 'minus') {
    out.push({ kind: 'action', title: `借共同熟人重建与「${nm}」的信任`, purpose: '把倒戈/抗拒态度先拉回中立，止住失血', resources: '共同熟人引荐、一次非正式场合', cautions: '先修复关系、暂不谈单，避免逼反' });
  } else if (sent === 'star' || sent === 'plus') {
    out.push({ kind: 'action', title: `把「${nm}」发展为教练`, purpose: '巩固支持，让他持续输送决策链情报', resources: '定期沟通节奏、可交换的人情/信息', cautions: '保护他不被暴露，别让他过度背书' });
  } else {
    out.push({ kind: 'action', title: `深度拜访「${nm}」摸清真实诉求`, purpose: '补齐 FORM 与燃点 BI，找到价值切入口', resources: '行业洞察、同类样板案例', cautions: '多听少讲，先问出痛点再给方案' });
  }

  // ② 策略卡：按 A/D/U/R/C 给打法方向 + 挂靠缺口
  const ROLE_CARD: Record<string, { title: string; basis: string; gap: string }> = {
    D: { title: `锁定「${nm}」的密谋级支持`, basis: '拍板人 P3（与 D 密谋）是决胜分项', gap: 'P3' },
    A: { title: `经 D 引荐拿下「${nm}」背书`, basis: '批准人 1K（与 A 密谋）占 20 分', gap: '1K' },
    R: { title: `用 POC 让「${nm}」倾向我方选型`, basis: '技术把关影响 P2 招采 / P4 关键影响', gap: 'P2' },
    U: { title: `把「${nm}」使用痛点转成需求推力`, basis: '使用者 UCV 驱动立项（C6）', gap: 'C6' },
    C: { title: `发挥教练「${nm}」补全格局`, basis: '教练助攻组织图 C1 / 多数人 P1', gap: 'C1' },
  };
  const rc = role ? ROLE_CARD[role] : undefined;
  out.push(rc ? { kind: 'card', title: rc.title, basis: rc.basis, gapItem: rc.gap }
              : { kind: 'card', title: `围绕「${nm}」立一张打法`, basis: '待挂靠 G64111 缺口项' });

  // ③ 风险登记：按 角色/态度 提示单点/失血风险
  if (role === 'D' || role === 'A') {
    out.push({ kind: 'risk', title: `决策链单点依赖「${nm}」，需物色并培养第二支持人`, severity: 'high' });
  } else if (sent === 'x' || sent === 'minus') {
    out.push({ kind: 'risk', title: `「${nm}」已失血，可能牵动周边人一起倒向对手`, severity: 'mid' });
  } else {
    out.push({ kind: 'risk', title: `「${nm}」态度未定，是本单的关键变量`, severity: 'mid' });
  }

  return out;
}

async function llmAdvisorCands(cfg: any, ctx: any, focus: { name: string; title?: string }, note: string): Promise<AdvCand[]> {
  const system = '你是 B2B 大客户销售策略顾问，精通 G64111 趋赢力方法论（6必清 C1-C6 / 4优势 P1-P4 / 1决胜 1K）。针对指定的「焦点干系人」，结合商机现状，生成 3-5 张可落地候选，混合三类：\n- kind="action" 行动牌（执行下一步）：字段 title/purpose/resources/cautions\n- kind="card" 策略卡（打法方向）：字段 title/basis/gapItem（gapItem 取 C1..C6|P1..P4|1K 之一，或省略）\n- kind="risk" 风险登记：字段 title/severity（low|mid|high）\n至少各出 1 张。只输出 JSON 数组，每项含 kind + 对应字段；title≤24字，purpose/basis≤40字，resources/cautions≤30字。不要输出 JSON 以外内容。';
  const user = `# 商机现状快照\n${JSON.stringify(ctx, null, 1)}\n\n# 焦点干系人\n${focus.name}（${focus.title || '职务未知'}）\n\n# 用户此刻的诉求（承接对话）\n${note || '给出攻坚这个人的下一步（行动 + 打法 + 风险）'}`;
  const text = await callLLM(cfg, system, user, 1000);
  const GAPS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', '1K'];
  const out: AdvCand[] = [];
  for (const r of grabJsonArray(text).slice(0, 6)) {
    const kind = r?.kind;
    if (kind === 'action' && r?.title) out.push({ kind, title: String(r.title).slice(0, 30), purpose: String(r.purpose || '').slice(0, 60), resources: String(r.resources || '').slice(0, 50), cautions: String(r.cautions || '').slice(0, 50) });
    else if (kind === 'card' && r?.title) out.push({ kind, title: String(r.title).slice(0, 40), basis: String(r.basis || '').slice(0, 60), gapItem: GAPS.includes(r.gapItem) ? String(r.gapItem) : undefined });
    else if (kind === 'risk' && (r?.title || r?.text)) out.push({ kind, title: String(r.title || r.text).slice(0, 60), severity: ['low', 'mid', 'high'].includes(r.severity) ? r.severity : 'mid' });
  }
  return out;
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
      const candidates = useMock ? mockAdvisorCands(context, focus) : await llmAdvisorCands(cfg, context, focus, note);
      return { candidates, provider: useMock ? 'mock' : cfg.model };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || 'AI 出牌失败，请检查模型配置' });
    }
  });
}
