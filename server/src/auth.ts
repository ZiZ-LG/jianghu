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
}).refine((d) => d.phone || d.email, { message: '请提供手机号或邮箱' });

function tenantView(t: { id: string; name: string; plan: string; subscriptionStatus: string; seatLimit: number }) {
  return { id: t.id, name: t.name, plan: t.plan, subscriptionStatus: t.subscriptionStatus, seatLimit: t.seatLimit };
}
function userView(u: { id: string; phone: string | null; email: string | null; name: string; role: string }) {
  return { id: u.id, phone: u.phone, email: u.email, name: u.name, role: u.role };
}

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (req, reply) => {
    const p = registerSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.issues[0]?.message || '参数无效' });
    const { phone: ph, email: em, password, name, tenantName } = p.data;

    if (ph && (await prisma.user.findUnique({ where: { phone: ph } }))) return reply.code(409).send({ error: '该手机号已注册' });
    if (em && (await prisma.user.findUnique({ where: { email: em } }))) return reply.code(409).send({ error: '该邮箱已注册' });

    const tenant = await prisma.tenant.create({ data: { id: randomUUID(), name: tenantName } });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, phone: ph ?? null, email: em ?? null, name, role: 'owner', passwordHash: await bcrypt.hash(password, 10) },
    });
    const token = app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role });
    return { token, user: userView(user), tenant: tenantView(tenant) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const p = loginSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.issues[0]?.message || '参数无效' });
    const { phone: ph, email: em, password } = p.data;

    const user = ph
      ? await prisma.user.findUnique({ where: { phone: ph } })
      : await prisma.user.findUnique({ where: { email: em! } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: '账号或密码错误' });
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
