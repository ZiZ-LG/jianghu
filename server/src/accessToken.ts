import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';

const MAX_TOKENS_PER_USER = 10;
const PREFIX = 'jh_';

export const hashToken = (plain: string) => crypto.createHash('sha256').update(plain).digest('hex');

/**
 * 混合鉴权（给 /api/mcp 用）：Authorization: Bearer <x>
 * - x 以 jh_ 开头 → 查 AccessToken 表（未吊销）→ 命中置 req.user，更新 lastUsedAt
 * - 否则走标准 JWT（向后兼容现有 Claude Desktop 配置）
 * 成功后 req.user = { userId, tenantId, role }（与 JWT 解出的一致）。
 */
export async function mcpAuthenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  const raw = m?.[1]?.trim() || '';
  if (raw.startsWith(PREFIX)) {
    const tok = await prisma.accessToken.findFirst({ where: { tokenHash: hashToken(raw), revokedAt: null } });
    if (!tok) { reply.code(401).send({ error: 'unauthorized' }); return; }
    const user = await prisma.user.findFirst({ where: { id: tok.userId, tenantId: tok.tenantId } });
    if (!user) { reply.code(401).send({ error: 'unauthorized' }); return; }
    // viewer（只读投影）不可接入 MCP：写工具会绕过只读门禁，读工具会绕过归属过滤。
    // 契约 v1.0：销售包推送用编辑角色成员的令牌。
    if (user.role === 'viewer') { reply.code(403).send({ error: 'viewer（只读）角色不可接入 MCP，请使用编辑角色成员的令牌' }); return; }
    (req as any).user = { userId: user.id, tenantId: tok.tenantId, role: user.role };
    // 异步更新 lastUsedAt（不阻塞请求）
    prisma.accessToken.update({ where: { id: tok.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return;
  }
  // 回退标准 JWT：同样校验成员仍存在 + 角色取库中最新，viewer 拒绝（与 jh_ 令牌路径同等门禁）
  try { await (req as any).jwtVerify(); } catch { reply.code(401).send({ error: 'unauthorized' }); return; }
  const ju = (req as any).user as { userId: string; tenantId: string; role: string };
  const dbUser = await prisma.user.findFirst({ where: { id: ju.userId, tenantId: ju.tenantId }, select: { role: true } });
  if (!dbUser) { reply.code(401).send({ error: 'unauthorized' }); return; }
  ju.role = dbUser.role;
  if (dbUser.role === 'viewer') { reply.code(403).send({ error: 'viewer（只读）角色不可接入 MCP，请使用编辑角色成员的令牌' }); return; }
}

export function accessTokenRoutes(app: FastifyInstance) {
  // 列出本人令牌（不含明文/哈希）
  app.get('/api/access-tokens', { preHandler: [app.authenticate] }, async (req: any) => {
    const rows = await prisma.accessToken.findMany({
      where: { tenantId: req.user.tenantId, userId: req.user.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { tokens: rows.map((t) => ({ id: t.id, name: t.name, lastFour: t.lastFour, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })) };
  });

  // 生成新令牌：响应里带一次性明文（jh_...），库里只存哈希
  app.post('/api/access-tokens', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    // viewer 不可创建接入令牌（其令牌也会被 mcpAuthenticate 拒绝，双保险）
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可创建接入令牌' });
    const p = z.object({ name: z.string().max(40).optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const count = await prisma.accessToken.count({ where: { tenantId: req.user.tenantId, userId: req.user.userId, revokedAt: null } });
    if (count >= MAX_TOKENS_PER_USER) return reply.code(400).send({ error: `令牌数量已达上限（${MAX_TOKENS_PER_USER}），请先吊销不用的` });

    const plain = PREFIX + crypto.randomBytes(32).toString('hex');
    const id = 'at_' + crypto.randomUUID().slice(0, 12);
    await prisma.accessToken.create({
      data: { id, tenantId: req.user.tenantId, userId: req.user.userId, name: (p.data.name || '').trim(), tokenHash: hashToken(plain), lastFour: plain.slice(-4) },
    });
    // token 明文只返回这一次
    return { id, name: (p.data.name || '').trim(), token: plain, lastFour: plain.slice(-4) };
  });

  // 吊销（只能删自己的，tenantId+userId 双锁）
  app.delete('/api/access-tokens/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const r = await prisma.accessToken.updateMany({
      where: { id: req.params.id, tenantId: req.user.tenantId, userId: req.user.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!r.count) return reply.code(404).send({ error: '令牌不存在或已吊销' });
    return { ok: true };
  });
}
