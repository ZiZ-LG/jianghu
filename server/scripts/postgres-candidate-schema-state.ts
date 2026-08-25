import { prisma } from '../src/prisma.js';

type TableRow = { tenant_exists: boolean; candidate_exists: boolean };
type ColumnRow = { column_name: string; data_type: string; is_nullable: 'YES' | 'NO' };
type IndexRow = { indexname: string };
type ConstraintRow = { contype: string; definition: string };

const expectedColumns = new Map<string, { type: string; nullable: 'YES' | 'NO' }>([
  ['id', { type: 'text', nullable: 'NO' }],
  ['tenantId', { type: 'text', nullable: 'NO' }],
  ['kind', { type: 'text', nullable: 'NO' }],
  ['status', { type: 'text', nullable: 'NO' }],
  ['accountId', { type: 'text', nullable: 'NO' }],
  ['matterId', { type: 'text', nullable: 'YES' }],
  ['targetKind', { type: 'text', nullable: 'NO' }],
  ['targetId', { type: 'text', nullable: 'YES' }],
  ['fieldKey', { type: 'text', nullable: 'YES' }],
  ['oldValue', { type: 'text', nullable: 'YES' }],
  ['newValue', { type: 'text', nullable: 'YES' }],
  ['payload', { type: 'text', nullable: 'NO' }],
  ['source', { type: 'text', nullable: 'NO' }],
  ['sourceRef', { type: 'text', nullable: 'NO' }],
  ['evidence', { type: 'text', nullable: 'NO' }],
  ['confidence', { type: 'double precision', nullable: 'NO' }],
  ['sourceArtifactId', { type: 'text', nullable: 'YES' }],
  ['reviewBatchId', { type: 'text', nullable: 'YES' }],
  ['createdByUserId', { type: 'text', nullable: 'YES' }],
  ['visibility', { type: 'text', nullable: 'NO' }],
  ['dedupeKey', { type: 'text', nullable: 'NO' }],
  ['legacySourceKind', { type: 'text', nullable: 'YES' }],
  ['legacySourceId', { type: 'text', nullable: 'YES' }],
  ['version', { type: 'integer', nullable: 'NO' }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO' }],
  ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO' }],
]);

const expectedIndexes = new Set([
  'Candidate_pkey',
  'Candidate_tenantId_status_createdAt_idx',
  'Candidate_tenantId_accountId_status_createdAt_idx',
  'Candidate_tenantId_matterId_status_createdAt_idx',
  'Candidate_tenantId_sourceArtifactId_idx',
  'Candidate_tenantId_reviewBatchId_idx',
  'Candidate_tenantId_createdByUserId_visibility_idx',
  'Candidate_tenantId_dedupeKey_key',
  'Candidate_tenantId_legacySourceKind_legacySourceId_key',
]);

try {
  const tables = await prisma.$queryRawUnsafe<TableRow[]>(`
    SELECT
      to_regclass('public."Tenant"') IS NOT NULL AS tenant_exists,
      to_regclass('public."Candidate"') IS NOT NULL AS candidate_exists
  `);
  const tableState = tables[0];
  if (!tableState?.tenant_exists && !tableState?.candidate_exists) {
    process.stdout.write('uninitialized');
  } else if (tableState?.tenant_exists && !tableState.candidate_exists) {
    process.stdout.write('legacy');
  } else if (!tableState?.tenant_exists || !tableState.candidate_exists) {
    process.stdout.write('partial');
  } else {
    const [columns, indexes, constraints] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Candidate'
        ORDER BY ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'Candidate'
        ORDER BY indexname
      `),
      prisma.$queryRawUnsafe<ConstraintRow[]>(`
        SELECT candidate_constraint.contype,
               pg_get_constraintdef(candidate_constraint.oid) AS definition
        FROM pg_constraint AS candidate_constraint
        JOIN pg_class AS relation ON relation.oid = candidate_constraint.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = 'Candidate'
        ORDER BY candidate_constraint.conname
      `),
    ]);
    const columnsMatch = columns.length === expectedColumns.size
      && columns.every((column) => {
        const expected = expectedColumns.get(column.column_name);
        return expected?.type === column.data_type && expected.nullable === column.is_nullable;
      });
    const indexNames = new Set(indexes.map((row) => row.indexname));
    const indexesMatch = indexNames.size === expectedIndexes.size
      && [...expectedIndexes].every((name) => indexNames.has(name));
    const primaryKeyMatches = constraints.some((row) => row.contype === 'p' && row.definition === 'PRIMARY KEY (id)');
    const tenantForeignKeyMatches = constraints.some((row) =>
      row.contype === 'f'
      && row.definition.includes('FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id)')
      && row.definition.includes('ON UPDATE CASCADE ON DELETE CASCADE'));
    if (columnsMatch && indexesMatch && primaryKeyMatches && tenantForeignKeyMatches) {
      process.stdout.write('expanded');
    } else {
      process.stdout.write('partial');
    }
  }
} finally {
  await prisma.$disconnect();
}
