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
// 登录命中「同一手机号/邮箱在多个工作区都有账号」时，后端返回候选工作区让用户选（而非直接发 token）
export interface WorkspaceChoice { needWorkspace: true; workspaces: { tenantId: string; tenantName: string }[] }

export const api = {
  getToken: () => token,
  setToken(t: string | null) {
    token = t;
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },
  register: (b: Credentials & { name: string; tenantName: string }): Promise<AuthResult> =>
    req('/api/auth/register', { method: 'POST', body: JSON.stringify(b) }),
  login: (b: Credentials & { tenantId?: string }): Promise<AuthResult | WorkspaceChoice> =>
    req('/api/auth/login', { method: 'POST', body: JSON.stringify(b) }),
  me: (): Promise<{ user: AuthResult['user']; tenant: AuthResult['tenant'] }> => req('/api/me'),
  getState: (): Promise<{ accounts: Account[] }> => req('/api/state'),
  mutate: (action: Action): Promise<{ ok: true }> => req('/api/mutate', { method: 'POST', body: JSON.stringify({ action }) }),
  // 录入情报：口述文字 → 后端 LLM 抽取 + 双轨落库 → 回执
  voiceExtract: (b: { text: string; accountId?: string; opportunityId?: string; priorText?: string }): Promise<any> =>
    req('/api/voice/extract', { method: 'POST', body: JSON.stringify(b) }),
  // 新建商机：空白(personIds 空) 或 从 fromOppId 克隆选定人物(+角色，可选关系线)
  cloneOpportunity: (b: { accountId: string; name: string; fromOppId?: string; personIds: string[]; withEdges: boolean }): Promise<{ opportunityId: string; memberCount: number }> =>
    req('/api/opportunity/clone', { method: 'POST', body: JSON.stringify(b) }),
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
  // 采纳关系：可能级联建新 Person（端点是候选人物时），返回 createdPersons 供前端先 ADD_PERSON 再 ADD_EDGE
  suggestAccept: (id: string): Promise<{ edge: any; createdPersons?: any[] }> => req(`/api/suggest/${id}/accept`, { method: 'POST' }),
  suggestReject: (id: string): Promise<{ ok: true }> => req(`/api/suggest/${id}/reject`, { method: 'POST' }),
  // 候选干系人（外部 agent 经 MCP propose_person 写入，待人审）
  personSuggestList: (accountId: string): Promise<{ suggestions: PersonSuggestion[] }> => req(`/api/suggest/persons?accountId=${encodeURIComponent(accountId)}`),
  personSuggestAccept: (id: string): Promise<{ person: any; accId: string }> => req(`/api/suggest/persons/${id}/accept`, { method: 'POST' }),
  personSuggestReject: (id: string): Promise<{ ok: true }> => req(`/api/suggest/persons/${id}/reject`, { method: 'POST' }),
  // 企查查 MCP / 自动建图
  qccConfig: (): Promise<{ configured: boolean; mode: string; endpoint: string; hasToken: boolean }> => req('/api/qcc/config'),
  qccSaveConfig: (b: { mcpJson: string }): Promise<{ ok: true; endpoint: string }> => req('/api/qcc/config', { method: 'PUT', body: JSON.stringify(b) }),
  qccClearConfig: (): Promise<{ ok: true }> => req('/api/qcc/config', { method: 'DELETE' }),
  qccTest: (): Promise<{ ok: boolean; message?: string }> => req('/api/qcc/test', { method: 'POST' }),
  qccResolve: (query: string): Promise<{ exact: boolean; candidates: CompanyCandidate[] }> =>
    req('/api/qcc/resolve', { method: 'POST', body: JSON.stringify({ query }) }),
  enrichCompany: (name: string, mode: 'auto' | 'web' = 'auto'): Promise<{ source: string; company: string; persons: { name: string; title: string }[]; note: string }> =>
    req('/api/enrich/company', { method: 'POST', body: JSON.stringify({ name, mode }) }),
  // 企查查 股权/对外投资（只读·仅供参考，不写库）。name 须为完整登记名（先经 qccResolve 锚定）。
  qccCompanyData: (name: string): Promise<CompanyEquityData> =>
    req('/api/qcc/company-data', { method: 'POST', body: JSON.stringify({ name }) }),
  // AI 助手接入令牌（长效，给外部 agent 连 MCP 用）
  accessTokenList: (): Promise<{ tokens: AccessTokenInfo[] }> => req('/api/access-tokens'),
  accessTokenCreate: (name: string): Promise<{ id: string; name: string; token: string; lastFour: string }> =>
    req('/api/access-tokens', { method: 'POST', body: JSON.stringify({ name }) }),
  accessTokenRevoke: (id: string): Promise<{ ok: true }> => req(`/api/access-tokens/${id}`, { method: 'DELETE' }),
};

export interface AccessTokenInfo { id: string; name: string; lastFour: string; createdAt: string; lastUsedAt: string | null }

export interface Shareholder { name: string; ratio: string; amount: string }
export interface Investment { name: string; ratio: string; status: string; establishDate: string }
export interface CompanyEquityData { shareholders: Shareholder[]; investments: Investment[] }

export interface CompanyCandidate {
  name: string; creditCode: string; legalPerson: string; status: string; establishDate: string;
}

export interface Suggestion {
  id: string; source: string; target: string; sourceName: string; targetName: string;
  sourceKind?: string; targetKind?: string; // person | suggestion（端点是否为候选人物）
  layer: string; label: string; confidence: number; origin: string; evidence: string;
}

// 候选干系人（外部 agent 经 MCP 提议，待人审采纳才建正式 Person）
export interface PersonSuggestion {
  id: string; accountId: string; name: string; title: string; orgLevel: number;
  origin: string; evidence: string; sourceUrl?: string; confidence: number;
  existingPersonId?: string; // 该客户下已有同名正式干系人时给出，供"合并/新建"提示
}
