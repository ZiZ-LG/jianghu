import type { Action } from './store';
import type { Account } from './types';

// 生产构建把 VITE_API_URL 设为空串 "" → 走同源相对路径 /api（由 Nginx 反代到后端）。
// 开发未设(undefined) → 回退本地后端。用 ?? 而非 ||，确保空串不被误回退。
const BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'jianghu.token';
let token: string | null = localStorage.getItem(TOKEN_KEY);

async function req(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((opts.headers as Record<string, string>) || {}),
  };
  // 仅在确有请求体时声明 JSON content-type，否则 Fastify 会因空 body 报 400
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

export interface AuthResult {
  token: string;
  user: { id: string; phone: string | null; email: string | null; name: string; role: string };
  tenant: { id: string; name: string; plan: string; subscriptionStatus: string; seatLimit: number };
}
export interface Credentials { phone?: string; email?: string; password: string }

export const api = {
  getToken: () => token,
  setToken(t: string | null) {
    token = t;
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },
  register: (b: Credentials & { name: string; tenantName: string }): Promise<AuthResult> =>
    req('/api/auth/register', { method: 'POST', body: JSON.stringify(b) }),
  login: (b: Credentials): Promise<AuthResult> =>
    req('/api/auth/login', { method: 'POST', body: JSON.stringify(b) }),
  me: (): Promise<{ user: AuthResult['user']; tenant: AuthResult['tenant'] }> => req('/api/me'),
  getState: (): Promise<{ accounts: Account[] }> => req('/api/state'),
  mutate: (action: Action): Promise<{ ok: true }> => req('/api/mutate', { method: 'POST', body: JSON.stringify({ action }) }),
  demo: (): Promise<{ ok: true }> => req('/api/demo', { method: 'POST' }),
  reset: (): Promise<{ ok: true }> => req('/api/reset', { method: 'POST' }),
  billing: (): Promise<{ plan: string; subscriptionStatus: string; seatLimit: number; memberCount: number }> => req('/api/billing'),
  donate: (): Promise<{ url: string; qrUrl: string; note: string }> => req('/api/donate'),
  members: (): Promise<{ members: { id: string; phone: string | null; email: string | null; name: string; role: string; createdAt: string }[] }> => req('/api/members'),
  addMember: (b: { phone?: string; email?: string; name: string; password: string; role: string }) => req('/api/members', { method: 'POST', body: JSON.stringify(b) }),
  removeMember: (id: string) => req(`/api/members/${id}`, { method: 'DELETE' }),
  // AI 模型（BYO-key）
  aiConfig: (): Promise<{ configured: boolean; provider: string; baseUrl: string; model: string; hasKey: boolean }> => req('/api/ai/config'),
  aiSaveConfig: (b: { provider: string; baseUrl?: string; model?: string; apiKey?: string }) => req('/api/ai/config', { method: 'PUT', body: JSON.stringify(b) }),
  aiTest: (): Promise<{ ok: boolean; message?: string }> => req('/api/ai/test', { method: 'POST' }),
  aiSimulate: (context: any, hypothesis: string): Promise<{ analysis: string; provider: string }> =>
    req('/api/ai/simulate', { method: 'POST', body: JSON.stringify({ context, hypothesis }) }),
  // AI 关系推断（待确认候选）
  suggestList: (opportunityId: string): Promise<{ suggestions: Suggestion[] }> => req(`/api/suggest?opportunityId=${encodeURIComponent(opportunityId)}`),
  suggestGenerate: (opportunityId: string): Promise<{ added: number; suggestions: Suggestion[] }> => req('/api/suggest/generate', { method: 'POST', body: JSON.stringify({ opportunityId }) }),
  suggestAccept: (id: string): Promise<{ edge: any }> => req(`/api/suggest/${id}/accept`, { method: 'POST' }),
  suggestReject: (id: string): Promise<{ ok: true }> => req(`/api/suggest/${id}/reject`, { method: 'POST' }),
  // 企查查 / 自动建图
  qccConfig: (): Promise<{ configured: boolean; baseUrl: string; appKey: string; hasSecret: boolean }> => req('/api/qcc/config'),
  qccSaveConfig: (b: { baseUrl?: string; appKey?: string; secretKey?: string }) => req('/api/qcc/config', { method: 'PUT', body: JSON.stringify(b) }),
  qccTest: (): Promise<{ ok: boolean; message?: string }> => req('/api/qcc/test', { method: 'POST' }),
  enrichCompany: (name: string): Promise<{ source: string; company: string; persons: { name: string; title: string }[]; note: string }> =>
    req('/api/enrich/company', { method: 'POST', body: JSON.stringify({ name }) }),
};

export interface Suggestion {
  id: string; source: string; target: string; sourceName: string; targetName: string;
  layer: string; label: string; confidence: number; origin: string; evidence: string;
}
