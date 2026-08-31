import { prisma } from '../src/prisma.js';

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};
type IndexRow = { indexname: string };
type ForeignKeyRow = {
  foreign_table: string;
  source_column: string;
  target_column: string;
  delete_rule: string;
};
type ExpectedColumn = {
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null | 'CURRENT_TIMESTAMP';
};

const expectedHypothesisColumns = new Map<string, ExpectedColumn>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['customerId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['matterId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['personId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['status', { type: 'text', nullable: 'NO', defaultValue: "'untested'::text" }],
  ['ownerUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['nextReviewAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['currentRevisionId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['legacyStrategyRiskId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['createdByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['statusConfirmedByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['statusConfirmedAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['version', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
  ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
]);

const expectedRevisionColumns = new Map<string, ExpectedColumn>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['hypothesisId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['revisionNumber', { type: 'integer', nullable: 'NO', defaultValue: null }],
  ['claim', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['reason', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
  ['expectedSignals', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
  ['falsificationConditions', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
  ['origin', { type: 'text', nullable: 'NO', defaultValue: "'user'::text" }],
  ['createdByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
]);

const expectedLinkColumns = new Map<string, ExpectedColumn>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['hypothesisId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['hypothesisRevisionId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['evidenceId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['evidenceVersion', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
  ['direction', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['linkedByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['linkedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
]);

const expectedHypothesisIndexes = new Set([
  'SalesHypothesis_pkey',
  'SalesHypothesis_tenantId_id_key',
  'SalesHypothesis_tenantId_legacyStrategyRiskId_key',
  'SalesHypothesis_tenantId_customerId_updatedAt_idx',
  'SalesHypothesis_tenantId_matterId_updatedAt_idx',
  'SalesHypothesis_tenantId_personId_updatedAt_idx',
  'SalesHypothesis_tenantId_ownerUserId_nextReviewAt_idx',
  'SalesHypothesis_tenantId_status_nextReviewAt_idx',
]);
const expectedRevisionIndexes = new Set([
  'SalesHypothesisRevision_pkey',
  'SalesHypothesisRevision_tenantId_id_key',
  'SalesHypothesisRevision_tenantId_hypothesisId_revisionNumbe_key',
  'SalesHypothesisRevision_tenantId_hypothesisId_createdAt_idx',
]);
const expectedLinkIndexes = new Set([
  'HypothesisEvidenceLink_pkey',
  'HypothesisEvidenceLink_tenantId_id_key',
  'HypothesisEvidenceLink_tenantId_hypothesisRevisionId_eviden_key',
  'HypothesisEvidenceLink_tenantId_hypothesisId_linkedAt_idx',
  'HypothesisEvidenceLink_tenantId_evidenceId_idx',
]);

function columnsMatch(columns: ColumnRow[], expectedColumns: Map<string, ExpectedColumn>): boolean {
  return columns.length === expectedColumns.size && columns.every((column) => {
    const expected = expectedColumns.get(column.column_name);
    if (!expected || expected.type !== column.data_type || expected.nullable !== column.is_nullable) return false;
    return expected.defaultValue === 'CURRENT_TIMESTAMP'
      ? Boolean(column.column_default?.includes('CURRENT_TIMESTAMP'))
      : expected.defaultValue === column.column_default;
  });
}

function indexesMatch(indexes: IndexRow[], expectedIndexes: ReadonlySet<string>): boolean {
  const names = new Set(indexes.map((index) => index.indexname));
  return names.size === expectedIndexes.size && [...expectedIndexes].every((name) => names.has(name));
}

function tenantForeignKeyMatches(foreignKeys: ForeignKeyRow[]): boolean {
  return foreignKeys.length === 1
    && foreignKeys[0]?.foreign_table === 'Tenant'
    && foreignKeys[0].source_column === 'tenantId'
    && foreignKeys[0].target_column === 'id'
    && foreignKeys[0].delete_rule === 'CASCADE';
}

async function tableState(
  tableName: 'SalesHypothesis' | 'SalesHypothesisRevision' | 'HypothesisEvidenceLink',
  expectedColumns: Map<string, ExpectedColumn>,
  expectedIndexes: ReadonlySet<string>,
): Promise<boolean> {
  const [columns, indexes, foreignKeys] = await Promise.all([
    prisma.$queryRawUnsafe<ColumnRow[]>(`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${tableName}'
       ORDER BY ordinal_position
    `),
    prisma.$queryRawUnsafe<IndexRow[]>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = '${tableName}'
       ORDER BY indexname
    `),
    prisma.$queryRawUnsafe<ForeignKeyRow[]>(`
      SELECT ccu.table_name AS foreign_table,
             kcu.column_name AS source_column,
             ccu.column_name AS target_column,
             rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
         AND rc.unique_constraint_schema = ccu.constraint_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = '${tableName}'
         AND tc.constraint_type = 'FOREIGN KEY'
    `),
  ]);
  return columnsMatch(columns, expectedColumns)
    && indexesMatch(indexes, expectedIndexes)
    && tenantForeignKeyMatches(foreignKeys);
}

try {
  const exists = await prisma.$queryRawUnsafe<Array<{
    tenant: boolean;
    migration_state: boolean;
    intelligence: boolean;
    focus: boolean;
    hypothesis: boolean;
    revision: boolean;
    evidence_link: boolean;
  }>>(`
    SELECT to_regclass('public."Tenant"') IS NOT NULL AS tenant,
           to_regclass('public."DataMigrationState"') IS NOT NULL AS migration_state,
           to_regclass('public."IntelligenceItem"') IS NOT NULL AS intelligence,
           to_regclass('public."StakeholderFocus"') IS NOT NULL AS focus,
           to_regclass('public."SalesHypothesis"') IS NOT NULL AS hypothesis,
           to_regclass('public."SalesHypothesisRevision"') IS NOT NULL AS revision,
           to_regclass('public."HypothesisEvidenceLink"') IS NOT NULL AS evidence_link
  `);
  const state = exists[0];
  if (!state?.hypothesis && !state?.revision && !state?.evidence_link) {
    process.stdout.write(state?.tenant && state.migration_state && state.intelligence && state.focus
      ? 'legacy' : 'uninitialized');
  } else if (!state.tenant || !state.migration_state || !state.intelligence || !state.focus) {
    process.stdout.write('partial');
  } else if (!state.hypothesis || !state.revision || !state.evidence_link) {
    process.stdout.write('partial');
  } else {
    const [hypothesisExact, revisionExact, linkExact] = await Promise.all([
      tableState('SalesHypothesis', expectedHypothesisColumns, expectedHypothesisIndexes),
      tableState('SalesHypothesisRevision', expectedRevisionColumns, expectedRevisionIndexes),
      tableState('HypothesisEvidenceLink', expectedLinkColumns, expectedLinkIndexes),
    ]);
    process.stdout.write(hypothesisExact && revisionExact && linkExact ? 'expanded' : 'partial');
  }
} finally {
  await prisma.$disconnect();
}
