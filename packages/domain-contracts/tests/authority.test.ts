import { describe, expect, it } from 'vitest';
import {
  CRM_FIELD_AUTHORITY,
  CrmAuthorityMapSchema,
  getCrmFieldAuthority,
  listCrmFieldConsumers,
} from '../src/index.js';

const VALID_ENTRY = {
  logicalField: 'fixture.field',
  currentAuthority: { kind: 'legacy_path', path: 'Legacy.value' },
  targetAuthority: { kind: 'core_path', path: 'Core.value' },
  consumers: {
    reads: ['app/src/reader.ts'],
    writes: ['server/src/writer.ts'],
    adapters: [],
    migrations: [],
    planned: [],
  },
  shadowComparison: 'Compare normalized old and new values; fail on mismatch.',
  cutoverCondition: 'All readers use the target projection.',
  stopCondition: 'No new writes reach the legacy field.',
  removalPhase: 'G7 after recovery rehearsal',
  forbidden: ['Fallback dual reads'],
} as const;

describe('CRM field authority map', () => {
  it('contains the thirteen approved logical fields with classified consumers', () => {
    expect(CRM_FIELD_AUTHORITY).toHaveLength(13);
    for (const entry of CRM_FIELD_AUTHORITY) expect(listCrmFieldConsumers(entry).length).toBeGreaterThan(0);
  });

  it('records completed G2 work as complete and routes remaining legacy cutovers to CORE-501', () => {
    const planned = CRM_FIELD_AUTHORITY.flatMap((entry) => entry.consumers.planned);
    expect(planned.join('\n')).not.toMatch(/\bCORE-(?:109|111|112|113)\b/);
    expect(getCrmFieldAuthority('matter.owner')?.consumers.planned).toEqual([]);
    expect(getCrmFieldAuthority('customer.category')?.consumers.planned).toEqual([
      'CORE-501 customerType consumer cutover',
    ]);
    expect(getCrmFieldAuthority('matter.lifecycle')?.consumers.planned).toEqual([
      'CORE-501 Opportunity.status consumer cutover',
    ]);
    expect(getCrmFieldAuthority('matter.current_stage')?.consumers.planned).toEqual([
      'CORE-501 pipelineStage consumer cutover',
    ]);
    expect(getCrmFieldAuthority('g64111.engage_stage')?.consumers.planned).toEqual([
      'CORE-501 engageStage consumer cutover',
    ]);
    expect(getCrmFieldAuthority('g64111.primary_d')?.consumers.planned).toEqual([
      'CORE-501 primaryD consumer cutover',
    ]);
  });

  it('rejects independent malformed entries instead of self-validating the built-in constant', () => {
    expect(CrmAuthorityMapSchema.safeParse([{
      ...VALID_ENTRY,
      consumers: { reads: [], writes: [], adapters: [], migrations: [], planned: [] },
    }]).success).toBe(false);
    expect(CrmAuthorityMapSchema.safeParse([{ ...VALID_ENTRY, cutoverCondition: '   ' }]).success).toBe(false);
    expect(CrmAuthorityMapSchema.safeParse([{
      ...VALID_ENTRY,
      currentAuthority: { kind: 'unregistered_source', path: 'Legacy.value' },
    }]).success).toBe(false);
  });

  it('rejects duplicate logical fields and duplicate consumer classification', () => {
    expect(CrmAuthorityMapSchema.safeParse([VALID_ENTRY, VALID_ENTRY]).success).toBe(false);
    expect(CrmAuthorityMapSchema.safeParse([{
      ...VALID_ENTRY,
      consumers: { ...VALID_ENTRY.consumers, adapters: ['app/src/reader.ts'] },
    }]).success).toBe(false);
  });

  it('routes the critical legacy fields to their approved distinct targets', () => {
    expect(getCrmFieldAuthority('customer.category')).toMatchObject({
      currentAuthority: { kind: 'legacy_path', path: 'Account.customerType' },
      targetAuthority: { kind: 'core_path', path: 'Customer.categoryKey' },
    });
    expect(getCrmFieldAuthority('matter.current_stage')).toMatchObject({
      currentAuthority: { kind: 'legacy_path', path: 'Opportunity.pipelineStage' },
      targetAuthority: { kind: 'methodology_value', path: 'MethodologyStageState' },
    });
    expect(getCrmFieldAuthority('g64111.engage_stage')).toMatchObject({
      currentAuthority: { kind: 'legacy_path', path: 'Opportunity.engageStage' },
      targetAuthority: { kind: 'methodology_value', path: 'MethodologyValue(g64111.engage_stage)' },
    });
    expect(getCrmFieldAuthority('pde.decision_stage')).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'PdeDecisionContext.stageKey' },
      targetAuthority: { kind: 'core_path', path: 'PdeDecisionContext.stageKey' },
    });
    expect(getCrmFieldAuthority('stakeholder.focus')).toMatchObject({
      currentAuthority: { kind: 'none', path: null },
      targetAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
    });
    expect(getCrmFieldAuthority('matter.owner')).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'Matter.primaryOwnerUserId' },
      targetAuthority: { kind: 'core_path', path: 'Matter.primaryOwnerUserId' },
    });
  });

  it('registers the exact executable customer.category consumer inventory', () => {
    const category = getCrmFieldAuthority('customer.category');
    expect([
      ...(category?.consumers.reads ?? []),
      ...(category?.consumers.writes ?? []),
      ...(category?.consumers.adapters ?? []),
      ...(category?.consumers.migrations ?? []),
    ].sort()).toEqual([
      'app/src/aiContext.ts',
      'app/src/api.ts',
      'app/src/components/CustomerHub.tsx',
      'app/src/components/MdDocPanel.tsx',
      'app/src/components/MdDocView.tsx',
      'app/src/components/NewOpportunityDialog.tsx',
      'app/src/components/RepairPanel.tsx',
      'app/src/data/seed.ts',
      'app/src/lib/mdProfile.ts',
      'app/src/store.ts',
      'app/src/types.ts',
      'app/src/wireAction.ts',
      'packages/domain-contracts/src/actions.ts',
      'server/scripts/migrate-adurc-v1.1.ts',
      'server/src/ai.ts',
      'server/src/mcp/syncBundle.ts',
      'server/src/mcpServer.ts',
      'server/src/mutate.ts',
      'server/src/opp.ts',
      'server/src/repair.ts',
      'server/src/seed-demo.ts',
      'server/src/state.ts',
      'server/src/voice.ts',
    ].sort());
  });

  it('registers the current critical stage, methodology, and commitment consumers', () => {
    const lifecycle = getCrmFieldAuthority('matter.lifecycle');
    expect(lifecycle?.consumers.writes).toEqual(expect.arrayContaining([
      'server/src/mcp/syncBundle.ts', 'server/src/mutate.ts', 'server/src/repair.ts',
    ]));
    expect(lifecycle?.consumers.migrations).toEqual(expect.arrayContaining([
      'server/prisma/postgres/migrations/20260821000000_expand_matter_fields/migration.sql',
      'server/scripts/migrate-matter-fields.ts', 'server/scripts/upgrade-sqlite-schema.ts',
    ]));
    expect(lifecycle?.consumers.planned).toEqual(['CORE-501 Opportunity.status consumer cutover']);
    const participants = getCrmFieldAuthority('matter.participants');
    expect(participants).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'MatterParticipant' },
      targetAuthority: { kind: 'core_path', path: 'MatterParticipant' },
    });
    expect(participants?.consumers.migrations).toEqual(expect.arrayContaining([
      'server/prisma/postgres/migrations/20260821010000_expand_matter_participants_relations/migration.sql',
      'server/scripts/migrate-matter-participants.ts', 'server/scripts/upgrade-sqlite-schema.ts',
    ]));
    expect(participants?.consumers.planned).toEqual([]);
    expect(listCrmFieldConsumers(getCrmFieldAuthority('matter.owner'))).toEqual(expect.arrayContaining([
      'server/src/matter/ownership.ts', 'server/src/mutation/matterOwnership.ts',
      'server/scripts/report-matter-owner-suggestions.ts', 'server/src/state.ts',
    ]));
    expect(listCrmFieldConsumers(getCrmFieldAuthority('matter.current_stage'))).toEqual(expect.arrayContaining([
      'app/src/wireAction.ts', 'server/src/mutate.ts', 'server/src/repair.ts', 'server/src/mcpServer.ts',
    ]));
    expect(listCrmFieldConsumers(getCrmFieldAuthority('g64111.primary_d'))).toEqual(expect.arrayContaining([
      'app/src/components/FocusPanel.tsx', 'app/src/components/DetailDrawer.tsx', 'app/src/store.ts',
      'server/src/mutate.ts', 'server/src/state.ts', 'server/src/wecom.ts',
      'server/src/mcpServer.ts', 'server/src/personMerge.ts',
    ]));
    const engageStage = getCrmFieldAuthority('g64111.engage_stage');
    expect(engageStage?.consumers.adapters).toEqual(expect.arrayContaining([
      'app/src/lib/g64111.ts', 'server/src/g64111.ts',
    ]));
    expect(engageStage?.consumers.reads).not.toContain('server/src/pde/assemble.ts');
    const pdeStage = getCrmFieldAuthority('pde.decision_stage');
    expect(pdeStage).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'PdeDecisionContext.stageKey' },
      targetAuthority: { kind: 'core_path', path: 'PdeDecisionContext.stageKey' },
      consumers: {
        reads: ['server/src/pde/assemble.ts'],
        adapters: ['server/src/pde/context.ts'],
        planned: [],
      },
    });
    expect(pdeStage?.consumers.writes).toEqual(expect.arrayContaining([
      'server/src/mcp/syncBundle.ts', 'server/src/mutate.ts', 'server/src/opp.ts',
      'server/src/pde/routes.ts', 'server/src/seed-demo.ts',
    ]));
    expect(pdeStage?.consumers.migrations).toEqual(expect.arrayContaining([
      'server/prisma/postgres/migrations/20260821070000_add_pde_decision_context/migration.sql',
      'server/scripts/migrate-pde-decision-context.ts', 'server/scripts/upgrade-sqlite-schema.ts',
      'server/src/pde/decisionContextMigration.ts',
    ]));
    expect(listCrmFieldConsumers(pdeStage)).not.toContain('app/src/lib/pde/adapter.ts');
    expect(listCrmFieldConsumers(getCrmFieldAuthority('commitment.record'))).toEqual(expect.arrayContaining([
      'app/src/lib/today.ts', 'server/src/state.ts', 'server/src/mutation/actionScope.ts',
      'server/src/mutation/commitments.ts',
    ]));
    expect(getCrmFieldAuthority('commitment.record')).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'PlanAction.[generic Commitment fields]' },
      targetAuthority: { kind: 'core_path', path: 'PlanAction.[generic Commitment fields]' },
      consumers: {
        writes: ['server/src/mutation/commitments.ts', 'server/src/mutation/compoundCommands.ts'],
        planned: [],
      },
    });
    expect(getCrmFieldAuthority('commitment.record')?.consumers.migrations).toContain(
      'server/prisma/postgres/migrations/20260821030000_release_customer_level_commitments/migration.sql',
    );
  });

  it('registers the complete effective data-scope authority with no pending consumer', () => {
    const scope = getCrmFieldAuthority('tenant.data_scope');
    expect(scope).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'Tenant.dataScopePolicy + EffectiveResourceScope' },
      targetAuthority: { kind: 'core_path', path: 'Tenant.dataScopePolicy + EffectiveResourceScope' },
      consumers: { writes: [], planned: [] },
    });
    expect(scope?.consumers.reads).toEqual(expect.arrayContaining([
      'server/src/resourceScope.ts',
      'server/src/state.ts',
      'server/src/ai.ts',
      'server/src/strategy.ts',
      'server/src/advisor.ts',
      'server/src/pde/assemble.ts',
      'server/src/pde/routes.ts',
      'server/src/mcpServer.ts',
      'server/src/personMerge.ts',
      'server/src/suggest.ts',
      'server/src/curated.ts',
      'server/src/recording.ts',
      'server/src/jobs.ts',
      'server/src/repair.ts',
    ]));
    expect(scope?.consumers.adapters).toEqual(expect.arrayContaining([
      'packages/domain-contracts/src/capabilities.ts',
      'server/src/scope.ts',
    ]));
    expect(scope?.consumers.migrations).toContain(
      'server/prisma/postgres/migrations/20260821040000_add_tenant_data_scope_policy/migration.sql',
    );
  });

  it('returns no authority or consumers for an unregistered logical field', () => {
    expect(getCrmFieldAuthority('unregistered.field')).toBeUndefined();
    expect(listCrmFieldConsumers(undefined)).toEqual([]);
  });
});
