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
  it('contains the sixteen approved logical fields with classified consumers', () => {
    expect(CRM_FIELD_AUTHORITY).toHaveLength(16);
    for (const entry of CRM_FIELD_AUTHORITY) expect(listCrmFieldConsumers(entry).length).toBeGreaterThan(0);
  });

  it('records completed G2 work as complete and routes remaining legacy cutovers to CORE-501', () => {
    const planned = CRM_FIELD_AUTHORITY.flatMap((entry) => entry.consumers.planned);
    expect(planned.join('\n')).not.toMatch(/\bCORE-(?:109|111|112|113)\b/);
    expect(getCrmFieldAuthority('matter.owner')?.consumers.planned).toEqual([]);
    expect(getCrmFieldAuthority('customer.category')?.consumers.planned).toEqual([]);
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
      currentAuthority: { kind: 'core_path', path: 'Customer.categoryKey' },
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
      currentAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
      targetAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
    });
    expect(getCrmFieldAuthority('matter.owner')).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'Matter.primaryOwnerUserId' },
      targetAuthority: { kind: 'core_path', path: 'Matter.primaryOwnerUserId' },
    });
  });

  it('registers the implemented StakeholderFocus relationship-workspace consumers with no pending cutover', () => {
    const focus = getCrmFieldAuthority('stakeholder.focus');
    expect(focus).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
      targetAuthority: { kind: 'core_path', path: 'StakeholderFocus' },
      consumers: {
        reads: [
          'app/src/components/RelationshipWorkspacePanel.tsx',
          'server/src/intelligenceFocus/routes.ts',
          'server/src/relationshipWorkspace/model.ts',
        ],
        writes: ['server/src/intelligenceFocus/service.ts'],
        adapters: [
          'packages/domain-contracts/src/intelligence.ts',
          'packages/domain-contracts/src/relationshipWorkspace.ts',
        ],
        planned: [],
      },
    });
    expect(focus?.consumers.migrations).toEqual(expect.arrayContaining([
      'server/prisma/postgres/migrations/20260827000000_expand_intelligence_focus/migration.sql',
      'server/src/intelligenceFocus/migration.ts',
      'server/scripts/migrate-intelligence-focus.ts',
      'server/scripts/postgres-intelligence-focus-schema-state.ts',
      'server/scripts/upgrade-sqlite-schema.ts',
    ]));
    expect(focus?.consumers.planned).toEqual([]);
    expect(focus?.forbidden.join('\n')).toMatch(/primaryDPersonId/);
    expect(focus?.forbidden.join('\n')).toMatch(/score|methodology/i);
  });

  it('registers SalesHypothesis as the sole hypothesis authority and freezes its predecessor', () => {
    const hypothesis = getCrmFieldAuthority('sales.hypothesis');
    expect(hypothesis).toMatchObject({
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
          'server/src/relationshipWorkspace/model.ts',
          'server/src/relationshipWorkspace/routes.ts',
        ],
        writes: ['server/src/hypotheses/service.ts', 'server/src/relationshipWorkspace/service.ts'],
        planned: [
          'SAAS-209 portfolio',
          'SAAS-212 relationship radar',
        ],
      },
    });
    expect(hypothesis?.consumers.adapters).toEqual(expect.arrayContaining([
      'packages/domain-contracts/src/hypotheses.ts',
      'packages/domain-contracts/src/relationshipWorkspace.ts',
      'app/src/api.ts',
      'app/src/lib/relationshipWorkspace.ts',
      'server/src/hypotheses/model.ts',
      'server/src/mutate.ts',
      'server/src/mutation/actionScope.ts',
      'server/src/candidates/reviewItems.ts',
    ]));
    expect(hypothesis?.consumers.migrations).toEqual(expect.arrayContaining([
      'server/prisma/postgres/migrations/20260830000000_expand_sales_hypothesis/migration.sql',
      'server/src/hypotheses/migration.ts',
      'server/scripts/migrate-sales-hypotheses.ts',
      'server/scripts/postgres-sales-hypothesis-schema-state.ts',
      'server/scripts/upgrade-sqlite-schema.ts',
      'server/src/seed-demo.ts',
      'server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql',
      'server/scripts/migrate-hypothesis-commitment-review.ts',
      'server/scripts/postgres-hypothesis-commitment-review-schema-state.ts',
    ]));
    expect(hypothesis?.forbidden.join('\n')).toMatch(/automatic|auto|自动/i);
    expect(hypothesis?.forbidden.join('\n')).toMatch(/fallback|dual/i);
    expect(hypothesis?.forbidden.join('\n')).toMatch(/revision|link/i);
  });

  it('records the relationship workspace as a read-only composition without a new field authority', () => {
    const projection = getCrmFieldAuthority('relationship.workspace_projection');
    expect(projection).toMatchObject({
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
    });
    expect(projection?.shadowComparison).toMatch(/Candidate.*IntelligenceItem/i);
    expect(projection?.forbidden.join('\n')).toMatch(/accept|write|score/i);
  });

  it('registers RelationshipRadarSnapshot as the derived relationship-signal authority', () => {
    const radar = getCrmFieldAuthority('sales.relationship_signal');
    expect(radar).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'RelationshipRadarSnapshot' },
      targetAuthority: { kind: 'core_path', path: 'RelationshipRadarSnapshot' },
      consumers: {
        writes: ['server/src/relationshipRadar/commit.ts'],
        planned: [],
      },
    });
    expect(radar?.consumers.reads).toEqual(expect.arrayContaining([
      'app/src/components/RelationshipRadarPanel.tsx',
      'server/src/relationshipRadar/service.ts',
      'server/src/today.ts',
    ]));
    expect(radar?.consumers.migrations).toEqual(expect.arrayContaining([
      'server/prisma/postgres/migrations/20260831235900_expand_relationship_radar/migration.sql',
      'server/src/relationshipRadar/migration.ts',
    ]));
    expect(radar?.forbidden.join('\n')).toMatch(/aggregate score|formal|自动|Automatically/i);
    expect(radar?.stopCondition).toMatch(/expired|changed|unknown/i);
  });

  it('registers the exact executable customer.category consumer inventory', () => {
    const category = getCrmFieldAuthority('customer.category');
    expect(category?.consumers.reads).toEqual([
      'app/src/components/CrmContextPages.tsx',
      'app/src/lib/crmContext.ts',
      'server/src/crmContext.ts',
    ]);
    expect(category?.consumers.writes).toEqual([
      'app/src/lib/quickCapture.ts',
      'server/src/mutation/customers.ts',
    ]);
    expect([
      ...(category?.consumers.reads ?? []),
      ...(category?.consumers.writes ?? []),
      ...(category?.consumers.adapters ?? []),
      ...(category?.consumers.migrations ?? []),
    ].sort()).toEqual([
      'app/src/aiContext.ts',
      'app/src/api.ts',
      'app/src/components/CustomerHub.tsx',
      'app/src/components/CrmContextPages.tsx',
      'app/src/components/MdDocPanel.tsx',
      'app/src/components/MdDocView.tsx',
      'app/src/components/NewOpportunityDialog.tsx',
      'app/src/components/RepairPanel.tsx',
      'app/src/data/seed.ts',
      'app/src/lib/mdProfile.ts',
      'app/src/lib/crmContext.ts',
      'app/src/lib/quickCapture.ts',
      'app/src/store.ts',
      'app/src/types.ts',
      'app/src/wireAction.ts',
      'packages/domain-contracts/src/actions.ts',
      'packages/domain-contracts/src/crm.ts',
      'packages/domain-contracts/src/postMeeting.ts',
      'server/scripts/migrate-adurc-v1.1.ts',
      'server/scripts/postgres-customer-schema-state.ts',
      'server/scripts/render-pre-customer-schema.ts',
      'server/src/ai.ts',
      'server/src/crmContext.ts',
      'server/src/mcp/syncBundle.ts',
      'server/src/mcpServer.ts',
      'server/src/mutate.ts',
      'server/src/mutation/customers.ts',
      'server/src/mutation/reviewedFields.ts',
      'server/src/opp.ts',
      'server/src/postMeeting/commit.ts',
      'server/src/postMeeting/extractor.ts',
      'server/src/postMeeting/handler.ts',
      'server/src/postMeeting/review.ts',
      'server/src/postMeeting/source.ts',
      'server/src/repair.ts',
      'server/src/salesClassification.ts',
      'server/src/seed-demo.ts',
      'server/src/state.ts',
      'server/src/voice.ts',
      'server/scripts/upgrade-sqlite-schema.ts',
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
      'server/src/mutation/commitments.ts', 'app/src/components/RelationshipWorkspacePanel.tsx',
      'server/src/relationshipWorkspace/service.ts',
    ]));
    expect(getCrmFieldAuthority('commitment.record')).toMatchObject({
      currentAuthority: { kind: 'core_path', path: 'PlanAction.[generic Commitment fields]' },
      targetAuthority: { kind: 'core_path', path: 'PlanAction.[generic Commitment fields]' },
      consumers: {
        writes: [
          'server/src/mutation/commitments.ts',
          'server/src/mutation/compoundCommands.ts',
          'server/src/relationshipWorkspace/service.ts',
        ],
        planned: [],
      },
    });
    expect(getCrmFieldAuthority('commitment.record')?.consumers.migrations).toContain(
      'server/prisma/postgres/migrations/20260821030000_release_customer_level_commitments/migration.sql',
    );
    expect(getCrmFieldAuthority('commitment.record')?.consumers.migrations).toContain(
      'server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql',
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
