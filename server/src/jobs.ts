import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { discoverPersons } from './enrich.js';

// 江湖自算 · 轻量后台任务队列（DB-backed）。
// 设计取舍（对齐架构纲领「加轻量 job 队列」）：单实例 setInterval 消费，原子 claim；
// 不引 Redis/Bull，部署形态（Mac mini / 阿里云单实例）足够。所有读写按 tenantId 隔离。
// 铁律②：handler 产物一律写候选表（PersonSuggestion），绝不自动写正式 Person。

const MAX_PENDING_PERSON_SUGG = 200; // 与 mcpServer 一致：候选容量上限，防自算刷爆收件箱
const MAX_ACTIVE_JOBS_PER_TENANT = 50; // 单租户在途任务上限，防滥用
const POLL_MS = 5000;
const ENRICH_CONFIDENCE: Record<string, number> = { qcc: 0.6, ai: 0.45, web: 0.45 };

/**
 * 入队一个 enrich_account 自算任务。幂等：同客户已有 pending/processing 任务则复用，不重复入队。
 * 返回 { id, enqueued }。失败（超上限）抛错由调用方决定吞或传。
 */
export async function enqueueEnrichJob(tenantId: string, accountId: string, mode: 'auto' | 'web' = 'auto'): Promise<{ id: string; enqueued: boolean }> {
  const active = await prisma.enrichJob.findFirst({
    where: { tenantId, accountId, type: 'enrich_account', status: { in: ['pending', 'processing'] } },
  });
  if (active) return { id: active.id, enqueued: false };

  const activeCount = await prisma.enrichJob.count({ where: { tenantId, status: { in: ['pending', 'processing'] } } });
  if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);

  const id = 'job_' + randomUUID().slice(0, 12);
  await prisma.enrichJob.create({ data: { id, tenantId, type: 'enrich_account', accountId, mode, status: 'pending' } });
  return { id, enqueued: true };
}

/** 把发现的关键人写入 PersonSuggestion 候选（带去重 + 容量上限）。返回 {created, deduped, skipped}。 */
async function writeCandidates(tenantId: string, accountId: string, source: string, persons: { name: string; title: string }[]): Promise<{ created: number; deduped: number; skipped: number }> {
  const origin = source === 'qcc' ? 'qcc' : 'ai'; // web 本质也是 AI 联网
  const confidence = ENRICH_CONFIDENCE[source] ?? 0.45;
  let created = 0, deduped = 0, skipped = 0;
  for (const p of persons) {
    const name = (p.name || '').trim();
    if (!name) { skipped++; continue; }
    const pendingCount = await prisma.personSuggestion.count({ where: { tenantId, status: 'pending' } });
    if (pendingCount >= MAX_PENDING_PERSON_SUGG) { skipped++; continue; }
    // 去重：同租户+同客户+同名+pending → 更新（取高 confidence、补 title），不新增
    const dup = await prisma.personSuggestion.findFirst({ where: { tenantId, accountId, name, status: 'pending' } });
    if (dup) {
      await prisma.personSuggestion.update({
        where: { id: dup.id },
        data: { title: (p.title || '').trim() || dup.title, confidence: Math.max(dup.confidence, confidence) },
      });
      deduped++;
      continue;
    }
    await prisma.personSuggestion.create({
      data: {
        id: 'ps_' + randomUUID().slice(0, 12),
        tenantId, accountId,
        name, title: (p.title || '').trim(),
        orgLevel: 3,
        origin,
        evidence: `江湖自算·${source === 'qcc' ? '企查查' : 'AI'} 发现，待核实`,
        confidence,
        status: 'pending',
        proposedBy: '',
      },
    });
    created++;
  }
  return { created, deduped, skipped };
}

/** 执行一个 enrich_account 任务：发现关键人 → 写候选。mock 源（无数据源配置）不写候选，避免占位噪声进收件箱。 */
async function runEnrichJob(job: { id: string; tenantId: string; accountId: string; mode: string }): Promise<void> {
  const acc = await prisma.account.findFirst({ where: { id: job.accountId, tenantId: job.tenantId } });
  if (!acc) { await finish(job.id, 'failed', '', '目标客户不存在或已删除'); return; }

  const r = await discoverPersons(job.tenantId, acc.name, job.mode === 'web' ? 'web' : 'auto');
  if (r.source === 'mock') {
    // 未配置企查查/AI：没有真实情报可算，跳过写候选（占位角色清单走 M2 骨架预填，不污染收件箱）
    await finish(job.id, 'done', JSON.stringify({ source: 'mock', created: 0, deduped: 0, note: r.note }), '');
    return;
  }
  const stat = await writeCandidates(job.tenantId, job.accountId, r.source, r.persons);
  await finish(job.id, 'done', JSON.stringify({ source: r.source, ...stat, note: r.note }), '');
}

async function finish(id: string, status: 'done' | 'failed', result: string, error: string): Promise<void> {
  await prisma.enrichJob.update({ where: { id }, data: { status, result, error } });
}

let workerTimer: NodeJS.Timeout | null = null;
let ticking = false;

/** 单次轮询：原子 claim 最旧一个 pending 任务并执行。串行（一次一个），避免并发抢同一任务。 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const next = await prisma.enrichJob.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' } });
    if (!next) return;
    // 原子认领：仅当仍为 pending 才置 processing（防多 worker/多 tick 抢同一条）
    const claim = await prisma.enrichJob.updateMany({ where: { id: next.id, status: 'pending' }, data: { status: 'processing', attempts: { increment: 1 } } });
    if (claim.count !== 1) return; // 被别处抢走
    try {
      await runEnrichJob(next);
    } catch (e: any) {
      await prisma.enrichJob.update({ where: { id: next.id }, data: { status: 'failed', error: String(e?.message || e).slice(0, 500) } }).catch(() => {});
    }
  } catch {
    /* 轮询本身异常（如 DB 抖动）忽略，下个 tick 再来 */
  } finally {
    ticking = false;
  }
}

/** 启动后台 worker（index.ts 在 listen 成功后调用一次）。 */
export function startJobWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => { void tick(); }, POLL_MS);
  workerTimer.unref?.(); // 不阻止进程退出
  console.log(`江湖自算 worker 已启动（每 ${POLL_MS / 1000}s 轮询）`);
}

export function jobRoutes(app: FastifyInstance): void {
  // 入队自算任务（建客户后补全干系人）。viewer 只读，不可触发。
  app.post('/api/enrich/enqueue', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可发起自算' });
    const p = z.object({ accountId: z.string().min(1), mode: z.enum(['auto', 'web']).default('auto') }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 accountId' });
    const acc = await prisma.account.findFirst({ where: { id: p.data.accountId, tenantId: req.user.tenantId } });
    if (!acc) return reply.code(404).send({ error: '客户不存在' });
    try {
      const r = await enqueueEnrichJob(req.user.tenantId, acc.id, p.data.mode);
      return { ...r, accountId: acc.id };
    } catch (e: any) { return reply.code(429).send({ error: e?.message || '入队失败' }); }
  });

  // 查某客户最近的自算任务状态（前端轮询展示进度）。
  app.get('/api/enrich/jobs', { preHandler: [app.authenticate] }, async (req: any) => {
    const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId : undefined;
    const jobs = await prisma.enrichJob.findMany({
      where: { tenantId: req.user.tenantId, ...(accountId ? { accountId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 20,
    });
    return { jobs: jobs.map((j) => ({ id: j.id, accountId: j.accountId, type: j.type, status: j.status, result: j.result, error: j.error, createdAt: j.createdAt })) };
  });
}
