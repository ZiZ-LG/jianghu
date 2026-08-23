import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.cleanup();
});

async function contextFor(config: {
  edition: 'commercial' | 'internal';
  enabledEntitlements?: string[];
}) {
  const context = await createTestContext({ productAccess: config });
  contexts.push(context);
  return context;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function expectDenied(app: FastifyInstance, token: string, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  const response = await app.inject({ method, url, headers: auth(token), payload });
  expect(response.statusCode, response.body).toBe(403);
  expect(response.json()).toEqual({ error: '能力未启用', code: 'capability_denied' });
}

describe('server product capability enforcement', () => {
  it('returns the commercial Free policy and denies real gated service routes', async () => {
    const context = await contextFor({ edition: 'commercial' });
    const unauthenticated = await context.app.inject({ method: 'GET', url: '/api/members' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: 'unauthorized' });
    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: auth(context.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().product).toMatchObject({
      edition: 'commercial',
      shell: 'commercial',
      policy: { entitlements: ['crm.core'], permissions: [] },
    });

    expect((await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) })).statusCode).toBe(200);
    await expectDenied(context.app, context.token, 'POST', '/api/mutate', { action: {
      type: 'ADD_OPP', accId: 'missing-account',
      opp: { id: 'missing-opportunity', name: 'Direct bypass', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
    } });
    await expectDenied(context.app, context.token, 'POST', '/api/mutate', { action: {
      type: 'SET_ROLE', accId: 'missing-account', oppId: 'missing-opportunity', personId: 'missing-person', patch: { role: 'D' },
    } });
    await expectDenied(context.app, context.token, 'GET', '/api/members');
    await expectDenied(context.app, context.token, 'POST', '/api/opportunity/clone', {});
    await expectDenied(context.app, context.token, 'POST', '/api/commands/methodology', {});
    await expectDenied(context.app, context.token, 'GET', '/api/pde/missing/ev');
  });

  it('lets enabled capabilities reach their existing handlers without changing Free defaults', async () => {
    const context = await contextFor({
      edition: 'commercial',
      enabledEntitlements: ['sales.workspace', 'team.operations', 'methodology.g64111', 'decision.pde'],
    });

    expect((await context.app.inject({ method: 'GET', url: '/api/members', headers: auth(context.token) })).statusCode).toBe(200);
    expect((await context.app.inject({ method: 'POST', url: '/api/opportunity/clone', headers: auth(context.token), payload: {} })).statusCode).not.toBe(403);
    expect((await context.app.inject({ method: 'POST', url: '/api/commands/methodology', headers: auth(context.token), payload: {} })).statusCode).not.toBe(403);
    expect((await context.app.inject({ method: 'GET', url: '/api/pde/missing/ev', headers: auth(context.token) })).statusCode).not.toBe(403);
  });

  it('keeps the legacy internal adapter policy and service behavior enabled', async () => {
    const context = await contextFor({ edition: 'internal' });
    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: auth(context.token) });
    expect(me.json().product).toMatchObject({ edition: 'internal', shell: 'internal_legacy' });
    expect((await context.app.inject({ method: 'GET', url: '/api/members', headers: auth(context.token) })).statusCode).toBe(200);
    expect((await context.app.inject({ method: 'GET', url: '/api/pde/missing/ev', headers: auth(context.token) })).statusCode).not.toBe(403);
  });

  it('fails closed for malformed runtime capability configuration', async () => {
    const context = await contextFor({ edition: 'commercial', enabledEntitlements: ['root.everything'] });
    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: auth(context.token) });
    expect(me.json().product).toMatchObject({ valid: false, policy: { entitlements: [], permissions: [] } });
    await expectDenied(context.app, context.token, 'GET', '/api/state');
    await expectDenied(context.app, context.token, 'POST', '/api/mutate', {});
  });
});
