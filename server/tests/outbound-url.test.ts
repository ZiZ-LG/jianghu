import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));

import { callLLM } from '../src/ai.js';
import { getAccessToken } from '../src/wecom.js';
import {
  assertOutboundUrl,
  fetchOutbound,
  outboundPolicyFromEnv,
} from '../src/security/outboundUrl.js';

const publicOnly = {
  allowedHosts: new Set(['8.8.8.8', 'provider.example.com']),
  allowedPrivateHosts: new Set<string>(),
  requireHttps: true,
};

describe('outbound URL policy', () => {
  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    'https://127.0.0.1/v1',
    'https://10.2.3.4/v1',
    'https://172.16.0.1/v1',
    'https://192.168.1.1/v1',
    'https://100.64.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://[fc00::1]/v1',
    'https://[fe80::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://[64:ff9b::127.0.0.1]/v1',
    'https://[64:ff9b::169.254.169.254]/latest/meta-data',
    'https://[64:ff9b::10.0.0.1]/v1',
    'https://[64:ff9b::100.64.0.1]/v1',
    'https://[64:ff9b:1::10.0.0.1]/v1',
    'https://[::127.0.0.1]/v1',
    'https://[::ffff:0:127.0.0.1]/v1',
    'https://[2002:7f00:1::]/v1',
  ])('rejects local/private target %s', async (url) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    await expect(assertOutboundUrl(url, {
      ...publicOnly,
      allowedHosts: new Set([...publicOnly.allowedHosts, host]),
    })).rejects.toThrow(/private|local|network|地址/i);
  });

  it('rejects non-HTTPS and hosts absent from the deployment allowlist', async () => {
    await expect(assertOutboundUrl('http://8.8.8.8/v1', publicOnly)).rejects.toThrow(/HTTPS/i);
    await expect(assertOutboundUrl('https://1.1.1.1/v1', publicOnly)).rejects.toThrow(/allowlist|允许/i);
  });

  it('rejects a hostname when any A or AAAA result is private', async () => {
    lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: 'fd00::10', family: 6 },
    ]);
    await expect(assertOutboundUrl('https://provider.example.com/v1', publicOnly)).rejects.toThrow(/private|local|network|地址/i);
    expect(lookup).toHaveBeenCalledWith('provider.example.com', { all: true, verbatim: true });
  });

  it('allows a deployment-approved private service only when separately private-approved', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);
    await expect(assertOutboundUrl('https://provider.example.com/v1', {
      ...publicOnly,
      allowedPrivateHosts: new Set(['provider.example.com']),
    })).resolves.toBeInstanceOf(URL);
  });

  it('revalidates redirect targets before issuing the redirected request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/metadata' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOutbound('https://8.8.8.8/start', {}, publicOnly)).rejects.toThrow(/allowlist|private|local|network|地址|允许/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses cross-origin redirects instead of forwarding credentials or request bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: 'https://provider.example.com/collect' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOutbound('https://8.8.8.8/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({ client_secret: 'secret' }),
    }, publicOnly)).rejects.toThrow(/cross-origin|跨主机/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses manual redirects, a timeout signal, and caps response bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('x'.repeat(33)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOutbound('https://8.8.8.8/data', {}, publicOnly, {
      timeoutMs: 50,
      maxResponseBytes: 32,
    })).rejects.toThrow(/large|size|响应/i);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels an oversized declared response before closing the connection pool', async () => {
    const response = new Response('oversized', { headers: { 'content-length': '1000' } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(fetchOutbound('https://8.8.8.8/data', {}, publicOnly, {
      maxResponseBytes: 32,
    })).rejects.toThrow(/large|size|响应/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('pins the request dispatcher to the DNS answers that passed validation', async () => {
    lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchOutbound('https://provider.example.com/data', {}, publicOnly);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: { dispatch?: unknown } };
    expect(init.dispatcher).toBeDefined();
    expect(init.dispatcher?.dispatch).toBeTypeOf('function');
  });

  it('does not let an arbitrary AI baseUrl trigger fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: 'unsafe' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLLM(
      { baseUrl: 'http://127.0.0.1:3000', model: 'x', apiKey: 'secret' },
      'system',
      'user',
    )).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes the fixed WeCom provider through the deployment egress policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ errcode: 0, access_token: 'unsafe' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAccessToken('test-tenant', `corp-${Date.now()}`, 'secret')).rejects.toThrow(/allowlist|允许/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds allowlists only from deployment environment values', () => {
    const policy = outboundPolicyFromEnv({
      OUTBOUND_ALLOWED_HOSTS: 'api.example.com, open.feishu.cn',
      OUTBOUND_ALLOWED_PRIVATE_HOSTS: 'internal.example.com',
    });
    expect([...policy.allowedHosts]).toEqual(['api.example.com', 'open.feishu.cn', 'internal.example.com']);
    expect([...policy.allowedPrivateHosts]).toEqual(['internal.example.com']);
  });
});
