import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type Registration = { token: string; user: { id: string; name: string; role: string }; tenant: { id: string; name: string } };
const credentials = { email: 'core208@example.test', name: '曹经理', password: 'core208-password' };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function register(context: TestContext, fields: Record<string, unknown> = {}): Promise<Registration> {
  const response = await context.app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...credentials, ...fields } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).not.toContain('passwordHash');
  return response.json<Registration>();
}

it('creates a private scoped account without an organization and ignores caller-owned identity/role fields', async () => {
  const context = await createTestContext({ productAccess: { edition: 'commercial' } });
  try {
    const result = await register(context, { name: ' 曹经理 ', tenantId: context.tenant.id, role: 'admin' });
    expect(result.user).toMatchObject({ name: '曹经理', role: 'owner' });
    expect(result.tenant.name).toBe('曹经理的私人工作区');
    expect(result.tenant.id).not.toBe(context.tenant.id);
    expect(await context.prisma.tenant.findUniqueOrThrow({ where: { id: result.tenant.id } }))
      .toMatchObject({ dataScopePolicy: 'scoped' });
    expect(await context.prisma.user.count({ where: { tenantId: result.tenant.id } })).toBe(1);
    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: auth(result.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().tenant.id).toBe(result.tenant.id);
  } finally { await context.cleanup(); }
});

it('rolls back the new tenant if the database rejects owner creation', async () => {
  const context = await createTestContext();
  try {
    const before = { tenants: await context.prisma.tenant.count(), users: await context.prisma.user.count() };
    await context.prisma.$executeRawUnsafe(`CREATE TRIGGER core208_reject_user BEFORE INSERT ON "User"
      WHEN NEW.name = 'CORE208 injected failure' BEGIN SELECT RAISE(ABORT, 'synthetic owner write failure'); END`);
    const response = await context.app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      ...credentials, name: 'CORE208 injected failure',
    } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'registration_unavailable', error: '暂时无法创建账户，请稍后重试' });
    expect(await context.prisma.tenant.count()).toBe(before.tenants);
    expect(await context.prisma.user.count()).toBe(before.users);
  } finally {
    await context.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS core208_reject_user');
    await context.cleanup();
  }
});

it('rejects blank identity fields before creating any rows', async () => {
  const context = await createTestContext();
  try {
    const before = await context.prisma.tenant.count();
    for (const invalid of [{ name: '   ' }, { email: 'invalid' }, { tenantName: ' ' }]) {
      const response = await context.app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...credentials, ...invalid } });
      expect(response.statusCode).toBe(400);
    }
    expect(await context.prisma.tenant.count()).toBe(before);
  } finally { await context.cleanup(); }
});

it('retains explicit legacy workspace names and password-verified identity choices', async () => {
  const context = await createTestContext();
  try {
    const first = await register(context, { tenantName: '旧工作区' });
    const second = await register(context);
    const third = await register(context, { password: 'another-password' });
    const login = (fields: Record<string, unknown> = {}) => context.app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: credentials.email, password: credentials.password, ...fields } });
    const choice = await login();
    expect(choice.json().needWorkspace).toBe(true);
    expect(choice.json().workspaces.map((item: { tenantId: string }) => item.tenantId).sort())
      .toEqual([first.tenant.id, second.tenant.id].sort());
    expect(choice.body).not.toContain(third.tenant.id);
    expect((await login({ tenantId: second.tenant.id })).json().tenant.id).toBe(second.tenant.id);
    expect((await login({ tenantId: third.tenant.id })).statusCode).toBe(401);
    expect((await login({ password: 'incorrect-password' })).statusCode).toBe(401);
    expect(first.tenant.name).toBe('旧工作区');
    expect(await context.prisma.tenant.findUniqueOrThrow({ where: { id: first.tenant.id } }))
      .toMatchObject({ dataScopePolicy: 'legacy_tenant_shared' });
  } finally { await context.cleanup(); }
});

it('does not silently ignore an explicitly selected wrong tenant when only one password matches', async () => {
  const context = await createTestContext();
  try {
    await register(context);
    const response = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      email: credentials.email, password: credentials.password, tenantId: context.tenant.id,
    } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: '账号或密码错误' });
  } finally { await context.cleanup(); }
});

it('isolates two personal accounts on real context and command APIs and enforces current roles and capability gates', async () => {
  const context = await createTestContext({ productAccess: { edition: 'commercial' } });
  try {
    const left = await register(context);
    const right = await register(context, { email: 'core208-b@example.test' });
    const customers: string[] = [];
    for (const owner of [left, right]) {
      const id = `customer_${randomUUID().replaceAll('-', '')}`;
      customers.push(id);
      const response = await context.app.inject({ method: 'POST', url: '/api/commands/customer',
        headers: { ...auth(owner.token), 'idempotency-key': randomUUID() }, payload: { type: 'CREATE_CUSTOMER',
          customer: { id, name: `Private ${id}`, categoryKey: null, primaryOwnerUserId: owner.user.id } } });
      expect(response.statusCode, response.body).toBe(200);
    }
    for (const [owner, index] of [[left, 0], [right, 1]] as const) {
      const response = await context.app.inject({ method: 'GET', url: '/api/crm/context', headers: auth(owner.token) });
      expect(response.statusCode).toBe(200);
      expect(response.json().customers.map((item: { id: string }) => item.id)).toEqual([customers[index]]);
      expect(response.body).not.toContain(customers[1 - index]);
      for (const url of ['/api/members', '/api/state']) {
        expect((await context.app.inject({ method: 'GET', url, headers: auth(owner.token) })).statusCode).toBe(403);
      }
    }
    const forged = context.app.jwt.sign({ userId: left.user.id, tenantId: right.tenant.id, role: 'owner' });
    expect((await context.app.inject({ method: 'GET', url: '/api/crm/context', headers: auth(forged) })).statusCode).toBe(401);
    await context.prisma.user.update({ where: { id: left.user.id }, data: { role: 'viewer' } });
    const denied = await context.app.inject({ method: 'POST', url: '/api/commands/customer',
      headers: { ...auth(left.token), 'idempotency-key': randomUUID() }, payload: { type: 'CREATE_CUSTOMER', customer: {
        id: `customer_${randomUUID().replaceAll('-', '')}`, name: 'Denied', categoryKey: null, primaryOwnerUserId: left.user.id,
      } } });
    expect(denied.statusCode).toBe(403);
    expect(await context.prisma.account.count({ where: { tenantId: left.tenant.id } })).toBe(1);
  } finally { await context.cleanup(); }
});
