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
}
