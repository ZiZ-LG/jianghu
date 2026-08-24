import './types.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  ActionSchema,
  ActorRoleSchema,
  assembleProductAccess,
  capabilityRequirementForActionType,
  capabilityPolicyAllows,
  type CapabilityRequirement,
  type CommandContext,
  type ProductAccess,
} from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { authRoutes } from './auth.js';
import { assembleState, type StateSecurityWarning } from './state.js';
import { applyAction } from './mutate.js';
import { ScopedNotFoundError } from './mutation/scopeGuards.js';
import { archiveEntity, restoreEntity } from './mutation/audit.js';
import { createDemoForTenant } from './seed-demo.js';
import { aiRoutes } from './ai.js';
import { suggestRoutes } from './suggest.js';
import { proposalRoutes } from './proposals.js';
import { strategyRoutes } from './strategy.js';
import { advisorRoutes } from './advisor.js';
import { enrichRoutes } from './enrich.js';
import { jobRoutes } from './jobs.js';
import { voiceRoutes } from './voice.js';
import { recordingRoutes } from './recording.js';
import { curatedRoutes } from './curated.js';
import { opportunityRoutes } from './opp.js';
import { wecomRoutes, syncFromAction } from './wecom.js';
import { pdeRoutes } from './pde/routes.js';
import { handleMcpBody } from './mcpServer.js';
import { accessTokenRoutes, mcpAuthenticate } from './accessToken.js';
import { compoundCommandRoutes } from './mutation/compoundCommands.js';
import { matterOwnershipRoutes } from './mutation/matterOwnership.js';
import { matterParticipantRoutes } from './mutation/matterParticipants.js';
import { commitmentRoutes } from './mutation/commitments.js';
import { customerRoutes } from './mutation/customers.js';
import { methodologyCommandRoutes } from './methodology/commands.js';
import { repairRoutes } from './repair.js';
import { personMergeRoutes } from './personMerge.js';
import { todayRoutes } from './today.js';
import { crmContextRoutes } from './crmContext.js';

async function registerSecurityPlugins(app: FastifyInstance): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-in-production';

  // 安全响应头（API 为 JSON 接口；CSP 交由前端 Nginx 对静态站点统一处理）
  await app.register(helmet, { contentSecurityPolicy: false });

  // CORS：生产默认同源（前端经 Nginx 反代到本服务），无需跨域。
  // 如确需跨域，用环境变量 CORS_ORIGIN 指定允许来源（逗号分隔）。
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : isProd
      ? false
      : true;
  await app.register(cors, { origin: corsOrigin, credentials: true });
  // JWT 7 天过期（此前永不过期：删成员/令牌泄漏均无法收口）。前端 401 已有跳登录处理，到期重登即可。
  await app.register(jwt, { secret: jwtSecret, sign: { expiresIn: '7d' } });

  // 全局限流：每 IP 每分钟 300 次（兜底防滥用；认证接口在 auth.ts 内单独收紧）
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  // 录音接入·文件上传（docx/pdf/md/txt）。单文件 ≤15MB，1 个/次。
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  app.decorate('authenticate', async (req: any, reply: any) => {
    try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'unauthorized' }); return; }
    // 验签后查库：①成员已被移除 → 旧会话立即失效 ②角色取库中最新（改权即生效，JWT 内 role 仅是签发时快照）。
    // 主键查询亚毫秒级，正确性优先不加缓存；/api/mcp 走 mcpAuthenticate 已有同等校验。
    const u = await prisma.user.findFirst({ where: { id: req.user.userId, tenantId: req.user.tenantId }, select: { role: true, name: true } });
    if (!u) { reply.code(401).send({ error: 'unauthorized' }); return; }
    const role = ActorRoleSchema.safeParse(u.role);
    if (!role.success) { reply.code(401).send({ error: 'unauthorized' }); return; }
    req.user.role = role.data;
    req.user.name = u.name; // 仅展示；授权使用 userId。
  });
}

const requireRole = (req: any, reply: any, roles: string[]): boolean => {
  if (!roles.includes(req.user.role)) { reply.code(403).send({ error: '权限不足' }); return false; }
  return true;
};

type ReadinessProbe = () => Promise<void>;

const serviceCapabilityRules: ReadonlyArray<{
  requirement: CapabilityRequirement;
  matches: (pathname: string) => boolean;
}> = [
  {
    requirement: { entitlement: 'crm.core' },
    matches: (pathname) => pathname === '/api/crm/context'
      || pathname === '/api/today'
      || pathname === '/api/today/source'
      || pathname === '/api/donate'
      || pathname === '/api/commands/customer'
      || pathname === '/api/commands/commitment'
      || pathname === '/api/commands/quick-capture'
      || pathname === '/api/commands/matter-participant',
  },
  {
    requirement: { entitlement: 'team.operations' },
    matches: (pathname) => pathname === '/api/members' || pathname.startsWith('/api/members/') || pathname === '/api/billing',
  },
  {
    requirement: { entitlement: 'sales.workspace' },
    matches: (pathname) => pathname === '/api/state'
      || pathname === '/api/mutate'
      || pathname === '/api/demo'
      || pathname === '/api/archive'
      || pathname.startsWith('/api/archive/')
      || pathname.startsWith('/api/repair/')
      || pathname.startsWith('/api/opportunity/')
      || pathname === '/api/commands/opportunity-skeleton'
      || pathname.startsWith('/api/strategy/')
      || pathname.startsWith('/api/advisor/'),
  },
  {
    requirement: { entitlement: 'methodology.g64111' },
    matches: (pathname) => pathname === '/api/commands/methodology',
  },
  {
    requirement: { entitlement: 'decision.pde' },
    matches: (pathname) => pathname.startsWith('/api/pde/'),
  },
];

function registerCapabilityEnforcement(app: FastifyInstance, product: ProductAccess): void {
  app.addHook('onRoute', (routeOptions) => {
    const preHandlers = routeOptions.preHandler
      ? (Array.isArray(routeOptions.preHandler) ? routeOptions.preHandler : [routeOptions.preHandler])
      : [];
    const protectedRoute = preHandlers.includes(app.authenticate) || preHandlers.includes(mcpAuthenticate);
    if (!protectedRoute || routeOptions.url === '/api/me') return;
    const rule = serviceCapabilityRules.find((candidate) => candidate.matches(routeOptions.url));
    // Any authenticated legacy service not explicitly classified above belongs to the
    // complex-sales adapter. This makes newly registered protected routes fail closed
    // for commercial Free while the internal adapter (all entitlements) stays intact.
    const requirement = rule?.requirement ?? { entitlement: 'sales.workspace' as const };
    if (capabilityPolicyAllows(product.policy, requirement)) return;
    const deny = async (_req: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => (
      reply.code(403).send({ error: '能力未启用', code: 'capability_denied' })
    );
    const existing = routeOptions.preHandler;
    routeOptions.preHandler = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), deny]
      : [deny];
  });
}

function registerRoutes(app: FastifyInstance, readinessProbe: ReadinessProbe, product: ProductAccess): void {
  app.get('/api/health/live', async () => ({ ok: true }));
  const readinessHandler = async (_req: unknown, reply: { code: (status: number) => { send: (body: { ok: boolean }) => unknown } }) => {
    try {
      await readinessProbe();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  };
  app.get('/api/health/ready', readinessHandler);
  // Backward-compatible endpoint used by existing deploy callers; semantically readiness.
  app.get('/api/health', readinessHandler);

  authRoutes(app, product);
  aiRoutes(app);
  suggestRoutes(app);
  proposalRoutes(app);
  strategyRoutes(app);
  advisorRoutes(app);
  enrichRoutes(app);
  jobRoutes(app);
  voiceRoutes(app);
  recordingRoutes(app);
  curatedRoutes(app);
  opportunityRoutes(app);
  accessTokenRoutes(app);
  wecomRoutes(app); // 企微日历：配置/绑定（江湖→企微同步在 mutate 落库后触发）
  pdeRoutes(app); // PDE 决策引擎（M3 评估主链）：ev / intel-priorities / action-ranking / snapshot
  compoundCommandRoutes(app, product);
  matterOwnershipRoutes(app);
  matterParticipantRoutes(app);
  customerRoutes(app, product.policy);
  commitmentRoutes(app);
  methodologyCommandRoutes(app);
  repairRoutes(app);
  personMergeRoutes(app);
  todayRoutes(app);
  crmContextRoutes(app);

  // ── 数据：拉取整树 / 应用变更 ──
  // 服务端组装时传入当前身份，统一执行归属与敏感字段 ACL。
  app.get('/api/state', { preHandler: [app.authenticate] }, async (req) => {
    const stateOptions = {
      onSecurityWarning: (warning: StateSecurityWarning) => {
        req.log.warn(warning, 'state scope rows dropped');
      },
    };
    return assembleState(req.user.tenantId, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: ActorRoleSchema.parse(req.user.role),
    }, stateOptions);
  });

  app.post('/api/mutate', { preHandler: [app.authenticate] }, async (req, reply) => {
    // 写总入口：applyAction 全是写操作（create/update/delete），viewer 只读须一律拒绝；owner/admin/member 放行（对齐 /api/members 的 RBAC）
    if (!requireRole(req, reply, ['owner', 'admin', 'member'])) return;
    const envelope = z.object({ action: z.unknown() }).strict().safeParse(req.body);
    if (!envelope.success) return reply.code(400).send({ error: '无效的 action' });
    const parsed = ActionSchema.safeParse(envelope.data.action);
    if (!parsed.success) return reply.code(400).send({ error: '无效的 action' });
    const actionRequirement = capabilityRequirementForActionType(parsed.data.type);
    if (!actionRequirement || !capabilityPolicyAllows(product.policy, actionRequirement)) {
      return reply.code(403).send({ error: '能力未启用', code: 'capability_denied' });
    }
    const ctx: CommandContext = {
      tenantId: req.user.tenantId,
      actorId: req.user.userId,
      actorRole: ActorRoleSchema.parse(req.user.role),
      channel: 'web',
      requestId: req.id,
      assertionMode: 'user_asserted',
    };
    try {
      await applyAction(ctx, parsed.data);
      void syncFromAction(req.user.tenantId, req.user.userId, parsed.data).catch(() => {}); // 江湖→企微日历同步：不阻塞、失败不影响落库
      return { ok: true };
    } catch (e: any) {
      req.log.warn(e);
      if (e instanceof ScopedNotFoundError || e?.scopedNotFound === true) {
        return reply.code(404).send({ error: '资源不存在' });
      }
      // 乐观锁冲突 → 409，前端据此提示并重拉整树（区别于 400 的参数/业务错误）
      if (e?.conflict) return reply.code(409).send({ error: e.message || '该数据已被其他成员修改，请刷新后重试' });
      return reply.code(400).send({ error: '应用变更失败' });
    }
  });

  app.post('/api/demo', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireRole(req, reply, ['owner', 'admin', 'member'])) return; // viewer 只读
    await createDemoForTenant(req.user.tenantId);
    return { ok: true };
  });

  const archiveTargetSchema = z.enum(['account', 'opportunity']);
  const archiveBodySchema = z.object({
    target: archiveTargetSchema,
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(200),
  }).strict();
  const restoreBodySchema = z.object({ target: archiveTargetSchema, id: z.string().min(1) }).strict();
  const archiveContext = (req: any): CommandContext => ({
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
    actorRole: ActorRoleSchema.parse(req.user.role),
    channel: 'web',
    requestId: req.id,
    assertionMode: 'user_asserted',
  });

  app.post('/api/archive', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireRole(req, reply, ['owner', 'admin', 'member'])) return;
    const body = archiveBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '归档参数无效' });
    try {
      await archiveEntity(archiveContext(req), body.data.target, body.data.id, body.data.reason);
      return { ok: true };
    } catch (error: any) {
      if (error instanceof ScopedNotFoundError || error?.scopedNotFound === true) {
        return reply.code(404).send({ error: '资源不存在' });
      }
      req.log.warn(error);
      return reply.code(400).send({ error: '归档失败' });
    }
  });

  app.post('/api/archive/restore', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireRole(req, reply, ['owner', 'admin'])) return;
    const body = restoreBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '恢复参数无效' });
    try {
      await restoreEntity(archiveContext(req), body.data.target, body.data.id);
      return { ok: true };
    } catch (error: any) {
      if (error instanceof ScopedNotFoundError || error?.scopedNotFound === true) {
        return reply.code(404).send({ error: '资源不存在' });
      }
      req.log.warn(error);
      return reply.code(400).send({ error: '恢复失败' });
    }
  });

  app.get('/api/archive', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireRole(req, reply, ['owner', 'admin'])) return;
    const [accounts, opportunities] = await Promise.all([
      prisma.account.findMany({
        where: { tenantId: req.user.tenantId, archivedAt: { not: null } },
        orderBy: { archivedAt: 'desc' },
        select: { id: true, name: true, archivedAt: true, archivedBy: true, archiveReason: true },
      }),
      prisma.opportunity.findMany({
        where: { tenantId: req.user.tenantId, archivedAt: { not: null } },
        orderBy: { archivedAt: 'desc' },
        select: {
          id: true, name: true, accountId: true, archivedAt: true, archivedBy: true, archiveReason: true,
          account: { select: { name: true, archivedAt: true } },
        },
      }),
    ]);
    return {
      accounts: accounts.map((item) => ({ ...item, target: 'account' as const })),
      opportunities: opportunities.map(({ account, ...item }) => ({
        ...item,
        target: 'opportunity' as const,
        accountName: account.name,
        canRestore: account.archivedAt === null,
      })),
    };
  });

  // ── MCP Server（streamable-HTTP）：让 AI 客户端查询 + 提议（写候选）本平台数据 ──
  // 复用现有 JWT（Authorization Bearer）：authenticate 解出 tenantId/userId，所有工具按租户隔离（铁律）。
  // 读工具只读；写工具（propose_*）只写候选层（待人审），绝不直接写正式表。协议处理见 mcpServer.ts。
  app.post('/api/mcp', { preHandler: [mcpAuthenticate] }, async (req, reply) => {
    const out = await handleMcpBody({
      tenantId: req.user.tenantId,
      actorId: req.user.userId,
      actorRole: ActorRoleSchema.parse(req.user.role),
      channel: 'mcp',
      requestId: req.id,
      assertionMode: 'machine_proposed',
      scopes: req.user.scopes,
    }, req.body, product.policy);
    if (out === null) return reply.code(204).send(); // 纯通知，无响应体
    return out;
  });

  // streamable-HTTP 的 server→client 通道（GET）：江湖无服务端主动推送的消息，但严格按 streamable-HTTP
  // 规范握手的客户端（WorkBuddy/CodeBuddy 等）会打开此 SSE 流——缺了它（旧版只挂 POST）→ GET 返 404
  // → 客户端整个连接握手失败。这里回 200 text/event-stream 并以心跳保持流，让握手通过。
  app.get('/api/mcp', { preHandler: [mcpAuthenticate] }, async (req, reply) => {
    reply.hijack(); // 接管原始响应，绕过 Fastify 的 JSON 序列化/onSend，自己写 SSE
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // 关掉反代缓冲，SSE 实时下发
    });
    raw.write(': mcp stream open\n\n'); // 初始注释帧，确认流已建立
    const hb = setInterval(() => { try { raw.write(': ping\n\n'); } catch { /* 流已关 */ } }, 25000);
    req.raw.on('close', () => { clearInterval(hb); try { raw.end(); } catch { /* 已结束 */ } });
  });

  // streamable-HTTP 的会话终止（DELETE）：江湖无状态、不维护 session，直接回 204。
  app.delete('/api/mcp', { preHandler: [mcpAuthenticate] }, async (_req, reply) => reply.code(204).send());

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
    // 租户内查重（不再跨租户 findUnique）：复合唯一 [tenantId, phone/email] 保证同租户不撞，且不泄漏该号是否在别的工作区存在。
    if (phone && (await prisma.user.findFirst({ where: { tenantId: req.user.tenantId, phone } }))) return reply.code(409).send({ error: '该手机号已被使用' });
    if (email && (await prisma.user.findFirst({ where: { tenantId: req.user.tenantId, email } }))) return reply.code(409).send({ error: '该邮箱已被使用' });

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

  // 重置成员密码（忘记密码的产品内救济，替代「删了重加」）：owner/admin 可重置成员/管理员；
  // owner 的密码仅 owner 本人可重置（防 admin 越级夺权；owner 全忘走运维改库兜底）。
  app.patch('/api/members/:id/password', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!requireRole(req, reply, ['owner', 'admin'])) return;
    const body = z.object({ password: z.string().min(6) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '新密码至少 6 位' });
    const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!target) return reply.code(404).send({ error: '成员不存在' });
    if (target.role === 'owner' && target.id !== req.user.userId) return reply.code(403).send({ error: '所有者的密码只能由本人重置' });
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await bcrypt.hash(body.data.password, 10) } });
    return { ok: true };
  });
}

export interface BuildAppOptions {
  logger?: boolean;
  readinessProbe?: ReadinessProbe;
  productAccess?: unknown;
}

function productAccessFrom(options: BuildAppOptions): ProductAccess {
  if (options.productAccess !== undefined) return assembleProductAccess(options.productAccess);
  const enabledEntitlements = process.env.PRODUCT_ENTITLEMENTS
    ?.split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  return assembleProductAccess({
    edition: process.env.PRODUCT_EDITION ?? 'commercial',
    ...(enabledEntitlements && enabledEntitlements.length > 0 ? { enabledEntitlements } : {}),
  });
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // trustProxy：部署在 Nginx 反代之后，据此识别真实客户端 IP（限流/日志才准确）
  const logger = options.logger === true ? { level: 'warn' } : false;
  const app = Fastify({ logger, trustProxy: true });
  const product = productAccessFrom(options);
  await registerSecurityPlugins(app);
  registerCapabilityEnforcement(app, product);
  registerRoutes(app, options.readinessProbe ?? (async () => {
    await prisma.$queryRaw`SELECT 1`;
  }), product);
  return app;
}
