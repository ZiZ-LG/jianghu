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

/** 从妙记链接或直接 token 提取 minute_token（URL 形如 https://xxx.feishu.cn/minutes/obcnxxxx?…，取最后一段路径）。 */
export function extractFeishuMinuteToken(input: string): string {
  const s = (input || '').trim();
  const m = s.match(/\/minutes\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return s.replace(/[?#].*$/, '').trim(); // 用户直接粘的就是 token
}

export interface FeishuMinuteData { title: string; durationSec: number; transcript: string }

/**
 * 按 minute_token 拉一篇妙记：先 minute/get 取元信息（端点已确认可用），再拉转写正文（transcript:export）。
 * ⚠️ 飞书妙记无「列表」开放 API（设计如此），须已知 token——从妙记链接提取。
 * transcript 端点/返回格式按文档推断，失败时回显飞书原始响应，便于真机精确校准。
 */
export async function getFeishuMinute(accessToken: string, minuteToken: string): Promise<FeishuMinuteData> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  // 1) 元信息：确认 token 有效 + 拿标题/时长（GET /minutes/v1/minutes/:token 已确认可用）
  const metaRes = await fetch(`${FEISHU_OPEN}/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}`, { headers: auth });
  const meta: any = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || (typeof meta.code === 'number' && meta.code !== 0)) {
    throw new Error(`获取妙记信息失败：${meta.msg || meta.error_description || `HTTP ${metaRes.status}`}（请确认链接正确、且该妙记属于授权账号）`);
  }
  const m = meta.data?.minute || meta.data || {};
  const title = m.title || '飞书妙记';
  const durRaw = Number(m.duration || 0);
  const durationSec = durRaw > 100000 ? Math.round(durRaw / 1000) : durRaw; // duration 可能是毫秒

  // 2) 转写正文（transcript:export）。⚠️端点待真机校准——失败回显飞书原始响应。
  const tRes = await fetch(`${FEISHU_OPEN}/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript?need_speaker=true&need_timestamp=false&file_format=txt`, { headers: auth });
  const ct = tRes.headers.get('content-type') || '';
  if (!tRes.ok) {
    const body = (await tRes.text().catch(() => '')).slice(0, 300);
    throw new Error(`拉妙记转写失败 HTTP ${tRes.status}（端点待真机校准）｜飞书返回：${body}`);
  }
  let transcript = '';
  if (ct.includes('application/json')) {
    const d: any = await tRes.json().catch(() => ({}));
    if (typeof d.code === 'number' && d.code !== 0) throw new Error(`拉妙记转写失败：${d.msg || d.error_description}（端点待真机校准）`);
    const segs = pickList(d, ['data.sentences', 'data.paragraphs', 'data.transcript', 'data.contents', 'data.transcripts']);
    transcript = segs.length
      ? segs.map((s: any) => (typeof s === 'string' ? s : s.text || s.content || s.sentence || '')).join('\n')
      : String(d.data?.text || d.data?.content || d.data?.transcript || '');
  } else {
    transcript = await tRes.text();
  }
  return { title, durationSec, transcript: transcript.trim() };
}

export interface FeishuMinuteBrief { token: string; title: string; createTime: number }

/**
 * 搜索/列出用户妙记（对应 minutes:minutes.search:read，供一键拉取扫描）。
 * ⚠️ 端点待真机校准：飞书文档为动态页抓不到，按惯例推断 POST minutes/search；失败回显飞书原始响应。
 * query 传「【拜访】」让飞书侧先粗筛标题，江湖再精确 startsWith 过滤。
 */
export async function searchFeishuMinutes(accessToken: string, query = ''): Promise<FeishuMinuteBrief[]> {
  const res = await fetch(`${FEISHU_OPEN}/open-apis/minutes/v1/minutes/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ query, page_size: 50 }),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`飞书妙记搜索失败 HTTP ${res.status}（端点待真机校准）｜飞书返回：${body}`);
  }
  const d: any = ct.includes('json') ? await res.json().catch(() => ({})) : {};
  if (typeof d.code === 'number' && d.code !== 0) throw new Error(`飞书妙记搜索失败：${d.msg || d.error_description}（端点待真机校准）`);
  const list = pickList(d, ['data.minutes', 'data.items', 'data.list', 'data.objects', 'minutes']);
  return list.map((m: any) => ({
    token: m.minute_token || m.token || m.id || '',
    title: m.title || m.topic || '',
    createTime: Number(m.create_time || m.start_time || 0),
  })).filter((m: FeishuMinuteBrief) => m.token);
}
