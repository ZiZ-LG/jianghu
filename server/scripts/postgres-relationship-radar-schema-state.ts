import { prisma } from '../src/prisma.js';

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};
type IndexRow = { indexname: string };
type ExpectedColumn = {
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null | 'CURRENT_TIMESTAMP';
};

const expectedColumns = new Map<string, ExpectedColumn>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['customerId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['matterId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['createdByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['agentRunId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['generationKey', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['payloadJson', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['payloadFingerprint', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['sourceSetHash', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['signalCount', { type: 'integer', nullable: 'NO', defaultValue: null }],
  ['interventionCount', { type: 'integer', nullable: 'NO', defaultValue: null }],
  ['draftCount', { type: 'integer', nullable: 'NO', defaultValue: null }],
  ['ruleVersion', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['generatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ['expiresAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ['version', { type: 'integer', nullable: 'NO', defaultValue: '1' }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
]);

const expectedIndexes = new Set([
  'RelationshipRadarSnapshot_pkey',
  'rrs_tenant_customer_matter_generated_idx',
  'rrs_tenant_matter_expires_idx',
  'rrs_tenant_run_key',
  'rrs_tenant_creator_generation_key',
]);

try {
  const exists = await prisma.$queryRawUnsafe<Array<{
    tenant: boolean;
    migration_state: boolean;
    agent_run: boolean;
    commitment: boolean;
    intelligence: boolean;
    focus: boolean;
    radar: boolean;
  }>>(`
    SELECT to_regclass('public."Tenant"') IS NOT NULL AS tenant,
           to_regclass('public."DataMigrationState"') IS NOT NULL AS migration_state,
           to_regclass('public."AgentRun"') IS NOT NULL AS agent_run,
           to_regclass('public."PlanAction"') IS NOT NULL AS commitment,
           to_regclass('public."IntelligenceItem"') IS NOT NULL AS intelligence,
           to_regclass('public."StakeholderFocus"') IS NOT NULL AS focus,
           to_regclass('public."RelationshipRadarSnapshot"') IS NOT NULL AS radar
  `);
  const state = exists[0];
  const dependencies = Boolean(state?.tenant && state.migration_state && state.agent_run
    && state.commitment && state.intelligence && state.focus);
  if (!state?.radar) {
    process.stdout.write(dependencies ? 'legacy' : 'uninitialized');
  } else if (!dependencies) {
    process.stdout.write('partial');
  } else {
    const [columns, indexes, foreignKeys] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'RelationshipRadarSnapshot'
         ORDER BY ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'RelationshipRadarSnapshot'
         ORDER BY indexname
      `),
      prisma.$queryRawUnsafe<Array<{
        foreign_table: string;
        source_column: string;
        target_column: string;
        delete_rule: string;
      }>>(`
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
           AND tc.table_name = 'RelationshipRadarSnapshot'
           AND tc.constraint_type = 'FOREIGN KEY'
      `),
    ]);
    const columnsMatch = columns.length === expectedColumns.size && columns.every((column) => {
      const expected = expectedColumns.get(column.column_name);
      if (!expected || expected.type !== column.data_type || expected.nullable !== column.is_nullable) return false;
      return expected.defaultValue === 'CURRENT_TIMESTAMP'
        ? Boolean(column.column_default?.includes('CURRENT_TIMESTAMP'))
        : expected.defaultValue === column.column_default;
    });
    const indexNames = new Set(indexes.map((index) => index.indexname));
    const indexesMatch = indexNames.size === expectedIndexes.size
      && [...expectedIndexes].every((name) => indexNames.has(name));
    const tenantFkMatches = foreignKeys.length === 1
      && foreignKeys[0]?.foreign_table === 'Tenant'
      && foreignKeys[0].source_column === 'tenantId'
      && foreignKeys[0].target_column === 'id'
      && foreignKeys[0].delete_rule === 'CASCADE';
    process.stdout.write(columnsMatch && indexesMatch && tenantFkMatches ? 'expanded' : 'partial');
  }
} finally {
  await prisma.$disconnect();
}
