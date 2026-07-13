import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchOutbound, type OutboundPolicy } from '../src/security/outboundUrl.js';

let server: Server;
let origin: string;
let streamClosed = false;
const sockets = new Set<Socket>();

const localPolicy: OutboundPolicy = {
  allowedHosts: new Set(['localhost']),
  allowedPrivateHosts: new Set(['localhost']),
  requireHttps: false,
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/stall-headers') return;
    if (path === '/stall-body') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first-chunk');
      return;
    }
    if (path === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.on('close', () => { streamClosed = true; });
      const timer = setInterval(() => res.write('0123456789abcdef'), 5);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (path.startsWith('/redirect/')) {
      res.writeHead(Number(path.split('/').at(-1)), { location: '/echo' });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      method: req.method,
      body: Buffer.concat(chunks).toString('utf8'),
      host: req.headers.host,
      localAddress: req.socket.localAddress,
    }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local test server did not bind');
  origin = `http://localhost:${address.port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('real Undici outbound boundary', () => {
  it('connects to a validated localhost DNS answer while preserving the original Host', async () => {
    const response = await fetchOutbound(`${origin}/echo`, {}, localPolicy, { timeoutMs: 1_000 });
    const data = await response.json() as { host: string; localAddress: string };
    expect(data.host).toMatch(/^localhost:/);
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(data.localAddress);
  });

  it.each(['/stall-headers', '/stall-body'])('aborts a real %s stall at the shared deadline', async (path) => {
    const started = Date.now();
    await expect(fetchOutbound(`${origin}${path}`, {}, localPolicy, {
      timeoutMs: 200,
      maxResponseBytes: 1_024,
    })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('cancels a real streaming response once the byte cap is crossed', async () => {
    streamClosed = false;
    await expect(fetchOutbound(`${origin}/stream`, {}, localPolicy, {
      timeoutMs: 1_000,
      maxResponseBytes: 24,
    })).rejects.toThrow(/响应超过大小限制/);
    await expect.poll(() => streamClosed).toBe(true);
  });

  it.each([
    [302, 'GET', ''],
    [303, 'GET', ''],
    [307, 'POST', 'payload'],
    [308, 'POST', 'payload'],
  ])('applies HTTP %i redirect method/body semantics', async (status, method, body) => {
    const response = await fetchOutbound(`${origin}/redirect/${status}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'payload',
    }, localPolicy, { timeoutMs: 1_000 });
    await expect(response.json()).resolves.toMatchObject({ method, body });
  });
});
