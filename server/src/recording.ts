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

export type RecordingSource = 'getnote' | 'feishu' | 'dingtalk' | 'mock' | 'manual';

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
async function pullFromSource(_tenantId: string, source: RecordingSource): Promise<{ items: PulledTranscript[]; note: string }> {
  if (source === 'mock') return { items: MOCK_TRANSCRIPTS, note: 'mock 演示转写（2 条）' };
  // TODO(P2-b)：得到大脑 MCP（getnote）/ 飞书妙记 / 钉钉听记 OpenAPI —— BYO 凭据 + OAuth，拉转写文字。
  throw new Error(`录音源「${source}」尚未接入：需先配置该来源的授权凭据（第一刀仅支持 mock 演示）`);
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
  const { items, note } = await pullFromSource(tenantId, source);
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
      const r = await pullAndSave(req.user.tenantId, req.user.id || '', p.data.source, { accountId: p.data.accountId, opportunityId: p.data.opportunityId });
      return r;
    } catch (e: any) { return reply.code(400).send({ error: e?.message || '拉取失败' }); }
  });

  // 抽取某条转写 → 双轨落库 + 候选进收件箱。viewer 只读不可触发。
  app.post('/api/recording/extract', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可抽取转写' });
    const p = z.object({ transcriptId: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 transcriptId' });
    const r = await extractTranscript(req.user.tenantId, req.user.id || '', p.data.transcriptId);
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
}
