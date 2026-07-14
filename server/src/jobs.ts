import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { denyViewer } from './scope.js';
import { discoverPersons, researchCompanyProfile } from './enrich.js';
import { generateRelSuggestions } from './suggest.js';
import { computeReminders, recordPatrol, type PatrolOpp, type PatrolRole, type PatrolAction } from './patrol.js';
import type { DbClient } from './mutation/scopeGuards.js';

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
export async function enqueueEnrichJob(tenantId: string, accountId: string, mode: 'auto' | 'web' = 'auto', db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  const active = await db.enrichJob.findFirst({
    where: { tenantId, accountId, type: 'enrich_account', status: { in: ['pending', 'processing'] } },
  });
  if (active) return { id: active.id, enqueued: false };

  const activeCount = await db.enrichJob.count({ where: { tenantId, status: { in: ['pending', 'processing'] } } });
  if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);

  const id = 'job_' + randomUUID().slice(0, 12);
  await db.enrichJob.create({ data: { id, tenantId, type: 'enrich_account', accountId, mode, status: 'pending' } });
  return { id, enqueued: true };
}

/**
 * P9 入队一个 account_profile 任务（建客户自动研究企业背景：企查查/LLM 双轨）。
 * 幂等：同客户已有 pending/processing 则复用。
 */
export async function enqueueProfileJob(tenantId: string, accountId: string, db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  const active = await db.enrichJob.findFirst({
    where: { tenantId, accountId, type: 'account_profile', status: { in: ['pending', 'processing'] } },
  });
  if (active) return { id: active.id, enqueued: false };

  const activeCount = await db.enrichJob.count({ where: { tenantId, status: { in: ['pending', 'processing'] } } });
  if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);

  const id = 'job_' + randomUUID().slice(0, 12);
  await db.enrichJob.create({ data: { id, tenantId, type: 'account_profile', accountId, status: 'pending' } });
  return { id, enqueued: true };
}

/**
 * 入队一个 suggest_relations 自算任务（图算法 + LLM 推断商机内关系候选）。
 * 幂等：同商机已有 pending/processing 任务则复用。accountId 一并存便于隔离/分组。
 */
export async function enqueueSuggestJob(tenantId: string, accountId: string, opportunityId: string, db: DbClient = prisma): Promise<{ id: string; enqueued: boolean }> {
  const active = await db.enrichJob.findFirst({
    where: { tenantId, opportunityId, type: 'suggest_relations', status: { in: ['pending', 'processing'] } },
  });
  if (active) return { id: active.id, enqueued: false };

  const activeCount = await db.enrichJob.count({ where: { tenantId, status: { in: ['pending', 'processing'] } } });
  if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);

  const id = 'job_' + randomUUID().slice(0, 12);
  await db.enrichJob.create({ data: { id, tenantId, type: 'suggest_relations', accountId, opportunityId, status: 'pending' } });
  return { id, enqueued: true };
}

/**
 * 入队一个 pull_recording 任务（后台从录音源拉转写 → 加密存 Transcript，供"定时/真实源自动拉取"用）。
 * 幂等：同租户+同源已有 pending/processing 则复用（mode 复用存 source）。accountId 可空（全局拉=''）。
 */
export async function enqueuePullRecordingJob(tenantId: string, source: string, accountId?: string): Promise<{ id: string; enqueued: boolean }> {
  const active = await prisma.enrichJob.findFirst({
    where: { tenantId, type: 'pull_recording', mode: source, status: { in: ['pending', 'processing'] } },
  });
  if (active) return { id: active.id, enqueued: false };

  const activeCount = await prisma.enrichJob.count({ where: { tenantId, status: { in: ['pending', 'processing'] } } });
  if (activeCount >= MAX_ACTIVE_JOBS_PER_TENANT) throw new Error(`在途自算任务已达上限（${MAX_ACTIVE_JOBS_PER_TENANT}），请稍候`);

  const id = 'job_' + randomUUID().slice(0, 12);
  await prisma.enrichJob.create({ data: { id, tenantId, type: 'pull_recording', accountId: accountId || '', mode: source, status: 'pending' } });
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

/** 执行一个 suggest_relations 任务：图算法 + LLM 推断商机内关系 → RelSuggestion 候选。 */
async function runSuggestJob(job: { id: string; tenantId: string; opportunityId: string | null }): Promise<void> {
  if (!job.opportunityId) { await finish(job.id, 'failed', '', '缺少 opportunityId'); return; }
  const r = await generateRelSuggestions(job.tenantId, job.opportunityId);
  if (!r) { await finish(job.id, 'failed', '', '目标商机不存在或已删除'); return; }
  await finish(job.id, 'done', JSON.stringify({ added: r.added, total: r.total }), '');
}

// P9 企业背景研究产物的笔记前缀（溯源 + 防重复研究的判重键）
const PROFILE_NOTE_PREFIX = '【AI 企业背景研究·待核】';

/** P9 执行一个 account_profile 任务：研究企业背景（企查查/LLM 双轨）→ 落 account 级 Note（source=ai 带前缀溯源）。
 *  产物经 curated 素材层进「AI 整理·待核」综述，绝不写结构化字段（铁律②）；已研究过（同前缀笔记在）则跳过不重复堆。 */
async function runProfileJob(job: { id: string; tenantId: string; accountId: string }): Promise<void> {
  const acc = await prisma.account.findFirst({ where: { id: job.accountId, tenantId: job.tenantId } });
  if (!acc) { await finish(job.id, 'failed', '', '目标客户不存在或已删除'); return; }
  const dup = await prisma.note.findFirst({ where: { tenantId: job.tenantId, accountId: acc.id, source: 'ai', content: { startsWith: PROFILE_NOTE_PREFIX } } });
  if (dup) { await finish(job.id, 'done', JSON.stringify({ skipped: 'exists' }), ''); return; }
  const r = await researchCompanyProfile(job.tenantId, acc.name);
  if (!r) { await finish(job.id, 'done', JSON.stringify({ source: 'none', note: '未配置企查查/AI，跳过背景研究' }), ''); return; }
  await prisma.note.create({
    data: {
      id: 'note_' + randomUUID().slice(0, 12), tenantId: job.tenantId, accountId: acc.id,
      content: `${PROFILE_NOTE_PREFIX}（来源：${r.source === 'qcc' ? '企查查工商数据' : 'AI 生成·未联网核实'}）\n${r.content}`,
      source: 'ai',
    },
  });
  await finish(job.id, 'done', JSON.stringify({ source: r.source, chars: r.content.length }), '');
}

/** 按 type 分派任务执行。 */
async function runJob(job: { id: string; tenantId: string; type: string; accountId: string; opportunityId: string | null; mode: string }): Promise<void> {
  if (job.type === 'suggest_relations') return runSuggestJob(job);
  if (job.type === 'pull_recording') return runPullRecordingJob(job);
  if (job.type === 'account_profile') return runProfileJob(job);
  return runEnrichJob(job);
}

/** 执行一个 pull_recording 任务：从录音源拉转写 → 加密存 Transcript（不自动抽取，抽取由人触发，守铁律②）。 */
async function runPullRecordingJob(job: { id: string; tenantId: string; accountId: string; mode: string }): Promise<void> {
  // 动态 import 打破 jobs → recording → voice → jobs 的顶层循环依赖。
  const { pullAndSave } = await import('./recording.js');
  const r = await pullAndSave(job.tenantId, '', (job.mode || 'mock') as any, { accountId: job.accountId || undefined });
  await finish(job.id, 'done', JSON.stringify(r), '');
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
      await runJob(next);
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

// ── 后台巡检（确定性·零 LLM）：每日扫活跃商机 → 提醒型提案进收件箱（铁律②：只产候选，人审）──
const PATROL_MS = 24 * 60 * 60 * 1000; // 每日一轮
const PATROL_FIRST_DELAY_MS = 30_000; // 启动后延迟首跑，避开启动风暴
let patrolTimer: NodeJS.Timeout | null = null;
let patrolling = false;

/**
 * 巡检一轮：遍历所有租户的活跃商机 → computeReminders → 按 dedupeKey upsert（去重不刷屏）+ 自动消除。
 * - 新提醒 → create(pending)；已 pending → 刷新文案；已 dismissed/done → 跳过（尊重人已处理，不复活）。
 * - 条件消失（某 pending 的 dedupeKey 不在本轮 draft）→ status=done（提醒随商机更新自动消失）。
 * tenantId 隔离：每条 Reminder 带其商机的 tenantId（后台动作在明确租户上下文，铁律①）。
 */
export async function runPatrol(): Promise<{ scanned: number; created: number; resolved: number }> {
  const now = new Date();
  const opps = await prisma.opportunity.findMany({ where: { status: 'active' } });
  const accIds = [...new Set(opps.map((o) => o.accountId))];
  const accs = accIds.length ? await prisma.account.findMany({ where: { id: { in: accIds } } }) : [];
  const accName = new Map(accs.map((a) => [a.id, a.name]));
  let created = 0, resolved = 0;
  const byTenant = new Map<string, { scanned: number; created: number; resolved: number }>(); // P2 心跳：按租户分桶（红线：绝不把全平台数字给单租户看）
  const bucket = (tid: string) => { let b = byTenant.get(tid); if (!b) { b = { scanned: 0, created: 0, resolved: 0 }; byTenant.set(tid, b); } return b; };

  for (const opp of opps) {
    // 最近活动 = max(evidence / visitNote / planAction)；并按人取最近证据（支持度复查用）
    const evs = await prisma.evidenceEvent.findMany({ where: { opportunityId: opp.id }, orderBy: { createdAt: 'desc' } });
    const lastEvByPerson = new Map<string, Date>();
    for (const e of evs) if (!lastEvByPerson.has(e.personId)) lastEvByPerson.set(e.personId, e.createdAt);
    const [lastVn, lastPa] = await Promise.all([
      prisma.visitNote.findFirst({ where: { opportunityId: opp.id }, orderBy: { createdAt: 'desc' } }),
      prisma.planAction.findFirst({ where: { opportunityId: opp.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const times = [evs[0]?.createdAt, lastVn?.createdAt, lastPa?.createdAt].filter(Boolean) as Date[];
    const lastActivityAt = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;

    const roles = await prisma.oppRole.findMany({ where: { opportunityId: opp.id } });
    const persons = roles.length ? await prisma.person.findMany({ where: { id: { in: roles.map((r) => r.personId) } } }) : [];
    const personById = new Map(persons.map((p) => [p.id, p]));
    const nameOf = new Map(persons.map((p) => [p.id, p.name]));
    // P14：FORM 四大项非空计数（family/occupation/recreation/moneyMotivation）——FORM 空缺规则的量化输入
    const formFilled = (formStr: string): number => {
      try { const f = JSON.parse(formStr || '{}');
        return ['family', 'occupation', 'recreation', 'moneyMotivation'].filter((k) => String(f?.[k] || '').trim() !== '').length;
      } catch { return 0; }
    };
    const patrolRoles: PatrolRole[] = roles.map((r) => ({
      personId: r.personId, personName: nameOf.get(r.personId) ?? '某干系人',
      role: r.role, sentiment: r.sentiment, lastEvidenceAt: lastEvByPerson.get(r.personId) ?? null,
      // Person 表无 createdAt——用 OppRole.assessedAt（M2 有，SET_ROLE 时刷新）代理，兜底商机 createdAt
      personCreatedAt: r.assessedAt ?? opp.createdAt,
      formFilledCount: formFilled(personById.get(r.personId)?.form ?? '{}'),
    }));

    // P14：预筛已上桌未完成、endDate 已过的行动牌（草稿=没上桌不算逾期）
    const nowYmd = now.toISOString().slice(0, 10);
    const overdueRaw = await prisma.planAction.findMany({
      where: { opportunityId: opp.id, done: false, draft: false, endDate: { lt: nowYmd, not: '' } },
      select: { id: true, title: true, personId: true, endDate: true },
    });
    const overdueActions: PatrolAction[] = overdueRaw.map((a) => ({
      actionId: a.id, title: a.title, personId: a.personId ?? null, endDate: a.endDate,
      personName: a.personId ? nameOf.get(a.personId) : undefined,
    }));

    const patrolOpp: PatrolOpp = {
      tenantId: opp.tenantId, accountId: opp.accountId, accountName: accName.get(opp.accountId) ?? '',
      opportunityId: opp.id, oppName: opp.name, createdAt: opp.createdAt, lastActivityAt, roles: patrolRoles, overdueActions,
    };

    const drafts = computeReminders(patrolOpp, now);
    const draftKeys = new Set(drafts.map((d) => d.dedupeKey));
    const b = bucket(opp.tenantId); b.scanned++;
    for (const d of drafts) {
      const existing = await prisma.reminder.findUnique({ where: { tenantId_dedupeKey: { tenantId: d.tenantId, dedupeKey: d.dedupeKey } } });
      if (!existing) { await prisma.reminder.create({ data: { id: 'rem_' + randomUUID().slice(0, 12), ...d } }); created++; b.created++; }
      else if (existing.status === 'pending') { await prisma.reminder.update({ where: { id: existing.id }, data: { title: d.title, detail: d.detail, severity: d.severity } }); }
      // dismissed / done → 跳过，不复活
    }
    // 自动消除：本轮 draft 已不含的 pending 提醒（条件消失）→ done
    const pendings = await prisma.reminder.findMany({ where: { tenantId: opp.tenantId, opportunityId: opp.id, status: 'pending' } });
    for (const p of pendings) if (!draftKeys.has(p.dedupeKey)) { await prisma.reminder.update({ where: { id: p.id }, data: { status: 'done' } }); resolved++; b.resolved++; }
  }
  recordPatrol(byTenant, now.toISOString()); // P2 心跳：按租户落最近一轮统计（状态在 patrol.ts，避免 suggest↔jobs 循环 import）
  return { scanned: opps.length, created, resolved };
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
    const jobs = await prisma.enrichJob.findMany({
      where: { tenantId: req.user.tenantId, ...(accountId ? { accountId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 20,
    });
    return { jobs: jobs.map((j) => ({ id: j.id, accountId: j.accountId, type: j.type, status: j.status, result: j.result, error: j.error, createdAt: j.createdAt })) };
  });
}
