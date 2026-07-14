import { Prisma, type PrismaClient } from '@prisma/client';
import { ACCOUNT_PROFILE_FIELDS, ActionSchema, CommandContextSchema, type Action, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { enqueueEnrichJob, enqueueProfileJob } from './jobs.js';
import { requireActionScope } from './mutation/actionScope.js';
import { requireScopedRow, type DbClient } from './mutation/scopeGuards.js';
import { isTrustedHumanAssertion, normalizeActionTrust } from './ingestTrust.js';
import { activePersonWhere } from './activePerson.js';

export type { DbClient } from './mutation/scopeGuards.js';

const ACCOUNT_PROFILE_SERVER_KEYS = new Set<string>([...ACCOUNT_PROFILE_FIELDS, '_mcpOrigin']);

type MachineActionPolicy = 'allow' | 'conditional_opp_role' | 'deny';
const MACHINE_ACTION_POLICY: Record<Action['type'], MachineActionPolicy> = {
  ADD_ACCOUNT: 'allow', UPDATE_ACCOUNT: 'allow', DELETE_ACCOUNT: 'deny',
  ADD_OPP: 'allow', UPDATE_OPP: 'deny', DELETE_OPP: 'deny',
  ADD_PERSON: 'deny', UPDATE_PERSON: 'deny', MOVE_PERSON: 'deny', DELETE_PERSON: 'deny', ADD_LOG: 'deny',
  SET_ROLE: 'conditional_opp_role', REMOVE_ROLE: 'deny', ADD_OPP_MEMBER: 'deny', REMOVE_OPP_MEMBER: 'deny',
  ADD_EDGE: 'deny', UPDATE_EDGE: 'deny', DELETE_EDGE: 'deny',
  ADD_BI: 'allow', UPDATE_BI: 'deny', DELETE_BI: 'deny',
  ADD_UCV: 'allow', UPDATE_UCV: 'deny', DELETE_UCV: 'deny',
  ADD_VISIT: 'allow', UPDATE_VISIT: 'allow', DELETE_VISIT: 'deny',
  ADD_NOTE: 'deny', UPDATE_NOTE: 'deny', DELETE_NOTE: 'deny',
  ADD_PLAN_ACTION: 'deny', UPDATE_PLAN_ACTION: 'deny', DELETE_PLAN_ACTION: 'deny', TOGGLE_PLAN_ACTION: 'deny',
  ADD_MILESTONE: 'deny', UPDATE_MILESTONE: 'deny', DELETE_MILESTONE: 'deny',
  ADD_OPP_STAGE: 'deny', UPDATE_OPP_STAGE: 'deny', DELETE_OPP_STAGE: 'deny',
  ADD_STRATEGY_CARD: 'deny', UPDATE_STRATEGY_CARD: 'deny', DELETE_STRATEGY_CARD: 'deny',
  ADD_STRATEGY_RISK: 'deny', UPDATE_STRATEGY_RISK: 'deny', DELETE_STRATEGY_RISK: 'deny',
  ADD_STRATEGY_RESOURCE: 'deny', UPDATE_STRATEGY_RESOURCE: 'deny', DELETE_STRATEGY_RESOURCE: 'deny',
  ADD_EVIDENCE: 'allow', DELETE_EVIDENCE: 'deny',
};

export function machineActionPolicy(type: Action['type']): MachineActionPolicy {
  return MACHINE_ACTION_POLICY[type];
}

function legacyProfileExtras(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !ACCOUNT_PROFILE_SERVER_KEYS.has(key)),
    );
  } catch {
    return {};
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

const mcpOriginMark = () => ({ source: 'mcp', at: new Date().toISOString(), needsReview: true });

/** 乐观锁冲突：目标实体 version 与客户端 baseVersion 不一致（他人已先改）。index.ts 据此回 409。 */
class ConflictError extends Error {
  readonly conflict = true;
  constructor(msg = '该数据已被其他成员修改，请刷新后重试') { super(msg); }
}

/**
 * 乐观锁 update：带 baseVersion 时按 version 匹配写入并自增；未命中再区分「版本冲突」与「记录不存在」。
 * - baseVersion 缺省（旧客户端 / 非关键路径）：不校验，仍自增 version 保持单调，便于并发方感知变化。
 * - 命中 0 行且记录仍在 → 版本已被他人改过 → 抛 ConflictError（→ 409）。
 * - 命中 0 行且记录已不在 → 删除竞争，静默（前端重拉即一致）。
 */
async function lockedUpdate(opts: {
  baseVersion?: number;
  update: (versionWhere: { version?: number }) => Promise<{ count: number }>;
  exists: () => Promise<boolean>;
}): Promise<void> {
  const { baseVersion, update, exists } = opts;
  if (baseVersion === undefined || baseVersion === null) { await update({}); return; }
  const r = await update({ version: baseVersion });
  if (r.count === 0 && (await exists())) throw new ConflictError();
}

export type PostCommitEffect =
  | { type: 'account_created'; tenantId: string; accountId: string }
  | { type: 'opportunity_stage_changed'; tenantId: string; opportunityId: string }
  | undefined;

function isTopLevelClient(db: DbClient): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === 'function';
}

const MAX_SERIALIZABLE_ATTEMPTS = 3;

function prismaErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function runTopLevelTransaction(
  db: PrismaClient,
  ctx: CommandContext,
  action: Action,
): Promise<PostCommitEffect> {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) => applyActionInTransaction(ctx, action, tx),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (prismaErrorCode(error) !== 'P2034') throw error;
      if (attempt === MAX_SERIALIZABLE_ATTEMPTS) throw new ConflictError();
    }
  }
  throw new Error('unreachable serializable transaction retry state');
}

export async function runPostCommitEffect(effect: PostCommitEffect): Promise<void> {
  if (!effect) return;
  if (effect.type === 'account_created') {
    try { await enqueueEnrichJob(effect.tenantId, effect.accountId, 'auto'); } catch { /* 超上限等，忽略 */ }
    try { await enqueueProfileJob(effect.tenantId, effect.accountId); } catch { /* 超上限等，忽略 */ }
    return;
  }
  void import('./pde/routes.js')
    .then(({ takePdeSnapshot }) => takePdeSnapshot(effect.tenantId, effect.opportunityId, 'stage_gate'))
    .catch(() => {});
}


/** 把经共享契约验证的 Action 落到数据库（全程按服务端 CommandContext.tenantId 隔离）。 */
export async function applyAction(ctx: CommandContext, action: Action, db: DbClient = prisma): Promise<PostCommitEffect> {
  CommandContextSchema.parse(ctx);
  const trustedAction = normalizeActionTrust(ctx, ActionSchema.parse(action));
  if (ctx.actorRole === 'viewer') throw new Error('mutation forbidden');
  // INT-103: legacy delete actions remain parseable for old clients, but are fail-closed.
  // Destructive account/opportunity removal is no longer an online operation.
  if (trustedAction.type === 'DELETE_ACCOUNT' || trustedAction.type === 'DELETE_OPP') {
    throw new Error('hard delete disabled; use archive');
  }
  const machinePolicy = machineActionPolicy(trustedAction.type);
  if (!isTrustedHumanAssertion(ctx) && machinePolicy === 'deny') {
    throw new Error(`machine action ${trustedAction.type} must use candidate or proposal`);
  }
  if (!isTrustedHumanAssertion(ctx) && machinePolicy === 'conditional_opp_role' && trustedAction.type === 'SET_ROLE') {
    const existing = await db.oppRole.findFirst({
      where: { tenantId: ctx.tenantId, opportunityId: trustedAction.oppId, personId: trustedAction.personId },
      select: { personId: true },
    });
    if (existing) throw new Error('machine formal oppRole update must use proposal');
  }

  if (isTopLevelClient(db)) {
    const effect = await runTopLevelTransaction(db, ctx, trustedAction);
    if (db === prisma) await runPostCommitEffect(effect);
    return effect;
  }
  return applyActionInTransaction(ctx, trustedAction, db);
}

async function applyActionInTransaction(ctx: CommandContext, action: Action, db: DbClient): Promise<PostCommitEffect> {
  const { tenantId } = ctx;
  const t = action.type;
  const S = (v: unknown) => JSON.stringify(v ?? null);

  // 仅挑选 patch 中存在的字段，避免覆盖为 undefined
  const pick = (patch: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    const d: Record<string, unknown> = {};
    for (const k of keys) if (patch[k] !== undefined) d[k] = patch[k];
    return d;
  };
  await requireActionScope(db, tenantId, action);
  const requireOwner = async (userId: string | null | undefined): Promise<string | null | undefined> => {
    if (userId === undefined) return undefined;
    if (userId === null) return null;
    const user = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
    if (!user) throw new Error('primary owner not found in tenant');
    return user.id;
  };

  switch (t) {
    case 'ADD_ACCOUNT': {
      const a = action.account;
      const profile: Record<string, unknown> = { ...(a.profile ?? {}) };
      if (ctx.channel === 'mcp') profile._mcpOrigin = mcpOriginMark();
      await db.account.create({ data: {
        id: a.id, tenantId, name: a.name, customerType: a.customerType, unifiedCreditCode: a.unifiedCreditCode ?? null,
        externalRef: a.externalRef ?? null, region: a.region ?? '', group: a.group ?? '', primaryOwner: a.primaryOwner ?? '',
        primaryOwnerUserId: (await requireOwner(a.primaryOwnerUserId)) ?? null,
        profile: S(profile),
      } });
      // 顶层事务成功提交后才入队，避免 job 观察到尚未提交/最终回滚的 Account。
      return { type: 'account_created', tenantId, accountId: a.id };
    }
    case 'UPDATE_ACCOUNT': {
      const d = pick(action.patch, ['name', 'customerType', 'unifiedCreditCode', 'externalRef', 'region', 'group', 'primaryOwner']);
      if (action.patch?.primaryOwnerUserId !== undefined) d.primaryOwnerUserId = await requireOwner(action.patch.primaryOwnerUserId);
      if (action.patch?.profile !== undefined) {
        const current = await db.account.findFirst({ where: { id: action.accId, tenantId }, select: { profile: true } });
        const profile: Record<string, unknown> = {
          ...legacyProfileExtras(current?.profile ?? '{}'),
          ...action.patch.profile,
        };
        if (ctx.channel === 'mcp') profile._mcpOrigin = mcpOriginMark();
        d.profile = S(profile);
      }
      await db.account.updateMany({ where: { id: action.accId, tenantId }, data: d });
      return;
    }
    case 'DELETE_ACCOUNT':
      throw new Error('hard delete disabled; use archive');

    case 'ADD_OPP': {
      const o = action.opp;
      await db.opportunity.create({ data: {
        id: o.id, tenantId, accountId: action.accId, name: o.name, customerType: o.customerType,
        pipelineStage: o.pipelineStage, engageStage: o.engageStage, changeMode: o.changeMode ?? null,
        singleSalesGoal: o.singleSalesGoal ?? '', customerBusinessGoal: o.customerBusinessGoal ?? null,
        buyingMotivation: o.buyingMotivation ?? null, c3Items: S(o.c3Items ?? {}), c5Items: S(o.c5Items ?? {}),
        externalRef: o.externalRef ?? null, status: o.status ?? 'active', productSolution: o.productSolution ?? '',
        competitor: o.competitor ?? '', competitiveSituation: o.competitiveSituation ?? '',
        winProbability: o.winProbability ?? 0, expectedSignDate: o.expectedSignDate ?? '',
        expectedAmountW: o.expectedAmountW ?? 0, meta: S(o.meta ?? {}),
        memberScoped: o.memberScoped ?? false,
      } });
      return;
    }
    case 'UPDATE_OPP': {
      const d = pick(action.patch, ['name', 'pipelineStage', 'engageStage', 'changeMode', 'singleSalesGoal', 'customerBusinessGoal', 'buyingMotivation', 'externalRef', 'status', 'productSolution', 'competitor', 'competitiveSituation', 'winProbability', 'expectedSignDate', 'expectedAmountW']);
      if (action.patch?.c3Items !== undefined) d.c3Items = S(action.patch.c3Items);
      if (action.patch?.c5Items !== undefined) d.c5Items = S(action.patch.c5Items);
      if (action.patch?.meta !== undefined) d.meta = S(action.patch.meta);
      // M3 stage-gate（K7）：介入阶段实际推进时强制落 PDE 快照留痕。先取旧值比对，写成功后 fire-and-forget（失败静默不阻塞更新）
      const stageChanging = d.engageStage !== undefined
        ? (await db.opportunity.findFirst({ where: { id: action.oppId, tenantId, accountId: action.accId }, select: { engageStage: true } }))?.engageStage !== d.engageStage
        : false;
      await lockedUpdate({
        baseVersion: action.baseVersion,
        update: (vw) => db.opportunity.updateMany({ where: { id: action.oppId, tenantId, accountId: action.accId, ...vw }, data: { ...d, version: { increment: 1 } } }),
        exists: async () => !!(await db.opportunity.findFirst({ where: { id: action.oppId, tenantId, accountId: action.accId }, select: { id: true } })),
      });
      return stageChanging
        ? { type: 'opportunity_stage_changed', tenantId, opportunityId: action.oppId }
        : undefined;
    }
    case 'DELETE_OPP':
      throw new Error('hard delete disabled; use archive');

    case 'ADD_PERSON': {
      const p = action.person;
      const initialLogs = (p.logs ?? []).map((log) => ({ ...log, createdBy: ctx.actorId }));
      await db.person.create({ data: {
        id: p.id, tenantId, accountId: action.accId, name: p.name, title: p.title, orgLevel: p.orgLevel ?? 3,
        isCompetitor: !!p.isCompetitor, avatarUrl: p.avatarUrl ?? null, coachLevel: p.coachLevel ?? null,
        x: p.x ?? 300, y: p.y ?? 240, form: S(p.form ?? {}), logs: S(initialLogs),
      } });
      return;
    }
    case 'UPDATE_PERSON': {
      const d = pick(action.patch, ['name', 'title', 'orgLevel', 'avatarUrl', 'coachLevel', 'color']);
      if (action.patch?.form !== undefined) d.form = S(action.patch.form);
      await lockedUpdate({
        baseVersion: action.baseVersion,
        update: (vw) => db.person.updateMany({ where: { id: action.personId, tenantId, accountId: action.accId, ...activePersonWhere, ...vw }, data: { ...d, version: { increment: 1 } } }),
        exists: async () => !!(await db.person.findFirst({ where: { id: action.personId, tenantId, accountId: action.accId, ...activePersonWhere }, select: { id: true } })),
      });
      return;
    }
    case 'MOVE_PERSON':
      await db.person.updateMany({ where: { id: action.personId, tenantId, accountId: action.accId, ...activePersonWhere }, data: { x: action.x, y: action.y } });
      return;
    case 'DELETE_PERSON': {
      const pid = action.personId;
      const opportunities = await db.opportunity.findMany({
        where: { tenantId, accountId: action.accId },
        select: { id: true },
      });
      const opportunityIds = opportunities.map((opportunity) => opportunity.id);
      const bis = await db.burningIssue.findMany({
        where: { personId: pid, tenantId, opportunityId: { in: opportunityIds } },
        select: { id: true },
      });
      const biIds = bis.map((b) => b.id);
      await db.uCV.deleteMany({ where: { tenantId, opportunityId: { in: opportunityIds }, targetBiId: { in: biIds } } });
      await db.burningIssue.deleteMany({ where: { personId: pid, tenantId, opportunityId: { in: opportunityIds } } });
      await db.oppRole.deleteMany({ where: { personId: pid, tenantId, opportunityId: { in: opportunityIds } } });
      await db.opportunityMember.deleteMany({ where: { personId: pid, tenantId, opportunityId: { in: opportunityIds } } });
      await db.edge.deleteMany({ where: { tenantId, accountId: action.accId, OR: [{ source: pid }, { target: pid }] } });
      await db.person.deleteMany({ where: { id: pid, tenantId, accountId: action.accId, ...activePersonWhere } });
      return;
    }
    case 'ADD_LOG': {
      const person = await requireScopedRow(db.person.findFirst({ where: { id: action.personId, tenantId, accountId: action.accId, ...activePersonWhere } }));
      const logs = (() => { try { return JSON.parse(person.logs); } catch { return []; } })();
      // createdBy 由服务端从已验证 CommandContext 注入，self ACL 不信任客户端。
      await db.person.updateMany({
        where: { id: action.personId, tenantId, accountId: action.accId, ...activePersonWhere },
        data: { logs: S([{ ...action.log, createdBy: ctx.actorId }, ...logs]) },
      });
      return;
    }

    case 'SET_ROLE': {
      const p = action.patch ?? {};
      await db.oppRole.upsert({
        where: { tenantId_opportunityId_personId: { tenantId, opportunityId: action.oppId, personId: action.personId } },
        create: {
          tenantId, opportunityId: action.oppId, personId: action.personId,
          role: p.role ?? 'U', sentiment: p.sentiment ?? 'unknown', confidence: p.confidence ?? '推理',
          sentimentValue: p.sentimentValue ?? null, isKeyInfluencer: !!p.isKeyInfluencer,
          procurementType: p.procurementType ?? null, procurementStatus: p.procurementStatus ?? null,
          assessedAt: new Date(), // PDE 立场评估时点（时间衰减基准，裁决B：OppRole 承载）
        },
        update: {
          ...pick(p, ['role', 'sentiment', 'sentimentValue', 'confidence', 'isKeyInfluencer', 'procurementType', 'procurementStatus']),
          // 改了态度或可信度 = 一次新的立场评估 → 刷新衰减基准
          ...('sentiment' in p || 'confidence' in p ? { assessedAt: new Date() } : {}),
        },
      });
      return;
    }
    case 'REMOVE_ROLE':
      await db.oppRole.deleteMany({ where: { tenantId, opportunityId: action.oppId, personId: action.personId } });
      return;

    case 'ADD_OPP_MEMBER':
      await db.opportunityMember.upsert({
        where: { tenantId_opportunityId_personId: { tenantId, opportunityId: action.oppId, personId: action.personId } },
        create: { tenantId, opportunityId: action.oppId, personId: action.personId },
        update: {},
      });
      return;
    case 'REMOVE_OPP_MEMBER':
      await db.opportunityMember.deleteMany({ where: { tenantId, opportunityId: action.oppId, personId: action.personId } });
      return;

    case 'ADD_EDGE': {
      const e = action.edge;
      await db.edge.create({ data: {
        id: e.id, tenantId, accountId: action.accId, opportunityId: action.oppId ?? null,
        source: e.source, target: e.target, layer: e.layer, label: e.label,
        color: e.color ?? null, style: e.style ?? null, width: e.width ?? null, directed: !!e.directed, origin: e.origin ?? 'manual',
        shape: e.shape ?? null, bend: e.bend ?? null,
      } });
      return;
    }
    case 'UPDATE_EDGE': {
      // 端点改接(source/target)+外观(label/color/style/width/directed/layer)+形状(shape/bend)，全程租户隔离 + 乐观锁
      const d = pick(action.patch, ['source', 'target', 'layer', 'label', 'color', 'style', 'width', 'directed', 'shape', 'bend']);
      await lockedUpdate({
        baseVersion: action.baseVersion,
        update: (vw) => db.edge.updateMany({
          where: {
            id: action.edgeId,
            tenantId,
            accountId: action.accId,
            OR: [{ opportunityId: action.oppId }, { opportunityId: null }],
            ...vw,
          },
          data: { ...d, version: { increment: 1 } },
        }),
        exists: async () => !!(await db.edge.findFirst({
          where: {
            id: action.edgeId,
            tenantId,
            accountId: action.accId,
            OR: [{ opportunityId: action.oppId }, { opportunityId: null }],
          },
          select: { id: true },
        })),
      });
      return;
    }
    case 'DELETE_EDGE':
      await db.edge.deleteMany({
        where: {
          id: action.edgeId,
          tenantId,
          accountId: action.accId,
          OR: [{ opportunityId: action.oppId }, { opportunityId: null }],
        },
      });
      return;

    case 'ADD_BI': {
      const b = action.bi;
      await db.burningIssue.create({ data: { id: b.id, tenantId, opportunityId: action.oppId, personId: b.personId, description: b.description ?? '', category: b.category ?? '其他', isPrivate: b.isPrivate ?? true, confidence: b.confidence ?? '推理' } });
      return;
    }
    case 'UPDATE_BI':
      await db.burningIssue.updateMany({ where: { id: action.biId, tenantId, opportunityId: action.oppId }, data: pick(action.patch, ['description', 'category', 'isPrivate', 'confidence']) });
      return;
    case 'DELETE_BI':
      await db.uCV.deleteMany({ where: { tenantId, opportunityId: action.oppId, targetBiId: action.biId } });
      await db.burningIssue.deleteMany({ where: { id: action.biId, tenantId, opportunityId: action.oppId } });
      return;

    case 'ADD_UCV': {
      const u = action.ucv;
      await db.uCV.create({ data: { id: u.id, tenantId, opportunityId: action.oppId, targetBiId: u.targetBiId, description: u.description ?? '', competitorCannot: u.competitorCannot ?? '', status: u.status ?? '建议' } });
      return;
    }
    case 'UPDATE_UCV':
      await db.uCV.updateMany({ where: { id: action.ucvId, tenantId, opportunityId: action.oppId }, data: pick(action.patch, ['description', 'competitorCannot', 'status', 'targetBiId']) });
      return;
    case 'DELETE_UCV':
      await db.uCV.deleteMany({ where: { id: action.ucvId, tenantId, opportunityId: action.oppId } });
      return;

    case 'ADD_VISIT': {
      const v = action.visit;
      await db.visitNote.create({ data: {
        id: v.id, tenantId, accountId: action.accId, opportunityId: v.opportunityId ?? null,
        externalRef: v.externalRef ?? null, date: v.date ?? '', topic: v.topic ?? '', summary: v.summary ?? '',
        participants: S(v.participants ?? []), origin: v.origin ?? 'workbuddy', createdBy: ctx.actorId,
      } });
      return;
    }
    case 'UPDATE_VISIT': {
      const d = pick(action.patch, ['opportunityId', 'externalRef', 'date', 'topic', 'summary', 'origin']);
      if (action.patch?.participants !== undefined) d.participants = S(action.patch.participants);
      await db.visitNote.updateMany({ where: { id: action.visitId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_VISIT':
      await db.visitNote.deleteMany({ where: { id: action.visitId, tenantId, accountId: action.accId } });
      return;

    // ── 自由文本层 · 通用笔记（Note，挂载对象可空）──
    case 'ADD_NOTE': {
      const n = action.note;
      await db.note.create({ data: {
        id: n.id, tenantId, accountId: action.accId, opportunityId: n.opportunityId ?? null,
        personId: n.personId ?? null, content: n.content ?? '', source: n.source ?? 'manual',
        tags: S(n.tags ?? []), createdBy: ctx.actorId,
      } });
      return;
    }
    case 'UPDATE_NOTE': {
      const d = pick(action.patch, ['opportunityId', 'personId', 'content', 'source']);
      if (action.patch?.tags !== undefined) d.tags = S(action.patch.tags);
      await db.note.updateMany({ where: { id: action.noteId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_NOTE':
      await db.note.deleteMany({ where: { id: action.noteId, tenantId, accountId: action.accId } });
      return;

    // ── 商机策划 · 行动计划（PlanAction）──
    case 'ADD_PLAN_ACTION': {
      const a = action.planAction;
      await db.planAction.create({ data: {
        id: a.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        gapItem: a.gapItem ?? '', personId: a.personId ?? null, title: a.title ?? '',
        scene: a.scene ?? '', scripts: a.scripts ?? '', target: a.target ?? '', ownerId: a.ownerId ?? '',
        startDate: a.startDate ?? '', endDate: a.endDate ?? '', half: a.half ?? 'am',
        done: !!a.done, doneAt: a.doneAt ?? null, draft: !!a.draft, review: a.review ?? '', origin: a.origin ?? 'manual', createdBy: ctx.actorId,
        resources: a.resources ?? '', cautions: a.cautions ?? '', props: a.props ?? '',
      } });
      return;
    }
    case 'UPDATE_PLAN_ACTION': {
      const d = pick(action.patch, ['gapItem', 'personId', 'title', 'scene', 'scripts', 'target', 'ownerId', 'startDate', 'endDate', 'half', 'done', 'doneAt', 'draft', 'review', 'resources', 'cautions', 'props']);
      await db.planAction.updateMany({ where: { id: action.actionId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_PLAN_ACTION': {
      const planAction = await requireScopedRow(db.planAction.findFirst({
        where: { id: action.actionId, tenantId, accountId: action.accId },
        select: { opportunityId: true },
      }));
      const [cards, planActions, persons] = await Promise.all([
        db.strategyCard.findMany({
          where: { tenantId, accountId: action.accId, opportunityId: planAction.opportunityId },
          select: { id: true, opportunityId: true, personId: true, dispatchedActionIds: true },
        }),
        db.planAction.findMany({
          where: { tenantId, accountId: action.accId, opportunityId: planAction.opportunityId },
          select: { id: true, personId: true },
        }),
        db.person.findMany({ where: { tenantId, accountId: action.accId, ...activePersonWhere }, select: { id: true } }),
      ]);
      const validPersonIds = new Set(persons.map((row) => row.id));
      const validActionIds = new Set(
        planActions
          .filter((row) => !row.personId || validPersonIds.has(row.personId))
          .map((row) => row.id),
      );
      for (const card of cards) {
        const references = parseStringArray(card.dispatchedActionIds);
        if (!references) continue;
        const validCard = (!card.personId || validPersonIds.has(card.personId))
          && references.every((id) => validActionIds.has(id));
        if (!validCard || !references.includes(action.actionId)) continue;
        const updated = await db.strategyCard.updateMany({
          where: {
            id: card.id,
            tenantId,
            accountId: action.accId,
            opportunityId: planAction.opportunityId,
            dispatchedActionIds: card.dispatchedActionIds,
          },
          data: { dispatchedActionIds: S(references.filter((id) => id !== action.actionId)) },
        });
        if (updated.count !== 1) throw new ConflictError();
      }
      await db.planAction.deleteMany({ where: { id: action.actionId, tenantId, accountId: action.accId } });
      return;
    }
    case 'TOGGLE_PLAN_ACTION':
      await db.planAction.updateMany({
        where: { id: action.actionId, tenantId, accountId: action.accId },
        data: { done: !!action.done, doneAt: action.done ? (action.doneAt ?? new Date().toISOString().slice(0, 10)) : null },
      });
      return;

    // ── 商机策划 · 里程碑（OppMilestone）──
    case 'ADD_MILESTONE': {
      const m = action.milestone;
      await db.oppMilestone.create({ data: {
        id: m.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        title: m.title ?? '', startDate: m.startDate ?? '', endDate: m.endDate ?? '', half: m.half ?? 'am',
      } });
      return;
    }
    case 'UPDATE_MILESTONE': {
      const d = pick(action.patch, ['title', 'startDate', 'endDate', 'half']);
      await db.oppMilestone.updateMany({ where: { id: action.milestoneId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_MILESTONE':
      await db.oppMilestone.deleteMany({ where: { id: action.milestoneId, tenantId, accountId: action.accId } });
      return;

    // ── 商机策划 · 阶段段（OppStage，年视图模型 B）──
    case 'ADD_OPP_STAGE': {
      const s = action.stage;
      await db.oppStage.create({ data: {
        id: s.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        stageKey: s.stageKey ?? '', startDate: s.startDate ?? '', endDate: s.endDate ?? '',
      } });
      return;
    }
    case 'UPDATE_OPP_STAGE': {
      const d = pick(action.patch, ['stageKey', 'startDate', 'endDate']);
      await db.oppStage.updateMany({ where: { id: action.stageId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_OPP_STAGE':
      await db.oppStage.deleteMany({ where: { id: action.stageId, tenantId, accountId: action.accId } });
      return;

    // ── 策略沙盘 · 策略卡（StrategyCard）──
    case 'ADD_STRATEGY_CARD': {
      const c = action.card;
      await db.strategyCard.create({ data: {
        id: c.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        gapItem: c.gapItem ?? '', title: c.title ?? '', basis: c.basis ?? '', alternatives: c.alternatives ?? '',
        personId: c.personId ?? null, status: c.status ?? 'active', origin: c.origin ?? 'manual',
        orderIndex: c.orderIndex ?? 0, dispatchedActionIds: S(c.dispatchedActionIds ?? []),
      } });
      return;
    }
    case 'UPDATE_STRATEGY_CARD': {
      const d = pick(action.patch, ['gapItem', 'title', 'basis', 'alternatives', 'personId', 'status', 'origin', 'orderIndex']);
      if (action.patch?.dispatchedActionIds !== undefined) d.dispatchedActionIds = S(action.patch.dispatchedActionIds);
      await db.strategyCard.updateMany({ where: { id: action.cardId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_STRATEGY_CARD':
      await db.strategyCard.deleteMany({ where: { id: action.cardId, tenantId, accountId: action.accId } });
      return;

    // ── 策略沙盘 · 风险/假设（StrategyRisk）──
    case 'ADD_STRATEGY_RISK': {
      const r = action.risk;
      await db.strategyRisk.create({ data: {
        id: r.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        kind: r.kind ?? 'risk', text: r.text ?? '', severity: r.severity ?? 'mid',
        mitigation: r.mitigation ?? '', status: r.status ?? 'open', origin: r.origin ?? 'manual',
      } });
      return;
    }
    case 'UPDATE_STRATEGY_RISK': {
      const d = pick(action.patch, ['kind', 'text', 'severity', 'mitigation', 'status', 'origin']);
      await db.strategyRisk.updateMany({ where: { id: action.riskId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_STRATEGY_RISK':
      await db.strategyRisk.deleteMany({ where: { id: action.riskId, tenantId, accountId: action.accId } });
      return;

    // ── 策略沙盘 · 轻量弹药（StrategyResource）──
    case 'ADD_STRATEGY_RESOURCE': {
      const x = action.resource;
      await db.strategyResource.create({ data: {
        id: x.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        label: x.label ?? '', kind: x.kind ?? '', note: x.note ?? '',
      } });
      return;
    }
    case 'UPDATE_STRATEGY_RESOURCE': {
      const d = pick(action.patch, ['label', 'kind', 'note']);
      await db.strategyResource.updateMany({ where: { id: action.resourceId, tenantId, accountId: action.accId }, data: d });
      return;
    }
    case 'DELETE_STRATEGY_RESOURCE':
      await db.strategyResource.deleteMany({ where: { id: action.resourceId, tenantId, accountId: action.accId } });
      return;

    case 'ADD_EVIDENCE': {
      const x = action.evidence;
      await db.evidenceEvent.create({ data: {
        id: x.id, tenantId, accountId: action.accId, opportunityId: action.oppId, personId: x.personId,
        signalKey: x.signalKey, direction: x.direction ?? 0, tier: x.tier ?? 'mid',
        rawContent: x.rawContent ?? '', occurredAt: x.occurredAt ?? '',
        status: x.status ?? 'approved', origin: x.origin ?? 'manual', // M3：人工直落 approved；机器路径显式 pending_review
      } });
      return;
    }
    case 'DELETE_EVIDENCE':
      await db.evidenceEvent.deleteMany({ where: { id: action.evidenceId, tenantId, accountId: action.accId, opportunityId: action.oppId } });
      return;

    default:
      throw new Error(`unknown action: ${t}`);
  }
}
