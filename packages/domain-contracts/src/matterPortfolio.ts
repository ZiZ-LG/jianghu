import { z } from 'zod';
import {
  CustomerV2Schema,
  LocalDateSchema,
  MatterV2Schema,
  UtcInstantSchema,
} from './crm.js';
import {
  InterventionItemSchema,
  InterventionSourceRefSchema,
  InterventionSuggestedActionSchema,
  InterventionTargetSchema,
} from './interventions.js';

const entityId = z.string().min(1);

export const MATTER_PORTFOLIO_RULE_VERSION = 'saas-209.matter-portfolio.v1';

export const MatterPortfolioAttentionBucketSchema = z.enum([
  'urgent',
  'next_step',
  'relationship',
  'intelligence',
  'hypothesis',
  'manual',
  'clear',
]);

export const MatterPortfolioSourceProviderSchema = z.enum([
  'core.today',
  'relationship_radar',
  'matter_portfolio.intelligence',
  'matter_portfolio.hypothesis',
]);

export const MatterPortfolioStageSchema = z.object({
  customerId: entityId,
  matterId: entityId,
  bindingId: entityId,
  packId: entityId,
  versionId: entityId,
  stageKey: z.string().trim().min(1).max(200),
  stageName: z.string().trim().min(1).max(200),
  updatedAtUtc: UtcInstantSchema,
}).strict();

export const MatterPortfolioSalesEstimateSchema = z.object({
  kind: z.literal('sales_entered_estimate'),
  expectedAmountW: z.number().finite().nonnegative(),
  winProbability: z.number().finite().min(0).max(100),
  expectedSignDate: LocalDateSchema.nullable(),
}).strict();

export const MatterPortfolioActionDraftSchema = z.object({
  state: z.literal('uncommitted'),
  sourceItemId: z.string().min(1),
  providerKey: z.string().trim().min(1).max(80),
  target: InterventionTargetSchema,
  sourceRefs: z.array(InterventionSourceRefSchema).min(1).max(8),
  suggestedAction: InterventionSuggestedActionSchema,
  observedAtUtc: UtcInstantSchema,
  ruleVersion: z.string().trim().min(1).max(80),
}).strict();

export const MATTER_PORTFOLIO_BUCKET_ORDER = [
  'urgent',
  'next_step',
  'relationship',
  'intelligence',
  'hypothesis',
  'manual',
  'clear',
] as const;

const attentionRank = {
  urgent: 0,
  next_step: 1,
  relationship: 2,
  intelligence: 3,
  hypothesis: 4,
} as const;

type ItemBucket = keyof typeof attentionRank;

export function matterPortfolioItemBucket(
  item: z.infer<typeof InterventionItemSchema>,
): ItemBucket | null {
  if (item.section === 'pending_confirmation' || item.time.relation === 'overdue') return 'urgent';
  if (item.reasonCode === 'matter_without_next_commitment'
    || item.reasonCode === 'next_step_completeness.gap') return 'next_step';
  if (item.providerKey === 'relationship_radar') return 'relationship';
  if (item.providerKey === 'matter_portfolio.intelligence') return 'intelligence';
  if (item.providerKey === 'matter_portfolio.hypothesis') return 'hypothesis';
  return null;
}

export function matterPortfolioManualPriorityRank(priority: string | null): number | null {
  if (priority === 'critical' || priority === 'urgent' || priority === 'high') return 0;
  if (priority === 'medium' || priority === 'normal') return 1;
  if (priority === 'low') return 2;
  return null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

export const MatterPortfolioEntrySchema = z.object({
  customer: CustomerV2Schema,
  matter: MatterV2Schema,
  methodologyStage: MatterPortfolioStageSchema.nullable(),
  salesEstimate: MatterPortfolioSalesEstimateSchema.nullable(),
  attentionBucket: MatterPortfolioAttentionBucketSchema,
  attentionItems: z.array(InterventionItemSchema),
  actionDraft: MatterPortfolioActionDraftSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.matter.customerId !== value.customer.id) {
    issue(ctx, ['matter', 'customerId'], 'Portfolio Matter must belong to its Customer');
  }

  if (value.methodologyStage
    && (value.methodologyStage.customerId !== value.customer.id
      || value.methodologyStage.matterId !== value.matter.id)) {
    issue(ctx, ['methodologyStage', 'matterId'], 'Methodology stage must belong to the portfolio Matter');
  }

  if (value.matter.kind === 'sales_opportunity') {
    if (!value.salesEstimate) {
      issue(ctx, ['salesEstimate'], 'Sales opportunity requires its explicit sales-entered estimate');
    }
  } else if (value.salesEstimate) {
    issue(ctx, ['salesEstimate'], 'Generic Matter cannot expose sales estimate fields');
  }

  const seenItems = new Set<string>();
  let previousRank = -1;
  let firstBucket: ItemBucket | null = null;
  value.attentionItems.forEach((item, index) => {
    if (seenItems.has(item.id)) {
      issue(ctx, ['attentionItems', index, 'id'], 'Portfolio intervention ids must be unique');
    }
    seenItems.add(item.id);

    if (!MatterPortfolioSourceProviderSchema.safeParse(item.providerKey).success) {
      issue(ctx, ['attentionItems', index, 'providerKey'], 'Portfolio provider must support current source revalidation');
    }

    if (item.target.customerId !== value.customer.id || item.target.matterId !== value.matter.id) {
      issue(ctx, ['attentionItems', index, 'target'], 'Portfolio item target must belong to the exact Customer and Matter');
    }

    const bucket = matterPortfolioItemBucket(item);
    if (!bucket) {
      issue(ctx, ['attentionItems', index], 'Portfolio item must belong to a supported attention category');
      return;
    }
    if (firstBucket === null) firstBucket = bucket;
    const rank = attentionRank[bucket];
    if (rank < previousRank) {
      issue(ctx, ['attentionItems', index], 'Portfolio attention items must follow categorical priority order');
    }
    previousRank = rank;
  });

  const expectedBucket = firstBucket
    ?? (matterPortfolioManualPriorityRank(value.matter.priority) !== null
      ? 'manual'
      : 'clear');
  if (value.attentionBucket !== expectedBucket) {
    issue(ctx, ['attentionBucket'], 'Portfolio attention bucket must match the first current attention category');
  }

  if (value.actionDraft) {
    const top = value.attentionItems[0];
    if (!top) {
      issue(ctx, ['actionDraft'], 'Action draft requires a current top intervention');
      return;
    }
    const matchesTop = value.actionDraft.sourceItemId === top.id
      && value.actionDraft.providerKey === top.providerKey
      && value.actionDraft.observedAtUtc === top.observedAtUtc
      && value.actionDraft.ruleVersion === top.ruleVersion
      && sameValue(value.actionDraft.target, top.target)
      && sameValue(value.actionDraft.sourceRefs, top.sourceRefs)
      && sameValue(value.actionDraft.suggestedAction, top.suggestedAction);
    if (!matchesTop) {
      issue(ctx, ['actionDraft'], 'Action draft must preserve the exact top intervention revision');
    }
  }
});

export const MatterPortfolioReadModelSchema = z.object({
  generatedAtUtc: UtcInstantSchema,
  ruleVersion: z.literal(MATTER_PORTFOLIO_RULE_VERSION),
  entries: z.array(MatterPortfolioEntrySchema),
}).strict().superRefine((value, ctx) => {
  const matterIds = new Set<string>();
  const itemIds = new Set<string>();
  value.entries.forEach((entry, entryIndex) => {
    if (matterIds.has(entry.matter.id)) {
      issue(ctx, ['entries', entryIndex, 'matter', 'id'], 'Portfolio Matter ids must be unique');
    }
    matterIds.add(entry.matter.id);

    entry.attentionItems.forEach((item, itemIndex) => {
      if (itemIds.has(item.id)) {
        issue(ctx, ['entries', entryIndex, 'attentionItems', itemIndex, 'id'], 'Portfolio intervention ids must be globally unique');
      }
      itemIds.add(item.id);
    });
  });
});

export const MatterPortfolioSourceRequestSchema = z.object({
  providerKey: MatterPortfolioSourceProviderSchema,
  customerId: entityId,
  matterId: entityId,
  sourceRef: InterventionSourceRefSchema,
}).strict();

export type MatterPortfolioAttentionBucket = z.infer<typeof MatterPortfolioAttentionBucketSchema>;
export type MatterPortfolioStage = z.infer<typeof MatterPortfolioStageSchema>;
export type MatterPortfolioSalesEstimate = z.infer<typeof MatterPortfolioSalesEstimateSchema>;
export type MatterPortfolioActionDraft = z.infer<typeof MatterPortfolioActionDraftSchema>;
export type MatterPortfolioEntry = z.infer<typeof MatterPortfolioEntrySchema>;
export type MatterPortfolioReadModel = z.infer<typeof MatterPortfolioReadModelSchema>;
export type MatterPortfolioSourceProvider = z.infer<typeof MatterPortfolioSourceProviderSchema>;
export type MatterPortfolioSourceRequest = z.infer<typeof MatterPortfolioSourceRequestSchema>;
