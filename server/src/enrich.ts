import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { enc, dec, loadAiConfig, callLLM } from './ai.js';
import { qccMcpFetch, qccMcpResolve, parseQccMcpConfig } from './qccMcp.js';

interface DiscoveredPerson { name: string; title: string; }

// ── AI 联想（无企查查 Key 时回退；用用户自配模型）──
async function llmProfile(ai: { baseUrl: string; model: string; apiKey: string }, name: string): Promise<DiscoveredPerson[]> {
  const sys = '你是企业情报助手。根据公司名，列出其「可能的关键人员」及职务（董事长/总经理/分管副总/信息化或数字化负责人/财务负责人/采购或招标负责人/项目或工程负责人等）。只输出 JSON 数组 [{name,title}]，最多 8 条；不确定的姓名写「(待核实)」。不要输出 JSON 以外内容。';
  let text = '';
  try { text = await callLLM(ai, sys, `公司：${name}`, 500); } catch { return []; }
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : []).map((x: any) => ({ name: String(x.name || '').slice(0, 20), title: String(x.title || '关键人员').slice(0, 30) })).filter((p) => p.name).slice(0, 8);
  } catch { return []; }
}

// ── 演示回退（无任何配置时）：给出 G64111 需补齐的典型角色清单 ──
function mockProfile(): DiscoveredPerson[] {
  return [
    { name: '(待补) 一把手', title: '董事长 / 总经理（A 批准人候选）' },
    { name: '(待补) 分管副总', title: '分管数字化/财务副总（A/D 候选）' },
    { name: '(待补) 信息化负责人', title: '信息化/数字化部负责人（D 拍板人候选）' },
    { name: '(待补) 财务负责人', title: '财务/审计（TB 候选）' },
    { name: '(待补) 采购负责人', title: '采购/招标管理（招采关键人）' },
    { name: '(待补) 业务负责人', title: '项目/工程/场站负责人（U 使用者候选）' },
  ];
}

// QccConfig 复用约定（避免改 schema）：appKey='mcp' 标记 MCP 模式；
//   baseUrl = company-stream 端点；secretKeyEnc = 加密后的 Bearer Token。
export function enrichRoutes(app: FastifyInstance) {
  const canManage = (req: any) => ['owner', 'admin'].includes(req.user.role);

  app.get('/api/qcc/config', { preHandler: [app.authenticate] }, async (req) => {
    const c = await prisma.qccConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    const configured = !!(c?.appKey === 'mcp' && c?.secretKeyEnc);
    return { configured, mode: 'mcp', endpoint: configured ? c!.baseUrl : '', hasToken: !!c?.secretKeyEnc };
  });

  // 配置：用户粘贴企查查 MCP 配置 JSON（agent.qcc.com/guide）
  app.put('/api/qcc/config', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置' });
    const p = z.object({ mcpJson: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请粘贴企查查 MCP 配置 JSON' });
    let cfg;
    try { cfg = parseQccMcpConfig(p.data.mcpJson); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || '配置解析失败' }); }
    const data = { baseUrl: cfg.url, appKey: 'mcp', secretKeyEnc: enc(cfg.token) };
    await prisma.qccConfig.upsert({ where: { tenantId: req.user.tenantId }, create: { tenantId: req.user.tenantId, ...data }, update: data });
    return { ok: true, endpoint: cfg.url };
  });

  app.delete('/api/qcc/config', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置' });
    await prisma.qccConfig.deleteMany({ where: { tenantId: req.user.tenantId } });
    return { ok: true };
  });

  app.post('/api/qcc/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    const c = await prisma.qccConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (c?.appKey !== 'mcp' || !c?.secretKeyEnc) return reply.code(400).send({ error: '尚未配置企查查 MCP' });
    try {
      const persons = await qccMcpFetch({ url: c.baseUrl, token: dec(c.secretKeyEnc) }, '华为技术有限公司');
      return { ok: true, message: `连通正常，示例公司返回 ${persons.length} 位关键人` };
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '连接失败' }); }
  });

  // 企业名锚定：输入简称/关键词 → 返回候选企业列表（用户人审选择，符合企查查"多候选不可自动锁定"规则）
  app.post('/api/qcc/resolve', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = z.object({ query: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入企业名称或关键词' });
    const c = await prisma.qccConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (c?.appKey !== 'mcp' || !c?.secretKeyEnc) return reply.code(400).send({ error: '尚未配置企查查 MCP' });
    try {
      const r = await qccMcpResolve({ url: c.baseUrl, token: dec(c.secretKeyEnc) }, p.data.query.trim());
      return r;
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '企业检索失败' }); }
  });

  // 自动建图：返回某公司的关键人（企查查 MCP → AI 回退 → 演示），供前端预览后导入
  app.post('/api/enrich/company', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入公司名称' });
    const name = p.data.name.trim();
    const tenantId = req.user.tenantId;

    let persons: DiscoveredPerson[] = [];
    let source = '', note = '';

    const qcc = await prisma.qccConfig.findUnique({ where: { tenantId } });
    if (qcc?.appKey === 'mcp' && qcc?.secretKeyEnc) {
      try { persons = await qccMcpFetch({ url: qcc.baseUrl, token: dec(qcc.secretKeyEnc) }, name); source = 'qcc'; }
      catch (e: any) { note = `企查查 MCP 调用失败（${e.message}），已回退 AI 推测`; }
    }
    if (!persons.length) {
      const ai = await loadAiConfig(tenantId);
      if (ai && ai.provider !== 'mock' && ai.baseUrl && ai.model) { persons = await llmProfile(ai, name); source = 'ai'; note = note || 'AI 联想·质量有限，请后续核实'; }
      if (!persons.length) { persons = mockProfile(); source = 'mock'; note = note || (ai ? 'AI 未给出结果，已用角色清单兜底' : '未配置企查查 MCP 与 AI 模型，先给 G64111 典型角色清单'); }
    }
    return { source, company: name, persons, note };
  });
}
