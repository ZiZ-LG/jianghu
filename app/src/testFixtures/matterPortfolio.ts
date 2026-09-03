import type { MatterPortfolioReadModel } from '@jianghu/domain-contracts';

const customer = {
  id: 'customer-209',
  name: '远山制造',
  categoryKey: 'enterprise',
  primaryOwnerUserId: 'user-1',
  archivedAt: null,
  version: 2,
};

const matter = {
  id: 'matter-209',
  customerId: customer.id,
  title: '年度框架采购',
  kind: 'sales_opportunity',
  lifecycleStatus: 'active' as const,
  outcomeKey: null,
  priority: 'high',
  targetDate: '2026-10-31',
  primaryOwnerUserId: 'user-1',
  archivedAt: null,
  version: 5,
};

const sourceRef = {
  entityKind: 'matter',
  entityId: matter.id,
  version: matter.version,
  scheduleVersion: null,
};

const target = {
  entityKind: 'matter',
  entityId: matter.id,
  customerId: customer.id,
  matterId: matter.id,
  commitmentId: null,
  version: matter.version,
  scheduleVersion: null,
};

const suggestedAction = {
  kind: 'create_commitment',
  label: '补一个下一步',
  commandType: 'CREATE_COMMITMENT' as const,
};

const intervention = {
  id: 'today:matter-without-next:matter-209:v5',
  section: 'follow_up' as const,
  providerKey: 'core.today',
  title: '补一个明确的下一步',
  context: { customerName: customer.name, matterName: matter.title },
  reasonCode: 'matter_without_next_commitment',
  explanation: '当前事项没有待执行的下一步承诺。',
  sourceRefs: [sourceRef],
  observedAtUtc: '2026-09-02T06:00:00Z',
  ruleVersion: 'core.today.v1',
  time: {
    kind: 'observed' as const,
    atUtc: '2026-09-02T06:00:00Z',
    relation: 'missing' as const,
    label: '缺少下一步',
  },
  suggestedAction,
  target,
};

export const MATTER_PORTFOLIO_FIXTURE: MatterPortfolioReadModel = {
  generatedAtUtc: '2026-09-02T06:00:00Z',
  ruleVersion: 'saas-209.matter-portfolio.v1',
  entries: [{
    customer,
    matter,
    methodologyStage: {
      customerId: customer.id,
      matterId: matter.id,
      bindingId: 'binding-209',
      packId: 'pack-209',
      versionId: 'version-209',
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
    actionDraft: {
      state: 'uncommitted',
      sourceItemId: intervention.id,
      providerKey: intervention.providerKey,
      target,
      sourceRefs: [sourceRef],
      suggestedAction,
      observedAtUtc: intervention.observedAtUtc,
      ruleVersion: intervention.ruleVersion,
    },
  }],
};

export const MATTER_PORTFOLIO_SOURCE_REF = sourceRef;
