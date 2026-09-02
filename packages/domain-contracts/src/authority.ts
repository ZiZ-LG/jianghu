import { z } from 'zod';

const nonBlank = z.string().trim().min(1);
const authoritySource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), path: z.null() }).strict(),
  z.object({
    kind: z.enum(['core_path', 'methodology_value', 'legacy_path']),
    path: nonBlank,
  }).strict(),
]);

const consumerInventory = z.object({
  reads: z.array(nonBlank),
  writes: z.array(nonBlank),
  adapters: z.array(nonBlank),
  migrations: z.array(nonBlank),
  planned: z.array(nonBlank),
}).strict().superRefine((value, ctx) => {
  const all = [...value.reads, ...value.writes, ...value.adapters, ...value.migrations, ...value.planned];
  if (all.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'authority entry requires at least one classified consumer' });
  }
  if (new Set(all).size !== all.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'consumer must appear in exactly one classification' });
  }
});

export const CrmAuthorityEntrySchema = z.object({
  logicalField: nonBlank,
  currentAuthority: authoritySource,
  targetAuthority: authoritySource,
  consumers: consumerInventory,
  shadowComparison: nonBlank,
  cutoverCondition: nonBlank,
  stopCondition: nonBlank,
  removalPhase: nonBlank,
  forbidden: z.array(nonBlank).min(1),
}).strict();

export const CrmAuthorityMapSchema = z.array(CrmAuthorityEntrySchema).min(1).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.logicalField)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'logicalField'],
        message: `duplicate logical field: ${entry.logicalField}`,
      });
    }
    seen.add(entry.logicalField);
  });
});

export type CrmAuthorityEntry = z.infer<typeof CrmAuthorityEntrySchema>;

export const CRM_FIELD_AUTHORITY: CrmAuthorityEntry[] = CrmAuthorityMapSchema.parse([
  {
    logicalField: 'customer.category',
    currentAuthority: { kind: 'core_path', path: 'Customer.categoryKey' },
    targetAuthority: { kind: 'core_path', path: 'Customer.categoryKey' },
    consumers: {
      reads: [
        'app/src/components/CrmContextPages.tsx', 'app/src/lib/crmContext.ts',
        'server/src/crmContext.ts', 'server/src/matterPortfolio/service.ts',
      ],
      writes: ['app/src/lib/quickCapture.ts', 'server/src/mutation/customers.ts'],
      adapters: [
        'app/src/aiContext.ts', 'app/src/api.ts', 'app/src/components/CustomerHub.tsx',
        'app/src/components/MdDocPanel.tsx', 'app/src/components/MdDocView.tsx',
        'app/src/components/NewOpportunityDialog.tsx', 'app/src/components/RepairPanel.tsx',
        'app/src/lib/mdProfile.ts', 'app/src/store.ts',
        'server/src/ai.ts', 'server/src/mcp/syncBundle.ts', 'server/src/mcpServer.ts',
        'server/src/mutation/reviewedFields.ts', 'server/src/opp.ts',
        'server/src/postMeeting/commit.ts', 'server/src/postMeeting/extractor.ts',
        'server/src/postMeeting/handler.ts', 'server/src/postMeeting/review.ts',
        'server/src/postMeeting/source.ts', 'server/src/repair.ts',
        'server/src/salesClassification.ts', 'server/src/state.ts',
        'app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/voice.ts',
        'app/src/types.ts', 'packages/domain-contracts/src/actions.ts',
        'packages/domain-contracts/src/crm.ts', 'packages/domain-contracts/src/postMeeting.ts',
      ],
      migrations: [
        'app/src/data/seed.ts', 'server/scripts/migrate-adurc-v1.1.ts', 'server/src/seed-demo.ts',
        'server/scripts/postgres-customer-schema-state.ts',
        'server/scripts/render-pre-customer-schema.ts', 'server/scripts/upgrade-sqlite-schema.ts',
      ],
      planned: [],
    },
    shadowComparison: 'No generic shadow comparison or fallback exists; explicit sales adapters may continue to consume preserved 1..4 values.',
    cutoverCondition: 'Customer.categoryKey is the sole generic authority and unclassified Customers remain explicitly null.',
    stopCondition: 'Only the classified explicit sales adapters may read or write Account.customerType.',
    removalPhase: 'G7 after sales-adapter consumer count reaches zero',
    forbidden: [
      'Requiring 1..4 in a generic Customer command',
      'Falling back to customerType when categoryKey is empty',
      'Executing migrate-adurc-v1.1.ts without a tenant-scoped rewrite and explicit migration approval',
    ],
  },
  {
    logicalField: 'matter.lifecycle',
    currentAuthority: { kind: 'legacy_path', path: 'Opportunity.status' },
    targetAuthority: { kind: 'core_path', path: 'Matter.lifecycleStatus + Matter.outcomeKey' },
    consumers: {
      reads: [
        'app/src/api.ts', 'app/src/components/OpportunityForm.tsx', 'app/src/lib/mdProfile.ts',
        'app/src/lib/pde/adapter.ts', 'app/src/store.ts', 'server/src/ai.ts',
        'server/src/jobs.ts', 'server/src/mcpServer.ts',
        'server/src/opp.ts', 'server/src/pde/assemble.ts', 'server/src/state.ts',
        'server/src/strategy.ts',
      ],
      writes: [
        'app/src/wireAction.ts', 'server/src/mcp/syncBundle.ts', 'server/src/mutate.ts',
        'server/src/repair.ts', 'server/src/voice.ts',
      ],
      adapters: [
        'app/src/types.ts', 'packages/domain-contracts/src/actions.ts', 'server/src/matter/lifecycle.ts',
      ],
      migrations: [
        'app/src/data/seed.ts',
        'server/prisma/postgres/migrations/20260821000000_expand_matter_fields/migration.sql',
        'server/scripts/migrate-matter-fields.ts', 'server/scripts/upgrade-sqlite-schema.ts',
        'server/src/matter/migration.ts', 'server/src/seed-demo.ts',
      ],
      planned: ['CORE-501 Opportunity.status consumer cutover'],
    },
    shadowComparison: 'Compare active/paused/won/lost mapping with lifecycleStatus/outcomeKey for every migrated Matter.',
    cutoverCondition: 'Lifecycle migration, reopen audit, SQLite/PostgreSQL parity, and consumer inventory all pass.',
    stopCondition: 'New generic writes update only lifecycleStatus/outcomeKey through the explicit lifecycle command path.',
    removalPhase: 'G7 after legacy Opportunity status consumers are adapter-only',
    forbidden: ['Treating won or lost as a generic lifecycle status', 'Fallback reads between status and lifecycleStatus'],
  },
  {
    logicalField: 'matter.owner',
    currentAuthority: { kind: 'core_path', path: 'Matter.primaryOwnerUserId' },
    targetAuthority: { kind: 'core_path', path: 'Matter.primaryOwnerUserId' },
    consumers: {
      reads: ['server/src/matter/ownership.ts', 'server/src/state.ts'],
      writes: ['server/src/mutation/matterOwnership.ts'],
      adapters: ['app/src/types.ts', 'packages/domain-contracts/src/crm.ts', 'server/src/types.ts'],
      migrations: [
        'server/prisma/postgres/migrations/20260821000000_expand_matter_fields/migration.sql',
        'server/scripts/report-matter-owner-suggestions.ts',
      ],
      planned: [],
    },
    shadowComparison: 'Account.primaryOwnerUserId is reported only as an administrator-reviewed suggestion; names are never mapped to Matter ownership.',
    cutoverCondition: 'Dry-run queue, tenant-local User.id validation, transfer CAS, audit, and immediate revocation of the old owner transfer-command permission all pass.',
    stopCondition: 'Every Matter owner write uses the transfer command; legacy Account-based read scope remains explicit until CORE-109.',
    removalPhase: 'No legacy owner field removal; CORE-109 may switch only the scope policy after a separate migration gate.',
    forbidden: [
      'Automatically copying Account owner into Matter owner',
      'Deriving Matter ownership from name, region, or OpportunityMember',
      'Fallback reads from Account owner when Matter owner is null',
    ],
  },
  {
    logicalField: 'tenant.data_scope',
    currentAuthority: { kind: 'core_path', path: 'Tenant.dataScopePolicy + EffectiveResourceScope' },
    targetAuthority: { kind: 'core_path', path: 'Tenant.dataScopePolicy + EffectiveResourceScope' },
    consumers: {
      reads: [
        'server/src/resourceScope.ts', 'server/src/state.ts', 'server/src/ai.ts',
        'server/src/matterPortfolio/service.ts',
        'server/src/strategy.ts', 'server/src/advisor.ts', 'server/src/pde/assemble.ts',
        'server/src/pde/routes.ts', 'server/src/mcpServer.ts', 'server/src/personMerge.ts',
        'server/src/suggest.ts', 'server/src/curated.ts', 'server/src/recording.ts',
        'server/src/jobs.ts', 'server/src/repair.ts',
      ],
      writes: [],
      adapters: ['packages/domain-contracts/src/capabilities.ts', 'server/src/scope.ts'],
      migrations: [
        'server/prisma/postgres/migrations/20260821040000_add_tenant_data_scope_policy/migration.sql',
        'server/scripts/deploy-postgres-migrations.sh',
      ],
      planned: [],
    },
    shadowComparison: 'legacy_tenant_shared must preserve owner/admin/member tenant-wide reads and viewer owner scope; scoped fixtures compare state, ID, AI, PDE, MCP, Inbox, curated, transcript, job, and repair results against one EffectiveResourceScope.',
    cutoverCondition: 'Every named online consumer resolves current tenant policy and current database role before business reads, cross-entry parity and both database migrations pass, and tenant activation remains an explicit separately approved operation.',
    stopCondition: 'No read surface derives authorization from JWT role, display name, region, OpportunityMember, or an ad-hoc Account query; partial Customer containers expose only id/name/categoryKey/customerType/version.',
    removalPhase: 'Permanent G2 authority; future Team/Grant and sensitive-content ACL may only intersect this scope and never replace tenant isolation.',
    forbidden: [
      'Falling back to tenant-wide access for an unknown policy, invalid role, or missing actor',
      'Automatically switching an existing tenant from legacy_tenant_shared to scoped',
      'Loading a full Customer graph before the effective scope check',
      'Reverting scoped tenants to pre-CORE-109 code or policy in a way that broadens access',
    ],
  },
  {
    logicalField: 'matter.current_stage',
    currentAuthority: { kind: 'legacy_path', path: 'Opportunity.pipelineStage' },
    targetAuthority: { kind: 'methodology_value', path: 'MethodologyStageState' },
    consumers: {
      reads: [
        'app/src/aiContext.ts', 'app/src/api.ts', 'app/src/components/MdDocPanel.tsx',
        'app/src/components/MdDocView.tsx', 'app/src/components/OpportunityForm.tsx',
        'app/src/lib/mdProfile.ts', 'app/src/lib/pde/adapter.ts', 'app/src/store.ts',
        'server/src/ai.ts', 'server/src/mcp/syncBundle.ts', 'server/src/mcpServer.ts',
        'server/src/opp.ts', 'server/src/repair.ts', 'server/src/state.ts',
        'server/src/matterPortfolio/service.ts',
      ],
      writes: ['app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/voice.ts'],
      adapters: ['app/src/types.ts', 'packages/domain-contracts/src/actions.ts'],
      migrations: ['app/src/data/seed.ts', 'server/src/seed-demo.ts'],
      planned: ['CORE-501 pipelineStage consumer cutover'],
    },
    shadowComparison: 'For bound sales Matters, compare the declared legacy storage binding with MethodologyStageState.',
    cutoverCondition: 'G64111 binding parity passes and unbound Matters render an explicit unconfigured stage.',
    stopCondition: 'Portfolio, generic UI, and AI context no longer read Opportunity.pipelineStage.',
    removalPhase: 'G7 after all stage consumers use methodology bindings',
    forbidden: ['Fallback reads between pipelineStage, OppStage, and MethodologyStageState'],
  },
  {
    logicalField: 'g64111.engage_stage',
    currentAuthority: { kind: 'legacy_path', path: 'Opportunity.engageStage' },
    targetAuthority: { kind: 'methodology_value', path: 'MethodologyValue(g64111.engage_stage)' },
    consumers: {
      reads: [
        'app/src/aiContext.ts', 'app/src/components/GapCards.tsx', 'app/src/components/MdDocView.tsx',
        'app/src/lib/gaps.ts', 'app/src/lib/mdProfile.ts', 'app/src/store.ts',
        'server/src/ai.ts', 'server/src/mcp/syncBundle.ts', 'server/src/mcpServer.ts',
        'server/src/opp.ts', 'server/src/repair.ts',
        'server/src/state.ts', 'server/src/wecom.ts',
      ],
      writes: ['app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/voice.ts'],
      adapters: [
        'app/src/lib/g64111.ts', 'app/src/types.ts', 'packages/domain-contracts/src/actions.ts',
        'packages/g64111/src/score.ts', 'packages/g64111/src/types.ts',
        'server/src/g64111.ts',
      ],
      migrations: ['app/src/data/seed.ts', 'server/src/seed-demo.ts'],
      planned: ['CORE-501 engageStage consumer cutover'],
    },
    shadowComparison: 'The G64111 adapter compares legacy engageStage with the bound methodology value and fails on divergence.',
    cutoverCondition: 'G64111 fixtures and server parity pass using the adapter-owned value.',
    stopCondition: 'Only the G64111 adapter may read the legacy engageStage field; new writes target the binding value.',
    removalPhase: 'G7 after the G64111 legacy binding consumer list is empty',
    forbidden: ['Importing engageStage into generic Matter', 'Letting PDE continue to read the G64111 value'],
  },
  {
    logicalField: 'pde.decision_stage',
    currentAuthority: { kind: 'core_path', path: 'PdeDecisionContext.stageKey' },
    targetAuthority: { kind: 'core_path', path: 'PdeDecisionContext.stageKey' },
    consumers: {
      reads: ['server/src/pde/assemble.ts'],
      writes: [
        'server/src/mcp/syncBundle.ts', 'server/src/mutate.ts', 'server/src/opp.ts',
        'server/src/pde/routes.ts', 'server/src/seed-demo.ts',
      ],
      adapters: ['server/src/pde/context.ts'],
      migrations: [
        'server/prisma/postgres/migrations/20260821070000_add_pde_decision_context/migration.sql',
        'server/scripts/migrate-pde-decision-context.ts', 'server/scripts/upgrade-sqlite-schema.ts',
        'server/src/pde/decisionContextMigration.ts',
      ],
      planned: [],
    },
    shadowComparison: 'Legacy values were mapped into an explicit context once; migration parity conflicts fail closed and runtime never falls back to the legacy input.',
    cutoverCondition: 'CORE-113 context migration, cross-database recovery, kernel golden/property tests, snapshot replay, and authority consumer checks pass.',
    stopCondition: 'PDE assemblers read only PdeDecisionContext.stageKey and decisionProfileRef; a visible Matter without context returns pde_context_uninitialized.',
    removalPhase: 'CORE-113 cutover complete; G7 may retire legacy shadow migration code after the recovery horizon',
    forbidden: ['Deriving PDE stage from MethodologyValue', 'Reading engageStage after cutover'],
  },
  {
    logicalField: 'g64111.primary_d',
    currentAuthority: { kind: 'legacy_path', path: 'Opportunity.primaryDPersonId' },
    targetAuthority: { kind: 'methodology_value', path: 'MethodologyRoleAssignment(g64111:D)' },
    consumers: {
      reads: [
        'app/src/aiContext.ts', 'app/src/components/DetailDrawer.tsx', 'app/src/components/FocusPanel.tsx',
        'app/src/components/Sidebar.tsx', 'app/src/lib/gaps.ts', 'app/src/store.ts',
        'server/src/ai.ts', 'server/src/mcpServer.ts', 'server/src/pde/assemble.ts',
        'server/src/state.ts', 'server/src/wecom.ts',
      ],
      writes: ['app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/personMerge.ts'],
      adapters: [
        'app/src/types.ts', 'packages/domain-contracts/src/actions.ts',
        'packages/g64111/src/score.ts', 'packages/g64111/src/types.ts',
      ],
      migrations: [],
      planned: ['CORE-501 primaryD consumer cutover'],
    },
    shadowComparison: 'The G64111 adapter compares the legacy primary D with the bound role assignment.',
    cutoverCondition: 'Role-assignment parity and G64111 scoring fixtures pass without generic Focus consumers.',
    stopCondition: 'Only the G64111 adapter reads primaryDPersonId.',
    removalPhase: 'G7 after all non-adapter primaryD consumers are removed',
    forbidden: ['Using primaryDPersonId as generic StakeholderFocus', 'Deleting Focus when G64111 is disabled'],
  },
  {
    logicalField: 'stakeholder.focus',
    currentAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
    targetAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
    consumers: {
      reads: [
        'app/src/components/RelationshipWorkspacePanel.tsx',
        'server/src/intelligenceFocus/routes.ts',
        'server/src/matterPortfolio/service.ts',
        'server/src/relationshipWorkspace/model.ts',
      ],
      writes: ['server/src/intelligenceFocus/service.ts'],
      adapters: [
        'packages/domain-contracts/src/intelligence.ts',
        'packages/domain-contracts/src/relationshipWorkspace.ts',
      ],
      migrations: [
        'server/prisma/postgres/migrations/20260827000000_expand_intelligence_focus/migration.sql',
        'server/src/intelligenceFocus/migration.ts',
        'server/scripts/migrate-intelligence-focus.ts',
        'server/scripts/postgres-intelligence-focus-schema-state.ts',
        'server/scripts/upgrade-sqlite-schema.ts',
      ],
      planned: [],
    },
    shadowComparison: 'No legacy value is promoted; any G64111 comparison is advisory and never copied automatically.',
    cutoverCondition: 'SAAS-206 commands, evidence reasons, permissions, user confirmation, exact-version replay, and dual-database migration tests pass.',
    stopCondition: 'Generic focus consumers never read primaryDPersonId or a methodology role as fallback.',
    removalPhase: 'No legacy removal; introduced in G4',
    forbidden: [
      'Creating Focus automatically from a score',
      'Binding Focus lifetime to a methodology pack',
      'Reading Opportunity.primaryDPersonId as StakeholderFocus authority or fallback',
    ],
  },
  {
    logicalField: 'relationship.workspace_projection',
    currentAuthority: { kind: 'none', path: null },
    targetAuthority: { kind: 'none', path: null },
    consumers: {
      reads: [
        'app/src/components/CrmRelationshipGraph.tsx',
        'app/src/components/RelationshipWorkspacePanel.tsx',
        'server/src/relationshipWorkspace/routes.ts',
      ],
      writes: [],
      adapters: [
        'app/src/api.ts',
        'app/src/lib/relationshipWorkspace.ts',
        'packages/domain-contracts/src/relationshipWorkspace.ts',
        'server/src/relationshipWorkspace/model.ts',
        'server/src/relationshipWorkspace/service.ts',
      ],
      migrations: [],
      planned: [],
    },
    shadowComparison: 'Read-only composition preserves Candidate and IntelligenceItem as their existing authorities and adds no shadow field, score, or write path.',
    cutoverCondition: 'Exact Customer/Matter closure, current scope, sensitive candidate ACL, strict response parsing, and viewer projection tests pass.',
    stopCondition: 'The workspace only composes authorized projections and every formal mutation continues through its existing command authority.',
    removalPhase: 'No storage authority or removal; introduced as a G4 read model in SAAS-208.',
    forbidden: [
      'Accepting a Candidate merely because it was read or displayed',
      'Writing a formal Relation, Focus, stage, forecast, or key-person state from a projection',
      'Creating a relationship score or InterventionItem in SAAS-208',
    ],
  },
  {
    logicalField: 'matter.portfolio_projection',
    currentAuthority: { kind: 'none', path: null },
    targetAuthority: { kind: 'none', path: null },
    consumers: {
      reads: [
        'app/src/components/MatterPortfolioPanel.tsx',
        'server/src/matterPortfolio/routes.ts',
      ],
      writes: [],
      adapters: [
        'app/src/api.ts',
        'app/src/lib/matterPortfolio.ts',
        'packages/domain-contracts/src/matterPortfolio.ts',
        'server/src/matterPortfolio/model.ts',
        'server/src/matterPortfolio/service.ts',
      ],
      migrations: [],
      planned: [],
    },
    shadowComparison: 'The portfolio is a transient read composition and creates no score, snapshot, shadow field, action write, or alternate authority.',
    cutoverCondition: 'Current role, tenant scope, exact source revision, active methodology binding, body-free projection, viewer and zero-write tests pass.',
    stopCondition: 'Every row is rebuilt from current formal authorities; missing or revoked sources only remove attention and drafts remain uncommitted.',
    removalPhase: 'No stored authority or migration; introduced as a G4 read model in SAAS-209.',
    forbidden: [
      'Persisting an aggregate portfolio score or snapshot',
      'Treating a draft or AI output as formal Commitment, Focus, Hypothesis, stage, forecast, Relation, or key-person state',
      'Reading pipelineStage, engageStage, primaryDPersonId, ADURC, or a G64111 score as a generic portfolio fallback',
    ],
  },
  {
    logicalField: 'sales.hypothesis',
    currentAuthority: {
      kind: 'core_path',
      path: 'SalesHypothesis + SalesHypothesisRevision + HypothesisEvidenceLink',
    },
    targetAuthority: {
      kind: 'core_path',
      path: 'SalesHypothesis + SalesHypothesisRevision + HypothesisEvidenceLink',
    },
    consumers: {
      reads: [
        'app/src/components/RelationshipWorkspacePanel.tsx',
        'server/src/hypotheses/routes.ts',
        'server/src/matterPortfolio/service.ts',
        'server/src/relationshipWorkspace/model.ts',
        'server/src/relationshipWorkspace/routes.ts',
      ],
      writes: ['server/src/hypotheses/service.ts', 'server/src/relationshipWorkspace/service.ts'],
      adapters: [
        'app/src/api.ts',
        'app/src/lib/relationshipWorkspace.ts',
        'packages/domain-contracts/src/hypotheses.ts',
        'packages/domain-contracts/src/relationshipWorkspace.ts',
        'server/src/hypotheses/model.ts',
        'server/src/mutate.ts',
        'server/src/mutation/actionScope.ts',
        'server/src/candidates/reviewItems.ts',
      ],
      migrations: [
        'server/prisma/postgres/legacy/20260830_pre_saas207.prisma',
        'server/prisma/postgres/migrations/20260830000000_expand_sales_hypothesis/migration.sql',
        'server/prisma/postgres/legacy/20260831_pre_saas208.prisma',
        'server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql',
        'server/scripts/deploy-postgres-migrations.sh',
        'server/scripts/migrate-hypothesis-commitment-review.ts',
        'server/scripts/migrate-sales-hypotheses.ts',
        'server/scripts/postgres-hypothesis-commitment-review-schema-state.ts',
        'server/scripts/postgres-sales-hypothesis-schema-state.ts',
        'server/scripts/upgrade-sqlite-schema.ts',
        'server/src/hypotheses/migration.ts',
        'server/src/seed-demo.ts',
      ],
      planned: [
        'SAAS-212 relationship radar',
      ],
    },
    shadowComparison: 'Manual legacy StrategyRisk assumptions are migrated once with exact tenant, parent, identity, status, and first-revision parity; runtime never dual-reads or falls back.',
    cutoverCondition: 'Dedicated commands, immutable history and evidence links, deterministic read-only status suggestions, current-role scope checks, dual-database migration, and recovery tests pass.',
    stopCondition: 'All new hypothesis writes use SalesHypothesis commands; StrategyRisk assumptions are frozen while StrategyRisk risks retain their existing behavior.',
    removalPhase: 'Legacy assumption rows remain rollback history through G7; no destructive removal is part of SAAS-207.',
    forbidden: [
      'Automatically applying any AI, Agent, methodology, or evidence-based status suggestion to the formal hypothesis status',
      'Updating or deleting a SalesHypothesisRevision or HypothesisEvidenceLink after creation',
      'Falling back to StrategyRisk(kind=assumption) or dual-writing canonical and legacy hypothesis records',
    ],
  },
  {
    logicalField: 'sales.forecast',
    currentAuthority: { kind: 'legacy_path', path: 'Opportunity.expectedAmountW + winProbability + expectedSignDate' },
    targetAuthority: { kind: 'core_path', path: 'ForecastEntry' },
    consumers: {
      reads: [
        'app/src/aiContext.ts', 'app/src/api.ts', 'app/src/components/DeliberationDock.tsx',
        'app/src/components/OpportunityForm.tsx', 'app/src/lib/mdProfile.ts',
        'app/src/lib/pde/adapter.ts', 'server/src/ai.ts', 'server/src/mcp/syncBundle.ts',
        'server/src/mcpServer.ts', 'server/src/pde/assemble.ts', 'server/src/repair.ts',
        'server/src/state.ts', 'server/src/strategy.ts',
        'server/src/matterPortfolio/service.ts',
      ],
      writes: ['app/src/wireAction.ts', 'server/src/mutate.ts'],
      adapters: ['app/src/types.ts', 'packages/domain-contracts/src/actions.ts'],
      migrations: ['server/src/seed-demo.ts'],
      planned: ['SAAS-302 ForecastEntry migration candidates'],
    },
    shadowComparison: 'Create reviewable migration candidates and compare amount/date/category without treating probability as commitment.',
    cutoverCondition: 'User-confirmed currency, period, category, and amount exist and forecast snapshot replay passes.',
    stopCondition: 'Team forecast reads only ForecastEntry and never silently includes legacy estimates.',
    removalPhase: 'G7 after legacy forecast fields have no active consumer',
    forbidden: ['Counting expected amount as signed revenue', 'Using winProbability as an implicit forecast category'],
  },
  {
    logicalField: 'sales.outcome',
    currentAuthority: { kind: 'legacy_path', path: 'Opportunity.status + Opportunity.expectedAmountW' },
    targetAuthority: { kind: 'core_path', path: 'SalesOutcomeRecord' },
    consumers: {
      reads: ['app/src/components/OpportunityForm.tsx', 'app/src/lib/mdProfile.ts', 'server/src/state.ts'],
      writes: ['server/src/mutate.ts'],
      adapters: ['app/src/types.ts', 'packages/domain-contracts/src/actions.ts'],
      migrations: ['server/src/seed-demo.ts'],
      planned: ['SAAS-302 SalesOutcomeRecord migration candidates', 'SAAS-303 forecast snapshot assembler'],
    },
    shadowComparison: 'Compare reviewed signed amount/date/currency against legacy won rows and list every excluded row.',
    cutoverCondition: 'Signed amount, signedAt, currency, and audit source are explicitly confirmed.',
    stopCondition: 'Actuals read only SalesOutcomeRecord; legacy won rows remain compatibility history.',
    removalPhase: 'G7 after outcome migration and replay evidence are complete',
    forbidden: ['Inferring signed revenue from won plus expected amount', 'Silently accepting missing currency or date'],
  },
  {
    logicalField: 'matter.participants',
    currentAuthority: { kind: 'core_path', path: 'MatterParticipant' },
    targetAuthority: { kind: 'core_path', path: 'MatterParticipant' },
    consumers: {
      reads: ['app/src/data/seed.ts', 'app/src/store.ts', 'server/src/state.ts'],
      writes: [
        'server/src/mutate.ts', 'server/src/opp.ts', 'server/src/personMerge.ts',
        'server/src/mutation/matterParticipants.ts', 'server/src/seed-demo.ts',
        'server/src/suggest.ts',
      ],
      adapters: [
        'app/src/types.ts', 'packages/domain-contracts/src/crm.ts',
      ],
      migrations: [
        'server/prisma/postgres/migrations/20260821010000_expand_matter_participants_relations/migration.sql',
        'server/scripts/deploy-postgres-migrations.sh',
        'server/scripts/migrate-matter-participants.ts',
        'server/scripts/postgres-participant-schema-state.ts',
        'server/scripts/upgrade-sqlite-schema.ts',
        'server/src/matter/participants.ts',
      ],
      planned: [],
    },
    shadowComparison: 'Backfill derives the distinct OppRole and OpportunityMember union while comparing exact tenant, Matter, Person, and Customer parentage.',
    cutoverCondition: 'Backfill, tenant scope, legacy visibility, open Relation kind, and SQLite/PostgreSQL recovery tests pass.',
    stopCondition: 'Generic participant reads and writes use only MatterParticipant; legacy tables retain only methodology-role and visibility semantics.',
    removalPhase: 'G7 after generic consumers of both legacy tables are zero',
    forbidden: ['Treating ADURC as generic participation', 'Treating OpportunityMember as the participant truth source'],
  },
  {
    logicalField: 'commitment.record',
    currentAuthority: { kind: 'core_path', path: 'PlanAction.[generic Commitment fields]' },
    targetAuthority: { kind: 'core_path', path: 'PlanAction.[generic Commitment fields]' },
    consumers: {
      reads: [
        'app/src/components/RelationshipWorkspacePanel.tsx', 'app/src/lib/today.ts',
        'server/src/commitment/view.ts', 'server/src/jobs.ts', 'server/src/patrol.ts',
        'server/src/relationshipWorkspace/model.ts', 'server/src/state.ts',
        'server/src/today.ts', 'server/src/wecom.ts',
      ],
      writes: [
        'server/src/mutation/commitments.ts', 'server/src/mutation/compoundCommands.ts',
        'server/src/relationshipWorkspace/service.ts',
      ],
      adapters: [
        'app/src/App.tsx', 'app/src/api.ts', 'app/src/components/AdvisorPanel.tsx',
        'app/src/components/Canvas.tsx', 'app/src/components/DeliberationDock.tsx',
        'app/src/lib/mdProfile.ts', 'app/src/store.ts', 'app/src/types.ts', 'app/src/wireAction.ts',
        'packages/domain-contracts/src/actions.ts', 'packages/domain-contracts/src/crm.ts',
        'packages/domain-contracts/src/relationshipWorkspace.ts',
        'server/src/commitment/legacy.ts', 'server/src/mutate.ts',
        'server/src/mutation/actionScope.ts',
        'server/src/personMerge.ts', 'server/src/seed-demo.ts',
      ],
      migrations: [
        'server/prisma/postgres/migrations/20260821020000_expand_commitment_fields/migration.sql',
        'server/prisma/postgres/migrations/20260821030000_release_customer_level_commitments/migration.sql',
        'server/prisma/postgres/legacy/20260831_pre_saas208.prisma',
        'server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql',
        'server/scripts/migrate-hypothesis-commitment-review.ts',
        'server/scripts/postgres-hypothesis-commitment-review-schema-state.ts',
        'server/scripts/migrate-commitment-fields.ts',
        'server/scripts/postgres-commitment-schema-state.ts',
        'server/scripts/upgrade-sqlite-schema.ts',
        'server/src/commitment/migration.ts',
      ],
      planned: [],
    },
    shadowComparison: 'Before CORE-108, legacy backfill parity covered only the initial expansion. After cutover, migration verification validates generic contract and tenant/Customer/optional-Matter/Person/User/next-Commitment parentage without comparing or falling back to legacy fields.',
    cutoverCondition: 'CORE-108 consumer checklist, generic state, reminder lifecycle, action-feedback CAS/audit, WorkBuddy/WeCom adapters, StrategyCard isolation, and SQLite/PostgreSQL nullable migration plus recovery tests pass.',
    stopCondition: 'Customer-level Commitment reads and writes use only generic fields; legacy PlanAction UI/actions remain a Matter-required same-row sales adapter and cannot see or mutate customer-level rows.',
    removalPhase: 'Physical table may remain; legacy command contraction is G7',
    forbidden: ['Creating a second Commitment master table', 'Long-term dual writes or fallback reads', 'Fabricating a Matter for a customer-level Commitment'],
  },
  {
    logicalField: 'sales.relationship_signal',
    currentAuthority: { kind: 'core_path', path: 'RelationshipRadarSnapshot' },
    targetAuthority: { kind: 'core_path', path: 'RelationshipRadarSnapshot' },
    consumers: {
      reads: [
        'app/src/components/RelationshipRadarPanel.tsx',
        'server/src/relationshipRadar/routes.ts',
        'server/src/relationshipRadar/service.ts',
        'server/src/today.ts',
      ],
      writes: ['server/src/relationshipRadar/commit.ts'],
      adapters: [
        'app/src/api.ts',
        'app/src/lib/relationshipRadar.ts',
        'packages/domain-contracts/src/relationshipRadar.ts',
        'server/src/agents/runner.ts',
        'server/src/relationshipRadar/handler.ts',
        'server/src/relationshipRadar/model.ts',
        'server/src/relationshipRadar/rules.ts',
      ],
      migrations: [
        'server/prisma/postgres/migrations/20260831235900_expand_relationship_radar/migration.sql',
        'server/scripts/migrate-relationship-radar.ts',
        'server/scripts/postgres-relationship-radar-schema-state.ts',
        'server/scripts/upgrade-sqlite-schema.ts',
        'server/src/relationshipRadar/migration.ts',
      ],
      planned: [],
    },
    shadowComparison: 'Recompute the six deterministic signals from current tenant-scoped formal metadata and compare the exact source-set hash before every projection.',
    cutoverCondition: 'The immutable snapshot, one-shot Agent port, current-scope revalidation, Today dedupe, viewer isolation, and SQLite/PostgreSQL migration gates all pass.',
    stopCondition: 'Relationship signals remain derived and expiring; stale, revoked, or changed sources downgrade to unknown and expose no intervention or draft.',
    removalPhase: 'No formal CRM field removal; introduced as the SAAS-212 derived-signal authority.',
    forbidden: [
      'Treating a relationship signal or aggregate score as a formal relationship, stage, forecast, or key-person authority',
      'Automatically submitting a draft or writing any formal CRM row from the deterministic producer',
      'Serving an expired, source-changed, cross-tenant, or currently unauthorized projection',
      'Adding a parallel customer type or methodology-specific role fallback',
    ],
  },
]);

export function getCrmFieldAuthority(logicalField: string): CrmAuthorityEntry | undefined {
  return CRM_FIELD_AUTHORITY.find((entry) => entry.logicalField === logicalField);
}

export function listCrmFieldConsumers(entry: CrmAuthorityEntry | undefined): string[] {
  if (!entry) return [];
  return [
    ...entry.consumers.reads,
    ...entry.consumers.writes,
    ...entry.consumers.adapters,
    ...entry.consumers.migrations,
    ...entry.consumers.planned,
  ];
}
