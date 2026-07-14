// 企业微信自建应用 client：access_token + 日程(oa/schedule) CRUD。
// 租户 BYO 凭据(WeComConfig)：corpId/agentId 明文 + secretEnc AES 密文；江湖代调【租户自己】企微的日程 API（平台不需公司资质）。
// ⚠️ 日程端点/字段按企微开放平台「日程」官方文档(oa/schedule)先写，标 TODO 待公网真机校准（同飞书妙记的处理）。
// PIPL：WeComSchedule 仅含 标题/描述(中性上下文)/时间/参与人 userid——绝不放 FORM/态度/弱点（字段白名单在调用方 syncToWecom 构造时把关）。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ActorRoleSchema, type Action } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import { enc, dec } from './ai.js';
import { scoreFromState } from './g64111.js';
import { wecomSignature, decryptWecomMsg, xmlTag } from './wecomCrypt.js';
import { deploymentOutboundPolicy, fetchOutbound } from './security/outboundUrl.js';
import { activePersonWhere } from './activePerson.js';

const QYAPI = 'https://qyapi.weixin.qq.com';

export interface WeComCred { tenantId: string; corpId: string; agentId: string; secret: string }

// access_token 缓存(tenantId + corpId → {token, exp})，禁止跨租户复用。
const tokenCache = new Map<string, { token: string; exp: number }>();
export const tokenCacheKey = (tenantId: string, corpId: string) => `${tenantId}\u0000${corpId}`;

/** 用 corpId + 应用 secret 换 access_token（缓存，留 60s 余量）。 */
export async function getAccessToken(tenantId: string, corpId: string, secret: string): Promise<string> {
  const cacheKey = tokenCacheKey(tenantId, corpId);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetchOutbound(`${QYAPI}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`, {}, deploymentOutboundPolicy(), { timeoutMs: 15_000, maxResponseBytes: 1_048_576 });
  const d: any = await res.json().catch(() => ({}));
  if (d.errcode !== 0 || !d.access_token) throw new Error(`企微 access_token 获取失败：${d.errmsg || d.errcode || `HTTP ${res.status}`}`);
  tokenCache.set(cacheKey, { token: d.access_token, exp: Date.now() + Number(d.expires_in || 7200) * 1000 });
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
export async function exchangeCodeToUserid(tenantId: string, corpId: string, secret: string, code: string): Promise<string> {
  const token = await getAccessToken(tenantId, corpId, secret);
  const res = await fetchOutbound(`${QYAPI}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`, {}, deploymentOutboundPolicy(), { timeoutMs: 15_000, maxResponseBytes: 1_048_576 });
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
  const res = await fetchOutbound(`${QYAPI}${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, deploymentOutboundPolicy(), { timeoutMs: 15_000, maxResponseBytes: 1_048_576 });
  const d: any = await res.json().catch(() => ({}));
  if (d.errcode !== 0) throw new Error(`企微接口失败：${d.errmsg || d.errcode}（${path}）`);
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
export function decryptWeComCred(row: { tenantId: string; corpId: string; agentId: string; secretEnc: string }): WeComCred {
  return { tenantId: row.tenantId, corpId: row.corpId, agentId: row.agentId, secret: row.secretEnc ? dec(row.secretEnc) : '' };
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
export async function syncFromAction(tenantId: string, userId: string, action: Action): Promise<void> {
  let kind: 'plan_action' | 'milestone';
  let refId: string;
  switch (action.type) {
    case 'ADD_PLAN_ACTION': kind = 'plan_action'; refId = action.planAction.id; break;
    case 'UPDATE_PLAN_ACTION':
    case 'DELETE_PLAN_ACTION':
    case 'TOGGLE_PLAN_ACTION': kind = 'plan_action'; refId = action.actionId; break;
    case 'ADD_MILESTONE': kind = 'milestone'; refId = action.milestone.id; break;
    case 'UPDATE_MILESTONE':
    case 'DELETE_MILESTONE': kind = 'milestone'; refId = action.milestoneId; break;
    default: return;
  }
  const isPlan = kind === 'plan_action';
  const isMile = kind === 'milestone';

  const cfg = await prisma.weComConfig.findUnique({ where: { tenantId } });
  if (!cfg || !cfg.corpId || !cfg.secretEnc) return; // 未接企微

  const whereMap = { tenantId_kind_refId: { tenantId, kind, refId } };

  // 删除：查映射 → 删企微日程
  if (action.type.startsWith('DELETE_')) {
    const map = await prisma.scheduleSync.findUnique({ where: whereMap });
    if (!map?.wecomScheduleId) return;
    try {
      const cred = decryptWeComCred(cfg);
      await delSchedule(await getAccessToken(cred.tenantId, cred.corpId, cred.secret), map.wecomScheduleId);
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
    const token = await getAccessToken(cred.tenantId, cred.corpId, cred.secret);
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

// ── 应用消息推送（场景 B：提醒卡 + 一键采纳模板卡）──

/** 发文本卡片（V1 验收：不依赖回调配置）。 */
export async function sendTextCard(cred: WeComCred, touser: string, card: { title: string; description: string; url: string; btntxt?: string }): Promise<void> {
  const token = await getAccessToken(cred.tenantId, cred.corpId, cred.secret);
  await callApi(token, '/cgi-bin/message/send', {
    touser, msgtype: 'textcard', agentid: Number(cred.agentId),
    textcard: { title: card.title, description: card.description, url: card.url, btntxt: card.btntxt || '详情' },
  });
}

export interface CardButton { text: string; key: string; style?: number }

/** 发按钮交互模板卡（V2/V3：按钮点击经「接收消息」回调回江湖——发送前提=应用已配回调 URL）。 */
export async function sendButtonCard(cred: WeComCred, touser: string, c: { taskId: string; title: string; desc?: string; fields?: Array<{ k: string; v: string }>; buttons: CardButton[] }): Promise<void> {
  const token = await getAccessToken(cred.tenantId, cred.corpId, cred.secret);
  await callApi(token, '/cgi-bin/message/send', {
    touser, msgtype: 'template_card', agentid: Number(cred.agentId),
    template_card: {
      card_type: 'button_interaction',
      task_id: c.taskId,
      main_title: { title: c.title, desc: c.desc || '' },
      ...(c.fields?.length ? { horizontal_content_list: c.fields.map((f) => ({ keyname: f.k, value: f.v })) } : {}),
      button_list: c.buttons.map((b) => ({ text: b.text, key: b.key, style: b.style ?? 1 })),
    },
  });
}

/** 按钮点击后刷新卡片（把按钮替换成结果文案，如「✓ 已采纳」）。 */
export async function updateCardButton(cred: WeComCred, responseCode: string, replaceName: string, userids: string[]): Promise<void> {
  const token = await getAccessToken(cred.tenantId, cred.corpId, cred.secret);
  await callApi(token, '/cgi-bin/message/update_template_card', {
    userids, agentid: Number(cred.agentId), response_code: responseCode,
    button: { replace_name: replaceName },
  });
}

/** 服务端算「采纳该 sentiment 提案」的趋赢力影响（照 mcpServer.getWinTendency 的组装，before/after 各算一次）。 */
async function sentimentImpact(tenantId: string, oppId: string, personId: string, newValue: string): Promise<{ before: number; after: number } | null> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: oppId, tenantId },
    include: { roles: true, bis: true, ucvs: true, account: { include: { persons: { where: activePersonWhere } } } },
  });
  if (!opp) return null;
  const J = (s: string | null, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  const account = { persons: opp.account.persons.map((p) => ({ id: p.id, form: J(p.form, {}) })) };
  const mk = (override?: string) => ({
    engageStage: opp.engageStage,
    c3Items: J(opp.c3Items, {}), c5Items: J(opp.c5Items, {}),
    roles: opp.roles.map((r) => ({
      personId: r.personId, role: r.role as any,
      sentiment: (override !== undefined && r.personId === personId ? override : r.sentiment) as any,
      confidence: r.confidence as any, isKeyInfluencer: r.isKeyInfluencer,
      procurementType: (r.procurementType ?? undefined) as any, procurementStatus: (r.procurementStatus ?? undefined) as any,
    })),
    bis: opp.bis.map((b) => ({ id: b.id, personId: b.personId, confidence: b.confidence as any })),
    ucvs: opp.ucvs.map((u) => ({ targetBiId: u.targetBiId, status: u.status as any })),
  });
  const pct = (s: { percent: number }) => Math.round(s.percent * 100);
  return { before: pct(scoreFromState(account as any, mk() as any)), after: pct(scoreFromState(account as any, mk(newValue) as any)) };
}

const FIELD_LABEL: Record<string, string> = { sentiment: '支持度' };

/**
 * 新字段提案 → 推企微模板卡给全租户已绑定成员（v1 小团队全员，后续按 deal owner 收窄）。
 * PIPL 从严：卡片只含 人名 / 字段类型 / 趋赢力影响 / 来源置信——不含新旧值明细（态度值不出应用，点开 App 才见全量）。
 * 全程静默失败（fire-and-forget，绝不影响提案落库）。
 */
export async function pushProposalCard(tenantId: string, proposalId: string): Promise<void> {
  try {
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId } });
    if (!cfg?.corpId || !cfg.secretEnc || !cfg.callbackToken) return; // 未配企微或未配回调（按钮卡需要回调）→ 不推
    const cp = await prisma.changeProposal.findFirst({ where: { id: proposalId, tenantId } });
    if (!cp || cp.status !== 'pending') return;
    const rawBinds = await prisma.weComUserBind.findMany({ where: { tenantId } });
    if (!rawBinds.length) return;
    const users = await prisma.user.findMany({ where: { tenantId, id: { in: rawBinds.map((b) => b.userId) } }, select: { id: true, role: true } });
    const roleByUser = new Map(users.map((u) => [u.id, ActorRoleSchema.safeParse(u.role)]));
    const counts = new Map<string, number>();
    for (const bind of rawBinds) counts.set(bind.wecomUserid, (counts.get(bind.wecomUserid) ?? 0) + 1);
    // 提案属于 account 敏感内容；只向当前有效且可审批的非 viewer 成员发送。重复 bind fail closed。
    const binds = rawBinds.filter((b) => {
      const role = roleByUser.get(b.userId);
      return counts.get(b.wecomUserid) === 1 && role?.success && role.data !== 'viewer';
    });
    if (!binds.length) return;

    const person = cp.entityKind === 'oppRole' ? await prisma.person.findFirst({ where: { id: cp.entityId, tenantId, ...activePersonWhere }, select: { name: true } }) : null;
    let impact = '';
    if (cp.entityKind === 'oppRole' && cp.field === 'sentiment' && cp.opportunityId) {
      const d = await sentimentImpact(tenantId, cp.opportunityId, cp.entityId, cp.newValue).catch(() => null);
      if (d && d.before !== d.after) impact = `${d.before}% → ${d.after}%`;
    }
    const cred = decryptWeComCred(cfg);
    const fields: Array<{ k: string; v: string }> = [
      { k: '来源', v: `${cp.origin || 'AI'} · 置信 ${(cp.confidence ?? 0.5).toFixed(2)}` },
      ...(impact ? [{ k: '趋赢力', v: impact }] : []),
    ];
    for (const b of binds) {
      const taskId = `cp_${cp.id.slice(3)}_${Date.now().toString(36)}_${b.wecomUserid}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
      await sendButtonCard(cred, b.wecomUserid, {
        taskId,
        title: `✏️ 待你拍板：${person?.name || '干系人'} 的${FIELD_LABEL[cp.field] || cp.field}有变更提案`,
        desc: '明细在江湖收件箱（企微内不展示敏感值）',
        fields,
        buttons: [
          { text: '✓ 采纳', key: `cp:accept:${cp.id}`, style: 1 },
          { text: '✗ 驳回', key: `cp:reject:${cp.id}`, style: 2 },
        ],
      }).catch(() => { /* 单人失败不影响其他人 */ });
    }
  } catch { /* fire-and-forget */ }
}

// ── 回调（「接收消息」）：URL 带租户段定位配置 + receiveId==corpId 双重校验 ──

async function loadCallbackCfg(tenantId: string): Promise<{ token: string; aesKey: string; corpId: string } | null> {
  const cfg = await prisma.weComConfig.findUnique({ where: { tenantId } });
  if (!cfg?.callbackToken || !cfg.callbackAesKeyEnc) return null;
  try { return { token: cfg.callbackToken, aesKey: dec(cfg.callbackAesKeyEnc), corpId: cfg.corpId }; } catch { return null; }
}

/** 处理解密后的回调事件（导出供 E2E 直测）。当前只关心模板卡按钮：test:ok / cp:accept:<id> / cp:reject:<id>。 */
export async function handleWecomEvent(tenantId: string, xml: string): Promise<void> {
  if (xmlTag(xml, 'MsgType') !== 'event' || xmlTag(xml, 'Event') !== 'template_card_event') return;
  const key = xmlTag(xml, 'EventKey');
  const responseCode = xmlTag(xml, 'ResponseCode');
  const fromUser = xmlTag(xml, 'FromUserName');
  const cfg = await prisma.weComConfig.findUnique({ where: { tenantId } });
  if (!cfg?.corpId || !cfg.secretEnc) return;
  const cred = decryptWeComCred(cfg);
  const finish = (name: string) => (responseCode ? updateCardButton(cred, responseCode, name, [fromUser]).catch(() => {}) : Promise.resolve());

  if (key === 'test:ok') { await finish('✅ 回调链路已通'); return; }

  const m = key.match(/^cp:(accept|reject):(.+)$/);
  if (!m) return;
  // 鉴权：点按钮的企微成员必须已绑定江湖账号（绑定 = 本工作区成员，人审授权有效）
  const { reviewProposalFromWecom } = await import('./proposals.js'); // 动态 import 破循环
  try {
    const r = await reviewProposalFromWecom(tenantId, fromUser, m[2], m[1] as 'accept' | 'reject');
    await finish(r === 'ok' ? (m[1] === 'accept' ? '✓ 已采纳' : '已驳回') : r === 'already' ? '已处理过' : r === 'unauthorized' ? '⚠️ 绑定账号无权操作' : '提案不存在');
  } catch { await finish('处理失败'); }
}

export function wecomRoutes(app: FastifyInstance) {
  const canManage = (req: any) => ['owner', 'admin'].includes(req.user.role);

  const callbackUrlOf = (req: any, tenantId: string) => {
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
    return `${base}/api/wecom/callback/${tenantId}`;
  };

  // 租户企微应用配置（管理员）。Secret / EncodingAESKey 经 AES 加密存、绝不回明文（照 AiConfig）。
  app.get('/api/wecom/config', { preHandler: [app.authenticate] }, async (req: any) => {
    const c = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    const callbackUrl = callbackUrlOf(req, req.user.tenantId);
    if (!c) return { configured: false, corpId: '', agentId: '', hasSecret: false, hasCallback: false, callbackUrl };
    return {
      configured: !!c.corpId && !!c.agentId && !!c.secretEnc,
      corpId: c.corpId, agentId: c.agentId, hasSecret: !!c.secretEnc,
      hasCallback: !!c.callbackToken && !!c.callbackAesKeyEnc, callbackUrl,
    };
  });

  app.put('/api/wecom/config', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    if (!canManage(req)) return reply.code(403).send({ error: '仅管理员可配置企微应用' });
    const p = z.object({
      corpId: z.string().optional(), agentId: z.string().optional(), secret: z.string().optional(),
      callbackToken: z.string().max(64).optional(), callbackAesKey: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const { corpId, agentId, secret, callbackToken, callbackAesKey } = p.data;
    if (callbackAesKey && callbackAesKey.length !== 43) return reply.code(400).send({ error: 'EncodingAESKey 应为 43 位' });
    const existing = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    // 全部字段：undefined → 保留旧；'' → 清空；有值 → （密钥类加密）更新。支持分区块保存不互相清空。
    const data = {
      corpId: corpId === undefined ? (existing?.corpId ?? '') : corpId,
      agentId: agentId === undefined ? (existing?.agentId ?? '') : agentId,
      secretEnc: secret === undefined ? (existing?.secretEnc ?? '') : (secret ? enc(secret) : ''),
      callbackToken: callbackToken === undefined ? (existing?.callbackToken ?? '') : callbackToken,
      callbackAesKeyEnc: callbackAesKey === undefined ? (existing?.callbackAesKeyEnc ?? '') : (callbackAesKey ? enc(callbackAesKey) : ''),
    };
    await prisma.weComConfig.upsert({ where: { tenantId: req.user.tenantId }, create: { tenantId: req.user.tenantId, ...data }, update: data });
    return { ok: true };
  });

  // ── 回调（企微「接收消息」，无登录态——靠签名 + AES 解密 + receiveId 校验）──
  app.addContentTypeParser(['text/xml', 'application/xml'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  // GET：管理员在企微后台保存回调配置时的 URL 验证（解密 echostr 回显明文）
  app.get('/api/wecom/callback/:tenantId', async (req: any, reply) => {
    try {
      const q = (req.query || {}) as any;
      const cb = await loadCallbackCfg(String(req.params.tenantId));
      if (!cb) return reply.code(404).type('text/plain').send('callback not configured');
      if (wecomSignature(cb.token, String(q.timestamp), String(q.nonce), String(q.echostr)) !== String(q.msg_signature)) {
        return reply.code(403).type('text/plain').send('bad signature');
      }
      const { msg, receiveId } = decryptWecomMsg(cb.aesKey, String(q.echostr));
      if (cb.corpId && receiveId && receiveId !== cb.corpId) return reply.code(403).type('text/plain').send('corp mismatch');
      return reply.type('text/plain').send(msg);
    } catch { return reply.code(400).type('text/plain').send('verify failed'); }
  });

  // POST：事件（模板卡按钮点击等）。企微要求 5s 内响应——校验后异步处理、先回 success（处理结果经 update_template_card 刷回卡片）。
  app.post('/api/wecom/callback/:tenantId', async (req: any, reply) => {
    try {
      const tenantId = String(req.params.tenantId);
      const q = (req.query || {}) as any;
      const cb = await loadCallbackCfg(tenantId);
      if (!cb) return reply.code(404).type('text/plain').send('');
      const encrypt = xmlTag(String(req.body || ''), 'Encrypt');
      if (!encrypt || wecomSignature(cb.token, String(q.timestamp), String(q.nonce), encrypt) !== String(q.msg_signature)) {
        return reply.code(403).type('text/plain').send('');
      }
      const { msg, receiveId } = decryptWecomMsg(cb.aesKey, encrypt);
      if (cb.corpId && receiveId && receiveId !== cb.corpId) return reply.code(403).type('text/plain').send('');
      void handleWecomEvent(tenantId, msg).catch(() => {});
      return reply.type('text/plain').send('success');
    } catch { return reply.type('text/plain').send('success'); } // 异常也回 success，防企微重试风暴
  });

  // 测试推送（V1 文本卡 / V2 按钮卡）：发给当前登录用户绑定的企微 userid。
  app.post('/api/wecom/test-push', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const kind = req.body?.kind === 'card' ? 'card' : 'textcard';
    const tenantId = req.user.tenantId;
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId } });
    if (!cfg?.corpId || !cfg.agentId || !cfg.secretEnc) return reply.code(400).send({ error: '请先保存企微应用配置（corpId / AgentId / Secret）' });
    const bind = await prisma.weComUserBind.findUnique({ where: { tenantId_userId: { tenantId, userId: req.user.userId } } });
    if (!bind?.wecomUserid) return reply.code(400).send({ error: '请先绑定你的企微 userid（下方②）' });
    if (kind === 'card' && !cfg.callbackToken) return reply.code(400).send({ error: '按钮卡需先配置回调（Token / EncodingAESKey），文本卡不需要' });
    const cred = decryptWeComCred(cfg);
    try {
      if (kind === 'textcard') {
        const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
        await sendTextCard(cred, bind.wecomUserid, { title: '江湖 · 测试推送', description: '看到这张卡说明推送链路已通（验收 V1 ✓）。', url: base, btntxt: '打开江湖' });
      } else {
        const taskId = `test_${Date.now().toString(36)}_${bind.wecomUserid}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
        await sendButtonCard(cred, bind.wecomUserid, {
          taskId, title: '江湖 · 一键采纳链路测试', desc: '点下方按钮，卡片会自动刷新（验收 V2）',
          buttons: [{ text: '点我测试', key: 'test:ok', style: 1 }],
        });
      }
      return { ok: true };
    } catch (e: any) { return reply.code(400).send({ error: String(e?.message || e) }); }
  });

  // 当前用户的企微 userid 绑定（P2-a 手填；P2-b 改 OAuth 扫码自动绑）。wecomUserid 是标识非密钥，明文存。
  app.get('/api/wecom/bind', { preHandler: [app.authenticate] }, async (req: any) => {
    const b = await prisma.weComUserBind.findUnique({ where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } } });
    return { wecomUserid: b?.wecomUserid ?? '' };
  });

  app.put('/api/wecom/bind', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const p = z.object({ wecomUserid: z.string().trim().max(128) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数无效' });
    const wecomUserid = p.data.wecomUserid;
    if (!wecomUserid) { await prisma.weComUserBind.deleteMany({ where: { tenantId: req.user.tenantId, userId: req.user.userId } }); return { ok: true, wecomUserid: '' }; }
    const occupied = await prisma.weComUserBind.findUnique({ where: { tenantId_wecomUserid: { tenantId: req.user.tenantId, wecomUserid } } });
    if (occupied && occupied.userId !== req.user.userId) return reply.code(409).send({ error: '该企微 userid 已绑定其他账号' });
    try {
      await prisma.weComUserBind.upsert({
        where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } },
        create: { id: 'wb_' + randomUUID().slice(0, 12), tenantId: req.user.tenantId, userId: req.user.userId, wecomUserid },
        update: { wecomUserid },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.code(409).send({ error: '该企微 userid 已绑定其他账号' });
      throw error;
    }
    return { ok: true, wecomUserid };
  });

  // OAuth 扫码绑定：callback 只交换企微 userid 并落短时 pending；原发起江湖会话须显式 confirm 才真正绑定。
  app.get('/api/wecom/oauth/start', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } });
    if (!cfg?.corpId || !cfg.agentId) return reply.code(400).send({ error: '请先配置企微应用（corpId / AgentId）' });
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
    const state = randomUUID(); // 只给 provider，允许被转发但不具备江湖侧确认能力
    const requestId = randomUUID(); // 只返回给当前已认证 app，绝不放进 OAuth URL
    await prisma.weComOAuthState.create({ data: {
      id: state, requestId, tenantId: req.user.tenantId, userId: req.user.userId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    } });
    return { url: buildWecomAuthUrl(cfg.corpId, cfg.agentId, `${base}/api/wecom/oauth/callback`, state), requestId };
  });

  app.get('/api/wecom/oauth/callback', async (req: any, reply) => {
    const { code, state } = (req.query || {}) as any;
    const html = (msg: string, ok: boolean) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:48px"><h2>${ok ? '✅' : '❌'} ${msg}</h2><p>可关闭本页返回江湖。</p></body>`;
    reply.type('text/html; charset=utf-8');
    try {
      const nonce = String(state || '');
      const st = await prisma.weComOAuthState.findFirst({ where: {
        id: nonce, requestId: { not: null }, consumedAt: null, pendingAt: null, expiresAt: { gt: new Date() },
      } });
      if (!st) return reply.send(html('绑定失败：state 已过期、已使用或无效', false));
      const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: st.tenantId } });
      if (!cfg?.corpId || !cfg.secretEnc) return reply.send(html('绑定失败：企微应用未配置', false));
      const cred = decryptWeComCred(cfg);
      const userid = await exchangeCodeToUserid(cred.tenantId, cred.corpId, cred.secret, String(code || ''));
      const stored = await prisma.weComOAuthState.updateMany({
        where: { id: nonce, requestId: st.requestId, consumedAt: null, pendingAt: null, expiresAt: { gt: new Date() } },
        data: { pendingWecomUserid: userid, pendingAt: new Date() },
      });
      if (stored.count !== 1) return reply.send(html('绑定失败：state 已过期、已使用或无效', false));
      return reply.send(html('企微身份已读取，等待原江湖会话确认', true));
    } catch (e: any) {
      return reply.send(html('绑定失败：' + (e?.message || e), false));
    }
  });

  app.get('/api/wecom/oauth/status', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const parsed = z.object({ requestId: z.string().min(1).max(128) }).safeParse(req.query || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数无效' });
    const row = await prisma.weComOAuthState.findFirst({ where: {
      requestId: parsed.data.requestId, tenantId: req.user.tenantId, userId: req.user.userId,
    } });
    if (!row) return reply.code(404).send({ error: '绑定请求不存在' });
    if (row.consumedAt) return { status: 'consumed' };
    if (row.expiresAt <= new Date()) return { status: 'expired' };
    if (row.pendingAt && row.pendingWecomUserid) return { status: 'pending', wecomUserid: row.pendingWecomUserid };
    return { status: 'waiting' };
  });

  app.post('/api/wecom/oauth/confirm', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (denyViewer(req, reply)) return;
    const parsed = z.object({ requestId: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数无效' });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const row = await tx.weComOAuthState.findFirst({ where: {
          requestId: parsed.data.requestId, tenantId: req.user.tenantId, userId: req.user.userId,
        } });
        if (!row) return { status: 'not_found' as const };
        if (row.consumedAt) return { status: 'consumed' as const };
        if (row.expiresAt <= new Date()) return { status: 'expired' as const };
        if (!row.pendingAt || !row.pendingWecomUserid) return { status: 'waiting' as const };
        const fresh = await tx.user.findFirst({ where: { id: row.userId, tenantId: row.tenantId }, select: { id: true, role: true } });
        const role = ActorRoleSchema.safeParse(fresh?.role);
        if (!fresh || !role.success || role.data === 'viewer') return { status: 'unauthorized' as const };
        const occupied = await tx.weComUserBind.findUnique({ where: {
          tenantId_wecomUserid: { tenantId: row.tenantId, wecomUserid: row.pendingWecomUserid },
        } });
        if (occupied && occupied.userId !== row.userId) return { status: 'occupied' as const };
        const claimed = await tx.weComOAuthState.updateMany({
          where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() }, pendingWecomUserid: row.pendingWecomUserid },
          data: { consumedAt: new Date() },
        });
        if (claimed.count !== 1) return { status: 'consumed' as const };
        await tx.weComUserBind.upsert({
          where: { tenantId_userId: { tenantId: row.tenantId, userId: row.userId } },
          create: { id: 'wb_' + randomUUID().slice(0, 12), tenantId: row.tenantId, userId: row.userId, wecomUserid: row.pendingWecomUserid },
          update: { wecomUserid: row.pendingWecomUserid },
        });
        return { status: 'ok' as const, wecomUserid: row.pendingWecomUserid };
      }, { isolationLevel: 'Serializable' });
      if (result.status === 'not_found') return reply.code(404).send({ error: '绑定请求不存在' });
      if (result.status === 'expired') return reply.code(410).send({ error: '绑定请求已过期' });
      if (result.status === 'consumed') return reply.code(409).send({ error: '绑定请求已使用' });
      if (result.status === 'waiting') return reply.code(409).send({ error: '尚未收到企微身份' });
      if (result.status === 'unauthorized') return reply.code(403).send({ error: '账号已失效或无权限' });
      if (result.status === 'occupied') return reply.code(409).send({ error: '该企微 userid 已绑定其他账号' });
      return { ok: true, wecomUserid: result.wecomUserid };
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.code(409).send({ error: '该企微 userid 已绑定其他账号' });
      throw error;
    }
  });
}
