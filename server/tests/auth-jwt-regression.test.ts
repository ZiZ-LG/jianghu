import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

const testSecret = 'jwt-regression-test-only-secret-32-bytes';

// Sign raw JSON so malformed payload tests reach verification, not signer validation.
function signRawPayload(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  return `${input}.${createHmac('sha256', testSecret).update(input).digest('base64url')}`;
}

describe('CORE-503 JWT dependency security regression', () => {
  beforeEach(() => { vi.stubEnv('JWT_SECRET', testSecret); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('logs in with the current identity and seven-day expiry, and rejects a wrong password', async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: context.owner.email, password: 'test-password' },
      });
      expect(response.statusCode).toBe(200);
      const { token } = response.json<{ token: string }>();
      const claims = context.app.jwt.verify<{ userId: string; tenantId: string; role: string; iat: number; exp: number }>(token);
      expect(claims).toMatchObject({ userId: context.owner.id, tenantId: context.tenant.id, role: 'owner' });
      expect(claims.iat).toEqual(expect.any(Number));
      expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60);

      const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { id: context.owner.id }, tenant: { id: context.tenant.id } });

      const denied = await context.app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: context.owner.email, password: 'wrong-password' },
      });
      expect(denied.statusCode).toBe(401);
    } finally { await context.cleanup(); }
  });

  it('rejects a correctly signed expired token before authenticated access', async () => {
    const context = await createTestContext();
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = signRawPayload({
        userId: context.owner.id, tenantId: context.tenant.id, role: 'owner',
        iat: now - 60, exp: now - 1,
      });
      expect(() => context.app.jwt.verify(token)).toThrow(/expired/i);
      const response = await context.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    } finally { await context.cleanup(); }
  });

  it('rejects a correctly signed array payload while accepting an object signed the same way', async () => {
    const context = await createTestContext();
    try {
      const claims = { userId: context.owner.id, tenantId: context.tenant.id, role: 'owner' };
      expect(context.app.jwt.verify(signRawPayload(claims))).toMatchObject(claims);
      const token = signRawPayload([claims]);
      expect(() => context.app.jwt.verify(token)).toThrow(/payload/i);
      const response = await context.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    } finally { await context.cleanup(); }
  });

  it('stops accepting a cached exp-without-iat token at expiry', async () => {
    const app = Fastify();
    try {
      await app.register(jwt, { secret: testSecret, verify: { cache: true, cacheTTL: 60_000 } });
      await app.ready();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_700_000_000_000);
      const payload = { sub: 'cached-test-user', exp: 1_700_000_001 };
      const token = signRawPayload(payload);
      expect(app.jwt.verify(token)).toEqual(payload);
      vi.setSystemTime(payload.exp * 1000 + 1);
      expect(() => app.jwt.verify(token)).toThrow(/expired/i);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
