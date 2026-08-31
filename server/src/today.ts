import { createHash } from 'node:crypto';
import type { Opportunity, Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import {
  ActorRoleSchema,
  INTERVENTION_ITEM_ID_MAX_LENGTH,
  InterventionItemSchema,
  InterventionSourceRefSchema,
  TodayReadModelSchema,
  TodaySourceViewSchema,
  type InterventionItem,
  type InterventionSourceRef,
  type InterventionTime,
  type TodayReadModel,
  type TodaySectionKey,
  type TodaySourceView,
} from '@jianghu/domain-contracts';
import { businessDayDistance, businessYmd } from './businessDate.js';
import {
  commitmentFromPlanAction,
  type CommitmentPlanActionRow,
} from './commitment/view.js';
import type { DbClient } from './mutation/scopeGuards.js';
import { prisma } from './prisma.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import type { ReadPrincipal } from './visibility.js';

const PROVIDER_KEY = 'core.today';
const RULE_VERSION = 'core.today.v1';
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

const TODAY_PLAN_ACTION_SELECT = {
  id: true,
  accountId: true,
  opportunityId: true,
  personId: true,
  title: true,
  kind: true,
  ownerUserId: true,
  executionStatus: true,
  confirmationStatus: true,
  scheduledAtUtc: true,
  dueAtUtc: true,
  timeZone: true,
  isAllDay: true,
  localDate: true,
  confirmationDueAtUtc: true,
  confirmedAtUtc: true,
  confirmedByUserId: true,
  scheduleVersion: true,
  nextCommitmentId: true,
  source: true,
  sourceRef: true,
  archivedAt: true,
  version: true,
  hypothesisId: true,
  hypothesisRevisionId: true,
  completionResult: true,
  completionResultRecordedAtUtc: true,
  completionResultRecordedByUserId: true,
  verificationReviewDisposition: true,
  verificationReviewedAtUtc: true,
  verificationReviewedByUserId: true,
  doneAt: true,
} satisfies Prisma.PlanActionSelect;

type RankedItem = {
  item: InterventionItem;
  group: number;
  sortAt: number;
};

const clip = (value: string, max: number): string => (
  value.trim().slice(0, max) || '（未命名）'
);

function relationForDate(targetYmd: string, now: Date, timeZone: string): 'overdue' | 'due' | 'upcoming' | null {
  const distance = businessDayDistance(targetYmd, businessYmd(now, timeZone));
  if (!Number.isFinite(distance) || distance > 1) return null;
  if (distance < 0) return 'overdue';
  return distance === 0 ? 'due' : 'upcoming';
}

function clockLabel(at: Date, timeZone: string): string {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    clockFormatters.set(timeZone, formatter);
  }
  return formatter.format(at);
}

function instantTime(at: Date, now: Date, timeZone: string, prefix = ''): InterventionTime | null {
  const relation = at.getTime() < now.getTime()
    ? 'overdue'
    : relationForDate(businessYmd(at, timeZone), now, timeZone);
  if (!relation) return null;
  const label = relation === 'overdue'
    ? `${prefix}已逾期`
    : `${relation === 'due' ? '今天' : '明天'} ${clockLabel(at, timeZone)}${prefix ? ` ${prefix}` : ''}`;
  return {
    kind: 'instant',
    atUtc: at.toISOString(),
    timeZone,
    relation,
    label,
  };
}

function localDateTime(localDate: string, now: Date, timeZone: string): InterventionTime | null {
  const relation = relationForDate(localDate, now, timeZone);
  if (!relation) return null;
  return {
    kind: 'local_date',
    localDate,
    timeZone,
    relation,
    label: relation === 'overdue'
      ? '全天事项已逾期'
      : `${relation === 'due' ? '今天' : '明天'}（全天）`,
  };
}

function sourceForCommitment(commitment: NonNullable<ReturnType<typeof commitmentFromPlanAction>>) {
  return [{
    entityKind: 'commitment',
    entityId: commitment.id,
    version: commitment.version,
    scheduleVersion: commitment.scheduleVersion,
  }];
}

function interventionItemId(
  reasonCode: string,
  entityId: string,
  version: number,
  scheduleVersion: number | null,
): string {
  const revision = `v${version}${scheduleVersion === null ? '' : `:s${scheduleVersion}`}`;
  const candidate = `today:${reasonCode}:raw:${entityId}:${revision}`;
  if (candidate.length <= INTERVENTION_ITEM_ID_MAX_LENGTH) return candidate;
  const digest = createHash('sha256').update(entityId).digest('hex');
  return `today:${reasonCode}:hash:${digest}:${revision}`;
}

function commitmentTarget(commitment: NonNullable<ReturnType<typeof commitmentFromPlanAction>>) {
  return {
    entityKind: 'commitment',
    entityId: commitment.id,
    customerId: commitment.customerId,
    matterId: commitment.matterId,
    commitmentId: commitment.id,
    version: commitment.version,
    scheduleVersion: commitment.scheduleVersion,
  };
}

function contextFor(
  customerName: string,
  matter: Pick<Opportunity, 'name'> | undefined,
) {
  return {
    customerName: clip(customerName, 240),
    matterName: matter ? clip(matter.name, 240) : null,
  };
}

function sortRanked(items: RankedItem[]): InterventionItem[] {
  return items
    .sort((left, right) => left.group - right.group
      || left.sortAt - right.sortAt
      || left.item.id.localeCompare(right.item.id))
    .map(({ item }) => item);
}

function validCurrentCommitment(row: CommitmentPlanActionRow) {
  const commitment = commitmentFromPlanAction(row);
  return commitment && commitment.archivedAt === null ? commitment : null;
}

function isActionablePlannedCommitment(
  commitment: NonNullable<ReturnType<typeof commitmentFromPlanAction>>,
): boolean {
  return commitment.executionStatus === 'planned' && commitment.confirmationStatus !== 'declined';
}

function possibleLocalDates(now: Date): string[] {
  const utcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return [-1, 0, 1].map((offset) => new Date(utcDay + offset * 86_400_000).toISOString().slice(0, 10));
}

const executionLabel: Record<string, string> = {
  planned: '计划中',
  completed: '已完成',
  canceled: '已取消',
  missed: '已错过',
};

const confirmationLabel: Record<string, string> = {
  not_required: '无需确认',
  pending: '待确认',
  confirmed: '已确认',
  declined: '已拒绝',
};

const lifecycleLabel: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  canceled: '已取消',
};

export async function resolveTodaySource(
  principal: ReadPrincipal,
  sourceRef: InterventionSourceRef,
  db: DbClient = prisma,
): Promise<TodaySourceView | null> {
  const scope = await resolveEffectiveResourceScope(db, principal);

  // Account.version is not yet a revision authority for every source-visible mutation.
  // Keep Customer/Account drilldown and provider targets closed until that invariant exists.
  if (sourceRef.entityKind === 'customer' || sourceRef.entityKind === 'account') return null;

  if (sourceRef.entityKind === 'matter') {
    if (!scope.canReadMatter(sourceRef.entityId) || sourceRef.scheduleVersion !== null) return null;
    const [matter, plannedRows] = await Promise.all([
      db.opportunity.findFirst({
        where: {
          id: sourceRef.entityId,
          tenantId: principal.tenantId,
          archivedAt: null,
          version: sourceRef.version,
          account: { tenantId: principal.tenantId, archivedAt: null },
        },
        select: { id: true, accountId: true, name: true, lifecycleStatus: true },
      }),
      db.planAction.findMany({
        where: {
          tenantId: principal.tenantId,
          opportunityId: sourceRef.entityId,
          archivedAt: null,
          executionStatus: 'planned',
        },
        select: TODAY_PLAN_ACTION_SELECT,
      }),
    ]);
    if (!matter) return null;
    const hasPlannedCommitment = plannedRows.some((row) => {
      const commitment = validCurrentCommitment(row);
      return commitment?.matterId === matter.id
        && commitment.customerId === matter.accountId
        && isActionablePlannedCommitment(commitment);
    });
    if (hasPlannedCommitment) return null;
    return TodaySourceViewSchema.parse({
      sourceRef,
      customerId: matter.accountId,
      matterId: matter.id,
      label: clip(matter.name, 200),
      detail: `事项 · ${lifecycleLabel[matter.lifecycleStatus] ?? '状态未知'} · 当前无计划中的下一步`,
    });
  }

  if (sourceRef.entityKind !== 'commitment') return null;
  const row = await db.planAction.findFirst({
    where: {
      id: sourceRef.entityId,
      tenantId: principal.tenantId,
      archivedAt: null,
    },
    select: TODAY_PLAN_ACTION_SELECT,
  });
  if (!row) return null;
  const commitment = validCurrentCommitment(row);
  if (!commitment
    || commitment.version !== sourceRef.version
    || commitment.scheduleVersion !== sourceRef.scheduleVersion) return null;
  if (commitment.matterId) {
    if (!scope.canReadMatter(commitment.matterId)) return null;
    const parent = await db.opportunity.findFirst({
      where: {
        id: commitment.matterId,
        tenantId: principal.tenantId,
        accountId: commitment.customerId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!parent) return null;
  } else if (!scope.canReadAccountData(commitment.customerId)) {
    return null;
  }
  return TodaySourceViewSchema.parse({
    sourceRef,
    customerId: commitment.customerId,
    matterId: commitment.matterId,
    label: clip(commitment.title, 200),
    detail: `${executionLabel[commitment.executionStatus] ?? '状态未知'} · ${confirmationLabel[commitment.confirmationStatus] ?? '确认状态未知'}`,
  });
}

export async function buildTodayReadModel(
  principal: ReadPrincipal,
  now: Date,
  db: DbClient = prisma,
  // Internal composition seam only. Before wiring any provider here, accept
  // structured facts/source refs and rebuild all visible prose from validated
  // tenant-scoped projections; never trust provider-authored display content.
  additionalItems: readonly unknown[] = [],
): Promise<TodayReadModel> {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid Today observation time');
  const generatedAtUtc = now.toISOString();
  const scope = await resolveEffectiveResourceScope(db, principal);
  const accountIds = [...scope.accountIds];
  const fullAccountIds = [...scope.fullAccountIds];
  const matterIds = [...scope.matterIds];
  const completionDateCandidates = possibleLocalDates(now);

  const [accounts, matters, planRows] = await Promise.all([
    accountIds.length === 0
      ? Promise.resolve([])
      : db.account.findMany({
          where: { tenantId: principal.tenantId, archivedAt: null, id: { in: accountIds } },
          select: { id: true, name: true },
        }),
    matterIds.length === 0
      ? Promise.resolve([])
      : db.opportunity.findMany({
          where: {
            tenantId: principal.tenantId,
            archivedAt: null,
            id: { in: matterIds },
            accountId: { in: accountIds },
          },
          select: {
            id: true,
            accountId: true,
            name: true,
            lifecycleStatus: true,
            version: true,
            createdAt: true,
          },
        }),
    fullAccountIds.length === 0 && matterIds.length === 0
      ? Promise.resolve([])
      : db.planAction.findMany({
          where: {
            tenantId: principal.tenantId,
            archivedAt: null,
            AND: [
              { OR: [
                ...(fullAccountIds.length > 0 ? [{ accountId: { in: fullAccountIds } }] : []),
                ...(matterIds.length > 0 ? [{ opportunityId: { in: matterIds } }] : []),
              ] },
              { OR: [
                { executionStatus: 'planned' },
                {
                  executionStatus: 'completed',
                  OR: [
                    { doneAt: { in: completionDateCandidates } },
                    { doneAt: null, localDate: { in: completionDateCandidates } },
                  ],
                },
              ] },
            ],
          },
          select: TODAY_PLAN_ACTION_SELECT,
        }),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const matterById = new Map(matters.map((matter) => [matter.id, matter]));
  const commitments: Array<NonNullable<ReturnType<typeof commitmentFromPlanAction>>> = [];
  const completionDateByCommitmentId = new Map<string, string>();
  for (const row of planRows) {
    if (!accountById.has(row.accountId)) continue;
    if (row.opportunityId) {
      const matter = matterById.get(row.opportunityId);
      if (!matter || matter.accountId !== row.accountId) continue;
    } else if (!scope.fullAccountIds.has(row.accountId)) continue;
    const commitment = validCurrentCommitment(row);
    if (commitment) {
      commitments.push(commitment);
      if (row.doneAt) completionDateByCommitmentId.set(commitment.id, row.doneAt);
    }
  }

  const pending: RankedItem[] = [];
  const followUp: RankedItem[] = [];
  const completed: RankedItem[] = [];
  const mattersWithPlanned = new Set<string>();

  for (const commitment of commitments) {
    const account = accountById.get(commitment.customerId);
    if (!account) continue;
    const matter = commitment.matterId ? matterById.get(commitment.matterId) : undefined;
    if (commitment.matterId && !matter) continue;
    const context = contextFor(account.name, matter);
    const sourceRefs = sourceForCommitment(commitment);
    const target = commitmentTarget(commitment);

    if (isActionablePlannedCommitment(commitment)) {
      if (commitment.matterId) mattersWithPlanned.add(commitment.matterId);
      const eventAt = commitment.dueAtUtc ?? commitment.scheduledAtUtc;
      const eventTime = commitment.isAllDay && commitment.localDate
        ? localDateTime(commitment.localDate, now, commitment.timeZone)
        : eventAt ? instantTime(new Date(eventAt), now, commitment.timeZone) : null;
      const eventIsOverdue = eventTime?.relation === 'overdue';
      if (!eventIsOverdue
        && commitment.confirmationStatus === 'pending'
        && commitment.confirmationDueAtUtc) {
        const deadline = new Date(commitment.confirmationDueAtUtc);
        const time = instantTime(deadline, now, commitment.timeZone, '确认');
        if (!time) continue;
        const item = InterventionItemSchema.parse({
          id: interventionItemId('confirmation_due', commitment.id, commitment.version, commitment.scheduleVersion),
          section: 'pending_confirmation',
          providerKey: PROVIDER_KEY,
          title: clip(commitment.title, 200),
          context,
          reasonCode: 'confirmation_due',
          explanation: time.relation === 'overdue'
            ? '这条下一步仍待确认，确认截止时间已经到达。'
            : '这条下一步仍待确认，确认截止时间即将到达。',
          sourceRefs,
          observedAtUtc: generatedAtUtc,
          ruleVersion: RULE_VERSION,
          time,
          suggestedAction: {
            kind: 'confirm_commitment',
            label: '确认或调整时间',
            commandType: 'CONFIRM_COMMITMENT',
          },
          target,
        });
        pending.push({ item, group: time.relation === 'overdue' ? 0 : 1, sortAt: deadline.getTime() });
        continue;
      }

      const time = eventTime;
      if (!time) continue;
      const eventSortAt = eventAt ? Date.parse(eventAt) : Date.parse(`${commitment.localDate}T00:00:00Z`);
      const group = time.relation === 'overdue' ? 0 : time.relation === 'due' ? 2 : 3;
      const item = InterventionItemSchema.parse({
        id: interventionItemId('commitment_due', commitment.id, commitment.version, commitment.scheduleVersion),
        section: 'follow_up',
        providerKey: PROVIDER_KEY,
        title: clip(commitment.title, 200),
        context,
        reasonCode: 'commitment_due',
        explanation: time.relation === 'overdue'
          ? '这条下一步已经逾期，需要确认结果或重新安排。'
          : time.relation === 'upcoming'
            ? '这条下一步将在明天进入跟进窗口。'
            : '这条下一步已进入今天的跟进窗口。',
        sourceRefs,
        observedAtUtc: generatedAtUtc,
        ruleVersion: RULE_VERSION,
        time,
        suggestedAction: {
          kind: 'complete_commitment',
          label: '完成后记录结果',
          commandType: 'COMPLETE_COMMITMENT',
        },
        target,
      });
      followUp.push({ item, group, sortAt: eventSortAt });
      continue;
    }

    const completionLocalDate = completionDateByCommitmentId.get(commitment.id) ?? commitment.localDate;
    if (commitment.executionStatus === 'completed'
      && completionLocalDate
      && completionLocalDate === businessYmd(now, commitment.timeZone)) {
      const item = InterventionItemSchema.parse({
        id: interventionItemId('commitment_completed', commitment.id, commitment.version, commitment.scheduleVersion),
        section: 'completed',
        providerKey: PROVIDER_KEY,
        title: clip(commitment.title, 200),
        context,
        reasonCode: 'commitment_completed',
        explanation: '这条下一步已在今天完成，可继续补充新的下一步。',
        sourceRefs,
        observedAtUtc: generatedAtUtc,
        ruleVersion: RULE_VERSION,
        time: {
          kind: 'local_date',
          localDate: completionLocalDate,
          timeZone: commitment.timeZone,
          relation: 'completed',
          label: '今天已完成',
        },
        suggestedAction: {
          kind: commitment.nextCommitmentId ? 'view_commitment' : 'create_next_commitment',
          label: commitment.nextCommitmentId ? '查看下一步' : '补充下一步',
          commandType: commitment.nextCommitmentId ? null : 'CREATE_NEXT_COMMITMENT',
        },
        target,
      });
      completed.push({ item, group: 0, sortAt: -Date.parse(`${completionLocalDate}T00:00:00Z`) });
    }
  }

  for (const matter of matters) {
    if (matter.lifecycleStatus !== 'active' && matter.lifecycleStatus !== 'paused') continue;
    if (mattersWithPlanned.has(matter.id)) continue;
    const account = accountById.get(matter.accountId);
    if (!account) continue;
    const item = InterventionItemSchema.parse({
      id: interventionItemId('matter_without_next_commitment', matter.id, matter.version, null),
      section: 'follow_up',
      providerKey: PROVIDER_KEY,
      title: clip(matter.name, 200),
      context: contextFor(account.name, matter),
      reasonCode: 'matter_without_next_commitment',
      explanation: '该事项仍在进行，但当前没有计划中的下一步。',
      sourceRefs: [{
        entityKind: 'matter',
        entityId: matter.id,
        version: matter.version,
        scheduleVersion: null,
      }],
      observedAtUtc: generatedAtUtc,
      ruleVersion: RULE_VERSION,
      time: {
        kind: 'observed',
        atUtc: generatedAtUtc,
        relation: 'missing',
        label: '当前未记录下一步',
      },
      suggestedAction: {
        kind: 'create_commitment',
        label: '补一个下一步',
        commandType: 'CREATE_COMMITMENT',
      },
      target: {
        entityKind: 'matter',
        entityId: matter.id,
        customerId: matter.accountId,
        matterId: matter.id,
        commitmentId: null,
        version: matter.version,
        scheduleVersion: null,
      },
    });
    followUp.push({ item, group: 1, sortAt: matter.createdAt.getTime() });
  }

  const commitmentById = new Map(commitments.map((commitment) => [commitment.id, commitment]));
  const sourceIsVisible = (source: InterventionItem['sourceRefs'][number]): boolean => {
    if (source.entityKind === 'matter') {
      const matter = matterById.get(source.entityId);
      return Boolean(matter
        && scope.canReadMatter(source.entityId)
        && matter.version === source.version
        && !mattersWithPlanned.has(source.entityId)
        && source.scheduleVersion === null);
    }
    if (source.entityKind === 'customer' || source.entityKind === 'account') {
      return false;
    }
    if (source.entityKind !== 'commitment') return false;
    const commitment = commitmentById.get(source.entityId);
    return Boolean(commitment
      && commitment.version === source.version
      && commitment.scheduleVersion === source.scheduleVersion);
  };
  const targetIsVisible = (item: InterventionItem): boolean => {
    const { target } = item;
    if (!accountById.has(target.customerId)) return false;
    if (target.matterId) {
      const matter = matterById.get(target.matterId);
      if (!matter || matter.accountId !== target.customerId || !scope.canReadMatter(target.matterId)) return false;
    } else if (!scope.canReadAccountData(target.customerId)) {
      return false;
    }

    if (target.entityKind === 'matter') {
      const matter = matterById.get(target.entityId);
      return Boolean(target.entityId === target.matterId
        && matter
        && matter.version === target.version
        && !mattersWithPlanned.has(target.entityId)
        && target.commitmentId === null
        && target.scheduleVersion === null);
    }
    if (target.entityKind === 'customer' || target.entityKind === 'account') {
      return false;
    }
    if (target.entityKind !== 'commitment') return false;
    const commitment = commitmentById.get(target.entityId);
    return Boolean(commitment
      && commitment.customerId === target.customerId
      && commitment.matterId === target.matterId
      && commitment.version === target.version
      && commitment.scheduleVersion === target.scheduleVersion);
  };
  const extras = additionalItems
    .map((item) => InterventionItemSchema.safeParse(item))
    .flatMap((parsed) => parsed.success ? [parsed.data] : [])
    .filter((item) => targetIsVisible(item) && item.sourceRefs.every(sourceIsVisible));
  const coreBySection = new Map<TodaySectionKey, InterventionItem[]>([
    ['pending_confirmation', sortRanked(pending)],
    ['follow_up', sortRanked(followUp)],
    ['completed', sortRanked(completed)],
  ]);
  const seenIds = new Set(
    [...coreBySection.values()].flatMap((items) => items.map((item) => item.id)),
  );
  const extraBySection = new Map<TodaySectionKey, InterventionItem[]>();
  for (const item of extras) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const rows = extraBySection.get(item.section) ?? [];
    rows.push(item);
    extraBySection.set(item.section, rows);
  }
  const itemsFor = (section: TodaySectionKey) => [
    ...(coreBySection.get(section) ?? []),
    ...(extraBySection.get(section) ?? []),
  ];

  return TodayReadModelSchema.parse({
    generatedAtUtc,
    sections: [
      { key: 'pending_confirmation', label: '待确认', items: itemsFor('pending_confirmation') },
      { key: 'follow_up', label: '待跟进', items: itemsFor('follow_up') },
      { key: 'completed', label: '已完成', items: itemsFor('completed') },
    ],
  });
}

export function todayRoutes(app: FastifyInstance): void {
  app.get('/api/today', { preHandler: [app.authenticate] }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return buildTodayReadModel({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: ActorRoleSchema.parse(req.user.role),
    }, new Date());
  });

  app.post<{ Body: unknown }>(
    '/api/today/source',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const parsed = InterventionSourceRefSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '来源参数无效' });
      const source = await resolveTodaySource({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        role: ActorRoleSchema.parse(req.user.role),
      }, parsed.data);
      if (!source) return reply.code(404).send({ error: '来源不存在或无权限' });
      return source;
    },
  );
}
