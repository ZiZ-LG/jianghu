import {
  CommandContextSchema,
  MATTER_PORTFOLIO_RULE_VERSION,
  MatterPortfolioReadModelSchema,
  MatterPortfolioSalesEstimateSchema,
  TodaySourceViewSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
  type InterventionItem,
  type InterventionSourceRef,
  type MatterPortfolioReadModel,
  type MatterPortfolioSourceRequest,
  type TodaySourceView,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import { buildTodayReadModel, resolveTodaySource } from '../today.js';
import {
  relationshipRadarSourceView,
  relationshipRadarTodayItems,
  RelationshipRadarReadError,
} from '../relationshipRadar/service.js';
import {
  intelligenceItemDetail,
} from '../intelligenceFocus/service.js';
import {
  salesHypothesisDetail,
} from '../hypotheses/service.js';
import { createSensitiveAccessEvaluator } from '../sensitiveAccess.js';
import {
  buildMatterPortfolio,
  type MatterPortfolioMatterFacts,
} from './model.js';
import { loadMatterPortfolioAuthorizedFacts } from './authorizedFacts.js';

export class MatterPortfolioReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly scopedNotFound = false,
  ) {
    super(code);
    this.name = 'MatterPortfolioReadError';
  }
}

function notFound(): never {
  throw new MatterPortfolioReadError('matter_portfolio_not_found', 404, true);
}

function sourceChanged(): never {
  throw new MatterPortfolioReadError('matter_portfolio_source_changed', 409);
}

function storageInvalid(): never {
  throw new MatterPortfolioReadError('matter_portfolio_storage_invalid', 409);
}

function requireCapability(policy: CapabilityPolicy): void {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new MatterPortfolioReadError('capability_denied', 403);
  }
}

function sourceKey(source: InterventionSourceRef): string {
  return `${source.entityKind}\0${source.entityId}\0${source.version}\0${source.scheduleVersion ?? ''}`;
}

function salesEstimateFor(row: {
  kind: string;
  expectedAmountW: number;
  winProbability: number;
  expectedSignDate: string;
}) {
  if (row.kind !== 'sales_opportunity') return null;
  const signDate = row.expectedSignDate.trim();
  const parsed = MatterPortfolioSalesEstimateSchema.safeParse({
    kind: 'sales_entered_estimate',
    expectedAmountW: row.expectedAmountW,
    winProbability: row.winProbability,
    expectedSignDate: signDate.length === 0 ? null : signDate,
  });
  return parsed.success ? parsed.data : {
    kind: 'sales_estimate_unavailable' as const,
    reason: 'invalid_stored_values' as const,
  };
}

interface MatterPortfolioReadOptions {
  target?: { customerId: string; matterId: string };
  providerKey?: MatterPortfolioSourceRequest['providerKey'];
}

export async function buildMatterPortfolioReadModel(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  now = new Date(),
  options: MatterPortfolioReadOptions = {},
): Promise<MatterPortfolioReadModel> {
  CommandContextSchema.parse(ctx);
  requireCapability(policy);
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid Matter portfolio observation time');
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  }, policy);
  const scope = evaluator.scope;
  if (!scope.valid) notFound();

  const visibleMatterIds = options.target
    ? scope.canReadMatter(options.target.matterId) ? [options.target.matterId] : []
    : [...scope.matterIds];
  if (visibleMatterIds.length === 0) {
    return MatterPortfolioReadModelSchema.parse({
      generatedAtUtc: now.toISOString(),
      ruleVersion: MATTER_PORTFOLIO_RULE_VERSION,
      entries: [],
    });
  }

  const matterRows = await db.opportunity.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: visibleMatterIds },
      ...(options.target ? { accountId: options.target.customerId } : {}),
      lifecycleStatus: 'active',
      archivedAt: null,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      accountId: true,
      name: true,
      kind: true,
      lifecycleStatus: true,
      outcomeKey: true,
      priority: true,
      targetDate: true,
      primaryOwnerUserId: true,
      archivedAt: true,
      version: true,
      activeMethodologyBindingId: true,
      expectedAmountW: true,
      winProbability: true,
      expectedSignDate: true,
    },
  });
  const activeMatterIds = matterRows.map((row) => row.id);
  const customerIds = [...new Set(matterRows.map((row) => row.accountId))];
  const customerRows = customerIds.length === 0 ? [] : await db.account.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: customerIds },
      archivedAt: null,
    },
    select: {
      id: true,
      name: true,
      categoryKey: true,
      primaryOwnerUserId: true,
      archivedAt: true,
      version: true,
    },
  });
  const customerById = new Map(customerRows.map((row) => [row.id, row]));

  const activeBindingIds = matterRows.flatMap((row) => (
    row.activeMethodologyBindingId ? [row.activeMethodologyBindingId] : []
  ));
  const bindingRows = activeBindingIds.length === 0 ? [] : await db.methodologyBinding.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: activeBindingIds },
      opportunityId: { in: activeMatterIds },
    },
    select: {
      id: true,
      opportunityId: true,
      packId: true,
      versionId: true,
      stageState: {
        select: {
          opportunityId: true,
          bindingId: true,
          packId: true,
          versionId: true,
          stageKey: true,
          updatedAt: true,
          stageDefinition: { select: { name: true } },
        },
      },
    },
  });
  const bindingByMatterId = new Map(bindingRows.map((binding) => [binding.opportunityId, binding]));

  const principal = {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: scope.actorRole,
  };
  const includeRadar = options.providerKey === undefined
    || options.providerKey === 'relationship_radar';
  const includeCoreToday = options.providerKey === undefined
    || options.providerKey === 'core.today';
  let radarItems: InterventionItem[] = [];
  if (includeRadar) {
    try {
      radarItems = await relationshipRadarTodayItems(db, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        actorRole: scope.actorRole,
      }, policy, now, options.target);
    } catch (error) {
      if (!(error instanceof RelationshipRadarReadError)) throw error;
      // A missing/expired/invalid provider projection can never elevate portfolio urgency.
      radarItems = [];
    }
  }
  const providerItems = includeCoreToday
    ? (await buildTodayReadModel(
        principal,
        now,
      db,
      options.providerKey === undefined ? radarItems : [],
      options.target ? { target: options.target } : {},
    )).sections.flatMap((section) => section.items)
    : radarItems;
  const interventionByMatterId = new Map<string, InterventionItem[]>();
  for (const item of providerItems) {
    if (!item.target.matterId || !activeMatterIds.includes(item.target.matterId)) continue;
    const values = interventionByMatterId.get(item.target.matterId) ?? [];
    values.push(item);
    interventionByMatterId.set(item.target.matterId, values);
  }

  const { latestIntelligence, focusPeople, hypotheses } = await loadMatterPortfolioAuthorizedFacts(
    db,
    ctx,
    evaluator,
    matterRows.map((row) => ({ id: row.id, customerId: row.accountId })),
    now,
  );

  const facts: MatterPortfolioMatterFacts[] = [];
  for (const row of matterRows) {
    const customer = customerById.get(row.accountId);
    if (!customer || !scope.canReadMatter(row.id) || !scope.canReadAccountContainer(customer.id)) continue;
    const matter = {
      id: row.id,
      customerId: row.accountId,
      title: row.name,
      kind: row.kind,
      lifecycleStatus: row.lifecycleStatus as 'active',
      outcomeKey: row.outcomeKey,
      priority: row.priority,
      targetDate: row.targetDate,
      primaryOwnerUserId: row.primaryOwnerUserId,
      archivedAt: null,
      version: row.version,
    };
    const binding = bindingByMatterId.get(row.id);
    const stageState = binding?.stageState;
    const methodologyStage = binding
      && binding.id === row.activeMethodologyBindingId
      && stageState
      && stageState.opportunityId === row.id
      && stageState.bindingId === binding.id
      && stageState.packId === binding.packId
      && stageState.versionId === binding.versionId
      ? {
          customerId: customer.id,
          matterId: row.id,
          bindingId: binding.id,
          packId: binding.packId,
          versionId: binding.versionId,
          stageKey: stageState.stageKey,
          stageName: stageState.stageDefinition.name,
          updatedAtUtc: stageState.updatedAt.toISOString(),
        }
      : null;
    facts.push({
      customer: {
        id: customer.id,
        name: customer.name,
        categoryKey: customer.categoryKey,
        primaryOwnerUserId: scope.canReadAccountData(customer.id) ? customer.primaryOwnerUserId : null,
        archivedAt: null,
        version: customer.version,
      },
      matter,
      methodologyStage,
      salesEstimate: salesEstimateFor(row),
      latestIntelligence: latestIntelligence.get(row.id) ?? null,
      focusPersonId: focusPeople.get(row.id) ?? null,
      hypotheses: hypotheses.get(row.id) ?? [],
      interventions: interventionByMatterId.get(row.id) ?? [],
    });
  }

  try {
    return buildMatterPortfolio({
      generatedAtUtc: now.toISOString(),
      canPrepareActionDrafts: scope.actorRole !== 'viewer',
      matters: facts,
    });
  } catch {
    storageInvalid();
  }
}

async function exactPortfolioEntry(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: MatterPortfolioSourceRequest,
  now: Date,
) {
  const portfolio = await buildMatterPortfolioReadModel(db, ctx, policy, now, {
    target: { customerId: input.customerId, matterId: input.matterId },
    providerKey: input.providerKey,
  });
  const entry = portfolio.entries.find((candidate) => (
    candidate.customer.id === input.customerId && candidate.matter.id === input.matterId
  ));
  if (!entry) notFound();
  const allowedRefs = new Set(entry.attentionItems
    .filter((item) => item.providerKey === input.providerKey)
    .flatMap((item) => item.sourceRefs)
    .map(sourceKey));
  if (!allowedRefs.has(sourceKey(input.sourceRef))) sourceChanged();
  return entry;
}

function matterSourceView(
  entry: Awaited<ReturnType<typeof exactPortfolioEntry>>,
  sourceRef: InterventionSourceRef,
): TodaySourceView {
  if (sourceRef.entityKind !== 'matter'
    || sourceRef.entityId !== entry.matter.id
    || sourceRef.version !== entry.matter.version
    || sourceRef.scheduleVersion !== null) sourceChanged();
  return TodaySourceViewSchema.parse({
    sourceRef,
    customerId: entry.customer.id,
    matterId: entry.matter.id,
    label: '当前事项',
    detail: `正式事项版本 ${sourceRef.version}`,
  });
}

export async function matterPortfolioSourceView(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  input: MatterPortfolioSourceRequest,
  now = new Date(),
): Promise<TodaySourceView> {
  const entry = await exactPortfolioEntry(db, ctx, policy, input, now);
  const ref = input.sourceRef;
  if (input.providerKey === 'core.today') {
    const source = await resolveTodaySource({
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      role: ctx.actorRole,
    }, ref, db);
    if (!source || source.customerId !== input.customerId || source.matterId !== input.matterId) sourceChanged();
    return source;
  }
  if (input.providerKey === 'relationship_radar') {
    try {
      return await relationshipRadarSourceView(db, ctx, policy, input, now);
    } catch (error) {
      if (error instanceof RelationshipRadarReadError) {
        if (error.scopedNotFound) notFound();
        sourceChanged();
      }
      throw error;
    }
  }
  if (ref.entityKind === 'matter') return matterSourceView(entry, ref);
  if (input.providerKey === 'matter_portfolio.intelligence') {
    if (ref.entityKind !== 'intelligence_item' || ref.scheduleVersion !== null) sourceChanged();
    const detail = await intelligenceItemDetail(db, ctx, policy, ref.entityId);
    if (!detail) notFound();
    if (detail.item.version !== ref.version
      || detail.item.status !== 'active'
      || detail.item.customerId !== input.customerId
      || detail.item.matterId !== input.matterId) sourceChanged();
    return TodaySourceViewSchema.parse({
      sourceRef: ref,
      customerId: input.customerId,
      matterId: input.matterId,
      label: '人工确认情报',
      detail: `得知于 ${detail.item.learnedAt}`,
    });
  }
  if (input.providerKey === 'matter_portfolio.hypothesis') {
    if (ref.entityKind !== 'sales_hypothesis' || ref.scheduleVersion !== null) sourceChanged();
    const detail = await salesHypothesisDetail(db, ctx, policy, ref.entityId, {
      beforeRevisionNumber: null,
      limit: 1,
    });
    if (!detail) notFound();
    if (detail.item.version !== ref.version
      || detail.item.customerId !== input.customerId
      || detail.item.matterId !== input.matterId) sourceChanged();
    return TodaySourceViewSchema.parse({
      sourceRef: ref,
      customerId: input.customerId,
      matterId: input.matterId,
      label: '当前销售假设',
      detail: detail.item.nextReviewAt
        ? `状态 ${detail.item.status} · 复核于 ${detail.item.nextReviewAt}`
        : `状态 ${detail.item.status}`,
    });
  }
  sourceChanged();
}
