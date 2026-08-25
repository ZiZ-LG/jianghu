import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Prisma, type EnrichJob, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import { discoverPersons, researchCompanyProfile } from './enrich.js';
import { generateRelSuggestions } from './suggest.js';
import {
  computeCommitmentReminders,
  computeMatterWithoutNextReminder,
  computeReminders,
  isValidNextCommitment,
  recordPatrol,
  type PatrolCommitment,
  type PatrolOpp,
  type PatrolRole,
  type ReminderDraft,
} from './patrol.js';
import type { DbClient } from './mutation/scopeGuards.js';
import { activePersonWhere } from './activePerson.js';
import { BUSINESS_TIME_ZONE } from './businessDate.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import {
  createPersonCandidate,
  personCandidateDedupeKey,
  updatePendingPersonCandidate,
} from './candidates/personRelation.js';
import {
  resolveReminderCandidate,
  upsertReminderCandidate,
} from './candidates/reviewItems.js';

// 江湖自算 · 轻量后台任务队列（DB-backed）。
// 设计取舍（对齐架构纲领「加轻量 job 队列」）：单实例 setInterval 消费，原子 claim；
// 不引 Redis/Bull，部署形态（Mac mini / 阿里云单实例）足够。所有读写按 tenantId 隔离。
// 铁律②：handler 产物一律写候选表（PersonSuggestion），绝不自动写正式 Person。

const MAX_PENDING_PERSON_SUGG = 200; // 与 mcpServer 一致：候选容量上限，防自算刷爆收件箱
const MAX_ACTIVE_JOBS_PER_TENANT = 50; // 单租户在途任务上限，防滥用
const POLL_MS = 5000;
const ENRICH_CONFIDENCE: Record<string, number> = { qcc: 0.6, ai: 0.45, web: 0.45 };
export const JOB_LEASE_MS = 5 * 60 * 1000;
export const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_BASE_MS = 1000;
const JOB_CLAIM_SCAN_LIMIT = 5;
const JOB_HEARTBEAT_MS = Math.floor(JOB_LEASE_MS / 3);

export type ClaimedJob = EnrichJob;

interface JobSeed {
  tenantId: string;
  dedupeKey: string;
  type: string;
  accountId: string;
  opportunityId?: string | null;
  mode?: string;
}

type JobWrite<T> = (db: DbClient) => Promise<T>;

async function enqueueUniqueJob(seed: JobSeed, db: DbClient): Promise<{ id: string; enqueued: boolean }> {
  const existing = await db.enrichJob.findUnique({ where: { tenantId_dedupeKey: {
    tenantId: seed.tenantId, dedupeKey: seed.dedupeKey,
  } } });
  const enqueueToken = randomUUID();
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'processing') return { id: existing.id, enqueued: false };
    const activeCount = await db.enrichJob.count({ where: { tenantId: seed.tenantId, status: { in: ['pending', 'processing'] } } });
    if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);
    const requeued = await db.enrichJob.updateMany({ where: {
      id: existing.id, tenantId: seed.tenantId, status: { in: ['done', 'failed'] },
    }, data: {
      type: seed.type, accountId: seed.accountId, opportunityId: seed.opportunityId ?? null,
      mode: seed.mode ?? 'auto', status: 'pending', attemptCount: 0,
      leaseOwner: '', leaseToken: '', leaseUntil: null, nextAttemptAt: new Date(), result: '', error: '', enqueueToken,
    } });
    return { id: existing.id, enqueued: requeued.count === 1 };
  }

  // INT-204 上线前的在途行没有 dedupeKey；继续按旧业务锚复用，避免升级瞬间重复入队。
  const legacyActive = await db.enrichJob.findFirst({ where: {
    tenantId: seed.tenantId, type: seed.type, dedupeKey: null, status: { in: ['pending', 'processing'] },
    ...(seed.type === 'suggest_relations'
      ? { opportunityId: seed.opportunityId }
      : seed.type === 'pull_recording'
        ? { mode: seed.mode }
        : { accountId: seed.accountId }),
  } });
  if (legacyActive) return { id: legacyActive.id, enqueued: false };

  const activeCount = await db.enrichJob.count({ where: { tenantId: seed.tenantId, status: { in: ['pending', 'processing'] } } });
  if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);
  const id = 'job_' + randomUUID().replaceAll('-', '');
  const row = await db.enrichJob.upsert({
    where: { tenantId_dedupeKey: { tenantId: seed.tenantId, dedupeKey: seed.dedupeKey } },
    create: {
      id, tenantId: seed.tenantId, dedupeKey: seed.dedupeKey, enqueueToken,
      type: seed.type, accountId: seed.accountId, opportunityId: seed.opportunityId ?? null,
      mode: seed.mode ?? 'auto', status: 'pending', nextAttemptAt: new Date(),
    },
    update: {},
  });
  return { id: row.id, enqueued: row.enqueueToken === enqueueToken };
}

const prismaCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
);

const retryableQueueTransaction = (error: unknown): boolean => {
  const code = prismaCode(error);
  return code === 'P2034' || code === 'P1008' || code === 'P2028'
    || (error instanceof Error && error.message.toLowerCase().includes('database is locked'));
};

async function enqueueJob(seed: JobSeed, db: DbClient): Promise<{ id: string; enqueued: boolean }> {
  const root = db as DbClient & Partial<Pick<PrismaClient, '$transaction'>>;
  if (typeof root.$transaction !== 'function') return enqueueUniqueJob(seed, db);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await root.$transaction(
        (tx) => enqueueUniqueJob(seed, tx),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      if (!retryableQueueTransaction(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt));
    }
  }
  throw new Error('job enqueue transaction could not be completed');
}

/**
 * 入队一个 enrich_account 自算任务。幂等：同客户已有 pending/processing 任务则复用，不重复入队。
 * 返回 { id, enqueued }。失败（超上限）抛错由调用方决定吞或传。
 */
export async function enqueueEnrichJob(tenantId: string, accountId: string, mode: 'auto' | 'web' = 'auto', db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  return enqueueJob({ tenantId, dedupeKey: `enrich_account:${accountId}`, type: 'enrich_account', accountId, mode }, db);
}

/**
 * P9 入队一个 account_profile 任务（建客户自动研究企业背景：企查查/LLM 双轨）。
 * 幂等：同客户已有 pending/processing 则复用。
 */
export async function enqueueProfileJob(tenantId: string, accountId: string, db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  return enqueueJob({ tenantId, dedupeKey: `account_profile:${accountId}`, type: 'account_profile', accountId }, db);
}

/**
 * 入队一个 suggest_relations 自算任务（图算法 + LLM 推断商机内关系候选）。
 * 幂等：同商机已有 pending/processing 任务则复用。accountId 一并存便于隔离/分组。
 */
export async function enqueueSuggestJob(tenantId: string, accountId: string, opportunityId: string, db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  return enqueueJob({
    tenantId, dedupeKey: `suggest_relations:${opportunityId}`, type: 'suggest_relations', accountId, opportunityId,
  }, db);
}

/**
 * 入队一个 pull_recording 任务（后台从录音源拉转写 → 加密存 Transcript，供"定时/真实源自动拉取"用）。
 * 幂等：同租户+同源已有 pending/processing 则复用（mode 复用存 source）。accountId 可空（全局拉=''）。
 */
export async function enqueuePullRecordingJob(tenantId: string, source: string, accountId?: string, db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  return enqueueJob({
    tenantId, dedupeKey: `pull_recording:${source}`, type: 'pull_recording', accountId: accountId || '', mode: source,
  }, db);
}

/** 把发现的关键人写入 PersonSuggestion 候选（带去重 + 容量上限）。返回 {created, deduped, skipped}。 */
export async function writeEnrichCandidates(
  job: ClaimedJob,
  source: string,
  persons: { name: string; title: string }[],
  note: string,
): Promise<{ created: number; deduped: number; skipped: number }> {
  return commitJobSideEffectAndComplete(job, async (db) => {
  const origin = source === 'qcc' ? 'qcc' : 'ai'; // web 本质也是 AI 联网
  const confidence = ENRICH_CONFIDENCE[source] ?? 0.45;
  let created = 0, deduped = 0, skipped = 0;
  for (const p of persons) {
    const name = (p.name || '').trim();
    if (!name) { skipped++; continue; }
    const pendingCount = await db.personSuggestion.count({ where: { tenantId: job.tenantId, status: 'pending' } });
    if (pendingCount >= MAX_PENDING_PERSON_SUGG) { skipped++; continue; }
    // 去重：同租户+同客户+同名+pending → 更新（取高 confidence、补 title），不新增
    const dup = await db.personSuggestion.findFirst({ where: { tenantId: job.tenantId, accountId: job.accountId, name, status: 'pending' } });
    if (dup) {
      await updatePendingPersonCandidate(db, {
        tenantId: job.tenantId,
        id: dup.id,
        dedupeKey: personCandidateDedupeKey(job.accountId, name),
        patch: { title: (p.title || '').trim() || dup.title, confidence: Math.max(dup.confidence, confidence) },
      });
      deduped++;
      continue;
    }
    const id = 'ps_' + randomUUID().replaceAll('-', '');
    const sourceRef = `enrich:${job.id}:${source}:${name.normalize('NFKC').trim()}`;
    await createPersonCandidate(db, {
      id,
      tenantId: job.tenantId,
      accountId: job.accountId,
      matterId: job.opportunityId,
      name,
      title: (p.title || '').trim(),
      orgLevel: 3,
      source: origin,
      sourceRef,
      evidence: `江湖自算·${source === 'qcc' ? '企查查' : 'AI'} 发现，待核实`,
      confidence,
      createdByUserId: null,
      dedupeKey: personCandidateDedupeKey(job.accountId, name),
    });
    created++;
  }
  const value = { created, deduped, skipped };
  return { value, result: JSON.stringify({ source, ...value, note }) };
  });
}

/** 执行一个 enrich_account 任务：发现关键人 → 写候选。mock 源（无数据源配置）不写候选，避免占位噪声进收件箱。 */
async function runEnrichJob(job: ClaimedJob): Promise<void> {
  const acc = await prisma.account.findFirst({ where: { id: job.accountId, tenantId: job.tenantId } });
  if (!acc) { await finish(job, 'failed', '', '目标客户不存在或已删除'); return; }

  const r = await discoverPersons(job.tenantId, acc.name, job.mode === 'web' ? 'web' : 'auto');
  if (r.source === 'mock') {
    // 未配置企查查/AI：没有真实情报可算，跳过写候选（占位角色清单走 M2 骨架预填，不污染收件箱）
    await finish(job, 'done', JSON.stringify({ source: 'mock', created: 0, deduped: 0, note: r.note }), '');
    return;
  }
  await writeEnrichCandidates(job, r.source, r.persons, r.note);
}

/** 执行一个 suggest_relations 任务：图算法 + LLM 推断商机内关系 → RelSuggestion 候选。 */
async function runSuggestJob(job: ClaimedJob): Promise<void> {
  if (!job.opportunityId) { await finish(job, 'failed', '', '缺少 opportunityId'); return; }
  const r = await generateRelSuggestions(job.tenantId, job.opportunityId, (write) => commitJobSideEffect(job, write));
  if (!r) { await finish(job, 'failed', '', '目标商机不存在或已删除'); return; }
  await finish(job, 'done', JSON.stringify({ added: r.added, total: r.total }), '');
}

// P9 企业背景研究产物的笔记前缀（溯源 + 防重复研究的判重键）
const PROFILE_NOTE_PREFIX = '【AI 企业背景研究·待核】';

/** P9 执行一个 account_profile 任务：研究企业背景（企查查/LLM 双轨）→ 落 account 级 Note（source=ai 带前缀溯源）。
 *  产物经 curated 素材层进「AI 整理·待核」综述，绝不写结构化字段（铁律②）；已研究过（同前缀笔记在）则跳过不重复堆。 */
async function runProfileJob(job: ClaimedJob): Promise<void> {
  const acc = await prisma.account.findFirst({ where: { id: job.accountId, tenantId: job.tenantId } });
  if (!acc) { await finish(job, 'failed', '', '目标客户不存在或已删除'); return; }
  const dup = await prisma.note.findFirst({ where: { tenantId: job.tenantId, accountId: acc.id, source: 'ai', content: { startsWith: PROFILE_NOTE_PREFIX } } });
  if (dup) { await finish(job, 'done', JSON.stringify({ skipped: 'exists' }), ''); return; }
  const r = await researchCompanyProfile(job.tenantId, acc.name);
  if (!r) { await finish(job, 'done', JSON.stringify({ source: 'none', note: '未配置企查查/AI，跳过背景研究' }), ''); return; }
  await commitJobSideEffect(job, async (db) => {
    const current = await db.note.findFirst({ where: {
      tenantId: job.tenantId, accountId: acc.id, source: 'ai', content: { startsWith: PROFILE_NOTE_PREFIX },
    } });
    if (current) return;
    await db.note.create({ data: {
      id: 'note_' + randomUUID().replaceAll('-', ''), tenantId: job.tenantId, accountId: acc.id,
      content: `${PROFILE_NOTE_PREFIX}（来源：${r.source === 'qcc' ? '企查查工商数据' : 'AI 生成·未联网核实'}）\n${r.content}`,
      source: 'ai',
    } });
  });
  await finish(job, 'done', JSON.stringify({ source: r.source, chars: r.content.length }), '');
}

/** 按 type 分派任务执行。 */
async function runJob(job: ClaimedJob): Promise<void> {
  if (job.type === 'suggest_relations') return runSuggestJob(job);
  if (job.type === 'pull_recording') return runPullRecordingJob(job);
  if (job.type === 'account_profile') return runProfileJob(job);
  return runEnrichJob(job);
}

/** 执行一个 pull_recording 任务：从录音源拉转写 → 加密存 Transcript（不自动抽取，抽取由人触发，守铁律②）。 */
async function runPullRecordingJob(job: ClaimedJob): Promise<void> {
  // 动态 import 打破 jobs → recording → voice → jobs 的顶层循环依赖。
  const { pullAndSave } = await import('./recording.js');
  const r = await pullAndSave(
    job.tenantId, '', (job.mode || 'mock') as any, { accountId: job.accountId || undefined },
    (write) => commitJobSideEffect(job, write),
  );
  await finish(job, 'done', JSON.stringify(r), '');
}

async function finish(job: Pick<ClaimedJob, 'id' | 'tenantId' | 'leaseOwner' | 'leaseToken'>, status: 'done' | 'failed', result: string, error: string): Promise<void> {
  const finished = await prisma.enrichJob.updateMany({ where: {
    id: job.id, tenantId: job.tenantId, status: 'processing',
    leaseOwner: job.leaseOwner, leaseToken: job.leaseToken,
  }, data: { status, result, error, leaseOwner: '', leaseToken: '', leaseUntil: null } });
  if (finished.count !== 1) throw new Error('stale job lease: completion rejected');
}

const retryDelayMs = (attemptCount: number): number => JOB_RETRY_BASE_MS * (2 ** Math.max(0, attemptCount - 1));

export async function commitJobSideEffect<T>(
  job: Pick<ClaimedJob, 'id' | 'tenantId' | 'leaseOwner' | 'leaseToken'>,
  write: JobWrite<T>,
  db: PrismaClient = prisma,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const fenced = await tx.enrichJob.updateMany({ where: {
      id: job.id, tenantId: job.tenantId, status: 'processing',
      leaseOwner: job.leaseOwner, leaseToken: job.leaseToken,
    }, data: { leaseUntil: new Date(Date.now() + JOB_LEASE_MS) } });
    if (fenced.count !== 1) throw new Error('stale job lease: side effect rejected');
    return write(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 30_000 });
}

export async function commitJobSideEffectAndComplete<T>(
  job: Pick<ClaimedJob, 'id' | 'tenantId' | 'leaseOwner' | 'leaseToken'>,
  write: JobWrite<{ value: T; result: string }>,
  db: PrismaClient = prisma,
): Promise<T> {
  return commitJobSideEffect(job, async (tx) => {
    const outcome = await write(tx);
    const completed = await tx.enrichJob.updateMany({ where: {
      id: job.id, tenantId: job.tenantId, status: 'processing',
      leaseOwner: job.leaseOwner, leaseToken: job.leaseToken,
    }, data: {
      status: 'done', result: outcome.result, error: '', leaseOwner: '', leaseToken: '', leaseUntil: null,
    } });
    if (completed.count !== 1) throw new Error('stale job lease: completion rejected');
    return outcome.value;
  }, db);
}

export async function claimNextJob(workerId: string, now: Date, db: PrismaClient = prisma): Promise<ClaimedJob | null> {
  if (!workerId.trim()) throw new Error('workerId is required');
  for (let scan = 0; scan < JOB_CLAIM_SCAN_LIMIT; scan += 1) {
    const next = await db.enrichJob.findFirst({
      where: { status: 'pending', nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!next) return null;
    const leaseUntil = new Date(now.getTime() + JOB_LEASE_MS);
    const leaseToken = randomUUID();
    const claimed = await db.enrichJob.updateMany({ where: {
      id: next.id, tenantId: next.tenantId, status: 'pending', nextAttemptAt: { lte: now },
    }, data: {
      status: 'processing', leaseOwner: workerId, leaseToken, leaseUntil, attemptCount: { increment: 1 },
    } });
    if (claimed.count === 1) {
      return db.enrichJob.findFirst({ where: {
        id: next.id, tenantId: next.tenantId, status: 'processing', leaseOwner: workerId, leaseToken,
      } });
    }
  }
  return null;
}

export async function renewJobLease(
  job: Pick<ClaimedJob, 'id' | 'tenantId' | 'leaseOwner' | 'leaseToken'>,
  now: Date,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const renewed = await db.enrichJob.updateMany({ where: {
    id: job.id, tenantId: job.tenantId, status: 'processing',
    leaseOwner: job.leaseOwner, leaseToken: job.leaseToken,
  }, data: { leaseUntil: new Date(now.getTime() + JOB_LEASE_MS) } });
  return renewed.count === 1;
}

export async function recoverExpiredLeases(now: Date, db: PrismaClient = prisma): Promise<number> {
  const expired = await db.enrichJob.findMany({ where: {
    status: 'processing', OR: [{ leaseUntil: { lte: now } }, { leaseUntil: null }],
  } });
  let recovered = 0;
  for (const job of expired) {
    const terminal = job.attemptCount >= JOB_MAX_ATTEMPTS;
    const result = await db.enrichJob.updateMany({ where: {
      id: job.id, tenantId: job.tenantId, status: 'processing', leaseOwner: job.leaseOwner,
      leaseToken: job.leaseToken, leaseUntil: job.leaseUntil,
    }, data: terminal ? {
      status: 'failed', leaseOwner: '', leaseToken: '', leaseUntil: null,
      error: `worker lease expired after ${job.attemptCount} attempts`,
    } : {
      status: 'pending', leaseOwner: '', leaseToken: '', leaseUntil: null,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(job.attemptCount)),
      error: 'worker lease expired; scheduled for retry',
    } });
    recovered += result.count;
  }
  return recovered;
}

async function retryOrFail(job: ClaimedJob, error: unknown, now: Date): Promise<void> {
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  const terminal = job.attemptCount >= JOB_MAX_ATTEMPTS;
  await prisma.enrichJob.updateMany({ where: {
    id: job.id, tenantId: job.tenantId, status: 'processing',
    leaseOwner: job.leaseOwner, leaseToken: job.leaseToken,
  }, data: terminal ? {
    status: 'failed', leaseOwner: '', leaseToken: '', leaseUntil: null, error: message,
  } : {
    status: 'pending', leaseOwner: '', leaseToken: '', leaseUntil: null,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(job.attemptCount)), error: message,
  } });
}

let workerTimer: NodeJS.Timeout | null = null;
let ticking = false;

/** 单次轮询：原子 claim 最旧一个 pending 任务并执行。串行（一次一个），避免并发抢同一任务。 */
const WORKER_ID = `worker-${process.pid}-${randomUUID().replaceAll('-', '')}`;

async function runJobWithHeartbeat(job: ClaimedJob): Promise<void> {
  let renewing = false;
  let leaseLost = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewJobLease(job, new Date())
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; })
      .finally(() => { renewing = false; });
  }, JOB_HEARTBEAT_MS);
  timer.unref?.();
  try {
    await runJob(job);
    if (leaseLost) throw new Error('stale job lease: heartbeat lost');
  } finally {
    clearInterval(timer);
  }
}

async function tick(workerId: string): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    await recoverExpiredLeases(now);
    const next = await claimNextJob(workerId, now);
    if (!next) return;
    try {
      await runJobWithHeartbeat(next);
    } catch (error) {
      await retryOrFail(next, error, new Date()).catch(() => {});
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
  void tick(WORKER_ID);
  workerTimer = setInterval(() => { void tick(WORKER_ID); }, POLL_MS);
  workerTimer.unref?.(); // 不阻止进程退出
  console.log(`江湖自算 worker 已启动（每 ${POLL_MS / 1000}s 轮询）`);
}

// ── 后台巡检（确定性·零 LLM）：每日扫活跃商机 → 提醒型提案进收件箱（铁律②：只产候选，人审）──
const PATROL_MS = 24 * 60 * 60 * 1000; // 每日一轮
const PATROL_FIRST_DELAY_MS = 30_000; // 启动后延迟首跑，避开启动风暴
let patrolTimer: NodeJS.Timeout | null = null;
let patrolling = false;

/**
 * 巡检一轮：读取通用 Commitment 字段和 active Matter，派生只读 Reminder。
 * 正式业务行永不在此函数中写入；状态变化通过本轮 draft key 的缺失自动结束旧提醒。
 */
export async function runPatrol(): Promise<{ scanned: number; created: number; resolved: number }> {
  const now = new Date();
  const opps = await prisma.opportunity.findMany({ where: { lifecycleStatus: 'active', archivedAt: null } });
  const accs = await prisma.account.findMany({
    where: { archivedAt: null },
    select: { id: true, tenantId: true, name: true },
  });
  const accIds = accs.map((account) => account.id);
  const accountKey = (tenantId: string, accountId: string) => `${tenantId}\u0000${accountId}`;
  const opportunityKey = (tenantId: string, opportunityId: string) => `${tenantId}\u0000${opportunityId}`;
  const accounts = new Map(accs.map((account) => [accountKey(account.tenantId, account.id), account]));
  const validOpps = opps.filter((opportunity) => accounts.has(accountKey(opportunity.tenantId, opportunity.accountId)));
  const opportunities = new Map(validOpps.map((opportunity) => [opportunityKey(opportunity.tenantId, opportunity.id), opportunity]));

  const rawCommitments = accIds.length ? await prisma.planAction.findMany({
    where: { accountId: { in: accIds }, archivedAt: null },
    orderBy: { createdAt: 'desc' },
  }) : [];
  const commitments: Array<{ row: (typeof rawCommitments)[number]; patrol: PatrolCommitment }> = [];
  const commitmentsByMatter = new Map<string, PatrolCommitment[]>();
  const latestCommitmentAtByMatter = new Map<string, Date>();
  for (const row of rawCommitments) {
    const account = accounts.get(accountKey(row.tenantId, row.accountId));
    if (!account) continue;
    const matterId: string | null = row.opportunityId;
    const matter = matterId ? opportunities.get(opportunityKey(row.tenantId, matterId)) : undefined;
    if (matterId && (!matter || matter.accountId !== row.accountId)) continue;
    const patrol: PatrolCommitment = {
      tenantId: row.tenantId,
      accountId: row.accountId,
      accountName: account.name,
      matterId,
      matterName: matter?.name ?? '',
      commitmentId: row.id,
      title: row.title,
      ownerUserId: row.ownerUserId,
      executionStatus: row.executionStatus,
      confirmationStatus: row.confirmationStatus,
      scheduledAtUtc: row.scheduledAtUtc,
      dueAtUtc: row.dueAtUtc,
      timeZone: row.timeZone,
      isAllDay: row.isAllDay,
      localDate: row.localDate,
      confirmationDueAtUtc: row.confirmationDueAtUtc,
      scheduleVersion: row.scheduleVersion,
      archivedAt: row.archivedAt,
    };
    commitments.push({ row, patrol });
    if (matterId) {
      const key = opportunityKey(row.tenantId, matterId);
      const rows = commitmentsByMatter.get(key) ?? [];
      rows.push(patrol);
      commitmentsByMatter.set(key, rows);
      const currentLatest = latestCommitmentAtByMatter.get(key);
      if (!currentLatest || row.createdAt > currentLatest) latestCommitmentAtByMatter.set(key, row.createdAt);
    }
  }

  const drafts: ReminderDraft[] = commitments.flatMap(({ patrol }) => computeCommitmentReminders(patrol, now));
  const byTenant = new Map<string, { scanned: number; created: number; resolved: number }>();
  const bucket = (tenantId: string) => {
    let current = byTenant.get(tenantId);
    if (!current) {
      current = { scanned: 0, created: 0, resolved: 0 };
      byTenant.set(tenantId, current);
    }
    return current;
  };

  for (const opp of validOpps) {
    const account = accounts.get(accountKey(opp.tenantId, opp.accountId))!;
    const [evs, lastVn, roles] = await Promise.all([
      prisma.evidenceEvent.findMany({
        where: { tenantId: opp.tenantId, accountId: opp.accountId, opportunityId: opp.id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.visitNote.findFirst({
        where: { tenantId: opp.tenantId, accountId: opp.accountId, opportunityId: opp.id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.oppRole.findMany({ where: { tenantId: opp.tenantId, opportunityId: opp.id } }),
    ]);
    const lastEvByPerson = new Map<string, Date>();
    for (const evidence of evs) {
      if (!lastEvByPerson.has(evidence.personId)) lastEvByPerson.set(evidence.personId, evidence.createdAt);
    }
    const lastPaAt = latestCommitmentAtByMatter.get(opportunityKey(opp.tenantId, opp.id));
    const times = [evs[0]?.createdAt, lastVn?.createdAt, lastPaAt].filter(Boolean) as Date[];
    const lastActivityAt = times.length ? new Date(Math.max(...times.map((time) => time.getTime()))) : null;

    const persons = roles.length ? await prisma.person.findMany({ where: {
      tenantId: opp.tenantId,
      accountId: opp.accountId,
      id: { in: roles.map((role) => role.personId) },
      ...activePersonWhere,
    } }) : [];
    const personById = new Map(persons.map((person) => [person.id, person]));
    const nameOf = new Map(persons.map((person) => [person.id, person.name]));
    const formFilled = (formStr: string): number => {
      try {
        const form = JSON.parse(formStr || '{}');
        return ['family', 'occupation', 'recreation', 'moneyMotivation']
          .filter((key) => String(form?.[key] || '').trim() !== '').length;
      } catch { return 0; }
    };
    const patrolRoles: PatrolRole[] = roles.map((role) => ({
      personId: role.personId,
      personName: nameOf.get(role.personId) ?? '某干系人',
      role: role.role,
      sentiment: role.sentiment,
      lastEvidenceAt: lastEvByPerson.get(role.personId) ?? null,
      personCreatedAt: role.assessedAt ?? opp.createdAt,
      formFilledCount: formFilled(personById.get(role.personId)?.form ?? '{}'),
    }));
    const patrolOpp: PatrolOpp = {
      tenantId: opp.tenantId,
      accountId: opp.accountId,
      accountName: account.name,
      opportunityId: opp.id,
      oppName: opp.name,
      createdAt: opp.createdAt,
      lastActivityAt,
      roles: patrolRoles,
    };
    drafts.push(...computeReminders(patrolOpp, now));
    const matterGap = computeMatterWithoutNextReminder({
      tenantId: opp.tenantId,
      accountId: opp.accountId,
      accountName: account.name,
      matterId: opp.id,
      matterName: opp.name,
      hasValidNextCommitment: (commitmentsByMatter.get(opportunityKey(opp.tenantId, opp.id)) ?? [])
        .some(isValidNextCommitment),
      businessTimeZone: BUSINESS_TIME_ZONE,
    }, now);
    if (matterGap) drafts.push(matterGap);
    bucket(opp.tenantId).scanned += 1;
  }

  let created = 0;
  const draftKeysByTenant = new Map<string, Set<string>>();
  for (const draft of drafts) {
    const keys = draftKeysByTenant.get(draft.tenantId) ?? new Set<string>();
    keys.add(draft.dedupeKey);
    draftKeysByTenant.set(draft.tenantId, keys);
    const receipt = await upsertReminderCandidate(prisma, {
      id: 'rem_' + randomUUID().replaceAll('-', ''),
      tenantId: draft.tenantId,
      accountId: draft.accountId,
      accountName: draft.accountName,
      matterId: draft.opportunityId,
      matterName: draft.oppName,
      kind: draft.kind,
      title: draft.title,
      detail: draft.detail,
      severity: draft.severity,
      targetId: draft.entityId,
      dedupeKey: draft.dedupeKey,
    });
    if (receipt.created) {
      created += 1;
      bucket(draft.tenantId).created += 1;
    }
  }

  const managedKinds = [
    'stalled', 'no_decider', 'sentiment_recheck', 'action_overdue', 'form_empty',
    'confirmation_due', 'commitment_due', 'matter_without_next_commitment',
  ];
  const pending = await prisma.candidate.findMany({ where: {
    kind: 'reminder', status: 'pending', legacySourceKind: 'Reminder', legacySourceId: { not: null },
  }, select: { tenantId: true, legacySourceId: true, payload: true } });
  let resolved = 0;
  for (const candidate of pending) {
    let payload: { legacyDedupeKey?: unknown; reminderKind?: unknown } = {};
    try { payload = JSON.parse(candidate.payload) as typeof payload; } catch { /* fail closed below */ }
    if (typeof payload.legacyDedupeKey !== 'string'
      || typeof payload.reminderKind !== 'string'
      || !managedKinds.includes(payload.reminderKind)) continue;
    if (draftKeysByTenant.get(candidate.tenantId)?.has(payload.legacyDedupeKey)) continue;
    const changed = await resolveReminderCandidate(prisma, {
      tenantId: candidate.tenantId,
      id: candidate.legacySourceId!,
    });
    if (!changed) continue;
    resolved += 1;
    bucket(candidate.tenantId).resolved += 1;
  }

  recordPatrol(byTenant, now.toISOString());
  return { scanned: validOpps.length, created, resolved };
}

/** 启动后台巡检（index.ts 在 listen 成功后调用一次）。串行保护：上一轮没跑完不叠跑。 */
export function startPatrol(): void {
  if (patrolTimer) return;
  const run = async () => {
    if (patrolling) return;
    patrolling = true;
    try { const r = await runPatrol(); console.log(`[巡检] 扫 ${r.scanned} 商机，新增提醒 ${r.created}，自动消除 ${r.resolved}`); }
    catch (e: any) { console.error('[巡检] 失败', e?.message || e); }
    finally { patrolling = false; }
  };
  setTimeout(() => { void run(); }, PATROL_FIRST_DELAY_MS);
  patrolTimer = setInterval(() => { void run(); }, PATROL_MS);
  patrolTimer.unref?.(); // 不阻止进程退出
  console.log(`江湖巡检已启动（每 ${PATROL_MS / 3600000}h 一轮，启动 ${PATROL_FIRST_DELAY_MS / 1000}s 后首跑）`);
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

  // 入队关系推断任务（对当前商机：图算法 + LLM 推断关系候选）。viewer 只读不可触发。
  app.post('/api/suggest/enqueue', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (req.user.role === 'viewer') return reply.code(403).send({ error: '只读成员不可发起自算' });
    const p = z.object({ opportunityId: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '缺少 opportunityId' });
    const opp = await prisma.opportunity.findFirst({ where: { id: p.data.opportunityId, tenantId: req.user.tenantId } });
    if (!opp) return reply.code(404).send({ error: '商机不存在' });
    try {
      const r = await enqueueSuggestJob(req.user.tenantId, opp.accountId, opp.id);
      return { ...r, opportunityId: opp.id };
    } catch (e: any) { return reply.code(429).send({ error: e?.message || '入队失败' }); }
  });

  // 查某客户最近的自算任务状态（前端轮询展示进度）。
  app.get('/api/enrich/jobs', { preHandler: [app.authenticate] }, async (req: any, reply: any) => {
    if (denyViewer(req, reply)) return; // viewer 只读，不可操作
    const accountId = typeof req.query?.accountId === 'string' ? req.query.accountId : undefined;
    const scope = await resolveEffectiveResourceScope(prisma, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
    });
    if (scope.actorRole === 'viewer') return reply.code(403).send({ error: '只读成员不可操作' });
    const jobs = await prisma.enrichJob.findMany({
      where: {
        tenantId: req.user.tenantId,
        ...(accountId ? { accountId } : {}),
        OR: [
          { accountId: { in: [...scope.fullAccountIds] } },
          { opportunityId: { in: [...scope.matterIds] } },
        ],
      },
      orderBy: { createdAt: 'desc' }, take: 20,
    });
    return { jobs: jobs.map((j) => ({ id: j.id, accountId: j.accountId, type: j.type, status: j.status, result: j.result, error: j.error, createdAt: j.createdAt })) };
  });
}
