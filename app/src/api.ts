import type { Action } from './store';
import type { Account, PipelineStage } from './types';
import { toWireAction } from './wireAction';

// 生产构建把 VITE_API_URL 设为空串 "" → 走同源相对路径 /api（由 Nginx 反代到后端）。
// 开发未设(undefined) → 回退本地后端。用 ?? 而非 ||，确保空串不被误回退。
const BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'jianghu.token';
const storage = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' ? localStorage : null;
let token: string | null = storage?.getItem(TOKEN_KEY) ?? null;
const unauthorizedListeners = new Set<(error: ApiError) => void>();

const bearerTokenFrom = (headers: Headers): string | null => {
  const authorization = headers.get('Authorization');
  const match = authorization?.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return match?.[1] ?? null;
};

export interface ApiErrorInit {
  status?: number;
  code?: string;
  message: string;
  retryable?: boolean;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor({ status, code = 'request_failed', message, retryable = false, cause }: ApiErrorInit) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new ApiError({ code: 'aborted', message: '请求已取消', retryable: true, cause });
  }
  return new ApiError({ code: 'network_error', message: cause instanceof Error ? cause.message : '网络请求失败', retryable: true, cause });
}

export function isConfirmedAuthFailure(cause: unknown): boolean {
  const status = cause instanceof ApiError
    ? cause.status
    : typeof cause === 'object' && cause !== null && 'status' in cause
      ? Number((cause as { status?: unknown }).status)
      : undefined;
  return status === 401 || status === 403;
}

export async function request<T = unknown>(
  path: string,
  opts: RequestInit = {},
  requestOptions: { timeoutMs?: number } = {},
): Promise<T> {
  const headers = new Headers(opts.headers);
  if (!headers.has('Authorization') && token) headers.set('Authorization', `Bearer ${token}`);
  // 仅在确有请求体时声明 JSON content-type，否则 Fastify 会因空 body 报 400。
  // FormData（文件上传）例外：让浏览器自动带 multipart boundary，不能手动设。
  if (opts.body && !(opts.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const requestBearerToken = bearerTokenFrom(headers);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = requestOptions.timeoutMs ?? 30_000;
  const timeout = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
    : undefined;
  const onExternalAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const res = await fetch(BASE + path, { ...opts, headers, signal: controller.signal });
    const data = await res.json().catch(() => ({})) as { error?: string; message?: string; code?: string };
    if (!res.ok) {
      const error = new ApiError({
        status: res.status,
        code: data.code ?? (res.status === 409 ? 'version_conflict' : `http_${res.status}`),
        message: data.error || data.message || `请求失败（HTTP ${res.status}）`,
        retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      });
      if (res.status === 401 && requestBearerToken === token) {
        unauthorizedListeners.forEach((listener) => listener(error));
      }
      throw error;
    }
    return data as T;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    if (timedOut) throw new ApiError({ code: 'timeout', message: '请求超时，请重试', retryable: true, cause });
    throw toApiError(cause);
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

const req = request;
const commandReq = async <T>(path: string, opts: RequestInit, requestOptions: { timeoutMs?: number } = {}): Promise<T> => {
  try { return await request<T>(path, opts, requestOptions); }
  catch (cause) {
    const error = toApiError(cause);
    if (error.code !== 'network_error' && error.code !== 'timeout') throw error;
    return request<T>(path, opts, requestOptions); // 同一 opts 保留同一个 Idempotency-Key。
  }
};
export const newIdempotencyKey = (): string => crypto.randomUUID();

export interface AuthResult {
  token: string;
  user: { id: string; phone: string | null; email: string | null; name: string; role: string };
  tenant: { id: string; name: string; plan: string; subscriptionStatus: string; seatLimit: number };
}
export interface Credentials { phone?: string; email?: string; password: string }
// 登录命中「同一手机号/邮箱在多个工作区都有账号」时，后端返回候选工作区让用户选（而非直接发 token）
export interface WorkspaceChoice { needWorkspace: true; workspaces: { tenantId: string; tenantName: string }[] }
// 录音转写（列表脱敏：不含正文，只有元数据 + hasContent 标志）
export interface Transcript {
  id: string; source: string; title: string;
  accountId: string | null; opportunityId: string | null;
  durationSec: number; status: string;
  recordedAt: string | null; extractedAt: string | null; createdAt: string;
  hasContent: boolean;
}

export interface ArchivedEntity {
  id: string;
  target: 'account' | 'opportunity';
  name: string;
  accountId?: string;
  accountName?: string;
  archivedAt: string;
  archivedBy: string | null;
  archiveReason: string;
  canRestore?: boolean;
}

export interface AccountRepairPatch {
  base: {
    name: string;
    customerType: 1 | 2 | 3 | 4;
    primaryOwner: string;
    primaryOwnerUserId: string | null;
  };
  name?: string;
  customerType?: 1 | 2 | 3 | 4;
  primaryOwnerUserId?: string | null;
}

export interface OpportunityRepairPatch {
  baseVersion: number;
  name?: string;
  pipelineStage?: PipelineStage;
  status?: 'active' | 'paused' | 'won' | 'lost';
  expectedAmountW?: number;
  expectedSignDate?: string;
  singleSalesGoal?: string;
  competitiveSituation?: '' | '领先' | '胶着' | '落后' | '未识别';
}

export interface RepairContext {
  source: string;
  sourceRef: string | null;
  syncedAt: string | null;
  syncRuns: Array<{ id: string; status: string; createdAt: string; updatedAt: string }>;
  auditEvents: Array<{
    id: string;
    action: string;
    actorId: string;
    channel: string;
    changedFields: string[];
    createdAt: string;
  }>;
}

export type PersonMergeRoleDecision = 'keep_target' | 'keep_source';
export interface PersonMergeDecision {
  targetPersonId: string;
  sourcePersonId: string;
  roleConflictByOpportunity: Record<string, PersonMergeRoleDecision>;
}
export interface PersonMergePreview {
  accountId: string;
  targetPerson: { id: string; name: string; title: string };
  sourcePerson: { id: string; name: string; title: string };
  conflicts: Array<{
    opportunityId: string;
    opportunityName: string;
    archived: boolean;
    targetRole: { role: string; sentiment: string; confidence: string };
    sourceRole: { role: string; sentiment: string; confidence: string };
  }>;
}

export const api = {
  getToken: () => token,
  setToken(t: string | null) {
    token = t;
    if (t) storage?.setItem(TOKEN_KEY, t);
    else storage?.removeItem(TOKEN_KEY);
  },
  onUnauthorized(listener: (error: ApiError) => void) {
    unauthorizedListeners.add(listener);
    return () => { unauthorizedListeners.delete(listener); };
  },
  register: (b: Credentials & { name: string; tenantName: string }): Promise<AuthResult> =>
    req('/api/auth/register', { method: 'POST', body: JSON.stringify(b) }),
  login: (b: Credentials & { tenantId?: string }): Promise<AuthResult | WorkspaceChoice> =>
    req('/api/auth/login', { method: 'POST', body: JSON.stringify(b) }),
  me: (): Promise<{ user: AuthResult['user']; tenant: AuthResult['tenant'] }> => req('/api/me'),
  getState: (): Promise<{ accounts: Account[] }> => req('/api/state'),
  mutate: (action: Action): Promise<{ ok: true }> => req('/api/mutate', { method: 'POST', body: JSON.stringify({ action: toWireAction(action) }) }),
  // 录入情报：口述文字 → 后端 LLM 抽取 + 双轨落库 → 回执
  voiceExtract: (b: { text: string; accountId?: string; opportunityId?: string; personId?: string; priorText?: string; sourceVisitId?: string }, idempotencyKey: string): Promise<any> =>
    commandReq('/api/voice/extract', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }, { timeoutMs: 120_000 }),
  // 新建商机：空白(personIds 空) 或 从 fromOppId 克隆选定人物(+角色，可选关系线)
  cloneOpportunity: (b: { accountId: string; name: string; fromOppId?: string; personIds: string[]; withEdges: boolean }): Promise<{ opportunityId: string; memberCount: number }> =>
    req('/api/opportunity/clone', { method: 'POST', body: JSON.stringify(b) }),
  opportunitySkeleton: (b: { accountId: string; name: string; fromOppId?: string; personIds: string[]; withEdges: boolean; skeleton: Array<{ title: string; role: string; orgLevel: number; x: number; y: number }> }, idempotencyKey: string): Promise<{ opportunityId: string; memberCount: number; skeletonPersonIds: string[]; replayed: boolean }> =>
    commandReq('/api/commands/opportunity-skeleton', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }),
  actionFeedback: (b: { accountId: string; opportunityId: string; actionId: string; outcome: 'up' | 'flat' | 'down'; occurredAt: string }, idempotencyKey: string): Promise<{ evidenceId?: string; replayed: boolean }> =>
    commandReq('/api/commands/action-feedback', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }),
  inboxBatch: (b: { items: Array<{ kind: 'proposal' | 'person' | 'rel' | 'evidence' | 'reminder'; id: string; decision: 'accept' | 'reject'; overrideValue?: string; personOverride?: { name?: string; title?: string }; relOverride?: { layer?: string; label?: string }; direction?: -1 | 0 | 1 }> }, idempotencyKey: string): Promise<{ items: Array<{ kind: string; id: string; status: string }>; replayed: boolean }> =>
    commandReq('/api/commands/inbox-batch', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }),
  demo: (): Promise<{ ok: true }> => req('/api/demo', { method: 'POST' }),
  archive: (target: 'account' | 'opportunity', id: string, reason: string): Promise<{ ok: true }> =>
    req('/api/archive', { method: 'POST', body: JSON.stringify({ target, id, reason }) }),
  archived: (): Promise<{ accounts: ArchivedEntity[]; opportunities: ArchivedEntity[] }> => req('/api/archive'),
  restore: (target: 'account' | 'opportunity', id: string): Promise<{ ok: true }> =>
    req('/api/archive/restore', { method: 'POST', body: JSON.stringify({ target, id }) }),
  repairAccount: (id: string, patch: AccountRepairPatch): Promise<{ ok: true }> =>
    req(`/api/repair/account/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  repairOpportunity: (id: string, patch: OpportunityRepairPatch): Promise<{ ok: true }> =>
    req(`/api/repair/opportunity/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  repairRebind: (input: { kind: 'visitNote' | 'note'; id: string; accountId: string; opportunityId?: string | null }): Promise<{ ok: true }> =>
    req('/api/repair/rebind', { method: 'POST', body: JSON.stringify(input) }),
  repairContext: (kind: 'account' | 'opportunity' | 'visitNote' | 'note', id: string): Promise<RepairContext> =>
    req(`/api/repair/context/${kind}/${encodeURIComponent(id)}`),
  repairPersonMergePreview: (targetPersonId: string, sourcePersonId: string): Promise<PersonMergePreview> =>
    req(`/api/repair/person-merge/preview?targetPersonId=${encodeURIComponent(targetPersonId)}&sourcePersonId=${encodeURIComponent(sourcePersonId)}`),
  repairPersonMerge: (decision: PersonMergeDecision, idempotencyKey: string): Promise<{
    sourcePersonId: string; targetPersonId: string; redirected: Record<string, number>;
  }> => commandReq('/api/repair/person-merge', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(decision),
  }),
  billing: (): Promise<{ plan: string; subscriptionStatus: string; seatLimit: number; memberCount: number }> => req('/api/billing'),
  donate: (): Promise<{ url: string; qrUrl: string; note: string }> => req('/api/donate'),
  members: (): Promise<{ members: { id: string; phone: string | null; email: string | null; name: string; role: string; createdAt: string }[] }> => req('/api/members'),
  addMember: (b: { phone?: string; email?: string; name: string; password: string; role: string }) => req('/api/members', { method: 'POST', body: JSON.stringify(b) }),
  removeMember: (id: string) => req(`/api/members/${id}`, { method: 'DELETE' }),
  resetMemberPassword: (id: string, password: string) => req(`/api/members/${id}/password`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  // AI 模型（BYO-key）
  aiConfig: (): Promise<{ configured: boolean; provider: string; baseUrl: string; model: string; hasKey: boolean }> => req('/api/ai/config'),
  aiSaveConfig: (b: { provider: string; baseUrl?: string; model?: string; apiKey?: string }) => req('/api/ai/config', { method: 'PUT', body: JSON.stringify(b) }),
  // 企微集成：租户应用配置(管理员·Secret/AESKey 不回明文) + 当前用户 userid 绑定 + 回调 + 测试推送
  wecomConfig: (): Promise<{ configured: boolean; corpId: string; agentId: string; hasSecret: boolean; hasCallback: boolean; callbackUrl: string }> => req('/api/wecom/config'),
  wecomSaveConfig: (b: { corpId?: string; agentId?: string; secret?: string; callbackToken?: string; callbackAesKey?: string }) => req('/api/wecom/config', { method: 'PUT', body: JSON.stringify(b) }),
  wecomBind: (): Promise<{ wecomUserid: string }> => req('/api/wecom/bind'),
  wecomSaveBind: (wecomUserid: string) => req('/api/wecom/bind', { method: 'PUT', body: JSON.stringify({ wecomUserid }) }),
  wecomOauthStart: (): Promise<{ url: string; requestId: string }> => req('/api/wecom/oauth/start'),
  wecomOauthStatus: (requestId: string): Promise<{ status: 'waiting' | 'pending' | 'expired' | 'consumed'; wecomUserid?: string }> =>
    req(`/api/wecom/oauth/status?requestId=${encodeURIComponent(requestId)}`),
  wecomOauthConfirm: (requestId: string): Promise<{ ok: true; wecomUserid: string }> =>
    req('/api/wecom/oauth/confirm', { method: 'POST', body: JSON.stringify({ requestId }) }),
  wecomTestPush: (kind: 'textcard' | 'card') => req('/api/wecom/test-push', { method: 'POST', body: JSON.stringify({ kind }) }), // V1 文本卡 / V2 按钮卡
  // PDE 决策引擎（评估主链；赢面永不脱离 confidenceFlag）
  pdeEv: (oppId: string): Promise<any> => req(`/api/pde/${oppId}/ev`),
  pdeIntel: (oppId: string): Promise<any> => req(`/api/pde/${oppId}/intel-priorities`), // 拜访卡「这次问什么」
  pdeActions: (oppId: string): Promise<any> => req(`/api/pde/${oppId}/action-ranking`),
  pdeSnapshot: (oppId: string) => req(`/api/pde/${oppId}/snapshot`, { method: 'POST' }),
  pdeSnapshots: (oppId: string): Promise<{ snapshots: any[] }> => req(`/api/pde/${oppId}/snapshots`), // 复盘台走势（M5）
  // what-if 假设推演（复盘台抽屉）：假设立场/可信度变化→赢面对比。纯计算零写库；overrides 用前端值域。
  pdeWhatIf: (oppId: string, overrides: { personId: string; sentiment?: string; confidence?: string }[]): Promise<{ base: any; hypo: any; dPwin: number; stakeholders: { id: string; name: string; sentiment: string; confidence: string }[]; potSource: string; confidenceFlag: string }> =>
    req(`/api/pde/${oppId}/what-if`, { method: 'POST', body: JSON.stringify({ overrides }) }),
  aiTest: (): Promise<{ ok: boolean; message?: string }> => req('/api/ai/test', { method: 'POST' }),
  aiSimulate: (context: any, hypothesis: string): Promise<{ analysis: string; provider: string }> =>
    req('/api/ai/simulate', { method: 'POST', body: JSON.stringify({ context, hypothesis }) }),
  // 策略沙盘 AI 顺推(策略卡候选)/倒推(里程碑候选)——只返回候选，前端暂存 + 人审采纳后才落库
  strategySuggest: (opportunityId: string, mode: 'forward' | 'backward', context: any): Promise<{ mode: string; candidates: any[]; provider: string }> =>
    req('/api/strategy/suggest', { method: 'POST', body: JSON.stringify({ opportunityId, mode, context }) }),
  // 参谋出牌（P2④b）：右栏焦点人 → AI 产行动牌候选（六要素之 目的/资源/注意）。只返回候选，人审采纳才 dispatch ADD_PLAN_ACTION 落画布。
  advisorActions: (opportunityId: string, focus: { name: string; title?: string }, context: any, note?: string): Promise<{ candidates: AdvisorCand[]; provider: string }> =>
    req('/api/strategy/actions', { method: 'POST', body: JSON.stringify({ opportunityId, focus, context, note }) }),
  // 派发预填（第3刀）：策略卡→行动牌四要素初稿 {target,resources,cautions,props}。只返回初稿，前端落草稿(origin=ai)开抽屉人微调。
  strategyPrefill: (opportunityId: string, card: { title?: string; basis?: string; gapItem?: string }, person: { name: string; title?: string } | undefined, context: any): Promise<{ prefill: { target: string; resources: string; cautions: string; props: string }; provider: string }> =>
    req('/api/strategy/prefill', { method: 'POST', body: JSON.stringify({ opportunityId, card, person, context }) }),
  // P6 里程碑「→ 排行动」：为达成里程碑拆 2-3 个行动候选（只返回候选，前端落 draft 草稿人审）
  milestoneActions: (opportunityId: string, milestone: { title: string; date?: string }, context: any, existingTitles: string[]): Promise<{ candidates: { title: string; target: string; cautions: string }[]; provider: string }> =>
    req('/api/strategy/milestone-actions', { method: 'POST', body: JSON.stringify({ opportunityId, milestone, context, existingTitles }) }),
  // P8 参谋会话历史（商机×焦点人 分桶）：读回放 / 追加一问一答 / 清空
  advisorHistory: (opportunityId: string, personId: string): Promise<{ messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }[] }> =>
    req(`/api/advisor/messages?opportunityId=${encodeURIComponent(opportunityId)}&personId=${encodeURIComponent(personId)}`),
  advisorAppend: (opportunityId: string, personId: string, entries: { role: 'user' | 'assistant'; text: string }[]): Promise<{ ok: true }> =>
    req('/api/advisor/messages', { method: 'POST', body: JSON.stringify({ opportunityId, personId, entries }) }),
  advisorClear: (opportunityId: string, personId: string): Promise<{ ok: true }> =>
    req(`/api/advisor/messages?opportunityId=${encodeURIComponent(opportunityId)}&personId=${encodeURIComponent(personId)}`, { method: 'DELETE' }),
  // AI 关系推断（待确认候选）
  suggestList: (opportunityId: string): Promise<{ suggestions: Suggestion[] }> => req(`/api/suggest?opportunityId=${encodeURIComponent(opportunityId)}`),
  suggestGenerate: (opportunityId: string): Promise<{ added: number; suggestions: Suggestion[] }> => req('/api/suggest/generate', { method: 'POST', body: JSON.stringify({ opportunityId }) }),
  // 采纳关系：可能级联建新 Person（端点是候选人物时），返回 createdPersons 供前端先 ADD_PERSON 再 ADD_EDGE
  suggestAccept: (id: string, override?: { layer?: string; label?: string }): Promise<{ edge: any; createdPersons?: any[] }> => req(`/api/suggest/${id}/accept`, { method: 'POST', body: JSON.stringify(override ?? {}) }), // P10 改后采纳
  suggestReject: (id: string): Promise<{ ok: true }> => req(`/api/suggest/${id}/reject`, { method: 'POST' }),
  // 候选干系人（外部 agent 经 MCP propose_person 写入，待人审）
  personSuggestList: (accountId: string): Promise<{ suggestions: PersonSuggestion[] }> => req(`/api/suggest/persons?accountId=${encodeURIComponent(accountId)}`),
  personSuggestAccept: (id: string, override?: { name?: string; title?: string }): Promise<{ person: any; accId: string }> => req(`/api/suggest/persons/${id}/accept`, { method: 'POST', body: JSON.stringify(override ?? {}) }), // P10 改后采纳
  personSuggestReject: (id: string): Promise<{ ok: true }> => req(`/api/suggest/persons/${id}/reject`, { method: 'POST' }),
  // Hub 级审核收件箱：聚合当前租户所有 pending 候选（关系 + 人物），带 account/opp 上下文 + P2 引擎心跳
  inboxList: (): Promise<{ rels: InboxRel[]; persons: InboxPerson[]; proposals: InboxProposal[]; reminders: InboxReminder[]; evidences: InboxEvidence[]; total: number; patrol?: PatrolInfo | null }> => req('/api/inbox'),
  // M3 证据审核：approve（可带 direction 定向=修改后采纳）/ reject。批准落 evidence_review 快照
  evidenceReview: (id: string, action: 'approve' | 'reject', opts?: { direction?: -1 | 0 | 1 }): Promise<{ ok: true; status: string }> =>
    req(`/api/evidence/${id}/review`, { method: 'POST', body: JSON.stringify({ action, ...opts }) }),
  // 字段更新提案（v2.0）：采纳（可改后采纳 overrideValue）/ 驳回
  proposalAccept: (id: string, overrideValue?: string): Promise<{ ok: true }> => req(`/api/proposals/${id}/accept`, { method: 'POST', body: JSON.stringify({ overrideValue }) }),
  proposalReject: (id: string): Promise<{ ok: true }> => req(`/api/proposals/${id}/reject`, { method: 'POST' }),
  reminderDismiss: (id: string): Promise<{ ok: true }> => req(`/api/reminders/${id}/dismiss`, { method: 'POST' }),
  // 企查查 MCP / 自动建图
  qccConfig: (): Promise<{ configured: boolean; mode: string; endpoint: string; hasToken: boolean }> => req('/api/qcc/config'),
  qccSaveConfig: (b: { mcpJson: string }): Promise<{ ok: true; endpoint: string }> => req('/api/qcc/config', { method: 'PUT', body: JSON.stringify(b) }),
  qccClearConfig: (): Promise<{ ok: true }> => req('/api/qcc/config', { method: 'DELETE' }),
  qccTest: (): Promise<{ ok: boolean; message?: string }> => req('/api/qcc/test', { method: 'POST' }),
  qccResolve: (query: string): Promise<{ exact: boolean; candidates: CompanyCandidate[] }> =>
    req('/api/qcc/resolve', { method: 'POST', body: JSON.stringify({ query }) }),
  enrichCompany: (name: string, mode: 'auto' | 'web' = 'auto'): Promise<{ source: string; company: string; persons: { name: string; title: string }[]; note: string }> =>
    req('/api/enrich/company', { method: 'POST', body: JSON.stringify({ name, mode }) }),
  // 江湖自算：后台入队 enrich 任务（企查查/AI 发现干系人 → 候选进收件箱人审）
  enrichEnqueue: (accountId: string, mode: 'auto' | 'web' = 'auto'): Promise<{ id: string; enqueued: boolean; accountId: string }> =>
    req('/api/enrich/enqueue', { method: 'POST', body: JSON.stringify({ accountId, mode }) }),
  suggestEnqueue: (opportunityId: string): Promise<{ id: string; enqueued: boolean; opportunityId: string }> =>
    req('/api/suggest/enqueue', { method: 'POST', body: JSON.stringify({ opportunityId }) }),
  enrichJobs: (accountId: string): Promise<{ jobs: { id: string; accountId: string; type: string; status: string; result: string; error: string; createdAt: string }[] }> =>
    req('/api/enrich/jobs?accountId=' + encodeURIComponent(accountId)),
  // 录音接入：拉转写(加密存)/列表(脱敏·不返正文)/抽取(解密→voice 双轨落库·候选人审)/降解/删除
  recordingPull: (b: { source?: 'mock' | 'getnote' | 'feishu' | 'dingtalk'; accountId?: string; opportunityId?: string }): Promise<{ source: string; saved: number; skipped: number; note: string }> =>
    req('/api/recording/pull', { method: 'POST', body: JSON.stringify(b) }),
  recordingTranscripts: (accountId?: string): Promise<{ transcripts: Transcript[] }> =>
    req('/api/recording/transcripts' + (accountId ? '?accountId=' + encodeURIComponent(accountId) : '')),
  recordingExtract: (transcriptId: string, idempotencyKey: string): Promise<any> =>
    commandReq('/api/recording/extract', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ transcriptId }) }, { timeoutMs: 120_000 }),
  recordingRedact: (transcriptId: string): Promise<{ ok: true; id: string; status: string }> =>
    req('/api/recording/redact', { method: 'POST', body: JSON.stringify({ transcriptId }) }),
  recordingDelete: (transcriptId: string): Promise<{ ok: true; id: string }> =>
    req(`/api/recording/transcripts/${transcriptId}`, { method: 'DELETE' }),
  // 录音源（P2-b）：文件上传 / per-user 凭据状态 / 飞书 App 配置(租户级) / 飞书 OAuth / 得到大脑 token
  recordingUpload: (file: File, accountId?: string): Promise<{ source: string; saved: number; skipped: number }> => {
    const fd = new FormData(); fd.append('file', file);
    return req('/api/recording/upload' + (accountId ? '?accountId=' + encodeURIComponent(accountId) : ''), { method: 'POST', body: fd }, { timeoutMs: 300_000 });
  },
  recordingCredentials: (): Promise<{ credentials: { source: string; status: string; expiresAt: string | null; updatedAt: string }[] }> =>
    req('/api/recording/credentials'),
  recordingFeishuConfig: (): Promise<{ configured: boolean; appId: string; hasSecret: boolean; enabled: boolean; redirectUri: string }> =>
    req('/api/recording/provider/feishu'),
  recordingSaveFeishuConfig: (b: { appId: string; appSecret?: string }): Promise<{ ok: true; redirectUri: string }> =>
    req('/api/recording/provider/feishu', { method: 'PUT', body: JSON.stringify(b) }),
  recordingFeishuOauthStart: (): Promise<{ authUrl: string }> =>
    req('/api/recording/oauth/feishu/start'),
  recordingFeishuPull: (url: string, accountId?: string): Promise<{ source: string; saved: number; skipped: number; note: string }> =>
    req('/api/recording/feishu/pull', { method: 'POST', body: JSON.stringify({ url, accountId }) }),
  recordingFeishuSync: (accountId?: string): Promise<{ source: string; saved: number; skipped: number; scanned: number; note: string }> =>
    req('/api/recording/feishu/sync', { method: 'POST', body: JSON.stringify({ accountId }) }),
  recordingSaveGetnote: (b: { apiKey: string; clientId: string; baseUrl?: string }): Promise<{ ok: true }> =>
    req('/api/recording/credential/getnote', { method: 'PUT', body: JSON.stringify(b) }),
  recordingDeleteCredential: (source: string): Promise<{ ok: true }> =>
    req(`/api/recording/credential/${source}`, { method: 'DELETE' }),
  // AI 梳理层（P3）：懒生成综述 / 人编辑(锁定 human-wins) / 强制重梳理
  curatedGet: (entityKind: 'account' | 'opportunity', entityId: string): Promise<{ content: string; status: string; editedByHuman: boolean; updatedAt?: string }> =>
    req(`/api/curated?entityKind=${entityKind}&entityId=${encodeURIComponent(entityId)}`),
  curatedSave: (entityKind: 'account' | 'opportunity', entityId: string, content: string): Promise<{ ok: true }> =>
    req('/api/curated', { method: 'PUT', body: JSON.stringify({ entityKind, entityId, content }) }),
  curatedRegen: (entityKind: 'account' | 'opportunity', entityId: string): Promise<{ content: string; status: string; editedByHuman: boolean; error?: string }> =>
    req('/api/curated/regenerate', { method: 'POST', body: JSON.stringify({ entityKind, entityId }) }),
  // 企查查 股权/对外投资（只读·仅供参考，不写库）。name 须为完整登记名（先经 qccResolve 锚定）。
  qccCompanyData: (name: string): Promise<CompanyEquityData> =>
    req('/api/qcc/company-data', { method: 'POST', body: JSON.stringify({ name }) }),
  // AI 助手接入令牌（长效，给外部 agent 连 MCP 用）
  accessTokenList: (): Promise<{ tokens: AccessTokenInfo[] }> => req('/api/access-tokens'),
  accessTokenCreate: (name: string, preset: AccessTokenPreset): Promise<AccessTokenCreateResult> =>
    req('/api/access-tokens', { method: 'POST', body: JSON.stringify({ name, preset }) }),
  accessTokenRevoke: (id: string): Promise<{ ok: true }> => req(`/api/access-tokens/${id}`, { method: 'DELETE' }),
};

export type AccessTokenPreset = 'workbuddy_sync' | 'readonly_analysis' | 'research_proposal';
export type AccessScope = 'read' | 'human_command' | 'sync_business' | 'propose_people' | 'propose_relations' | 'submit_evidence';
export interface AccessTokenInfo {
  id: string;
  name: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
  preset: AccessTokenPreset | null;
  scopes: AccessScope[];
  tokenVersion: number;
}
export interface AccessTokenCreateResult extends Omit<AccessTokenInfo, 'createdAt' | 'lastUsedAt'> { token: string }

export interface Shareholder { name: string; ratio: string; amount: string }
export interface Investment { name: string; ratio: string; status: string; establishDate: string }
export interface CompanyEquityData { shareholders: Shareholder[]; investments: Investment[] }

export interface CompanyCandidate {
  name: string; creditCode: string; legalPerson: string; status: string; establishDate: string;
}

// 参谋候选（P2④b→多类型）：action 行动牌(目的/资源/注意→PlanAction) / card 策略卡(依据/缺口→StrategyCard) / risk 风险登记(→StrategyRisk)；人审采纳才落库，挂焦点人
export type AdvisorCand =
  | { kind: 'action'; title: string; purpose: string; resources: string; cautions: string }
  | { kind: 'card'; title: string; basis: string; gapItem?: string }
  | { kind: 'risk'; title: string; severity: 'low' | 'mid' | 'high' };

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

// P2 引擎心跳：本租户最近一轮后台巡检统计（服务刚重启未跑完首轮 / 无活跃商机 → null）
export interface PatrolInfo { at: string; scanned: number; created: number; resolved: number }
// 收件箱聚合视图：关系/人物候选附带 account/opp 上下文（供 Hub 级跨客户分组 + 采纳后定位）
export interface InboxRel extends Suggestion { opportunityId: string; oppName: string; accountId: string; accountName: string }
export interface InboxPerson extends PersonSuggestion { accountName: string }
// 字段更新提案（v2.0）：机器对已有实体字段的改动，带 改前→改后 + 溯源，待人审
export interface InboxProposal {
  id: string; accountId: string; accountName: string; opportunityId?: string; oppName: string;
  entityKind: string; entityId: string; entityName: string;
  field: string; oldValue: string; newValue: string; origin: string; evidence: string; confidence: number;
}
// 巡检提醒（提醒型提案）：确定性后台发现「该动了」。只读——人「忽略 / 去看看」，不建边/不改值。
export interface InboxReminder {
  id: string; accountId: string; accountName: string; opportunityId?: string; oppName: string;
  kind: string; title: string; detail: string; severity: string; entityId?: string;
}
// M3 第5类 · 证据待审：机器抽取的干系人行为信号（人批准才进 E2 燃料池；direction 0=中性待人工定向）
export interface InboxEvidence {
  id: string; accountId: string; accountName: string; opportunityId: string; oppName: string;
  personId: string; personName: string;
  signalKey: string; signalLabel: string; direction: number; tier: string;
  rawContent: string; occurredAt: string; origin: string;
}
