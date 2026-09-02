import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const runtimeSchema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const customer = {
  id: 'customer-1',
  name: '远山制造',
  categoryKey: 'enterprise',
  primaryOwnerUserId: 'user-1',
  archivedAt: null,
  version: 3,
};

const matter = {
  id: 'matter-1',
  customerId: customer.id,
  title: '年度框架采购',
  kind: 'sales_opportunity',
  lifecycleStatus: 'active',
  outcomeKey: null,
  priority: 'high',
  targetDate: '2026-10-31',
  primaryOwnerUserId: 'user-1',
  archivedAt: null,
  version: 5,
};

const intervention = {
  id: 'today:matter_without_next_commitment:matter-1:v5',
  section: 'follow_up',
  providerKey: 'core.today',
  title: '补一个明确的下一步',
  context: { customerName: customer.name, matterName: matter.title },
  reasonCode: 'matter_without_next_commitment',
  explanation: '当前事项没有待执行的下一步承诺。',
  sourceRefs: [{
    entityKind: 'matter',
    entityId: matter.id,
    version: matter.version,
    scheduleVersion: null,
  }],
  observedAtUtc: '2026-09-02T06:00:00Z',
  ruleVersion: 'core.today.v1',
  time: {
    kind: 'observed',
    atUtc: '2026-09-02T06:00:00Z',
    relation: 'missing',
    label: '缺少下一步',
  },
  suggestedAction: {
    kind: 'create_commitment',
    label: '补一个下一步',
    commandType: 'CREATE_COMMITMENT',
  },
  target: {
    entityKind: 'matter',
    entityId: matter.id,
    customerId: customer.id,
    matterId: matter.id,
    commitmentId: null,
    version: matter.version,
    scheduleVersion: null,
  },
};

const draft = {
  state: 'uncommitted',
  sourceItemId: intervention.id,
  providerKey: intervention.providerKey,
  target: intervention.target,
  sourceRefs: intervention.sourceRefs,
  suggestedAction: intervention.suggestedAction,
  observedAtUtc: intervention.observedAtUtc,
  ruleVersion: intervention.ruleVersion,
};

const entry = {
  customer,
  matter,
  methodologyStage: {
    customerId: customer.id,
    matterId: matter.id,
    bindingId: 'binding-1',
    packId: 'pack-1',
    versionId: 'pack-version-1',
    stageKey: 'discovery',
    stageName: '需求澄清',
    updatedAtUtc: '2026-09-01T08:00:00Z',
  },
  salesEstimate: {
    kind: 'sales_entered_estimate',
    expectedAmountW: 300,
    winProbability: 55,
    expectedSignDate: '2026-10-31',
  },
  attentionBucket: 'next_step',
  attentionItems: [intervention],
  actionDraft: draft,
};

const readModel = {
  generatedAtUtc: '2026-09-02T06:00:00Z',
  ruleVersion: 'saas-209.matter-portfolio.v1',
  entries: [entry],
};

describe('SAAS-209 Matter portfolio contract', () => {
  it('publishes strict anchors, current methodology stage, sales estimate, attention and draft contracts', () => {
    const readModelSchema = runtimeSchema('MatterPortfolioReadModelSchema');
    const sourceRequestSchema = runtimeSchema('MatterPortfolioSourceRequestSchema');

    expect(readModelSchema, 'MatterPortfolioReadModelSchema must be exported').toBeDefined();
    expect(sourceRequestSchema, 'MatterPortfolioSourceRequestSchema must be exported').toBeDefined();
    expect(readModelSchema!.safeParse(readModel).success).toBe(true);
    expect(sourceRequestSchema!.safeParse({
      providerKey: intervention.providerKey,
      customerId: customer.id,
      matterId: matter.id,
      sourceRef: intervention.sourceRefs[0],
    }).success).toBe(true);
  });

  it('keeps methodology stage nullable and rejects legacy or aggregate-score extras', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, methodologyStage: null }],
    }).success).toBe(true);
    expect(schema!.safeParse({
      ...readModel,
      aggregateScore: 87,
    }).success).toBe(false);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, pipelineStage: '合同谈判' }],
    }).success).toBe(false);
  });

  it('allows estimates only for sales opportunities and bounds explicit sales inputs', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        matter: { ...matter, kind: 'customer_success' },
        salesEstimate: null,
      }],
    }).success).toBe(true);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        matter: { ...matter, kind: 'customer_success' },
      }],
    }).success).toBe(false);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        salesEstimate: { ...entry.salesEstimate, winProbability: 101 },
      }],
    }).success).toBe(false);

    const unavailable = {
      kind: 'sales_estimate_unavailable',
      reason: 'invalid_stored_values',
    };
    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, salesEstimate: unavailable }],
    }).success).toBe(true);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        matter: { ...matter, kind: 'customer_success' },
        salesEstimate: unavailable,
      }],
    }).success).toBe(false);
  });

  it('rejects broken parent closure, duplicate identities and item-target drift', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, matter: { ...matter, customerId: 'customer-2' } }],
    }).success).toBe(false);
    expect(schema!.safeParse({
      ...readModel,
      entries: [entry, entry],
    }).success).toBe(false);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        attentionItems: [{
          ...intervention,
          target: { ...intervention.target, matterId: 'matter-2' },
        }],
      }],
    }).success).toBe(false);
  });

  it('requires an uncommitted draft to preserve the exact top item revision', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, actionDraft: { ...draft, state: 'committed' } }],
    }).success).toBe(false);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, actionDraft: { ...draft, sourceItemId: 'another-item' } }],
    }).success).toBe(false);
    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, actionDraft: { ...draft, ruleVersion: 'stale-rule' } }],
    }).success).toBe(false);
  });

  it('rejects an attention provider that cannot be revalidated by the source drill', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        attentionItems: [{ ...intervention, providerKey: 'untrusted.provider' }],
        actionDraft: null,
      }],
    }).success).toBe(false);
  });

  it('rejects impossible attention buckets and item ordering', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    expect(schema!.safeParse({
      ...readModel,
      entries: [{ ...entry, attentionBucket: 'clear' }],
    }).success).toBe(false);

    const urgent = {
      ...intervention,
      id: 'today:overdue:commitment-1:v1:s1',
      section: 'follow_up',
      reasonCode: 'commitment_due',
      time: {
        kind: 'instant',
        atUtc: '2026-09-01T06:00:00Z',
        timeZone: 'Asia/Shanghai',
        relation: 'overdue',
        label: '已逾期',
      },
      sourceRefs: [{
        entityKind: 'commitment',
        entityId: 'commitment-1',
        version: 1,
        scheduleVersion: 1,
      }],
      suggestedAction: {
        kind: 'reschedule_commitment',
        label: '调整时间',
        commandType: 'RESCHEDULE_COMMITMENT',
      },
      target: {
        entityKind: 'commitment',
        entityId: 'commitment-1',
        customerId: customer.id,
        matterId: matter.id,
        commitmentId: 'commitment-1',
        version: 1,
        scheduleVersion: 1,
      },
    };
    expect(schema!.safeParse({
      ...readModel,
      entries: [{
        ...entry,
        attentionBucket: 'urgent',
        attentionItems: [intervention, urgent],
        actionDraft: null,
      }],
    }).success).toBe(false);
  });

  it('does not turn the 4-5 Matter fixture into a response cap', () => {
    const schema = runtimeSchema('MatterPortfolioReadModelSchema');
    expect(schema).toBeDefined();

    const entries = Array.from({ length: 6 }, (_, index) => ({
      ...entry,
      customer: { ...customer, id: `customer-${index + 1}` },
      matter: {
        ...matter,
        id: `matter-${index + 1}`,
        customerId: `customer-${index + 1}`,
        kind: 'customer_success',
        priority: null,
      },
      methodologyStage: null,
      salesEstimate: null,
      attentionBucket: 'clear',
      attentionItems: [],
      actionDraft: null,
    }));
    expect(schema!.safeParse({ ...readModel, entries }).success).toBe(true);
  });
});
