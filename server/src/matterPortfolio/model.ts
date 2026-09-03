import {
  InterventionItemSchema,
  MATTER_PORTFOLIO_BUCKET_ORDER,
  MATTER_PORTFOLIO_RULE_VERSION,
  MatterPortfolioReadModelSchema,
  matterPortfolioItemBucket,
  matterPortfolioManualPriorityRank,
  type CustomerV2,
  type InterventionItem,
  type MatterPortfolioActionDraft,
  type MatterPortfolioAttentionBucket,
  type MatterPortfolioReadModel,
  type MatterPortfolioSalesEstimate,
  type MatterPortfolioStage,
  type MatterV2,
} from '@jianghu/domain-contracts';

const DAY_MS = 86_400_000;
const INTELLIGENCE_STALE_AFTER_MS = 30 * DAY_MS;
const HYPOTHESIS_DUE_WITHIN_MS = 7 * DAY_MS;

export interface MatterPortfolioIntelligenceFact {
  id: string;
  version: number;
  learnedAtUtc: string;
}

export interface MatterPortfolioHypothesisFact {
  id: string;
  version: number;
  status: 'untested' | 'testing' | 'supported' | 'contradicted' | 'retired';
  personId: string | null;
  nextReviewAtUtc: string | null;
}

/** Already-authorized, body-free facts accepted by the deterministic portfolio composer. */
export interface MatterPortfolioMatterFacts {
  customer: CustomerV2;
  matter: MatterV2;
  methodologyStage: MatterPortfolioStage | null;
  salesEstimate: MatterPortfolioSalesEstimate | null;
  latestIntelligence: MatterPortfolioIntelligenceFact | null;
  focusPersonId: string | null;
  hypotheses: readonly MatterPortfolioHypothesisFact[];
  interventions: readonly unknown[];
}

export interface MatterPortfolioBuildInput {
  generatedAtUtc: string;
  canPrepareActionDrafts: boolean;
  matters: readonly MatterPortfolioMatterFacts[];
}

const clip = (value: string, maximum: number): string => (
  value.trim().slice(0, maximum) || '（未命名）'
);

function matterSource(facts: MatterPortfolioMatterFacts) {
  return {
    entityKind: 'matter',
    entityId: facts.matter.id,
    version: facts.matter.version,
    scheduleVersion: null,
  } as const;
}

function matterTarget(facts: MatterPortfolioMatterFacts) {
  return {
    entityKind: 'matter',
    entityId: facts.matter.id,
    customerId: facts.customer.id,
    matterId: facts.matter.id,
    commitmentId: null,
    version: facts.matter.version,
    scheduleVersion: null,
  } as const;
}

function currentContext(facts: MatterPortfolioMatterFacts) {
  return {
    customerName: clip(facts.customer.name, 240),
    matterName: clip(facts.matter.title, 240),
  };
}

function validMillis(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function staleIntelligenceItem(
  facts: MatterPortfolioMatterFacts,
  generatedAtUtc: string,
): InterventionItem | null {
  const latest = facts.latestIntelligence;
  if (!latest) return null;
  const generatedAt = validMillis(generatedAtUtc);
  const learnedAt = validMillis(latest.learnedAtUtc);
  if (generatedAt === null || learnedAt === null || learnedAt > generatedAt
    || generatedAt - learnedAt <= INTELLIGENCE_STALE_AFTER_MS) return null;

  return InterventionItemSchema.parse({
    id: `portfolio:intelligence-stale:${latest.id}:v${latest.version}`,
    section: 'follow_up',
    providerKey: 'matter_portfolio.intelligence',
    title: `更新「${clip(facts.matter.title, 170)}」的当前情报`,
    context: currentContext(facts),
    reasonCode: 'intelligence_freshness.stale',
    explanation: '最近一条当前可读情报已超过 30 天，建议先核对是否仍然有效。',
    sourceRefs: [
      matterSource(facts),
      {
        entityKind: 'intelligence_item',
        entityId: latest.id,
        version: latest.version,
        scheduleVersion: null,
      },
    ],
    observedAtUtc: generatedAtUtc,
    ruleVersion: MATTER_PORTFOLIO_RULE_VERSION,
    time: {
      kind: 'observed',
      atUtc: latest.learnedAtUtc,
      relation: 'missing',
      label: '最近情报已超过 30 天',
    },
    suggestedAction: {
      kind: 'review_intelligence',
      label: '查看情报依据',
      commandType: null,
    },
    target: matterTarget(facts),
  });
}

function hypothesisTime(
  nextReviewAtUtc: string,
  generatedAtUtc: string,
): InterventionItem['time'] {
  const dueAt = Date.parse(nextReviewAtUtc);
  const generatedAt = Date.parse(generatedAtUtc);
  const relation = dueAt < generatedAt
    ? 'overdue'
    : nextReviewAtUtc.slice(0, 10) === generatedAtUtc.slice(0, 10)
      ? 'due'
      : 'upcoming';
  return {
    kind: 'instant',
    atUtc: nextReviewAtUtc,
    timeZone: 'Etc/UTC',
    relation,
    label: relation === 'overdue' ? '复核已逾期' : relation === 'due' ? '今天复核' : '七天内复核',
  };
}

function dueHypothesisItems(
  facts: MatterPortfolioMatterFacts,
  generatedAtUtc: string,
): InterventionItem[] {
  const generatedAt = validMillis(generatedAtUtc);
  if (generatedAt === null) return [];
  return facts.hypotheses.flatMap((hypothesis) => {
    if ((hypothesis.status !== 'untested' && hypothesis.status !== 'testing')
      || hypothesis.nextReviewAtUtc === null
      || (hypothesis.personId !== null && hypothesis.personId !== facts.focusPersonId)) return [];
    const reviewAt = validMillis(hypothesis.nextReviewAtUtc);
    if (reviewAt === null || reviewAt - generatedAt > HYPOTHESIS_DUE_WITHIN_MS) return [];

    return [InterventionItemSchema.parse({
      id: `portfolio:hypothesis-review:${hypothesis.id}:v${hypothesis.version}`,
      section: 'follow_up',
      providerKey: 'matter_portfolio.hypothesis',
      title: `复核「${clip(facts.matter.title, 174)}」的当前假设`,
      context: currentContext(facts),
      reasonCode: 'hypothesis_review.due',
      explanation: '一条当前未验证假设已进入七天复核窗口，建议基于正式证据人工复核。',
      sourceRefs: [
        matterSource(facts),
        {
          entityKind: 'sales_hypothesis',
          entityId: hypothesis.id,
          version: hypothesis.version,
          scheduleVersion: null,
        },
      ],
      observedAtUtc: generatedAtUtc,
      ruleVersion: MATTER_PORTFOLIO_RULE_VERSION,
      time: hypothesisTime(hypothesis.nextReviewAtUtc, generatedAtUtc),
      suggestedAction: {
        kind: 'review_sales_hypothesis',
        label: '查看假设依据',
        commandType: null,
      },
      target: matterTarget(facts),
    })];
  });
}

function currentAuthorizedItems(facts: MatterPortfolioMatterFacts): InterventionItem[] {
  const parsed = facts.interventions.flatMap((candidate) => {
    const result = InterventionItemSchema.safeParse(candidate);
    if (!result.success) return [];
    const item = result.data;
    if (item.target.customerId !== facts.customer.id
      || item.target.matterId !== facts.matter.id
      || matterPortfolioItemBucket(item) === null) return [];
    return [{ ...item, context: currentContext(facts) }];
  });

  const uniqueById = new Map<string, InterventionItem>();
  for (const item of parsed.sort((left, right) => left.id.localeCompare(right.id))) {
    if (!uniqueById.has(item.id)) uniqueById.set(item.id, item);
  }

  const nextStepItems = [...uniqueById.values()].filter((item) => (
    item.reasonCode === 'matter_without_next_commitment'
    || item.reasonCode === 'next_step_completeness.gap'
  ));
  if (nextStepItems.length > 1) {
    nextStepItems.sort((left, right) => (
      Number(right.providerKey === 'core.today') - Number(left.providerKey === 'core.today')
      || left.id.localeCompare(right.id)
    ));
    for (const duplicate of nextStepItems.slice(1)) uniqueById.delete(duplicate.id);
  }
  return [...uniqueById.values()];
}

function sortItems(items: readonly InterventionItem[]): InterventionItem[] {
  const bucketRank = new Map(MATTER_PORTFOLIO_BUCKET_ORDER.map((bucket, index) => [bucket, index]));
  return [...items].sort((left, right) => {
    const leftBucket = matterPortfolioItemBucket(left)!;
    const rightBucket = matterPortfolioItemBucket(right)!;
    return bucketRank.get(leftBucket)! - bucketRank.get(rightBucket)!
      || right.observedAtUtc.localeCompare(left.observedAtUtc)
      || left.id.localeCompare(right.id);
  });
}

function draftFor(item: InterventionItem | undefined): MatterPortfolioActionDraft | null {
  if (!item) return null;
  return {
    state: 'uncommitted',
    sourceItemId: item.id,
    providerKey: item.providerKey,
    target: item.target,
    sourceRefs: item.sourceRefs,
    suggestedAction: item.suggestedAction,
    observedAtUtc: item.observedAtUtc,
    ruleVersion: item.ruleVersion,
  };
}

function emptyPriorityRank(priority: string | null): number {
  const known = matterPortfolioManualPriorityRank(priority);
  if (known !== null) return known;
  return priority === null ? 4 : 3;
}

export function buildMatterPortfolio(input: MatterPortfolioBuildInput): MatterPortfolioReadModel {
  const bucketRank = new Map(MATTER_PORTFOLIO_BUCKET_ORDER.map((bucket, index) => [bucket, index]));
  const entries = input.matters.map((facts) => {
    const items = currentAuthorizedItems(facts);
    const stale = staleIntelligenceItem(facts, input.generatedAtUtc);
    if (stale) items.push(stale);
    items.push(...dueHypothesisItems(facts, input.generatedAtUtc));
    const attentionItems = sortItems(items);
    const firstBucket = attentionItems[0] ? matterPortfolioItemBucket(attentionItems[0]) : null;
    const attentionBucket: MatterPortfolioAttentionBucket = firstBucket
      ?? (matterPortfolioManualPriorityRank(facts.matter.priority) === null ? 'clear' : 'manual');
    return {
      customer: facts.customer,
      matter: facts.matter,
      methodologyStage: facts.methodologyStage,
      salesEstimate: facts.salesEstimate,
      attentionBucket,
      attentionItems,
      actionDraft: input.canPrepareActionDrafts ? draftFor(attentionItems[0]) : null,
    };
  }).sort((left, right) => (
    bucketRank.get(left.attentionBucket)! - bucketRank.get(right.attentionBucket)!
    || (right.attentionItems[0]?.observedAtUtc ?? '').localeCompare(left.attentionItems[0]?.observedAtUtc ?? '')
    || emptyPriorityRank(left.matter.priority) - emptyPriorityRank(right.matter.priority)
    || left.matter.id.localeCompare(right.matter.id)
  ));

  return MatterPortfolioReadModelSchema.parse({
    generatedAtUtc: input.generatedAtUtc,
    ruleVersion: MATTER_PORTFOLIO_RULE_VERSION,
    entries,
  });
}
