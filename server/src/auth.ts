import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';

const phone = z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的中国大陆手机号');
const email = z.string().email();

// 注册：手机号或邮箱二选一
const registerSchema = z.object({
  phone: phone.optional(),
  email: email.optional(),
  password: z.string().min(6),
  name: z.string().min(1),
  tenantName: z.string().min(1),
}).refine((d) => d.phone || d.email, { message: '请提供手机号或邮箱' });

const loginSchema = z.object({
  phone: phone.optional(),
  email: email.optional(),
  password: z.string().min(1),
  tenantId: z.string().optional(), // 同一手机号/邮箱在多个工作区都有账号时，前端二次提交据此定位目标工作区
}).refine((d) => d.phone || d.email, { message: '请提供手机号或邮箱' });

function tenantView(t: { id: string; name: string; plan: string; subscriptionStatus: string; seatLimit: number }) {
  return { id: t.id, name: t.name, plan: t.plan, subscriptionStatus: t.subscriptionStatus, seatLimit: t.seatLimit };
}
function userView(u: { id: string; phone: string | null; email: string | null; name: string; role: string }) {
  return { id: u.id, phone: u.phone, email: u.email, name: u.name, role: u.role };
}

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = registerSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.issues[0]?.message || '参数无效' });
    const { phone: ph, email: em, password, name, tenantName } = p.data;

    // 注册即新建独立工作区（租户）。复合唯一 [tenantId, phone/email] 下，同一手机号可在不同工作区各注册一个账号，
    // 故不再做全局查重（旧逻辑造成跨租户 DoS：A 占号后 B 永远无法注册）；新建租户内必不撞号。
    const tenant = await prisma.tenant.create({ data: { id: randomUUID(), name: tenantName } });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, phone: ph ?? null, email: em ?? null, name, role: 'owner', passwordHash: await bcrypt.hash(password, 10) },
    });
    const token = app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role });
    return { token, user: userView(user), tenant: tenantView(tenant) };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = loginSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.issues[0]?.message || '参数无效' });
    const { phone: ph, email: em, password, tenantId } = p.data;

    // 复合唯一下 phone/email 不再全局唯一：按 phone/email 找出所有同号账号（可能分布在多个工作区），逐个验密码。
    const candidates = await prisma.user.findMany({ where: ph ? { phone: ph } : { email: em! } });
    const matched: typeof candidates = [];
    for (const u of candidates) if (await bcrypt.compare(password, u.passwordHash)) matched.push(u);
    if (matched.length === 0) return reply.code(401).send({ error: '账号或密码错误' });

    // 命中唯一账号 → 直接登录；命中多个（同号多工作区且同密码）→ 让前端选工作区后带 tenantId 二次提交。
    const user = matched.length === 1 ? matched[0] : matched.find((u) => u.tenantId === tenantId);
    if (!user) {
      const tenants = await prisma.tenant.findMany({ where: { id: { in: matched.map((u) => u.tenantId) } } });
      return reply.send({ needWorkspace: true, workspaces: tenants.map((t) => ({ tenantId: t.id, tenantName: t.name })) });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
    if (!tenant) return reply.code(401).send({ error: '工作区不存在' });
    const token = app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role });
    return { token, user: userView(user), tenant: tenantView(tenant) };
  });

  app.get('/api/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
    if (!user || !tenant) return reply.code(401).send({ error: 'unauthorized' });
    return { user: userView(user), tenant: tenantView(tenant) };
  });
}
