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

const expectedIntelligenceColumns = new Map<string, ExpectedColumn>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['customerId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['matterId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['assertionType', { type: 'text', nullable: 'NO', defaultValue: "'reported'::text" }],
  ['statement', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['sourceKind', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['sourceDescription', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['sourceRefId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['sourceRefVersion', { type: 'integer', nullable: 'YES', defaultValue: null }],
  ['occurredAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['learnedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ['confidence', { type: 'double precision', nullable: 'NO', defaultValue: '0.5' }],
  ['targetRefs', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
  ['createdByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['version', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
  ['archivedAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['archivedByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['archiveReason', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
  ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
]);

const expectedFocusColumns = new Map<string, ExpectedColumn>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['customerId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['matterId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['personId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['desiredChange', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['rationale', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['evidenceGap', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['basisRefs', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
  ['validUntil', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ['activeMatterKey', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['confirmedByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['confirmedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ['retiredByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['retiredAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['retireReason', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
  ['version', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
  ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
]);

const expectedIntelligenceIndexes = new Set([
  'IntelligenceItem_pkey',
  'IntelligenceItem_tenantId_customerId_learnedAt_idx',
  'IntelligenceItem_tenantId_matterId_learnedAt_idx',
  'IntelligenceItem_tenantId_assertionType_learnedAt_idx',
  'IntelligenceItem_tenantId_archivedAt_learnedAt_idx',
  'IntelligenceItem_tenantId_id_key',
]);
const expectedFocusIndexes = new Set([
  'StakeholderFocus_pkey',
  'StakeholderFocus_tenantId_customerId_updatedAt_idx',
  'StakeholderFocus_tenantId_matterId_updatedAt_idx',
  'StakeholderFocus_tenantId_personId_updatedAt_idx',
  'StakeholderFocus_tenantId_id_key',
  'StakeholderFocus_tenantId_activeMatterKey_key',
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
  tableName: 'IntelligenceItem' | 'StakeholderFocus',
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
    research_brief: boolean;
    intelligence: boolean;
    focus: boolean;
  }>>(`
    SELECT to_regclass('public."Tenant"') IS NOT NULL AS tenant,
           to_regclass('public."DataMigrationState"') IS NOT NULL AS migration_state,
           to_regclass('public."ResearchBriefSnapshot"') IS NOT NULL AS research_brief,
           to_regclass('public."IntelligenceItem"') IS NOT NULL AS intelligence,
           to_regclass('public."StakeholderFocus"') IS NOT NULL AS focus
  `);
  const state = exists[0];
  if (!state?.intelligence && !state?.focus) {
    process.stdout.write(state?.tenant && state.migration_state && state.research_brief
      ? 'legacy' : 'uninitialized');
  } else if (!state.tenant || !state.migration_state || !state.research_brief) {
    process.stdout.write('partial');
  } else if (!state.intelligence || !state.focus) {
    process.stdout.write('partial');
  } else {
    const [intelligenceExact, focusExact] = await Promise.all([
      tableState('IntelligenceItem', expectedIntelligenceColumns, expectedIntelligenceIndexes),
      tableState('StakeholderFocus', expectedFocusColumns, expectedFocusIndexes),
    ]);
    process.stdout.write(intelligenceExact && focusExact ? 'expanded' : 'partial');
  }
} finally {
  await prisma.$disconnect();
}
