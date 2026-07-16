import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ActorRoleSchema } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';

const MAX_TOKENS_PER_USER = 10;
const PREFIX = 'jh_';
export const ACCESS_TOKEN_VERSION = 1;

export type AccessScope =
  | 'read'
  | 'human_command'
  | 'sync_business'
  | 'propose_people'
  | 'propose_relations'
  | 'submit_evidence';

export type AccessTokenPreset = 'workbuddy_sync' | 'readonly_analysis' | 'research_proposal';

export const ALL_ACCESS_SCOPES: readonly AccessScope[] = [
  'read', 'human_command', 'sync_business', 'propose_people', 'propose_relations', 'submit_evidence',
];

export const ACCESS_TOKEN_PRESETS: Readonly<Record<AccessTokenPreset, readonly AccessScope[]>> = {
  workbuddy_sync: ['read', 'sync_business', 'propose_people', 'propose_relations', 'submit_evidence'],
  readonly_analysis: ['read'],
  research_proposal: ['read', 'propose_people', 'propose_relations', 'submit_evidence'],
};

const AccessTokenPresetSchema = z.enum(['workbuddy_sync', 'readonly_analysis', 'research_proposal']);
const ACCESS_SCOPE_SET = new Set<string>(ALL_ACCESS_SCOPES);

export function parseAccessScopes(raw: string, tokenVersion: number): AccessScope[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length === 0) return null;
    if (!value.every((scope): scope is AccessScope => typeof scope === 'string' && ACCESS_SCOPE_SET.has(scope))) return null;
    const scopes = [...new Set(value)];
    // v0 只用于迁移前无 scope 的旧行：仅接受安全只读默认，且列表中保持 preset=null 提示重发。
    if (tokenVersion === 0) return scopes.length === 1 && scopes[0] === 'read' ? scopes : null;
    if (tokenVersion !== ACCESS_TOKEN_VERSION) return null;
    return scopes;
  } catch {
    return null;
  }
}

export function scopesForCurrentRole(role: 'owner' | 'admin' | 'member' | 'viewer'): readonly AccessScope[] {
  return role === 'viewer' ? ['read'] : ALL_ACCESS_SCOPES;
}

function effectiveScopes(stored: readonly AccessScope[], role: 'owner' | 'admin' | 'member' | 'viewer'): AccessScope[] {
  const allowed = new Set(scopesForCurrentRole(role));
  return stored.filter((scope) => allowed.has(scope));
}

function presetForScopes(scopes: readonly AccessScope[], tokenVersion: number): AccessTokenPreset | null {
  if (tokenVersion !== ACCESS_TOKEN_VERSION) return null;
  const encoded = JSON.stringify(scopes);
  for (const [preset, presetScopes] of Object.entries(ACCESS_TOKEN_PRESETS) as Array<[AccessTokenPreset, readonly AccessScope[]]>) {
    if (JSON.stringify(presetScopes) === encoded) return preset;
  }
  return null;
}

export const hashToken = (plain: string) => crypto.createHash('sha256').update(plain).digest('hex');

/**
 * 混合鉴权（给 /api/mcp 用）：Authorization: Bearer <x>
 * - x 以 jh_ 开头 → 查 AccessToken 表（未吊销）→ 命中置 req.user，更新 lastUsedAt
 * - 否则走标准 JWT（向后兼容现有 Claude Desktop 配置）
 * 成功后 req.user 带当前 role、tokenId 和本次请求的有效 scopes。
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
    const role = ActorRoleSchema.safeParse(user.role);
    if (!role.success) { reply.code(401).send({ error: 'unauthorized' }); return; }
    const storedScopes = parseAccessScopes(tok.scopes, tok.tokenVersion);
    if (!storedScopes) { reply.code(401).send({ error: 'unauthorized' }); return; }
    req.user = {
      userId: user.id,
      tenantId: tok.tenantId,
      role: role.data,
      tokenId: tok.id,
      scopes: effectiveScopes(storedScopes, role.data),
      tokenVersion: tok.tokenVersion,
    };
    // 异步更新 lastUsedAt（不阻塞请求）
    prisma.accessToken.update({ where: { id: tok.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return;
  }
  // 回退标准 JWT：同样校验成员仍存在 + 角色取库中最新；viewer 只获得 read。
  try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'unauthorized' }); return; }
  const ju = req.user;
  const dbUser = await prisma.user.findFirst({ where: { id: ju.userId, tenantId: ju.tenantId }, select: { role: true } });
  if (!dbUser) { reply.code(401).send({ error: 'unauthorized' }); return; }
  const role = ActorRoleSchema.safeParse(dbUser.role);
  if (!role.success) { reply.code(401).send({ error: 'unauthorized' }); return; }
  ju.role = role.data;
  ju.tokenId = undefined;
  ju.scopes = [...scopesForCurrentRole(role.data)];
  ju.tokenVersion = ACCESS_TOKEN_VERSION;
}

export function accessTokenRoutes(app: FastifyInstance) {
  // 列出本人令牌（不含明文/哈希）
  app.get('/api/access-tokens', { preHandler: [app.authenticate] }, async (req: any) => {
    const rows = await prisma.accessToken.findMany({
      where: { tenantId: req.user.tenantId, userId: req.user.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { tokens: rows.map((t) => {
      const scopes = parseAccessScopes(t.scopes, t.tokenVersion) ?? [];
      return {
        id: t.id, name: t.name, lastFour: t.lastFour, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt,
        preset: presetForScopes(scopes, t.tokenVersion), scopes, tokenVersion: t.tokenVersion,
      };
    }) };
  });

  // 生成新令牌：响应里带一次性明文（jh_...），库里只存哈希
  app.post('/api/access-tokens', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    // viewer 不可创建接入令牌（其令牌也会被 mcpAuthenticate 拒绝，双保险）
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可创建接入令牌' });
    const p = z.object({
      name: z.string().max(40).optional(),
      preset: AccessTokenPresetSchema,
    }).strict().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const count = await prisma.accessToken.count({ where: { tenantId: req.user.tenantId, userId: req.user.userId, revokedAt: null } });
    if (count >= MAX_TOKENS_PER_USER) return reply.code(400).send({ error: `令牌数量已达上限（${MAX_TOKENS_PER_USER}），请先吊销不用的` });

    const plain = PREFIX + crypto.randomBytes(32).toString('hex');
    const id = 'at_' + crypto.randomUUID().replaceAll('-', '');
    const scopes = ACCESS_TOKEN_PRESETS[p.data.preset];
    await prisma.accessToken.create({
      data: {
        id, tenantId: req.user.tenantId, userId: req.user.userId, name: (p.data.name || '').trim(),
        tokenHash: hashToken(plain), lastFour: plain.slice(-4), scopes: JSON.stringify(scopes), tokenVersion: ACCESS_TOKEN_VERSION,
      },
    });
    // token 明文只返回这一次
    return {
      id, name: (p.data.name || '').trim(), token: plain, lastFour: plain.slice(-4),
      preset: p.data.preset, scopes, tokenVersion: ACCESS_TOKEN_VERSION,
    };
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
