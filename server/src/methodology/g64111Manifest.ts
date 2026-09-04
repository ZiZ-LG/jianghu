import { G64111_BUILTIN_ENGINE_REF } from '@jianghu/domain-contracts';

const APP_ENGINE = 'app:g64111-adapter';
const SERVER_ENGINE = 'server:g64111-adapter';
const APP_LEGACY_SALES = 'app:legacy-sales-shell';
const SERVER_LEGACY_SALES = 'server:legacy-sales-api';
const APP_PDE_CORE113 = 'app:pde-adapter:CORE-113';
const SERVER_PDE_CORE113 = 'server:pde-assembler:CORE-113';

export const G64111_ENGINE_REF = G64111_BUILTIN_ENGINE_REF;
export const G64111_LEGACY_STOP_DATE = '2026-12-31';

const consumers = (...values: string[]) => JSON.stringify([...new Set(values)]);
const engineConsumers = consumers(APP_ENGINE, SERVER_ENGINE, APP_LEGACY_SALES, SERVER_LEGACY_SALES);
const pdeConsumers = consumers(
  APP_ENGINE,
  SERVER_ENGINE,
  APP_LEGACY_SALES,
  SERVER_LEGACY_SALES,
  APP_PDE_CORE113,
  SERVER_PDE_CORE113,
);

const legacyField = (
  key: string,
  storageBindingPath: string,
  position: number,
  options: {
    targetKind?: 'matter' | 'person';
    dataType?: string;
    valueDomain?: Record<string, unknown>;
    legacyConsumersJson?: string;
    missingValuePolicy?: string;
  } = {},
) => ({
  key,
  targetKind: options.targetKind ?? ('matter' as const),
  dataType: options.dataType ?? 'json',
  valueDomainJson: JSON.stringify(options.valueDomain ?? { engineRef: G64111_ENGINE_REF }),
  required: false,
  missingValuePolicy: options.missingValuePolicy ?? 'engine_default',
  storageBindingKind: 'legacy_path' as const,
  storageBindingPath,
  legacyStopDate: G64111_LEGACY_STOP_DATE,
  legacyConsumersJson: options.legacyConsumersJson ?? engineConsumers,
  position,
});

export const G64111_DEFINITION_MANIFEST = Object.freeze({
  fields: Object.freeze([
    legacyField('g64111.primary_d', 'Opportunity.primaryDPersonId', 0, {
      dataType: 'person_ref',
      valueDomain: { nullable: true, roleKey: 'D' },
      legacyConsumersJson: pdeConsumers,
    }),
    legacyField('g64111.pipeline_stage', 'Opportunity.pipelineStage', 1, {
      dataType: 'stage_key',
      valueDomain: { source: 'methodology_stage_definition' },
      legacyConsumersJson: consumers(APP_LEGACY_SALES, SERVER_LEGACY_SALES, APP_PDE_CORE113),
      missingValuePolicy: 'unconfigured',
    }),
    legacyField('g64111.engage_stage', 'Opportunity.engageStage', 2, {
      dataType: 'engine_key',
      valueDomain: { source: `${G64111_ENGINE_REF}#EngageStage` },
      // CORE-113 decoupled PDE decision stage. This legacy value now serves only the G64111 scoring boundary.
      legacyConsumersJson: engineConsumers,
    }),
    legacyField('g64111.c3_items', 'Opportunity.c3Items', 3, {
      valueDomain: { source: `${G64111_ENGINE_REF}#C3_ITEMS`, valueType: 'boolean' },
    }),
    legacyField('g64111.c5_items', 'Opportunity.c5Items', 4, {
      valueDomain: { source: `${G64111_ENGINE_REF}#C5_ITEMS`, valueType: 'boolean' },
    }),
    legacyField('g64111.roles', 'OppRole[]', 5, {
      dataType: 'collection',
      valueDomain: { roleDefinitions: true },
      legacyConsumersJson: pdeConsumers,
    }),
    legacyField('g64111.burning_issues', 'BurningIssue[]', 6, {
      dataType: 'collection',
      valueDomain: { source: `${G64111_ENGINE_REF}#ScoringBurningIssue` },
    }),
    legacyField('g64111.unique_value_claims', 'UCV[]', 7, {
      dataType: 'collection',
      valueDomain: { source: `${G64111_ENGINE_REF}#ScoringUcv` },
    }),
    legacyField('g64111.person_form_family7', 'Person.form.family7', 8, {
      targetKind: 'person',
      valueDomain: { source: `${G64111_ENGINE_REF}#FAMILY_7Q` },
      legacyConsumersJson: pdeConsumers,
    }),
  ]),
  stages: Object.freeze([
    '线索',
    '需求引导',
    '方案认可',
    '客户立项',
    '招投标',
    '合同谈判',
    '合同双签',
  ].map((name, position) => ({
    key: name,
    name,
    position,
    entryConditionsJson: '[]',
    exitConditionsJson: '[]',
  }))),
  roles: Object.freeze([
    ['A', '批准人'],
    ['D', '拍板人'],
    ['U', '使用者'],
    ['R', '影响者'],
    ['C', '教练'],
  ].map(([key, name], position) => ({
    key: key!,
    name: name!,
    appliesTo: 'person' as const,
    constraintsJson: JSON.stringify({ legacyCode: key, primarySelectionField: key === 'D' ? 'g64111.primary_d' : null }),
    minimumAssignments: 0,
    maximumAssignments: 1_000,
    position,
  }))),
  // Formula weights and thresholds remain exclusively in @jianghu/g64111.
  rules: Object.freeze([]),
  actions: Object.freeze([]),
});
