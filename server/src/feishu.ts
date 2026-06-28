// 飞书妙记接入：OAuth 2.0(网页授权码) + 妙记 minutes API client。
// 凭据两层：租户级 App ID/Secret(RecordingProviderConfig) + per-user user_access_token(RecordingCredential)。
// 江湖只拉转写文字(transcript:export)，不碰音视频、不自建 ASR。
// ⚠️ OAuth token 端点用飞书 v2 标准；妙记 list/transcript 端点据开放平台文档推断，标 TODO 待公网真机校准。

const FEISHU_OPEN = 'https://open.feishu.cn';
const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn';

// 妙记接入所需 scope（用户身份）：导出转写正文 + 搜索 + 基本信息（对齐用户已开通的权限）
export const FEISHU_MINUTES_SCOPES = [
  'minutes:minutes.transcript:export',
  'minutes:minutes.search:read',
  'minutes:minutes.basic:read',
];

export interface FeishuApp { appId: string; appSecret: string; }
export interface FeishuToken { accessToken: string; refreshToken: string; expiresAt: Date | null }
export interface FeishuMinute { token: string; title: string; startTime: number; durationSec: number }

/** 生成飞书 OAuth 授权 URL（网页授权码模式）。state 防 CSRF（调用方校验）。 */
export function buildFeishuAuthUrl(appId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: FEISHU_MINUTES_SCOPES.join(' '),
    state,
  });
  return `${FEISHU_ACCOUNTS}/open-apis/authen/v1/authorize?${p.toString()}`;
}

// 飞书 OAuth v2 token 端点：授权码 / 刷新 共用，按 grant_type 区分。
async function tokenRequest(body: Record<string, string>): Promise<FeishuToken> {
  const res = await fetch(`${FEISHU_OPEN}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const d: any = await res.json().catch(() => ({}));
  // 飞书成功返回 code=0；HTTP 非 2xx 或 code≠0 视为失败
  if (!res.ok || (typeof d.code === 'number' && d.code !== 0)) {
    throw new Error(`飞书 token 接口失败：${d.error_description || d.msg || d.error || `HTTP ${res.status}`}`);
  }
  const expiresIn = Number(d.expires_in || d.data?.expires_in || 0);
  return {
    accessToken: d.access_token || d.data?.access_token || '',
    refreshToken: d.refresh_token || d.data?.refresh_token || '',
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

/** 用授权码换 user_access_token + refresh_token。 */
export function exchangeFeishuCode(app: FeishuApp, code: string, redirectUri: string): Promise<FeishuToken> {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: app.appId,
    client_secret: app.appSecret,
    code,
    redirect_uri: redirectUri,
  });
}

/** 用 refresh_token 续期 user_access_token。 */
export function refreshFeishuToken(app: FeishuApp, refreshToken: string): Promise<FeishuToken> {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: app.appId,
    client_secret: app.appSecret,
    refresh_token: refreshToken,
  });
}

// 取 JSON 路径里第一段字符串数组/对象，容错飞书返回结构微调。
function pickList(d: any, keys: string[]): any[] {
  for (const k of keys) {
    const v = k.split('.').reduce((o: any, kk) => (o == null ? o : o[kk]), d);
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * 列出该用户的妙记（用 user_access_token）。
 * ⚠️ TODO(真机校准)：飞书妙记列表/搜索端点与分页字段需用真实 token 核实；
 *    现按 minutes/v1 + search:read 推断，失败时返回空（不阻塞，前端提示去飞书确认权限）。
 */
export async function listFeishuMinutes(accessToken: string): Promise<FeishuMinute[]> {
  const res = await fetch(`${FEISHU_OPEN}/open-apis/minutes/v1/minutes?page_size=20`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || (typeof d.code === 'number' && d.code !== 0)) {
    throw new Error(`飞书妙记列表失败：${d.msg || d.error_description || `HTTP ${res.status}`}（端点待真机校准）`);
  }
  const list = pickList(d, ['data.minutes', 'data.items', 'data.list', 'minutes']);
  return list.map((m: any) => ({
    token: m.minute_token || m.token || m.id || '',
    title: m.title || m.topic || '(无标题妙记)',
    startTime: Number(m.start_time || m.create_time || 0),
    durationSec: Number(m.duration || 0),
  })).filter((m: FeishuMinute) => m.token);
}

/**
 * 拉取一篇妙记的转写正文（transcript:export，user_access_token）。
 * ⚠️ TODO(真机校准)：导出转写的确切端点/返回格式(纯文本 or 分段 JSON)需真机核实；
 *    现按 minutes/v1/{token}/transcript 推断，尽力拼出纯文本。
 */
export async function getFeishuTranscript(accessToken: string, minuteToken: string): Promise<string> {
  const res = await fetch(`${FEISHU_OPEN}/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`飞书转写导出失败：HTTP ${res.status}（端点待真机校准）`);
  // 可能直接返回纯文本/SRT，或返回 JSON 含分段
  if (ct.includes('application/json')) {
    const d: any = await res.json().catch(() => ({}));
    if (typeof d.code === 'number' && d.code !== 0) throw new Error(`飞书转写导出失败：${d.msg || d.error_description}`);
    const segs = pickList(d, ['data.sentences', 'data.paragraphs', 'data.transcript', 'data.contents']);
    if (segs.length) return segs.map((s: any) => (typeof s === 'string' ? s : s.text || s.content || '')).join('\n').trim();
    const text = d.data?.text || d.data?.content || '';
    return String(text).trim();
  }
  return (await res.text()).trim();
}
