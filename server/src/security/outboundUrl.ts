import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

export interface OutboundPolicy {
  allowedHosts: Set<string>;
  allowedPrivateHosts: Set<string>;
  requireHttps: boolean;
}

export interface OutboundFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

interface ResolvedOutboundUrl {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blockedV4.addSubnet(network, prefix, 'ipv4');

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  // Fail closed for IPv4-compatible, translated, NAT64 and 6to4 forms.
  // Their apparent global IPv6 address can route to a blocked IPv4 target.
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0:0', 96],
  ['100::', 64],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseAllowlist(value: string | undefined): string[] {
  return (value ?? '').split(',').map(normalizeHost).filter(Boolean);
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith('::ffff:')) return null;
  const tail = normalized.slice('::ffff:'.length);
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) return null;
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, 'ipv4');
  if (family === 6) {
    const mapped = mappedIpv4(address);
    return mapped ? blockedV4.check(mapped, 'ipv4') : blockedV6.check(address, 'ipv6');
  }
  return true;
}

async function resolveOutboundUrl(rawUrl: string, policy: OutboundPolicy): Promise<ResolvedOutboundUrl> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('出站 URL 无效'); }
  if (url.username || url.password) throw new Error('出站 URL 不允许内嵌凭据');
  if (policy.requireHttps && url.protocol !== 'https:') throw new Error('出站请求必须使用 HTTPS');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('出站 URL 协议不受支持');

  const host = normalizeHost(url.hostname);
  if (!policy.allowedHosts.has(host)) throw new Error(`出站主机不在部署允许列表：${host}`);

  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`出站主机 DNS 无解析结果：${host}`);
  if (!policy.allowedPrivateHosts.has(host) && addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error(`出站主机解析到 private/local network 地址：${host}`);
  }
  return { url, addresses };
}

export async function assertOutboundUrl(rawUrl: string, policy: OutboundPolicy): Promise<URL> {
  return (await resolveOutboundUrl(rawUrl, policy)).url;
}

export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): OutboundPolicy {
  const privateHosts = parseAllowlist(env.OUTBOUND_ALLOWED_PRIVATE_HOSTS);
  return {
    allowedHosts: new Set([...parseAllowlist(env.OUTBOUND_ALLOWED_HOSTS), ...privateHosts]),
    allowedPrivateHosts: new Set(privateHosts),
    requireHttps: true,
  };
}

export function deploymentOutboundPolicy(): OutboundPolicy {
  return outboundPolicyFromEnv(process.env);
}

async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('外部响应超过大小限制');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('外部响应超过大小限制');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function redirectedInit(status: number, init: RequestInit): RequestInit {
  const next: RequestInit = { ...init };
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    next.method = 'GET';
    delete next.body;
    headers.delete('content-type');
    headers.delete('content-length');
  }
  next.headers = headers;
  return next;
}

function pinnedDispatcher(addresses: Array<{ address: string; family: number }>): Agent {
  let cursor = 0;
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const candidates = options.family
          ? addresses.filter(({ family }) => family === options.family)
          : addresses;
        if (options.all) {
          (callback as unknown as (error: null, values: Array<{ address: string; family: number }>) => void)(null, candidates.length ? candidates : addresses);
          return;
        }
        const selected = candidates[cursor % candidates.length] ?? addresses[0];
        cursor += 1;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

export async function fetchOutbound(
  rawUrl: string,
  init: RequestInit,
  policy: OutboundPolicy,
  options: OutboundFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let current = await resolveOutboundUrl(rawUrl, policy);
  let currentInit: RequestInit = { ...init };

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const dispatcher = pinnedDispatcher(current.addresses);
    try {
      const response = await fetch(current.url, {
        ...currentInit,
        redirect: 'manual',
        signal,
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error('外部重定向缺少 Location');
        if (redirects === maxRedirects) throw new Error('外部请求重定向次数过多');
        const next = await resolveOutboundUrl(new URL(location, current.url).href, policy);
        if (current.url.origin !== next.url.origin) throw new Error('外部请求拒绝 cross-origin 跨主机重定向');
        currentInit = redirectedInit(response.status, currentInit);
        current = next;
        continue;
      }
      const body = await readCappedBody(response, maxResponseBytes);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error('外部请求重定向次数过多');
}
