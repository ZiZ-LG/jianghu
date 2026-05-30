import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { enc, dec, loadAiConfig, callLLM } from './ai.js';

interface DiscoveredPerson { name: string; title: string; }

// ── 企查查 OpenAPI（best-effort）：标准签名 Token=md5(appKey+Timespan+secretKey) ──
async function qccFetch(cfg: { baseUrl: string; appKey: string; secretKey: string }, keyword: string): Promise<DiscoveredPerson[]> {
  const timespan = Math.floor(Date.now() / 1000).toString();
  const token = crypto.createHash('md5').update(cfg.appKey + timespan + cfg.secretKey).digest('hex').toUpperCase();
  // 企查查「企业主要人员」类接口（不同套餐 endpoint 可能不同，可按需调整）
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/ECIV4/GetMainStaff?key=${encodeURIComponent(cfg.appKey)}&keyword=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, { headers: { Token: token, Timespan: timespan } });
  const data: any = await res.json().catch(() => ({}));
  if (data?.Status && data.Status !== '200') throw new Error(data?.Message || `企查查返回 ${data.Status}`);
  // 防御式解析：在结果里找含 姓名/职务 的数组
  const result = data?.Result ?? data?.result ?? data;
  const arr: any[] = Array.isArray(result) ? result : (result?.Staffs || result?.Employees || result?.KeyPersonnel || []);
  const persons = (arr || [])
    .map((x: any) => ({ name: x?.Name || x?.name || '', title: x?.Job || x?.Position || x?.position || x?.title || '关键人员' }))
    .filter((p: DiscoveredPerson) => p.name);
  if (!persons.length) throw new Error('企查查响应未能解析出人员（套餐/接口可能不同）');
  return persons.slice(0, 12);
}

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

export function enrichRoutes(app: FastifyInstance) {
  const canManage = (req: any) => ['owner', 'admin'].includes(req.user.role);

  app.get('/api/qcc/config', { preHandler: [app.authenticate] }, async (req) => {
    const c = await prisma.qccConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    return { configured: !!(c?.appKey && c?.secretKeyEnc), baseUrl: c?.baseUrl || 'https://api.qichacha.com', appKey: c?.appKey || '', hasSecret: !!c?.secretKeyEnc };
  });

  app.put('/api/qcc/config', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置' });
    const p = z.object({ baseUrl: z.string().optional(), appKey: z.string().optional(), secretKey: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const existing = await prisma.qccConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    const secretKeyEnc = p.data.secretKey === undefined ? (existing?.secretKeyEnc ?? '') : (p.data.secretKey ? enc(p.data.secretKey) : '');
    const data = { baseUrl: p.data.baseUrl || existing?.baseUrl || 'https://api.qichacha.com', appKey: p.data.appKey ?? existing?.appKey ?? '', secretKeyEnc };
    await prisma.qccConfig.upsert({ where: { tenantId: req.user.tenantId }, create: { tenantId: req.user.tenantId, ...data }, update: data });
    return { ok: true };
  });

  app.post('/api/qcc/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    const c = await prisma.qccConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c?.appKey || !c?.secretKeyEnc) return reply.code(400).send({ error: '尚未配置企查查 Key' });
    try {
      const persons = await qccFetch({ baseUrl: c.baseUrl, appKey: c.appKey, secretKey: dec(c.secretKeyEnc) }, '华为技术有限公司');
      return { ok: true, message: `连通正常，示例返回 ${persons.length} 人` };
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '连接失败' }); }
  });

  // 自动建图：返回某公司的关键人（企查查 → AI 回退 → 演示），供前端预览后导入
  app.post('/api/enrich/company', { preHandler: [app.authenticate] }, async (req, reply) => {
    const p = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请输入公司名称' });
    const name = p.data.name.trim();
    const tenantId = req.user.tenantId;

    let persons: DiscoveredPerson[] = [];
    let source = '', note = '';

    const qcc = await prisma.qccConfig.findUnique({ where: { tenantId } });
    if (qcc?.appKey && qcc?.secretKeyEnc) {
      try { persons = await qccFetch({ baseUrl: qcc.baseUrl, appKey: qcc.appKey, secretKey: dec(qcc.secretKeyEnc) }, name); source = 'qcc'; }
      catch (e: any) { note = `企查查调用失败（${e.message}），已回退 AI 推测`; }
    }
    if (!persons.length) {
      const ai = await loadAiConfig(tenantId);
      if (ai && ai.provider !== 'mock' && ai.baseUrl && ai.model) { persons = await llmProfile(ai, name); source = 'ai'; note = note || 'AI 联想·质量有限，请后续核实'; }
      if (!persons.length) { persons = mockProfile(); source = 'mock'; note = note || (ai ? 'AI 未给出结果，已用角色清单兜底' : '未配置企查查 Key 与 AI 模型，先给 G64111 典型角色清单'); }
    }
    return { source, company: name, persons, note };
  });
}
