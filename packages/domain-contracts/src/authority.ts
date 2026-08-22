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
    currentAuthority: { kind: 'legacy_path', path: 'Account.customerType' },
    targetAuthority: { kind: 'core_path', path: 'Customer.categoryKey' },
    consumers: {
      reads: [
        'app/src/aiContext.ts', 'app/src/api.ts', 'app/src/components/CustomerHub.tsx',
        'app/src/components/MdDocPanel.tsx', 'app/src/components/MdDocView.tsx',
        'app/src/components/NewOpportunityDialog.tsx', 'app/src/components/RepairPanel.tsx',
        'app/src/lib/mdProfile.ts', 'app/src/store.ts',
        'server/src/ai.ts', 'server/src/mcp/syncBundle.ts', 'server/src/mcpServer.ts',
        'server/src/opp.ts', 'server/src/repair.ts', 'server/src/state.ts',
      ],
      writes: ['app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/voice.ts'],
      adapters: ['app/src/types.ts', 'packages/domain-contracts/src/actions.ts'],
      migrations: [
        'app/src/data/seed.ts', 'server/scripts/migrate-adurc-v1.1.ts', 'server/src/seed-demo.ts',
      ],
      planned: [],
    },
    shadowComparison: 'Map legacy 1..4 through the sales adapter and compare with proposed categoryKey; mismatch fails closed.',
    cutoverCondition: 'Customer.categoryKey migration dry-run is reviewed and every generic consumer reads the V2 DTO.',
    stopCondition: 'No generic command or view reads or writes Account.customerType.',
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
      planned: [],
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
      planned: ['CORE-109 TenantDataScopePolicy and effective-scope resolver'],
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
    stopCondition: 'No read surface derives authorization from JWT role, display name, region, OpportunityMember, or an ad-hoc Account query; partial Customer containers expose only id/name/customerType.',
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
      ],
      writes: ['app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/voice.ts'],
      adapters: ['app/src/types.ts', 'packages/domain-contracts/src/actions.ts'],
      migrations: ['app/src/data/seed.ts', 'server/src/seed-demo.ts'],
      planned: ['CORE-111 MethodologyStageState', 'CORE-112 G64111 storage binding'],
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
      planned: ['CORE-112 G64111 legacy storage binding'],
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
      planned: ['CORE-112 G64111 role-assignment binding'],
    },
    shadowComparison: 'The G64111 adapter compares the legacy primary D with the bound role assignment.',
    cutoverCondition: 'Role-assignment parity and G64111 scoring fixtures pass without generic Focus consumers.',
    stopCondition: 'Only the G64111 adapter reads primaryDPersonId.',
    removalPhase: 'G7 after all non-adapter primaryD consumers are removed',
    forbidden: ['Using primaryDPersonId as generic StakeholderFocus', 'Deleting Focus when G64111 is disabled'],
  },
  {
    logicalField: 'stakeholder.focus',
    currentAuthority: { kind: 'none', path: null },
    targetAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
    consumers: {
      reads: [], writes: [], adapters: [], migrations: [],
      planned: ['SAAS-206 StakeholderFocus command', 'SAAS-208 relationship-map projection'],
    },
    shadowComparison: 'No legacy value is promoted; any G64111 comparison is advisory and never copied automatically.',
    cutoverCondition: 'SAAS-206 commands, evidence reasons, permissions, and user confirmation tests pass.',
    stopCondition: 'Generic focus consumers never read primaryDPersonId or a methodology role as fallback.',
    removalPhase: 'No legacy removal; introduced in G4',
    forbidden: ['Creating Focus automatically from a score', 'Binding Focus lifetime to a methodology pack'],
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
        'app/src/lib/today.ts', 'server/src/jobs.ts', 'server/src/patrol.ts',
        'server/src/state.ts', 'server/src/wecom.ts',
      ],
      writes: ['server/src/mutation/commitments.ts', 'server/src/mutation/compoundCommands.ts'],
      adapters: [
        'app/src/App.tsx', 'app/src/api.ts', 'app/src/components/AdvisorPanel.tsx',
        'app/src/components/Canvas.tsx', 'app/src/components/DeliberationDock.tsx',
        'app/src/lib/mdProfile.ts', 'app/src/store.ts', 'app/src/types.ts', 'app/src/wireAction.ts',
        'packages/domain-contracts/src/actions.ts', 'packages/domain-contracts/src/crm.ts',
        'server/src/commitment/legacy.ts', 'server/src/mutate.ts',
        'server/src/mutation/actionScope.ts',
        'server/src/personMerge.ts', 'server/src/seed-demo.ts',
      ],
      migrations: [
        'server/prisma/postgres/migrations/20260821020000_expand_commitment_fields/migration.sql',
        'server/prisma/postgres/migrations/20260821030000_release_customer_level_commitments/migration.sql',
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
