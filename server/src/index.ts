import './types.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { authRoutes } from './auth.js';
import { assembleState } from './state.js';
import { applyAction } from './mutate.js';
import { createDemoForTenant } from './seed-demo.js';
import { aiRoutes } from './ai.js';
import { suggestRoutes } from './suggest.js';
import { strategyRoutes } from './strategy.js';
import { enrichRoutes } from './enrich.js';
import { voiceRoutes } from './voice.js';
import { opportunityRoutes } from './opp.js';
import { handleMcpBody } from './mcpServer.js';
import { accessTokenRoutes, mcpAuthenticate } from './accessToken.js';

// 加载本地 .env（生产环境用真实环境变量，文件不存在则忽略）
try { process.loadEnvFile(); } catch { /* no .env in prod */ }

const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
// 生产环境拒绝以默认开发密钥启动（默认密钥 = 任何人可伪造登录态）
if (IS_PROD && JWT_SECRET === 'dev-secret-change-in-production') {
  console.error('[安全] 生产环境必须设置强随机 JWT_SECRET（openssl rand -hex 32），已拒绝启动');
  process.exit(1);
}

// trustProxy：部署在 Nginx 反代之后，据此识别真实客户端 IP（限流/日志才准确）
const app = Fastify({ logger: { level: 'warn' }, trustProxy: true });

// 安全响应头（API 为 JSON 接口；CSP 交由前端 Nginx 对静态站点统一处理）
await app.register(helmet, { contentSecurityPolicy: false });

// CORS：生产默认同源（前端经 Nginx 反代到本服务），无需跨域。
// 如确需跨域，用环境变量 CORS_ORIGIN 指定允许来源（逗号分隔）。
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : IS_PROD
    ? false
    : true;
await app.register(cors, { origin: corsOrigin, credentials: true });
await app.register(jwt, { secret: JWT_SECRET });

// 全局限流：每 IP 每分钟 300 次（兜底防滥用；认证接口在 auth.ts 内单独收紧）
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

app.decorate('authenticate', async (req: any, reply: any) => {
  try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'unauthorized' }); }
});

const requireRole = (req: any, reply: any, roles: string[]): boolean => {
  if (!roles.includes(req.user.role)) { reply.code(403).send({ error: '权限不足' }); return false; }
  return true;
};

app.get('/api/health', async () => ({ ok: true }));

authRoutes(app);
aiRoutes(app);
suggestRoutes(app);
strategyRoutes(app);
enrichRoutes(app);
voiceRoutes(app);
opportunityRoutes(app);
accessTokenRoutes(app);

// ── 数据：拉取整树 / 应用变更 ──
app.get('/api/state', { preHandler: [app.authenticate] }, async (req) => assembleState(req.user.tenantId));

app.post('/api/mutate', { preHandler: [app.authenticate] }, async (req, reply) => {
  const body = z.object({ action: z.object({ type: z.string() }).passthrough() }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: '无效的 action' });
  try {
    await applyAction(req.user.tenantId, body.data.action);
    return { ok: true };
  } catch (e: any) {
    req.log.warn(e);
    return reply.code(400).send({ error: e?.message || '应用变更失败' });
  }
});

app.post('/api/demo', { preHandler: [app.authenticate] }, async (req) => {
  await createDemoForTenant(req.user.tenantId);
  return { ok: true };
});

app.post('/api/reset', { preHandler: [app.authenticate] }, async (req) => {
  await prisma.account.deleteMany({ where: { tenantId: req.user.tenantId } });
  return { ok: true };
});

// ── MCP Server（streamable-HTTP）：让 AI 客户端查询 + 提议（写候选）本平台数据 ──
// 复用现有 JWT（Authorization Bearer）：authenticate 解出 tenantId/userId，所有工具按租户隔离（铁律）。
// 读工具只读；写工具（propose_*）只写候选层（待人审），绝不直接写正式表。协议处理见 mcpServer.ts。
app.post('/api/mcp', { preHandler: [mcpAuthenticate] }, async (req, reply) => {
  const out = await handleMcpBody(req.user.tenantId, req.user.userId, req.body);
  if (out === null) return reply.code(204).send(); // 纯通知，无响应体
  return out;
});

// ── 计费 / 席位 ──
app.get('/api/billing', { preHandler: [app.authenticate] }, async (req) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
  const memberCount = await prisma.user.count({ where: { tenantId: req.user.tenantId } });
  return { plan: tenant?.plan, subscriptionStatus: tenant?.subscriptionStatus, seatLimit: tenant?.seatLimit, memberCount };
});

// 自愿捐赠入口（个人可用，无需商户号）。通过环境变量配置：爱发电链接 / 个人收款码图片。
app.get('/api/donate', { preHandler: [app.authenticate] }, async () => ({
  url: process.env.DONATE_URL || '',
  qrUrl: process.env.DONATE_QR_URL || '',
  note: process.env.DONATE_NOTE || '江湖是免费的。如果它帮到了你的销售作战，欢迎请作者喝杯咖啡 ☕',
}));

// ── 成员 / RBAC ──
app.get('/api/members', { preHandler: [app.authenticate] }, async (req) => {
  const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, phone: true, email: true, name: true, role: true, createdAt: true } });
  return { members: users };
});

app.post('/api/members', { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, ['owner', 'admin'])) return;
  const body = z.object({
    phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
    email: z.string().email().optional(),
    name: z.string().min(1), password: z.string().min(6), role: z.enum(['admin', 'member', 'viewer']),
  }).refine((d) => d.phone || d.email, { message: '请提供手机号或邮箱' }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: '参数无效（需手机号或邮箱）' });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
  const count = await prisma.user.count({ where: { tenantId: req.user.tenantId } });
  if (tenant && count >= tenant.seatLimit) return reply.code(402).send({ error: `席位已满（${count}/${tenant.seatLimit}）` });

  const { phone, email } = body.data;
  if (phone && (await prisma.user.findUnique({ where: { phone } }))) return reply.code(409).send({ error: '该手机号已被使用' });
  if (email && (await prisma.user.findUnique({ where: { email } }))) return reply.code(409).send({ error: '该邮箱已被使用' });

  const u = await prisma.user.create({ data: { tenantId: req.user.tenantId, phone: phone ?? null, email: email ?? null, name: body.data.name, role: body.data.role, passwordHash: await bcrypt.hash(body.data.password, 10) } });
  return { member: { id: u.id, phone: u.phone, email: u.email, name: u.name, role: u.role } };
});

app.delete('/api/members/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
  if (!requireRole(req, reply, ['owner', 'admin'])) return;
  const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!target) return reply.code(404).send({ error: '成员不存在' });
  if (target.role === 'owner') return reply.code(400).send({ error: '不能移除所有者' });
  if (target.id === req.user.userId) return reply.code(400).send({ error: '不能移除自己' });
  await prisma.user.delete({ where: { id: target.id } });
  return { ok: true };
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`江湖 API listening on http://localhost:${port}`);
}).catch((e) => { console.error(e); process.exit(1); });
