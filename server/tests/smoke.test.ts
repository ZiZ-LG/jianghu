import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createTestContext } from './helpers/testApp.js';

describe('buildApp', () => {
  it('injects health without opening a port', async () => {
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('preserves warn-level startup logging when enabled', async () => {
    const app = await buildApp({ logger: true });
    try {
      expect(app.log.level).toBe('warn');
    } finally {
      await app.close();
    }
  });
});

async function registerTenant(app: Awaited<ReturnType<typeof buildApp>>) {
  const suffix = randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `tenant-${suffix}@example.test`,
      password: 'test-password',
      name: 'Test Owner',
      tenantName: `Test Tenant ${suffix}`,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string; tenant: { id: string } }>();
}

async function createAccount(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  id: string,
  name: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/mutate',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      action: {
        type: 'ADD_ACCOUNT',
        account: { id, name, customerType: 1 },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
}

describe('isolated integration context', () => {
  it('rejects unauthenticated state reads', async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({ method: 'GET', url: '/api/state' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await context.cleanup();
    }
  });

  it('allows same-name accounts in different tenants', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context.app);
      await createAccount(context.app, context.token, 'acc-tenant-a', 'Shared Account');
      await createAccount(context.app, tenantB.token, 'acc-tenant-b', 'Shared Account');

      const accounts = await context.prisma.account.findMany({
        where: { name: 'Shared Account' },
        select: { tenantId: true },
      });
      expect(accounts).toHaveLength(2);
      expect(new Set(accounts.map((account) => account.tenantId))).toEqual(
        new Set([context.tenant.id, tenantB.tenant.id]),
      );
    } finally {
      await context.cleanup();
    }
  });

  it("keeps tenant B's account out of tenant A's state", async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context.app);
      await createAccount(context.app, context.token, 'acc-state-a', 'Shared Account');
      await createAccount(context.app, tenantB.token, 'acc-state-b', 'Shared Account');

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/state',
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(response.statusCode).toBe(200);
      const state = response.json<{ accounts: Array<{ id: string; name: string }> }>();
      expect(state.accounts.map((account) => account.id)).toContain('acc-state-a');
      expect(state.accounts.map((account) => account.id)).not.toContain('acc-state-b');
    } finally {
      await context.cleanup();
    }
  });
});
