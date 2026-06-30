// 企业微信自建应用 client：access_token + 日程(oa/schedule) CRUD。
// 租户 BYO 凭据(WeComConfig)：corpId/agentId 明文 + secretEnc AES 密文；江湖代调【租户自己】企微的日程 API（平台不需公司资质）。
// ⚠️ 日程端点/字段按企微开放平台「日程」官方文档(oa/schedule)先写，标 TODO 待公网真机校准（同飞书妙记的处理）。
// PIPL：WeComSchedule 仅含 标题/描述(中性上下文)/时间/参与人 userid——绝不放 FORM/态度/弱点（字段白名单在调用方 syncToWecom 构造时把关）。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { enc, dec } from './ai.js';

const QYAPI = 'https://qyapi.weixin.qq.com';

export interface WeComCred { corpId: string; agentId: string; secret: string }

// access_token 缓存(corpId → {token, exp})：企微 token ~2h 且有拉取限频，必须缓存复用。
const tokenCache = new Map<string, { token: string; exp: number }>();

/** 用 corpId + 应用 secret 换 access_token（缓存，留 60s 余量）。 */
export async function getAccessToken(corpId: string, secret: string): Promise<string> {
  const cached = tokenCache.get(corpId);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${QYAPI}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`);
  const d: any = await res.json().catch(() => ({}));
  if (d.errcode !== 0 || !d.access_token) throw new Error(`企微 access_token 获取失败：${d.errmsg || d.errcode || `HTTP ${res.status}`}`);
  tokenCache.set(corpId, { token: d.access_token, exp: Date.now() + Number(d.expires_in || 7200) * 1000 });
  return d.access_token;
}

// ── OAuth2 网页授权（snsapi_base 静默）：扫码自动绑 userid，替代手填 ──
const WXWORK_OAUTH = 'https://open.weixin.qq.com/connect/oauth2/authorize';

/** 构造企微网页授权链接（静默 snsapi_base）。redirectUri 须在应用「可信域名」内（真机配置）。 */
export function buildWecomAuthUrl(corpId: string, agentId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ appid: corpId, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_base', agentid: agentId, state });
  return `${WXWORK_OAUTH}?${p.toString()}#wechat_redirect`;
}

/** 用授权 code 换企微 userid（auth/getuserinfo）。 */
export async function exchangeCodeToUserid(corpId: string, secret: string, code: string): Promise<string> {
  const token = await getAccessToken(corpId, secret);
  const res = await fetch(`${QYAPI}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`);
  const d: any = await res.json().catch(() => ({}));
  if (d.errcode !== 0 || !d.userid) throw new Error(`企微 getuserinfo 失败：${d.errmsg || d.errcode}（确认应用可信域名 + 成员在可见范围）`);
  return String(d.userid);
}

// 日程数据（PIPL 白名单：只允许这些字段进企微，敏感信息不在此结构内）
export interface WeComSchedule {
  summary: string;            // 标题（如「【拜访】客户·商机·下一步」）
  description?: string;       // 描述（仅客户/商机中性上下文）
  startTime: number;          // Unix 秒
  endTime: number;
  organizerUserid: string;    // 组织者企微 userid
  attendeeUserids: string[];  // 参与人企微 userid
  remindBeforeSecs?: number;  // 提前提醒秒数
}

async function callApi(token: string, path: string, body: any): Promise<any> {
  const res = await fetch(`${QYAPI}${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d: any = await res.json().catch(() => ({}));
  if (d.errcode !== 0) throw new Error(`企微日程接口失败：${d.errmsg || d.errcode}（${path}，端点待真机校准）`);
  return d;
}

function scheduleBody(s: WeComSchedule, scheduleId?: string): any {
  return {
    schedule: {
      ...(scheduleId ? { schedule_id: scheduleId } : {}),
      organizer: s.organizerUserid,
      summary: s.summary,
      description: s.description || '',
      start_time: s.startTime,
      end_time: s.endTime,
      attendees: s.attendeeUserids.map((u) => ({ userid: u })),
      ...(s.remindBeforeSecs ? { reminders: { is_remind: 1, remind_time_diffs: [-Math.abs(s.remindBeforeSecs)] } } : {}), // 企微：负数=提前秒数
    },
  };
}

/** 建企微日程，返回 schedule_id。⚠️ oa/schedule/add 按官方文档，待真机校准。 */
export async function addSchedule(token: string, s: WeComSchedule): Promise<string> {
  const d = await callApi(token, '/cgi-bin/oa/schedule/add', scheduleBody(s));
  return d.schedule_id || '';
}

/** 改企微日程。 */
export async function updateSchedule(token: string, scheduleId: string, s: WeComSchedule): Promise<void> {
  await callApi(token, '/cgi-bin/oa/schedule/update', scheduleBody(s, scheduleId));
}

/** 删企微日程。 */
export async function delSchedule(token: string, scheduleId: string): Promise<void> {
  await callApi(token, '/cgi-bin/oa/schedule/del', { schedule_id: scheduleId });
}

/** 从 WeComConfig 行解密拿可用凭据（secretEnc → secret）。 */
export function decryptWeComCred(row: { corpId: string; agentId: string; secretEnc: string }): WeComCred {
  return { corpId: row.corpId, agentId: row.agentId, secret: row.secretEnc ? dec(row.secretEnc) : '' };
}

// ── 江湖 → 企微 单向同步（PlanAction / OppMilestone 落库后由 /api/mutate fire-and-forget 触发）──
// PIPL 白名单：日程只含 标题 / 商机名 / 时间 / 操作者本人 userid，绝不含 FORM / 态度 / 弱点。
const HALF_TIME: Record<string, [number, number]> = { am: [9, 12], pm: [14, 17], eve: [19, 21] };
function toUnix(dateStr: string, hour: number): number {
  const hh = String(hour).padStart(2, '0');
  const t = Date.parse(`${dateStr}T${hh}:00:00+08:00`); // 企微时间按东八区
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * 行动/里程碑落库后同步到操作者的企微日历。未配企微 / 操作者未绑 userid → 静默跳过。
 * 失败记 ScheduleSync.status=failed（绝不抛——不影响江湖侧落库，调用方 fire-and-forget）。
 */
export async function syncFromAction(tenantId: string, userId: string, action: any): Promise<void> {
  const type: string = action?.type || '';
  const isPlan = type.includes('PLAN_ACTION');
  const isMile = type.includes('MILESTONE');
  if (!isPlan && !isMile) return;
  const kind = isPlan ? 'plan_action' : 'milestone';

  const cfg = await prisma.weComConfig.findUnique({ where: { tenantId } });
  if (!cfg || !cfg.corpId || !cfg.secretEnc) return; // 未接企微

  const refId: string = action.planAction?.id || action.milestone?.id || action.actionId || action.milestoneId || '';
  if (!refId) return;
  const whereMap = { tenantId_kind_refId: { tenantId, kind, refId } };

  // 删除：查映射 → 删企微日程
  if (type.startsWith('DELETE_')) {
    const map = await prisma.scheduleSync.findUnique({ where: whereMap });
    if (!map?.wecomScheduleId) return;
    try {
      const cred = decryptWeComCred(cfg);
      await delSchedule(await getAccessToken(cred.corpId, cred.secret), map.wecomScheduleId);
      await prisma.scheduleSync.update({ where: { id: map.id }, data: { status: 'deleted', lastError: '' } });
    } catch (e: any) {
      await prisma.scheduleSync.update({ where: { id: map.id }, data: { status: 'failed', lastError: String(e?.message || e).slice(0, 300) } }).catch(() => {});
    }
    return;
  }

  // 新建 / 更新：读 ref + 操作者企微 userid
  const ref: any = isPlan
    ? await prisma.planAction.findFirst({ where: { id: refId, tenantId } })
    : await prisma.oppMilestone.findFirst({ where: { id: refId, tenantId } });
  if (!ref) return;
  const bind = await prisma.weComUserBind.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
  if (!bind?.wecomUserid) return; // 操作者没绑企微 userid → 无法建日程

  const [h0, h1] = HALF_TIME[ref.half] || HALF_TIME.am;
  const startTime = toUnix(ref.startDate || ref.endDate, h0);
  const endTime = toUnix(ref.endDate || ref.startDate, h1);
  if (!startTime || !endTime) return; // 无有效日期不建

  const opp = await prisma.opportunity.findFirst({ where: { id: ref.opportunityId, tenantId }, select: { name: true } });
  const schedule: WeComSchedule = {
    summary: (isMile ? '🚩 ' : '') + (ref.title || (isMile ? '里程碑' : '销售行动')),
    description: opp?.name ? `商机：${opp.name}` : '', // 中性上下文，无敏感
    startTime, endTime,
    organizerUserid: bind.wecomUserid,
    attendeeUserids: [bind.wecomUserid],
    remindBeforeSecs: 3600,
  };

  const map = await prisma.scheduleSync.findUnique({ where: whereMap });
  try {
    const cred = decryptWeComCred(cfg);
    const token = await getAccessToken(cred.corpId, cred.secret);
    if (map?.wecomScheduleId) {
      await updateSchedule(token, map.wecomScheduleId, schedule);
      await prisma.scheduleSync.update({ where: { id: map.id }, data: { status: 'synced', lastError: '' } });
    } else {
      const sid = await addSchedule(token, schedule);
      await prisma.scheduleSync.upsert({ where: whereMap, create: { id: 'ss_' + randomUUID().slice(0, 12), tenantId, kind, refId, wecomScheduleId: sid, status: 'synced' }, update: { wecomScheduleId: sid, status: 'synced', lastError: '' } });
    }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    await prisma.scheduleSync.upsert({ where: whereMap, create: { id: 'ss_' + randomUUID().slice(0, 12), tenantId, kind, refId, wecomScheduleId: '', status: 'failed', lastError: msg }, update: { status: 'failed', lastError: msg } });
  }
}

export function wecomRoutes(app: FastifyInstance) {
  const canManage = (req: any) => ['owner', 'admin'].includes(req.user.role);

  // 租户企微应用配置（管理员）。Secret 经 AES 加密存、绝不回明文（照 AiConfig）。
  app.get('/api/wecom/config', { preHandler: [app.authenticate] }, async (req: any) => {
    const c = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!c) return { configured: false, corpId: '', agentId: '', hasSecret: false };
    return { configured: !!c.corpId && !!c.agentId && !!c.secretEnc, corpId: c.corpId, agentId: c.agentId, hasSecret: !!c.secretEnc };
  });

  app.put('/api/wecom/config', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置企微应用' });
    const p = z.object({ corpId: z.string().optional(), agentId: z.string().optional(), secret: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const { corpId = '', agentId = '', secret } = p.data;
    const existing = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    // secret 为 undefined → 保留旧；为 '' → 清空；有值 → 加密更新
    const secretEnc = secret === undefined ? (existing?.secretEnc ?? '') : (secret ? enc(secret) : '');
    const data = { corpId, agentId, secretEnc };
    await prisma.weComConfig.upsert({ where: { tenantId: req.user.tenantId }, create: { tenantId: req.user.tenantId, ...data }, update: data });
    return { ok: true };
  });

  // 当前用户的企微 userid 绑定（P2-a 手填；P2-b 改 OAuth 扫码自动绑）。wecomUserid 是标识非密钥，明文存。
  app.get('/api/wecom/bind', { preHandler: [app.authenticate] }, async (req: any) => {
    const b = await prisma.weComUserBind.findUnique({ where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } } });
    return { wecomUserid: b?.wecomUserid ?? '' };
  });

  app.put('/api/wecom/bind', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const p = z.object({ wecomUserid: z.string().trim().max(128) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const wecomUserid = p.data.wecomUserid;
    if (!wecomUserid) { await prisma.weComUserBind.deleteMany({ where: { tenantId: req.user.tenantId, userId: req.user.userId } }); return { ok: true, wecomUserid: '' }; }
    await prisma.weComUserBind.upsert({
      where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } },
      create: { id: 'wb_' + randomUUID().slice(0, 12), tenantId: req.user.tenantId, userId: req.user.userId, wecomUserid },
      update: { wecomUserid },
    });
    return { ok: true, wecomUserid };
  });

  // OAuth 扫码绑定：start 生成授权链接，callback 用 code 换 userid 落 WeComUserBind（替代手填）。⚠️ 回调需公网 + 应用可信域名，真机生效。
  app.get('/api/wecom/oauth/start', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!cfg?.corpId || !cfg.agentId) return reply.code(400).send({ error: '请先配置企微应用（corpId / AgentId）' });
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
    const state = enc(JSON.stringify({ t: req.user.tenantId, u: req.user.userId, ts: Date.now() }));
    return { url: buildWecomAuthUrl(cfg.corpId, cfg.agentId, `${base}/api/wecom/oauth/callback`, state) };
  });

  app.get('/api/wecom/oauth/callback', async (req: any, reply) => {
    const { code, state } = (req.query || {}) as any;
    const html = (msg: string, ok: boolean) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:48px"><h2>${ok ? '✅' : '❌'} ${msg}</h2><p>可关闭本页返回江湖。</p></body>`;
    reply.type('text/html; charset=utf-8');
    try {
      const st = JSON.parse(dec(String(state || '')));
      if (!st?.t || !st?.u) return reply.send(html('绑定失败：state 无效', false));
      const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: st.t } });
      if (!cfg?.corpId || !cfg.secretEnc) return reply.send(html('绑定失败：企微应用未配置', false));
      const cred = decryptWeComCred(cfg);
      const userid = await exchangeCodeToUserid(cred.corpId, cred.secret, String(code || ''));
      await prisma.weComUserBind.upsert({
        where: { tenantId_userId: { tenantId: st.t, userId: st.u } },
        create: { id: 'wb_' + randomUUID().slice(0, 12), tenantId: st.t, userId: st.u, wecomUserid: userid },
        update: { wecomUserid: userid },
      });
      return reply.send(html(`已绑定企微 userid：${userid}`, true));
    } catch (e: any) {
      return reply.send(html('绑定失败：' + (e?.message || e), false));
    }
  });
}
