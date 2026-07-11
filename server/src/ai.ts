import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';

// ── 加密（AES-256-GCM）：用用户自己的 Key，服务端只加密代管 ──
const SECRET = process.env.AI_KEY_SECRET || 'dev-ai-secret-change-in-production';
const KEY = crypto.createHash('sha256').update(SECRET).digest();
export function enc(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function dec(b64: string): string {
  if (!b64) return '';
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ── 提示词 ──
const SYSTEM_PROMPT = `你是资深 B2B 大客户销售策略顾问，精通「销售罗盘 / G64111」方法论。术语：
- 角色 A 批准人(经济决策/否决) · D 拍板人(本项目决策) · U 使用者 · R 影响者/技术选型/招采把关 · C 教练。竞争对手不是角色。
- 支持度：☆排他支持 / +明确支持 / =中立 / ?未知 / −负面 / x倒向对手。
- 趋赢力满分100 = 6必清(35)+4优势(45,P1多数人/P2招采关键人/P3与D密谋/P4关键影响人)+1决胜(1K与A)。P3/1K 可为负。
- 741竞争策略：≥75%绝对优势·可承诺 / 50-75%相对优势·可争取 / 25-50%相对劣势·可参与 / <25%绝对劣势·重新复盘。
请基于给定的真实商机快照，针对用户的「假设策略」给出务实、点名到人的分析。用简洁中文 Markdown，分这几节：
**① 局势判断** **② 对趋赢力的预测影响**(指出会动到哪些分项 P1/P2/P3/P4/1K 及大致方向) **③ 风险** **④ 下一步最佳行动**(具体、可执行) **⑤ 话术要点**。不超过 400 字。`;

function buildUserPrompt(ctx: any, hypothesis: string): string {
  return `# 当前商机快照\n${JSON.stringify(ctx, null, 2)}\n\n# 用户的假设策略\n${hypothesis}\n\n请按系统要求分析。`;
}

// ── 内置演示分析（无需 Key，用真实数据生成）──
function mockAnalysis(ctx: any, hypothesis: string): string {
  const wt = ctx?.winTendency || {};
  const people: any[] = ctx?.people || [];
  const find = (r: string) => people.filter((p) => p.role === r);
  const A = find('A')[0], D = find('D')[0];
  const ki = people.find((p) => p.isKeyInfluencer);
  const traitors = people.filter((p) => p.sentiment === 'x');
  const items = wt.items || {};
  const gaps = Object.entries(items)
    .filter(([k]) => ['P2', 'P3', 'P4', '1K', 'C2', 'C6'].includes(k))
    .filter(([, v]: any) => typeof v === 'number' && v <= 0)
    .map(([k]) => k);
  const sName = (p: any) => (p ? `${p.name}(${p.role}${p.sentiment === 'x' ? '·倒戈' : p.sentiment === 'star' ? '·☆' : ''})` : '未识别');

  return `> 🧪 内置演示分析（基于真实 G64111 数据生成，非外部大模型；配置你的模型后可获得更深入的推演）

**① 局势判断**
当前趋赢力 **${Math.round((wt.percent ?? 0) * 100)}%**（${wt.band || '—'}）。批准人 A＝${sName(A)}，拍板人 D＝${sName(D)}，关键影响人＝${ki ? ki.name : '未锁定'}。${traitors.length ? `⚠️ 已有 ${traitors.map((t) => t.name).join('、')} 倒向竞争对手。` : ''}

**② 对趋赢力的预测影响**
你的假设「${hypothesis}」——${D ? `若动作绕过 D(${D.name})，P3(与D密谋, 占20分) 很可能由正转负，是最大风险敞口；` : ''}${A ? `直接触达 A(${A.name}) 若处理得当可拉升 1K(决胜20分)，但越级易引发 D 反弹。` : ''}净效果取决于 A 是否会把你推回给 D。

**③ 风险**
- 越级触达 A 会让 D 觉得被架空 → P3 可能掉到 −10~−20。
- ${traitors.length ? `${traitors[0].name} 在招采环节(P2)配合竞品，需重点防守。` : '招采关键人(P2)覆盖不足，易被对手设卡。'}

**④ 下一步最佳行动**
- 先借 ${ki ? ki.name + '(教练)' : '内线教练'} 摸清 A 的真实关注点与 BI，再谋求"D 引荐上 A"而非绕过。
- 补齐缺口项：${gaps.length ? gaps.join('、') : 'P2 招采关键人'}。
- 用样板/降本数据帮 D 拿到向 A 汇报的"政绩"，把 D 变成你上 A 的桥。

**⑤ 话术要点**
对 D：「这套能帮您做出向集团/领导可对标上报的成果，汇报材料我来备。」——给政绩、不抢功，避免越级反噬。`;
}

/** 读取并解密某租户的 AI 配置（供推断引擎复用）。无配置返回 null。 */
export async function loadAiConfig(tenantId: string): Promise<{ provider: string; baseUrl: string; model: string; apiKey: string } | null> {
  const c = await prisma.aiConfig.findUnique({ where: { tenantId } });
  if (!c) return null;
  return { provider: c.provider, baseUrl: c.baseUrl, model: c.model, apiKey: dec(c.apiKeyEnc) };
}

export async function callLLM(cfg: { baseUrl: string; model: string; apiKey: string }, system: string, user: string, maxTokens = 900): Promise<string> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.4, max_tokens: maxTokens, stream: false }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `模型返回 HTTP ${res.status}`);
  return data?.choices?.[0]?.message?.content || '(模型无返回内容)';
}

export function aiRoutes(app: FastifyInstance) {
  const canManage = (req: any) => ['owner', 'admin'].includes(req.user.role);

  app.get('/api/ai/config', { preHandler: [app.authenticate] }, async (req) => {
    const c = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return { configured: false, provider: 'mock', baseUrl: '', model: '', hasKey: false };
    return { configured: c.provider === 'mock' || (!!c.baseUrl && !!c.model), provider: c.provider, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKeyEnc };
  });

  app.put('/api/ai/config', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置模型' });
    const p = z.object({
      provider: z.enum(['openai-compatible', 'mock']),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const { provider, baseUrl = '', model = '', apiKey } = p.data;

    const existing = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    // apiKey 为 undefined → 保留旧 key；为 '' → 清空；有值 → 加密更新
    const apiKeyEnc = apiKey === undefined ? (existing?.apiKeyEnc ?? '') : (apiKey ? enc(apiKey) : '');
    const data = { provider, baseUrl, model, apiKeyEnc };
    await prisma.aiConfig.upsert({ where: { tenantId: req.user.tenantId }, create: { tenantId: req.user.tenantId, ...data }, update: data });
    return { ok: true };
  });

  app.post('/api/ai/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const c = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return reply.code(400).send({ error: '尚未配置模型' });
    if (c.provider === 'mock') return { ok: true, message: '内置演示模式可用' };
    if (!c.baseUrl || !c.model) return reply.code(400).send({ error: '缺少 baseURL 或模型名' });
    try {
      const out = await callLLM({ baseUrl: c.baseUrl, model: c.model, apiKey: dec(c.apiKeyEnc) }, '你是连通性测试。', '回复两个字：可用', 16);
      return { ok: true, message: out.slice(0, 40) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '连接失败' });
    }
  });

  app.post('/api/ai/simulate', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const p = z.object({ context: z.any(), hypothesis: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入假设策略' });
    const c = await prisma.aiConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return reply.code(400).send({ error: '请先在「AI 模型」里配置模型（或选择内置演示模式）', needConfig: true });

    if (c.provider === 'mock') {
      return { analysis: mockAnalysis(p.data.context, p.data.hypothesis), provider: 'mock' };
    }
    if (!c.baseUrl || !c.model) return reply.code(400).send({ error: '模型配置不完整', needConfig: true });
    try {
      const analysis = await callLLM(
        { baseUrl: c.baseUrl, model: c.model, apiKey: dec(c.apiKeyEnc) },
        SYSTEM_PROMPT, buildUserPrompt(p.data.context, p.data.hypothesis),
      );
      return { analysis, provider: c.model };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '推演失败，请检查模型配置' });
    }
  });
}
