import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

describe('Fastify header-name security constraints (GHSA-389g-gv7q-r4x8)', () => {
  const denyLists = [
    { name: 'enum', rule: { not: { enum: ['X-Debug-Override'] } } },
    { name: 'const', rule: { not: { const: 'X-Debug-Override' } } },
  ];

  for (const { name, rule } of denyLists) {
    it.each(['X-Debug-Override', 'x-debug-override', 'x-DeBuG-oVeRrIdE'])(
      `rejects %s before its handler with a canonical-case ${name} deny-list`,
      async (headerName) => {
        const app = Fastify();
        let handlerCalls = 0;
        try {
          app.get('/restricted', {
            schema: { headers: { type: 'object', propertyNames: rule } },
          }, async () => {
            handlerCalls += 1;
            return { ok: true };
          });

          const denied = await app.inject({
            method: 'GET', url: '/restricted', headers: { [headerName]: '1' },
          });
          expect(denied.statusCode).toBe(400);
          expect(handlerCalls).toBe(0);

          const allowed = await app.inject({
            method: 'GET', url: '/restricted', headers: { 'X-Allowed': '1' },
          });
          expect(allowed.statusCode).toBe(200);
          expect(allowed.json()).toEqual({ ok: true });
          expect(handlerCalls).toBe(1);
        } finally {
          await app.close();
        }
      },
    );
  }

  it('preserves an existing lowercase header-name deny-list', async () => {
    const app = Fastify();
    try {
      app.get('/restricted', {
        schema: {
          headers: { type: 'object', propertyNames: { not: { enum: ['x-debug-override'] } } },
        },
      }, async () => ({ ok: true }));
      expect((await app.inject({
        method: 'GET', url: '/restricted', headers: { 'X-Debug-Override': '1' },
      })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/restricted' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('keeps header values case-sensitive while normalizing header names', async () => {
    const app = Fastify();
    try {
      app.get('/validated', {
        schema: {
          headers: {
            type: 'object',
            required: ['X-Mode'],
            properties: { 'X-Mode': { type: 'string', const: 'CaseSensitive' } },
          },
        },
      }, async () => ({ ok: true }));
      expect((await app.inject({
        method: 'GET', url: '/validated', headers: { 'x-MoDe': 'CaseSensitive' },
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: 'GET', url: '/validated', headers: { 'X-Mode': 'casesensitive' },
      })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/validated' })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
