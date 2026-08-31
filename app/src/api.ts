import type { Action } from './store';
import type { AccountState, CommitmentCommand, CommitmentCommandReceipt, PipelineStage } from './types';
import type { AiContextOptions, ContextManifest } from './aiContext';
import { toWireAction } from './wireAction';
import {
  parsePostMeetingJobCards,
  parsePostMeetingReviewDetail,
  parsePostMeetingReviewReceipt,
  parsePostMeetingRuns,
  parsePostMeetingSourceOptions,
} from './lib/postMeetingReview';
import { exactPostMeetingImportReceipt } from './lib/postMeetingImport';
import {
  parsePreMeetingBriefDetail,
  parsePreMeetingBriefList,
  parsePreMeetingJobCards,
  parsePreMeetingRuns,
} from './lib/preMeetingBrief';
import {
  parseHypothesisVerificationReviewReceipt,
  parseRelationshipWorkspace,
  parseSalesHypothesisCommandReceipt,
} from './lib/relationshipWorkspace';
import {
  ActorRoleSchema,
  AgentJobCardSchema,
  AgentJobControlRequestSchema,
  AgentManualRunRequestSchema,
  AgentRunReceiptSchema,
  CommitmentCommandReceiptSchema,
  commitmentReceiptMatchesCommand,
  CrmContextSnapshotSchema,
  PostMeetingReviewRequestSchema,
  PostMeetingFeishuImportRequestSchema,
  PostMeetingFeishuOAuthStartResponseSchema,
  PostMeetingFeishuProviderConfigReceiptSchema,
  PostMeetingFeishuProviderConfigRequestSchema,
  PostMeetingFeishuProviderStatusSchema,
  PostMeetingRecordingCredentialStatusResponseSchema,
  PostMeetingSourceLifecycleReceiptSchema,
  PostMeetingUploadMetadataSchema,
  ProductAccessSchema,
  QuickCaptureCommandReceiptSchema,
  ReviewHypothesisVerificationCommandSchema,
  SalesHypothesisCommandSchema,
  TodayReadModelSchema,
  TodaySourceViewSchema,
  type AgentJobCard,
  type AgentManualRunRequest,
  type AgentRunReceipt,
  type InterventionSourceRef,
  type CrmContextSnapshot,
  type CommandContext,
  type ProductAccess,
  type PostMeetingReviewBatchDetail,
  type PostMeetingReviewReceipt,
  type PostMeetingReviewRequest,
  type PostMeetingFeishuImportRequest,
  type PostMeetingFeishuOAuthStartResponse,
  type PostMeetingFeishuProviderConfigReceipt,
  type PostMeetingFeishuProviderConfigRequest,
  type PostMeetingFeishuProviderStatus,
  type PostMeetingRecordingCredentialStatusResponse,
  type PostMeetingSourceImportReceipt,
  type PostMeetingSourceLifecycleReceipt,
  type PostMeetingSourceOption,
  type PostMeetingUploadMetadata,
  type QuickCaptureCommand,
  type QuickCaptureCommandReceipt,
  type RelationshipWorkspaceResponse,
  type ResearchBriefSnapshotDetail,
  type ResearchBriefSnapshotListResponse,
  type ReviewHypothesisVerificationCommand,
  type ReviewHypothesisVerificationReceipt,
  type SalesHypothesisCommand,
  type SalesHypothesisCommandReceipt,
  type TodayReadModel,
  type TodaySourceView,
} from '@jianghu/domain-contracts';

// 生产构建把 VITE_API_URL 设为空串 "" → 走同源相对路径 /api（由 Nginx 反代到后端）。
// 开发未设(undefined) → 回退本地后端。用 ?? 而非 ||，确保空串不被误回退。
const BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'jianghu.token';
const storage = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' ? localStorage : null;
let token: string | null = storage?.getItem(TOKEN_KEY) ?? null;
let tokenGeneration = 0;
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
  const requestTokenGeneration = tokenGeneration;
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
        cause: data,
      });
      if (res.status === 401 && requestBearerToken === token && requestTokenGeneration === tokenGeneration) {
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
  const commandToken = token;
  const commandTokenGeneration = tokenGeneration;
  const headers = new Headers(opts.headers);
  if (!headers.has('Authorization') && commandToken) headers.set('Authorization', `Bearer ${commandToken}`);
  const frozenOptions = { ...opts, headers };
  try { return await request<T>(path, frozenOptions, requestOptions); }
  catch (cause) {
    const error = toApiError(cause);
    if (error.code !== 'network_error' && error.code !== 'timeout') throw error;
    if (commandToken !== token || commandTokenGeneration !== tokenGeneration) {
      throw new ApiError({ code: 'session_reset', message: '会话已切换，已取消旧会话命令重试', retryable: false, cause: error });
    }
    return request<T>(path, frozenOptions, requestOptions); // 固定认证头与 Idempotency-Key，重试不得跨会话。
  }
};

const invalidQuickCaptureResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的快速记录结果无效，请刷新后确认正式记录。',
  retryable: false,
  cause,
});

const invalidCommitmentResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的下一步操作结果无效，请刷新后确认正式记录。',
  retryable: false,
  cause,
});

const invalidTodayResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的今日干预数据无效，请刷新后重试。',
  retryable: false,
  cause,
});

const invalidCrmContextResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的客户与事项上下文无效，请刷新后重试。',
  retryable: false,
  cause,
});

const invalidPostMeetingResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的会后速审数据无效，请刷新后重试。',
  retryable: false,
  cause,
});

const invalidPreMeetingResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的拜访前简报数据无效，请刷新后重试。',
  retryable: false,
  cause,
});

const invalidRelationshipWorkspaceResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的关系工作台数据无效，请刷新后重试。',
  retryable: false,
  cause,
});

function postMeetingParse<T>(parse: () => T): T {
  try { return parse(); } catch (cause) { throw invalidPostMeetingResponse(cause); }
}

function preMeetingParse<T>(parse: () => T): T {
  try { return parse(); } catch (cause) { throw invalidPreMeetingResponse(cause); }
}

function relationshipWorkspaceParse<T>(parse: () => T): T {
  try { return parse(); } catch (cause) { throw invalidRelationshipWorkspaceResponse(cause); }
}

function parseCrmContextResponse(raw: unknown): CrmContextSnapshot {
  const parsed = CrmContextSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw invalidCrmContextResponse(parsed.error);
  return parsed.data;
}

function parseTodayResponse(raw: unknown): TodayReadModel {
  const parsed = TodayReadModelSchema.safeParse(raw);
  if (!parsed.success) throw invalidTodayResponse(parsed.error);
  return parsed.data;
}

function parseTodaySourceResponse(raw: unknown, expected: InterventionSourceRef): TodaySourceView {
  const parsed = TodaySourceViewSchema.safeParse(raw);
  if (!parsed.success) throw invalidTodayResponse(parsed.error);
  const actual = parsed.data.sourceRef;
  if (actual.entityKind !== expected.entityKind
    || actual.entityId !== expected.entityId
    || actual.version !== expected.version
    || actual.scheduleVersion !== expected.scheduleVersion) {
    throw invalidTodayResponse(new Error('Today source revision mismatch'));
  }
  return parsed.data;
}

function parseQuickCaptureResponse(
  raw: unknown,
  command: QuickCaptureCommand,
): QuickCaptureCommandReceipt & { replayed: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalidQuickCaptureResponse();
  const { replayed, ...receiptValue } = raw as Record<string, unknown>;
  if (typeof replayed !== 'boolean') throw invalidQuickCaptureResponse();
  const parsed = QuickCaptureCommandReceiptSchema.safeParse(receiptValue);
  if (!parsed.success) throw invalidQuickCaptureResponse(parsed.error);

  const expectedCustomerId = command.customer.mode === 'existing'
    ? command.customer.customerId
    : command.customer.command.customer.id;
  const expectedMatterId = command.commitment.commitment.matterId;
  const customerReceiptMatches = command.customer.mode === 'existing'
    ? parsed.data.customer === null
    : parsed.data.customer?.customerId === expectedCustomerId;
  if (!customerReceiptMatches
    || parsed.data.commitment.commitmentId !== command.commitment.commitment.id
    || parsed.data.commitment.customerId !== expectedCustomerId
    || parsed.data.commitment.matterId !== expectedMatterId) {
    throw invalidQuickCaptureResponse();
  }
  return { ...parsed.data, replayed };
}

function parseCommitmentResponse(
  raw: unknown,
  command: CommitmentCommand,
): CommitmentCommandReceipt & { replayed: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalidCommitmentResponse();
  const { replayed, ...receiptValue } = raw as Record<string, unknown>;
  if (typeof replayed !== 'boolean') throw invalidCommitmentResponse();
  const parsed = CommitmentCommandReceiptSchema.safeParse(receiptValue);
  if (!parsed.success) throw invalidCommitmentResponse(parsed.error);
  if (!commitmentReceiptMatchesCommand(parsed.data, command)) {
    throw invalidCommitmentResponse(new Error('Commitment command receipt mismatch'));
  }
  return { ...parsed.data, replayed };
}
export const newIdempotencyKey = (): string => crypto.randomUUID();

export interface AuthResult {
  token: string;
  user: { id: string; phone: string | null; email: string | null; name: string; role: CommandContext['actorRole'] };
  tenant: { id: string; name: string; plan: string; subscriptionStatus: string; seatLimit: number };
  product: ProductAccess;
}
export interface Credentials { phone?: string; email?: string; password: string }
// 登录命中「同一手机号/邮箱在多个工作区都有账号」时，后端返回候选工作区让用户选（而非直接发 token）
export interface WorkspaceChoice { needWorkspace: true; workspaces: { tenantId: string; tenantName: string }[] }

const invalidAuthResponse = (cause?: unknown): ApiError => new ApiError({
  code: 'invalid_response',
  message: '服务返回的登录身份或产品能力配置无效，请联系管理员。',
  retryable: false,
  cause,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidAuthResponse(new Error(`${field} must be a non-empty string`));
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function parseSessionIdentity(raw: unknown): Omit<AuthResult, 'token'> {
  if (!isRecord(raw) || !isRecord(raw.user) || !isRecord(raw.tenant)) throw invalidAuthResponse();
  const product = ProductAccessSchema.safeParse(raw.product);
  if (!product.success) throw invalidAuthResponse(product.error);
  const role = ActorRoleSchema.safeParse(raw.user.role);
  if (!role.success) throw invalidAuthResponse(role.error);
  if (!Number.isSafeInteger(raw.tenant.seatLimit) || Number(raw.tenant.seatLimit) < 0) {
    throw invalidAuthResponse(new Error('tenant.seatLimit must be a non-negative safe integer'));
  }
  return {
    user: {
      id: requiredString(raw.user.id, 'user.id'),
      phone: nullableString(raw.user.phone, 'user.phone'),
      email: nullableString(raw.user.email, 'user.email'),
      name: requiredString(raw.user.name, 'user.name'),
      role: role.data,
    },
    tenant: {
      id: requiredString(raw.tenant.id, 'tenant.id'),
      name: requiredString(raw.tenant.name, 'tenant.name'),
      plan: requiredString(raw.tenant.plan, 'tenant.plan'),
      subscriptionStatus: requiredString(raw.tenant.subscriptionStatus, 'tenant.subscriptionStatus'),
      seatLimit: Number(raw.tenant.seatLimit),
    },
    product: product.data,
  };
}

function parseAuthResult(raw: unknown): AuthResult {
  if (!isRecord(raw)) throw invalidAuthResponse();
  return { token: requiredString(raw.token, 'token'), ...parseSessionIdentity(raw) };
}

function parseLoginResult(raw: unknown): AuthResult | WorkspaceChoice {
  if (isRecord(raw) && raw.needWorkspace === true) {
    if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) throw invalidAuthResponse();
    return {
      needWorkspace: true,
      workspaces: raw.workspaces.map((workspace, index) => {
        if (!isRecord(workspace)) throw invalidAuthResponse();
        return {
          tenantId: requiredString(workspace.tenantId, `workspaces[${index}].tenantId`),
          tenantName: requiredString(workspace.tenantName, `workspaces[${index}].tenantName`),
        };
      }),
    };
  }
  return parseAuthResult(raw);
}
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
    customerType: 1 | 2 | 3 | 4 | null;
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
    tokenGeneration += 1;
    token = t;
    if (t) storage?.setItem(TOKEN_KEY, t);
    else storage?.removeItem(TOKEN_KEY);
  },
  onUnauthorized(listener: (error: ApiError) => void) {
    unauthorizedListeners.add(listener);
    return () => { unauthorizedListeners.delete(listener); };
  },
  register: async (b: Credentials & { name: string; tenantName: string }): Promise<AuthResult> => parseAuthResult(
    await req<unknown>('/api/auth/register', { method: 'POST', body: JSON.stringify(b) }),
  ),
  login: async (b: Credentials & { tenantId?: string }): Promise<AuthResult | WorkspaceChoice> => parseLoginResult(
    await req<unknown>('/api/auth/login', { method: 'POST', body: JSON.stringify(b) }),
  ),
  me: async (): Promise<{ user: AuthResult['user']; tenant: AuthResult['tenant']; product: ProductAccess }> => parseSessionIdentity(
    await req<unknown>('/api/me'),
  ),
  getState: (): Promise<{ accounts: AccountState[] }> => req('/api/state'),
  crmContext: async (): Promise<CrmContextSnapshot> => parseCrmContextResponse(
    await req<unknown>('/api/crm/context'),
  ),
  relationshipWorkspace: async (
    customerId: string,
    matterId: string,
  ): Promise<RelationshipWorkspaceResponse> => {
    const query = new URLSearchParams({ customerId, matterId });
    const raw = await req<unknown>(`/api/relationship-workspace?${query.toString()}`);
    return relationshipWorkspaceParse(() => parseRelationshipWorkspace(raw, customerId, matterId));
  },
  preMeetingJobCards: async (): Promise<{ items: AgentJobCard[] }> => {
    const raw = await req<unknown>('/api/agent-jobs');
    return preMeetingParse(() => parsePreMeetingJobCards(raw));
  },
  preMeetingRuns: async (): Promise<{ items: AgentRunReceipt['run'][]; nextCursor: string | null }> => {
    const raw = await req<unknown>('/api/agent-runs?limit=50');
    return preMeetingParse(() => parsePreMeetingRuns(raw));
  },
  preMeetingSources: async (
    customerId: string,
    matterId: string,
  ): Promise<PostMeetingSourceOption[]> => {
    const raw = await req<unknown>(`/api/source-artifacts?accountId=${encodeURIComponent(customerId)}&matterId=${encodeURIComponent(matterId)}&limit=100`);
    return preMeetingParse(() => parsePostMeetingSourceOptions(raw, { customerId, matterId }));
  },
  preMeetingBriefs: async (
    customerId: string,
    matterId: string,
  ): Promise<ResearchBriefSnapshotListResponse> => {
    const query = new URLSearchParams({ customerId, matterId, limit: '50' });
    const raw = await req<unknown>(`/api/research-briefs?${query.toString()}`);
    return preMeetingParse(() => parsePreMeetingBriefList(raw));
  },
  preMeetingBrief: async (briefId: string): Promise<ResearchBriefSnapshotDetail> => {
    const raw = await req<unknown>(`/api/research-briefs/${encodeURIComponent(briefId)}`);
    return preMeetingParse(() => parsePreMeetingBriefDetail(raw, briefId));
  },
  preMeetingControl: async (
    jobVersion: string,
    enabled: boolean,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<{ card: AgentJobCard; replayed: boolean }> => {
    const payload = AgentJobControlRequestSchema.parse({ jobVersion, enabled, expectedVersion });
    const raw = await commandReq<unknown>('/api/agent-jobs/pre_meeting_brief/control', {
      method: 'PUT',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    return preMeetingParse(() => {
      if (!isRecord(raw) || typeof raw.replayed !== 'boolean') throw new Error('control envelope');
      const { replayed, ...cardValue } = raw;
      const card = AgentJobCardSchema.safeParse(cardValue);
      if (!card.success
        || card.data.jobKey !== 'pre_meeting_brief'
        || card.data.jobVersion !== jobVersion) throw new Error('control card');
      return { card: card.data, replayed };
    });
  },
  preMeetingRun: async (
    input: AgentManualRunRequest,
    idempotencyKey: string,
  ): Promise<AgentRunReceipt> => {
    const payload = AgentManualRunRequestSchema.parse(input);
    const raw = await commandReq<unknown>('/api/agent-jobs/pre_meeting_brief/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    }, { timeoutMs: 120_000 });
    return preMeetingParse(() => {
      const parsed = AgentRunReceiptSchema.safeParse(raw);
      if (!parsed.success
        || parsed.data.run.jobKey !== 'pre_meeting_brief'
        || parsed.data.run.jobVersion !== payload.jobVersion
        || parsed.data.run.customerId !== payload.customerId
        || parsed.data.run.matterId !== payload.matterId
        || parsed.data.run.sourceArtifactId !== payload.sourceArtifactId
        || JSON.stringify(parsed.data.run.inputRefs) !== JSON.stringify(payload.inputRefs)) {
        throw new Error('run receipt mismatch');
      }
      return parsed.data;
    });
  },
  postMeetingJobCards: async (): Promise<{ items: AgentJobCard[] }> => {
    const raw = await req<unknown>('/api/agent-jobs');
    return postMeetingParse(() => parsePostMeetingJobCards(raw));
  },
  postMeetingRuns: async (): Promise<{ items: AgentRunReceipt['run'][]; nextCursor: string | null }> => {
    const raw = await req<unknown>('/api/agent-runs?limit=50');
    const page = postMeetingParse(() => parsePostMeetingRuns(raw));
    return {
      items: page.items.filter((run) => run.jobKey === 'post_meeting_extract'),
      nextCursor: page.nextCursor,
    };
  },
  postMeetingSources: async (
    customerId: string,
    matterId: string,
  ): Promise<PostMeetingSourceOption[]> => {
    const raw = await req<unknown>(`/api/source-artifacts?accountId=${encodeURIComponent(customerId)}&matterId=${encodeURIComponent(matterId)}&limit=100`);
    return postMeetingParse(() => parsePostMeetingSourceOptions(raw, { customerId, matterId }));
  },
  postMeetingImportUpload: async (
    file: File,
    metadata: PostMeetingUploadMetadata,
    idempotencyKey: string,
  ): Promise<PostMeetingSourceImportReceipt> => {
    const payload = PostMeetingUploadMetadataSchema.parse(metadata);
    const query = new URLSearchParams({
      customerId: payload.customerId,
      matterId: payload.matterId,
    });
    if (payload.occurredAt !== undefined && payload.occurredAt !== null) {
      query.set('occurredAt', payload.occurredAt);
    }
    const form = new FormData();
    form.append('file', file);
    const raw = await commandReq<unknown>(`/api/post-meeting/import/upload?${query.toString()}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: form,
    }, { timeoutMs: 120_000 });
    return postMeetingParse(() => exactPostMeetingImportReceipt(raw, payload, 'uploaded_file'));
  },
  postMeetingImportFeishu: async (
    request: PostMeetingFeishuImportRequest,
    idempotencyKey: string,
  ): Promise<PostMeetingSourceImportReceipt> => {
    const payload = PostMeetingFeishuImportRequestSchema.parse(request);
    const raw = await commandReq<unknown>('/api/post-meeting/import/feishu', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    }, { timeoutMs: 120_000 });
    return postMeetingParse(() => exactPostMeetingImportReceipt(raw, payload, 'transcript'));
  },
  postMeetingFeishuProviderStatus: async (): Promise<PostMeetingFeishuProviderStatus> => {
    const raw = await req<unknown>('/api/recording/provider/feishu');
    return postMeetingParse(() => {
      const parsed = PostMeetingFeishuProviderStatusSchema.safeParse(raw);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
  },
  postMeetingRecordingCredentialStatus: async (): Promise<PostMeetingRecordingCredentialStatusResponse> => {
    const raw = await req<unknown>('/api/recording/credentials');
    return postMeetingParse(() => {
      const parsed = PostMeetingRecordingCredentialStatusResponseSchema.safeParse(raw);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
  },
  postMeetingSaveFeishuProviderConfig: async (
    request: PostMeetingFeishuProviderConfigRequest,
  ): Promise<PostMeetingFeishuProviderConfigReceipt> => {
    const payload = PostMeetingFeishuProviderConfigRequestSchema.parse(request);
    const raw = await req<unknown>('/api/recording/provider/feishu', {
      method: 'PUT', body: JSON.stringify(payload),
    });
    return postMeetingParse(() => {
      const parsed = PostMeetingFeishuProviderConfigReceiptSchema.safeParse(raw);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
  },
  postMeetingFeishuOAuthStart: async (): Promise<PostMeetingFeishuOAuthStartResponse> => {
    const raw = await req<unknown>('/api/recording/oauth/feishu/start');
    return postMeetingParse(() => {
      const parsed = PostMeetingFeishuOAuthStartResponseSchema.safeParse(raw);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
  },
  postMeetingDegradeSource: async (
    source: PostMeetingSourceOption,
    idempotencyKey: string,
  ): Promise<PostMeetingSourceLifecycleReceipt> => {
    const raw = await commandReq<unknown>(`/api/source-artifacts/${encodeURIComponent(source.id)}/degrade`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ expectedAclVersion: source.aclVersion }),
    });
    return postMeetingParse(() => {
      const parsed = PostMeetingSourceLifecycleReceiptSchema.safeParse(raw);
      if (!parsed.success || parsed.data.id !== source.id
        || parsed.data.aclVersion !== source.aclVersion
        || parsed.data.retentionState !== 'degraded'
        || parsed.data.contentAvailable) throw new Error('source lifecycle mismatch');
      return parsed.data;
    });
  },
  postMeetingDeleteSource: async (
    source: PostMeetingSourceOption,
    idempotencyKey: string,
  ): Promise<PostMeetingSourceLifecycleReceipt> => {
    const raw = await commandReq<unknown>(`/api/source-artifacts/${encodeURIComponent(source.id)}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ expectedAclVersion: source.aclVersion }),
    });
    return postMeetingParse(() => {
      const parsed = PostMeetingSourceLifecycleReceiptSchema.safeParse(raw);
      if (!parsed.success || parsed.data.id !== source.id
        || parsed.data.aclVersion !== source.aclVersion
        || parsed.data.retentionState !== 'deleted'
        || parsed.data.contentAvailable
        || parsed.data.backingPresent) throw new Error('source lifecycle mismatch');
      return parsed.data;
    });
  },
  postMeetingReview: async (batchId: string): Promise<PostMeetingReviewBatchDetail> => {
    const raw = await req<unknown>(`/api/review-batches/${encodeURIComponent(batchId)}`);
    return postMeetingParse(() => parsePostMeetingReviewDetail(raw, batchId));
  },
  postMeetingControl: async (
    jobVersion: string,
    enabled: boolean,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<{ card: AgentJobCard; replayed: boolean }> => {
    const payload = AgentJobControlRequestSchema.parse({ jobVersion, enabled, expectedVersion });
    const raw = await commandReq<unknown>('/api/agent-jobs/post_meeting_extract/control', {
      method: 'PUT',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    return postMeetingParse(() => {
      if (!isRecord(raw) || typeof raw.replayed !== 'boolean') throw new Error('control envelope');
      const { replayed, ...cardValue } = raw;
      const card = AgentJobCardSchema.safeParse(cardValue);
      if (!card.success
        || card.data.jobKey !== 'post_meeting_extract'
        || card.data.jobVersion !== jobVersion) throw new Error('control card');
      return { card: card.data, replayed };
    });
  },
  postMeetingRun: async (
    input: AgentManualRunRequest,
    idempotencyKey: string,
  ): Promise<AgentRunReceipt> => {
    const payload = AgentManualRunRequestSchema.parse(input);
    const raw = await commandReq<unknown>('/api/agent-jobs/post_meeting_extract/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    }, { timeoutMs: 120_000 });
    return postMeetingParse(() => {
      const parsed = AgentRunReceiptSchema.safeParse(raw);
      if (!parsed.success
        || parsed.data.run.jobKey !== 'post_meeting_extract'
        || parsed.data.run.jobVersion !== payload.jobVersion
        || parsed.data.run.customerId !== payload.customerId
        || parsed.data.run.matterId !== payload.matterId
        || parsed.data.run.sourceArtifactId !== payload.sourceArtifactId
        || JSON.stringify(parsed.data.run.inputRefs) !== JSON.stringify(payload.inputRefs)) {
        throw new Error('run receipt mismatch');
      }
      return parsed.data;
    });
  },
  postMeetingAccept: async (
    batchId: string,
    input: PostMeetingReviewRequest,
    idempotencyKey: string,
  ): Promise<Exclude<PostMeetingReviewReceipt, { code: 'review_batch_conflict' }>> => {
    const payload = PostMeetingReviewRequestSchema.parse(input);
    let raw: unknown;
    try {
      raw = await commandReq<unknown>(`/api/review-batches/${encodeURIComponent(batchId)}/accept`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      const error = toApiError(cause);
      if (error.status === 409) {
        const conflict = postMeetingParse(() => parsePostMeetingReviewReceipt(error.cause));
        if ('code' in conflict) {
          throw new ApiError({
            status: 409,
            code: conflict.code,
            message: '会后速审项已变化，请刷新后重试。',
            retryable: false,
            cause: conflict,
          });
        }
      }
      throw error;
    }
    return postMeetingParse(() => {
      const receipt = parsePostMeetingReviewReceipt(raw);
      if ('code' in receipt || receipt.batchId !== batchId) throw new Error('review receipt mismatch');
      const expected = new Map(payload.decisions.map((decision) => [decision.candidateId, decision.decision]));
      if (receipt.items.length !== expected.size
        || receipt.items.some((item) => expected.get(item.candidateId) !== item.decision)) {
        throw new Error('review item receipt mismatch');
      }
      return receipt;
    });
  },
  today: async (): Promise<TodayReadModel> => parseTodayResponse(await req<unknown>('/api/today')),
  todaySource: async (source: InterventionSourceRef): Promise<TodaySourceView> => parseTodaySourceResponse(
    await req<unknown>('/api/today/source', { method: 'POST', body: JSON.stringify(source) }),
    source,
  ),
  mutate: (action: Action): Promise<{ ok: true }> => req('/api/mutate', { method: 'POST', body: JSON.stringify({ action: toWireAction(action) }) }),
  // 录入情报：口述文字 → 后端 LLM 抽取 + 双轨落库 → 回执
  voiceExtract: (b: { text: string; accountId?: string; opportunityId?: string; personId?: string; priorText?: string; sourceVisitId?: string }, idempotencyKey: string): Promise<any> =>
    commandReq('/api/voice/extract', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }, { timeoutMs: 120_000 }),
  // 新建商机：空白(personIds 空) 或 从 fromOppId 克隆选定人物(+角色，可选关系线)
  cloneOpportunity: (b: { accountId: string; name: string; fromOppId?: string; personIds: string[]; withEdges: boolean }): Promise<{ opportunityId: string; memberCount: number }> =>
    req('/api/opportunity/clone', { method: 'POST', body: JSON.stringify(b) }),
  opportunitySkeleton: (b: { accountId: string; name: string; fromOppId?: string; personIds: string[]; withEdges: boolean; skeleton: Array<{ title: string; role: string; orgLevel: number; x: number; y: number }> }, idempotencyKey: string): Promise<{ opportunityId: string; memberCount: number; skeletonPersonIds: string[]; replayed: boolean }> =>
    commandReq('/api/commands/opportunity-skeleton', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }),
  actionFeedback: (b: {
    accountId: string;
    opportunityId: string | null;
    actionId: string;
    outcome: 'up' | 'flat' | 'down';
    occurredAt: string;
    baseVersion: number;
    expectedScheduleVersion: number;
  }, idempotencyKey: string): Promise<{ evidenceId?: string; replayed: boolean }> =>
    commandReq('/api/commands/action-feedback', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }),
  inboxBatch: (b: { items: Array<{ kind: 'proposal' | 'person' | 'rel' | 'evidence' | 'reminder'; id: string; decision: 'accept' | 'reject'; overrideValue?: string; personOverride?: { name?: string; title?: string }; relOverride?: { layer?: string; label?: string }; direction?: -1 | 0 | 1 }> }, idempotencyKey: string): Promise<{ items: Array<{ kind: string; id: string; status: string }>; replayed: boolean }> =>
    commandReq('/api/commands/inbox-batch', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) }),
  commitment: async (command: CommitmentCommand, idempotencyKey: string): Promise<CommitmentCommandReceipt & { replayed: boolean }> =>
    parseCommitmentResponse(await commandReq<unknown>('/api/commands/commitment', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(command),
    }), command),
  salesHypothesisCommand: async (
    input: SalesHypothesisCommand,
    idempotencyKey: string,
  ): Promise<SalesHypothesisCommandReceipt> => {
    const command = SalesHypothesisCommandSchema.parse(input);
    const raw = await commandReq<unknown>('/api/commands/sales-hypothesis', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(command),
    });
    return relationshipWorkspaceParse(() => parseSalesHypothesisCommandReceipt(raw, command));
  },
  reviewHypothesisVerification: async (
    input: ReviewHypothesisVerificationCommand,
    idempotencyKey: string,
  ): Promise<ReviewHypothesisVerificationReceipt> => {
    const command = ReviewHypothesisVerificationCommandSchema.parse(input);
    const raw = await commandReq<unknown>('/api/commands/hypothesis-verification-review', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(command),
    });
    return relationshipWorkspaceParse(() => parseHypothesisVerificationReviewReceipt(raw, command));
  },
  quickCapture: async (command: QuickCaptureCommand, idempotencyKey: string): Promise<QuickCaptureCommandReceipt & { replayed: boolean }> => {
    const raw = await commandReq<unknown>('/api/commands/quick-capture', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(command),
    });
    return parseQuickCaptureResponse(raw, command);
  },
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
  aiContextManifest: (opportunityId: string, options: AiContextOptions): Promise<{ manifest: ContextManifest; manifestToken: string }> =>
    req('/api/ai/context-manifest', { method: 'POST', body: JSON.stringify({ opportunityId, options }) }),
  aiSimulate: (opportunityId: string, focusPersonId: string, hypothesis: string, options: AiContextOptions, manifestToken: string): Promise<{ analysis: string; provider: string; manifest: ContextManifest }> =>
    req('/api/ai/simulate', { method: 'POST', body: JSON.stringify({ opportunityId, focusPersonId, hypothesis, options, manifestToken }) }),
  // 策略沙盘 AI 顺推(策略卡候选)/倒推(里程碑候选)——只返回候选，前端暂存 + 人审采纳后才落库
  strategySuggest: (opportunityId: string, mode: 'forward' | 'backward', options: AiContextOptions, manifestToken: string): Promise<{ mode: string; candidates: any[]; provider: string; manifest: ContextManifest }> =>
    req('/api/strategy/suggest', { method: 'POST', body: JSON.stringify({ opportunityId, mode, options, manifestToken }) }),
  // 参谋出牌（P2④b）：右栏焦点人 → AI 产行动牌候选（六要素之 目的/资源/注意）。只返回候选，人审采纳才 dispatch ADD_PLAN_ACTION 落画布。
  advisorActions: (opportunityId: string, focusPersonId: string, options: AiContextOptions, manifestToken: string, note?: string): Promise<{ candidates: AdvisorCand[]; provider: string; manifest: ContextManifest }> =>
    req('/api/strategy/actions', { method: 'POST', body: JSON.stringify({ opportunityId, focusPersonId, options, manifestToken, note }) }),
  // 派发预填（第3刀）：策略卡→行动牌四要素初稿 {target,resources,cautions,props}。只返回初稿，前端落草稿(origin=ai)开抽屉人微调。
  strategyPrefill: (opportunityId: string, card: { title?: string; basis?: string; gapItem?: string }, personId: string | undefined, options: AiContextOptions, manifestToken: string): Promise<{ prefill: { target: string; resources: string; cautions: string; props: string }; provider: string; manifest: ContextManifest }> =>
    req('/api/strategy/prefill', { method: 'POST', body: JSON.stringify({ opportunityId, card, personId, options, manifestToken }) }),
  // P6 里程碑「→ 排行动」：为达成里程碑拆 2-3 个行动候选（只返回候选，前端落 draft 草稿人审）
  milestoneActions: (opportunityId: string, milestone: { title: string; date?: string }, options: AiContextOptions, manifestToken: string, existingTitles: string[]): Promise<{ candidates: { title: string; target: string; cautions: string }[]; provider: string; manifest: ContextManifest }> =>
    req('/api/strategy/milestone-actions', { method: 'POST', body: JSON.stringify({ opportunityId, milestone, options, manifestToken, existingTitles }) }),
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
