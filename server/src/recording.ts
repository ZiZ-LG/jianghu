// 录音接入 —— 从录音源拉「转写文字」→ 加密存 Transcript（PIPL 原始层）→ 复用 voice 抽取链路 → 候选人审。
// 第一刀（地基+骨架）：实现 mock 源端到端；得到大脑 MCP / 飞书妙记 · 钉钉听记 OpenAPI 留接入点，待 BYO 凭据真验。
// 铁律：① 转写含客户隐私 → contentEnc 加密落库（绝不明文，复用 ai.ts 的 AES-256-GCM）；
//      ② 全程 tenantId 强隔离；③ 抽取产物一律走 voice 双轨（explicit 直落 / inferred 候选人审，铁律②）；
//      ④ 江湖只取转写文字，不碰音频、不自建 ASR（三源自带语音转写）。

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { enc, dec } from './ai.js';
import { ingestVoiceText, type IngestResult } from './voice.js';
import { buildFeishuAuthUrl, exchangeFeishuCode, refreshFeishuToken, getFeishuMinute, extractFeishuMinuteToken, searchFeishuMinutes, type FeishuApp } from './feishu.js';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { listGetnoteNotes, getGetnoteTranscript } from './getnote.js';

export type RecordingSource = 'getnote' | 'feishu' | 'dingtalk' | 'mock' | 'manual' | 'upload';

// 从录音源 API 拉到的一条原始转写。江湖只取转写文字（不碰音频）。
export interface PulledTranscript {
  externalRef: string;     // 源侧唯一 id（幂等去重）
  title: string;           // 录音/会议标题（非隐私）
  text: string;            // 转写全文（隐私 → 落库前加密）
  durationSec?: number;
  recordedAt?: Date | null;
}

// ── mock 源：演示用拜访录音转写（无外部凭据即可端到端验证抽取链路）──
// 内容刻意含可抽取的客户/商机/角色/支持度/BI/UCV/关系，验证转写→结构化全链路。
const MOCK_TRANSCRIPTS: PulledTranscript[] = [
  {
    externalRef: 'mock-visit-binhai-01',
    title: '滨海新区能源集团·智慧园区项目拜访录音',
    durationSec: 1742,
    recordedAt: null,
    text:
      '今天下午去拜访了滨海新区能源集团，主要谈智慧园区综合能源管理项目。见到了规划部的王建国部长，' +
      '他是这个项目的总负责人，最后拍板的就是他，对我们方案挺支持的。还有信息中心的李海主任，' +
      '负责技术选型这块，态度还比较中立，在观望。王部长说他们现在最头疼的是园区能耗数据分散在十几个系统里，' +
      '没法统一调度，上面能耗考核压得紧。我跟他讲我们方案能把这些系统数据全打通做统一优化，' +
      '这点是华为给不了的。竞争对手主要就是华为。李主任和王部长是老同事，私交不错，能说得上话。',
  },
  {
    externalRef: 'mock-call-zhongbei-01',
    title: '中北电力建设·数据中心扩建电话沟通录音',
    durationSec: 624,
    recordedAt: null,
    text:
      '刚跟中北电力建设的赵刚总监通了电话，他们那个数据中心扩建项目有进展。赵总监分管采购招标，' +
      '之前对我们有点顾虑，今天聊下来感觉松动了不少。他提到预算审批卡在财务的钱建华总那里，' +
      '钱总管钱、比较强势，这块得想办法。',
  },
];

/**
 * 从录音源拉转写。第一刀仅 mock 可用；得到大脑/飞书/钉钉留接入点（需 BYO 凭据，未配置时抛友好错误）。
 * 真实源接入（P2-b）：得到大脑复用 qccMcp.ts 的 streamable-HTTP 模式；飞书·钉钉走开放平台 OpenAPI。
 */
async function pullFromSource(tenantId: string, userId: string, source: RecordingSource): Promise<{ items: PulledTranscript[]; note: string }> {
  if (source === 'mock') return { items: MOCK_TRANSCRIPTS, note: 'mock 演示转写（2 条）' };
  if (source === 'getnote') return pullGetnote(tenantId, userId);
  // 飞书无「列表」开放 API → 走 POST /api/recording/feishu/pull（按妙记链接拉单篇），不经此批量入口。
  // 钉钉听记无转写开放 API → 改文件上传(/api/recording/upload)，不走此路径。
  throw new Error(`录音源「${source}」暂未接入：请改用文件上传，或在录音接入里先完成该来源的授权/配置`);
}

/** 把拉到的转写加密存 Transcript。幂等：同租户+源+externalRef 已存在则跳过。返回 {saved, skipped}。 */
async function saveTranscripts(
  tenantId: string,
  userId: string,
  source: RecordingSource,
  items: PulledTranscript[],
  mount: { accountId?: string; opportunityId?: string },
): Promise<{ saved: number; skipped: number }> {
  let saved = 0, skipped = 0;
  for (const it of items) {
    const ref = it.externalRef?.trim() || '';
    if (ref) {
      const dup = await prisma.transcript.findFirst({ where: { tenantId, source, externalRef: ref } });
      if (dup) { skipped++; continue; } // 同一条录音不重复拉取（幂等）
    }
    await prisma.transcript.create({
      data: {
        id: 'tr_' + randomUUID().slice(0, 12),
        tenantId,
        accountId: mount.accountId ?? null,
        opportunityId: mount.opportunityId ?? null,
        source,
        externalRef: ref || null,
        title: (it.title || '').slice(0, 200),
        contentEnc: enc(it.text || ''), // PIPL：转写正文加密落库，绝不明文
        durationSec: Math.max(0, Math.round(it.durationSec ?? 0)),
        recordedAt: it.recordedAt ?? null,
        status: 'active',
        createdBy: userId,
      },
    });
    saved++;
  }
  return { saved, skipped };
}

/** 拉 + 存合并（同步路由与后台 job 共用）。 */
export async function pullAndSave(
  tenantId: string,
  userId: string,
  source: RecordingSource,
  mount: { accountId?: string; opportunityId?: string },
): Promise<{ source: RecordingSource; saved: number; skipped: number; note: string }> {
  const { items, note } = await pullFromSource(tenantId, userId, source);
  const stat = await saveTranscripts(tenantId, userId, source, items, mount);
  return { source, ...stat, note };
}

/**
 * 从一条 Transcript 抽取：解密 → 复用 ingestVoiceText（source='recording'，双轨落库 + 候选人审）→ 标记 extracted。
 * 隔离：仅能抽取本租户的转写。降解/删除后的转写不可再抽。
 */
export async function extractTranscript(tenantId: string, userId: string, transcriptId: string): Promise<IngestResult> {
  const tr = await prisma.transcript.findFirst({ where: { id: transcriptId, tenantId } });
  if (!tr) return { ok: false, status: 404, body: { error: '转写不存在或无权访问' } };
  if (tr.status === 'redacted' || !tr.contentEnc) return { ok: false, status: 400, body: { error: '该转写原文已降解/删除，无法再抽取' } };
  const text = dec(tr.contentEnc);
  if (!text) return { ok: false, status: 400, body: { error: '转写解密失败（密钥可能已变更）' } };

  const r = await ingestVoiceText(tenantId, userId, {
    text,
    accountId: tr.accountId ?? undefined,
    opportunityId: tr.opportunityId ?? undefined,
    source: 'recording',
  });
  // 真正抽取成功（非"未配模型"退化）才标记已抽取，可降解原文。
  if (r.ok && !r.receipt?.needConfig) {
    await prisma.transcript.update({ where: { id: tr.id }, data: { status: 'extracted', extractedAt: new Date() } });
  }
  return r;
}

// ── 凭据 / 配置存取（铁律④：全 AES 加密，复用 ai.ts enc/dec）─────────────
// OAuth 回调地址：公网部署域名（飞书服务器要能回调到此）。生产经 PUBLIC_BASE_URL 注入。
const FEISHU_REDIRECT = (process.env.PUBLIC_BASE_URL || 'https://nova-jianghu.glodon.com') + '/api/recording/oauth/feishu/callback';

/** 读租户级飞书应用凭据（解密 App Secret）。无配置返回 null。 */
async function getFeishuApp(tenantId: string): Promise<FeishuApp | null> {
  const c = await prisma.recordingProviderConfig.findUnique({ where: { tenantId_provider: { tenantId, provider: 'feishu' } } });
  if (!c || !c.appId || !c.appSecretEnc) return null;
  return { appId: c.appId, appSecret: dec(c.appSecretEnc) };
}

/** 读 per-user 录音源凭据（解密 token）。非 active 或无 token 返回 null。 */
async function getCredential(tenantId: string, userId: string, source: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date | null } | null> {
  const c = await prisma.recordingCredential.findUnique({ where: { tenantId_userId_source: { tenantId, userId, source } } });
  if (!c || c.status !== 'active' || !c.accessTokenEnc) return null;
  return { accessToken: dec(c.accessTokenEnc), refreshToken: dec(c.refreshTokenEnc), expiresAt: c.expiresAt };
}

/** 写 per-user 凭据（加密 upsert）。 */
async function saveCredential(tenantId: string, userId: string, source: string, tok: { accessToken: string; refreshToken: string; expiresAt: Date | null }): Promise<void> {
  const data = { accessTokenEnc: enc(tok.accessToken), refreshTokenEnc: enc(tok.refreshToken || ''), expiresAt: tok.expiresAt ?? null, status: 'active' };
  await prisma.recordingCredential.upsert({
    where: { tenantId_userId_source: { tenantId, userId, source } },
    update: data,
    create: { id: 'rc_' + randomUUID().slice(0, 12), tenantId, userId, source, ...data },
  });
}

/** 取 per-user 飞书 user_access_token（过期则 refresh 并回存）。 */
async function feishuToken(tenantId: string, userId: string): Promise<string> {
  const cred = await getCredential(tenantId, userId, 'feishu');
  if (!cred) throw new Error('尚未授权飞书妙记：请先点「连接飞书」完成授权');
  if (cred.expiresAt && cred.expiresAt.getTime() < Date.now() + 60_000) { // 提前 1 分钟续期
    const appCfg = await getFeishuApp(tenantId);
    if (!appCfg) throw new Error('工作区未配置飞书应用（请管理员先配置 App ID/Secret）');
    if (!cred.refreshToken) throw new Error('飞书授权已过期，请重新授权');
    const fresh = await refreshFeishuToken(appCfg, cred.refreshToken);
    await saveCredential(tenantId, userId, 'feishu', fresh);
    return fresh.accessToken;
  }
  return cred.accessToken;
}

/** 飞书一键拉取：搜索妙记 → 筛标题「【拜访】」开头 → externalRef 去重(只拉新增) → 逐篇拉转写存 Transcript。 */
async function pullFeishuAuto(tenantId: string, userId: string, mount: { accountId?: string; opportunityId?: string }): Promise<{ saved: number; skipped: number; scanned: number; note: string }> {
  const token = await feishuToken(tenantId, userId);
  const { briefs, debug } = await searchFeishuMinutes(token, '【拜访】');
  const visits = briefs.filter((b) => b.title.trim().startsWith('【拜访】'));
  let saved = 0, skipped = 0;
  for (const b of visits) {
    const ref = `feishu:${b.token}`;
    const exists = await prisma.transcript.findFirst({ where: { tenantId, source: 'feishu', externalRef: ref } });
    if (exists) { skipped++; continue; } // 已拉过 → 跳过(只拉新增)
    try {
      const m = await getFeishuMinute(token, b.token);
      if (!m.transcript) { skipped++; continue; }
      await saveTranscripts(tenantId, userId, 'feishu', [{ externalRef: ref, title: m.title, text: m.transcript, durationSec: m.durationSec }], mount);
      saved++;
    } catch { skipped++; } // 单篇失败不阻塞整体
  }
  const note = visits.length === 0
    ? `未扫描到「【拜访】」开头的妙记（搜索原始返回 ${briefs.length} 条）。诊断：${debug}`
    : `扫描到【拜访】妙记 ${visits.length} 篇，新增拉取 ${saved} 篇`;
  return { saved, skipped, scanned: visits.length, note };
}

/** 飞书拉取：按 minute_token/链接拉单篇（备选入口）。 */
async function pullFeishuByToken(tenantId: string, userId: string, input: string, mount: { accountId?: string; opportunityId?: string }): Promise<{ saved: number; skipped: number; note: string }> {
  const minuteToken = extractFeishuMinuteToken(input);
  if (!minuteToken) throw new Error('请粘贴妙记链接或 token');
  const token = await feishuToken(tenantId, userId);
  const m = await getFeishuMinute(token, minuteToken);
  if (!m.transcript) throw new Error('该妙记暂无转写正文（可能尚未转写完成，或该篇无语音转写）');
  const stat = await saveTranscripts(tenantId, userId, 'feishu', [{ externalRef: `feishu:${minuteToken}`, title: m.title, text: m.transcript, durationSec: m.durationSec }], mount);
  return { ...stat, note: `飞书妙记「${m.title}」` };
}

/** 得到大脑拉取：读 per-user 凭据(apiKey+clientId) → 列笔记 → 拉录音/会议类的转写正文(audio.original)。 */
async function pullGetnote(tenantId: string, userId: string): Promise<{ items: PulledTranscript[]; note: string }> {
  const c = await prisma.recordingCredential.findUnique({ where: { tenantId_userId_source: { tenantId, userId, source: 'getnote' } } });
  if (!c || c.status !== 'active' || !c.accessTokenEnc) throw new Error('尚未配置得到大脑：请先在录音接入填 API Key + Client ID');
  let meta: any = {}; try { meta = JSON.parse(c.meta || '{}'); } catch { /* ignore */ }
  const cred = { apiKey: dec(c.accessTokenEnc), clientId: meta.clientId || '', baseUrl: meta.baseUrl || undefined };
  if (!cred.clientId) throw new Error('得到大脑凭据缺 Client ID，请重新配置');
  const notes = await listGetnoteNotes(cred);
  // 优先录音/会议类；type 缺失也尝试(detail 取不到转写会被跳过)
  const cand = notes.filter((n) => !n.type || ['meeting', 'recorder_audio', 'audio'].includes(n.type));
  const items: PulledTranscript[] = [];
  for (const n of cand.slice(0, 30)) {
    try {
      const det = await getGetnoteTranscript(cred, n.id);
      if (det.transcript) items.push({ externalRef: `getnote:${n.id}`, title: det.title || n.title, text: det.transcript, durationSec: det.durationSec });
    } catch { /* 单条失败跳过 */ }
  }
  return { items, note: `得到大脑 ${items.length} 条转写（候选 ${cand.length} 条，无转写的已跳过）` };
}

export function recordingRoutes(app: FastifyInstance): void {
  // 拉录音转写 → 加密存 Transcript。viewer 只读不可触发。
  app.post('/api/recording/pull', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可拉取录音' });
    const p = z.object({
      source: z.enum(['mock', 'getnote', 'feishu', 'dingtalk']).default('mock'),
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '参数错误' });
    // 挂载对象须属本租户（隔离）
    if (p.data.accountId) {
      const acc = await prisma.account.findFirst({ where: { id: p.data.accountId, tenantId: req.user.tenantId } });
      if (!acc) return reply.code(404).send({ error: '客户不存在' });
    }
    try {
      const r = await pullAndSave(req.user.tenantId, req.user.userId || '', p.data.source, { accountId: p.data.accountId, opportunityId: p.data.opportunityId });
      return r;
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '拉取失败' }); }
  });

  // 抽取某条转写 → 双轨落库 + 候选进收件箱。viewer 只读不可触发。
  app.post('/api/recording/extract', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可抽取转写' });
    const p = z.object({ transcriptId: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 transcriptId' });
    const r = await extractTranscript(req.user.tenantId, req.user.userId || '', p.data.transcriptId);
    if (!r.ok) return reply.code(r.status).send(r.body);
    return r.receipt;
  });

  // 列转写。PIPL 脱敏：列表只返元数据，绝不返回转写明文（要正文须经抽取，不旁路泄露）。
  app.get('/api/recording/transcripts', { preHandler: [app.authenticate] }, async (req: any) => {
    const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId : undefined;
    const rows = await prisma.transcript.findMany({
      where: { tenantId: req.user.tenantId, ...(accountId ? { accountId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    return {
      transcripts: rows.map((t) => ({
        id: t.id, source: t.source, title: t.title,
        accountId: t.accountId, opportunityId: t.opportunityId,
        durationSec: t.durationSec, status: t.status,
        recordedAt: t.recordedAt, extractedAt: t.extractedAt, createdAt: t.createdAt,
        hasContent: Boolean(t.contentEnc) && t.status !== 'redacted', // 仅标志，不含正文
      })),
    };
  });

  // PIPL 降解（最小留存）：清空原文密文、保留元数据。用完即可降解，仍可复查"抽过什么"。
  app.post('/api/recording/redact', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可操作' });
    const p = z.object({ transcriptId: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 transcriptId' });
    const tr = await prisma.transcript.findFirst({ where: { id: p.data.transcriptId, tenantId: req.user.tenantId } });
    if (!tr) return reply.code(404).send({ error: '转写不存在或无权访问' });
    await prisma.transcript.update({ where: { id: tr.id }, data: { contentEnc: '', status: 'redacted' } });
    return { ok: true, id: tr.id, status: 'redacted' };
  });

  // PIPL 可删：彻底删除转写原文 + 元数据。viewer 只读不可删。
  app.delete('/api/recording/transcripts/:id', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可删除' });
    const id = (req.params as any)?.id;
    const tr = await prisma.transcript.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!tr) return reply.code(404).send({ error: '转写不存在或无权访问' });
    await prisma.transcript.delete({ where: { id: tr.id } });
    return { ok: true, id: tr.id };
  });

  // ── 文件上传（替代钉钉听记）：md/txt/docx/pdf 文件 → 服务端解析提取文字 → 存 Transcript（加密）→ 可抽取 ──
  // multipart 文件，accountId/opportunityId 走 query。docx=mammoth、pdf=unpdf、md/txt=直读。
  app.post('/api/recording/upload', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可上传' });
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: '缺少上传文件' });
    const buf = await data.toBuffer();
    const name = (data.filename || '上传文件').slice(0, 200);
    const ext = (name.split('.').pop() || '').toLowerCase();
    let text = '';
    try {
      if (ext === 'md' || ext === 'txt') text = buf.toString('utf8');
      else if (ext === 'docx') text = (await mammoth.extractRawText({ buffer: buf })).value;
      else if (ext === 'pdf') {
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const r = await extractText(pdf, { mergePages: true });
        text = Array.isArray(r.text) ? r.text.join('\n') : r.text;
      } else return reply.code(400).send({ error: `不支持的格式「.${ext}」（支持 md/txt/docx/pdf）` });
    } catch (e: any) { return reply.code(400).send({ error: '文件解析失败：' + (e?.message || e) }); }
    text = text.trim();
    if (!text) return reply.code(400).send({ error: ext === 'pdf' ? '没从 PDF 提取到文字（可能是扫描版/图片型 PDF，无文本层）' : '文件没有可提取的文字' });
    const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId : undefined;
    const opportunityId = typeof req.query?.opportunityId === 'string' ? req.query.opportunityId : undefined;
    if (accountId) {
      const acc = await prisma.account.findFirst({ where: { id: accountId, tenantId: req.user.tenantId } });
      if (!acc) return reply.code(404).send({ error: '客户不存在' });
    }
    const stat = await saveTranscripts(req.user.tenantId, req.user.userId || '', 'upload', [{ externalRef: '', title: name, text }], { accountId, opportunityId });
    return { source: 'upload', ...stat };
  });

  // ── 租户级飞书应用配置（owner/admin 配 App ID/Secret，Secret 加密存、读不回明文）──
  app.get('/api/recording/provider/feishu', { preHandler: [app.authenticate] }, async (req: any) => {
    const c = await prisma.recordingProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: req.user.tenantId, provider: 'feishu' } } });
    return { configured: Boolean(c?.appId && c?.appSecretEnc), appId: c?.appId || '', hasSecret: Boolean(c?.appSecretEnc), enabled: c?.enabled ?? true, redirectUri: FEISHU_REDIRECT };
  });
  app.put('/api/recording/provider/feishu', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!['owner', 'admin'].includes(req.user.role)) return reply.code(403).send({ error: '仅管理员可配置飞书应用' });
    const p = z.object({ appId: z.string().min(1), appSecret: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 App ID' });
    const cur = await prisma.recordingProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: req.user.tenantId, provider: 'feishu' } } });
    const appSecretEnc = p.data.appSecret ? enc(p.data.appSecret) : (cur?.appSecretEnc || ''); // 留空=保留原密文
    await prisma.recordingProviderConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider: 'feishu' } },
      update: { appId: p.data.appId, appSecretEnc },
      create: { tenantId: req.user.tenantId, provider: 'feishu', appId: p.data.appId, appSecretEnc },
    });
    return { ok: true, redirectUri: FEISHU_REDIRECT };
  });

  // ── per-user 凭据状态：我授权/配置了哪些源 ──
  app.get('/api/recording/credentials', { preHandler: [app.authenticate] }, async (req: any) => {
    const rows = await prisma.recordingCredential.findMany({
      where: { tenantId: req.user.tenantId, userId: req.user.userId },
      select: { source: true, status: true, expiresAt: true, updatedAt: true },
    });
    return { credentials: rows };
  });

  // ── 飞书妙记·一键拉取：搜索 → 筛标题「【拜访】」开头 → 只拉新增。viewer 只读不可触发 ──
  app.post('/api/recording/feishu/sync', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可拉取' });
    const p = z.object({ accountId: z.string().optional(), opportunityId: z.string().optional() }).safeParse(req.body || {});
    const accountId = p.success ? p.data.accountId : undefined;
    const opportunityId = p.success ? p.data.opportunityId : undefined;
    if (accountId) {
      const acc = await prisma.account.findFirst({ where: { id: accountId, tenantId: req.user.tenantId } });
      if (!acc) return reply.code(404).send({ error: '客户不存在' });
    }
    try {
      const r = await pullFeishuAuto(req.user.tenantId, req.user.userId, { accountId, opportunityId });
      return { source: 'feishu', ...r };
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '一键拉取失败' }); }
  });

  // ── 飞书妙记：按链接/token 拉单篇转写（飞书无列表 API）。viewer 只读不可触发 ──
  app.post('/api/recording/feishu/pull', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可拉取' });
    const p = z.object({ url: z.string().min(1), accountId: z.string().optional(), opportunityId: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '请粘贴妙记链接' });
    if (p.data.accountId) {
      const acc = await prisma.account.findFirst({ where: { id: p.data.accountId, tenantId: req.user.tenantId } });
      if (!acc) return reply.code(404).send({ error: '客户不存在' });
    }
    try {
      const r = await pullFeishuByToken(req.user.tenantId, req.user.userId, p.data.url, { accountId: p.data.accountId, opportunityId: p.data.opportunityId });
      return { source: 'feishu', ...r };
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '拉取失败' }); }
  });

  // ── 飞书 OAuth：生成授权 URL（前端跳转）。state 加密含 tenantId+userId，回调按它定位授权人 ──
  app.get('/api/recording/oauth/feishu/start', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可授权' });
    const appCfg = await getFeishuApp(req.user.tenantId);
    if (!appCfg) return reply.code(400).send({ error: '工作区未配置飞书应用，请管理员先在录音设置里配置 App ID/Secret' });
    const state = enc(JSON.stringify({ t: req.user.tenantId, u: req.user.userId, ts: Date.now() }));
    return { authUrl: buildFeishuAuthUrl(appCfg.appId, FEISHU_REDIRECT, state) };
  });

  // ── 飞书 OAuth 回调：换 token 存 per-user 凭据。无需登录态（飞书服务器回调），靠 state 加密自证 ──
  app.get('/api/recording/oauth/feishu/callback', async (req: any, reply) => {
    const code = req.query?.code, state = req.query?.state;
    if (!code || !state) return reply.type('text/html; charset=utf-8').send('<p>授权失败：缺少 code/state</p>');
    let st: any;
    try { st = JSON.parse(dec(String(state))); } catch { return reply.type('text/html; charset=utf-8').send('<p>授权失败：state 无效</p>'); }
    if (!st?.t || !st?.u) return reply.type('text/html; charset=utf-8').send('<p>授权失败：state 缺字段</p>');
    const appCfg = await getFeishuApp(st.t);
    if (!appCfg) return reply.type('text/html; charset=utf-8').send('<p>授权失败：工作区未配置飞书应用</p>');
    try {
      const tok = await exchangeFeishuCode(appCfg, String(code), FEISHU_REDIRECT);
      await saveCredential(st.t, st.u, 'feishu', tok);
      return reply.type('text/html; charset=utf-8').send('<p>✅ 飞书妙记已授权。请回到江湖，在「录音接入」点「拉取拜访录音」。本页可关闭。</p>');
    } catch (e: any) {
      return reply.type('text/html; charset=utf-8').send(`<p>授权失败：${e?.message || e}</p>`);
    }
  });

  // ── 得到大脑：手填 per-user 凭据（API Key + Client ID；apiKey 加密存 accessTokenEnc，clientId 存 meta）──
  app.put('/api/recording/credential/getnote', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可配置' });
    const p = z.object({ apiKey: z.string().min(1), clientId: z.string().min(1), baseUrl: z.string().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 API Key 或 Client ID' });
    const meta = JSON.stringify({ clientId: p.data.clientId, baseUrl: p.data.baseUrl || '' });
    await prisma.recordingCredential.upsert({
      where: { tenantId_userId_source: { tenantId: req.user.tenantId, userId: req.user.userId, source: 'getnote' } },
      update: { accessTokenEnc: enc(p.data.apiKey), meta, status: 'active' },
      create: { id: 'rc_' + randomUUID().slice(0, 12), tenantId: req.user.tenantId, userId: req.user.userId, source: 'getnote', accessTokenEnc: enc(p.data.apiKey), meta },
    });
    return { ok: true };
  });

  // ── 撤销某源授权（per-user）──
  app.delete('/api/recording/credential/:source', { preHandler: [app.authenticate] }, async (req: any) => {
    const source = (req.params as any)?.source;
    await prisma.recordingCredential.deleteMany({ where: { tenantId: req.user.tenantId, userId: req.user.userId, source } });
    return { ok: true };
  });
}
