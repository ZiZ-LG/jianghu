import { prisma } from '../src/prisma.js';

type TableRow = {
  tenant_exists: boolean;
  candidate_exists: boolean;
  note_exists: boolean;
  transcript_exists: boolean;
  artifact_exists: boolean;
  grant_exists: boolean;
};
type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};
type IndexRow = { indexname: string };
type ForeignKeyRow = { table_name: string; definition: string };

type ExpectedDefault = 'none' | 'one' | 'quarantine' | 'system-domain';
const expectedColumns = new Map<string, {
  type: string;
  nullable: 'YES' | 'NO';
  default: ExpectedDefault;
}>([
  ['Candidate.aclVersion', { type: 'integer', nullable: 'NO', default: 'one' }],
  ['Candidate.visibility', { type: 'text', nullable: 'NO', default: 'quarantine' }],
  ['Note.createdByUserId', { type: 'text', nullable: 'YES', default: 'none' }],
  ['Note.visibility', { type: 'text', nullable: 'NO', default: 'quarantine' }],
  ['Note.aclVersion', { type: 'integer', nullable: 'NO', default: 'one' }],
  ['Transcript.createdByUserId', { type: 'text', nullable: 'YES', default: 'none' }],
  ['Transcript.idempotencyDomain', { type: 'text', nullable: 'NO', default: 'system-domain' }],
  ['Transcript.visibility', { type: 'text', nullable: 'NO', default: 'quarantine' }],
  ['Transcript.aclVersion', { type: 'integer', nullable: 'NO', default: 'one' }],
]);

function defaultMatches(actual: string | null, expected: ExpectedDefault): boolean {
  if (expected === 'none') return actual === null;
  if (expected === 'one') return actual === '1';
  if (expected === 'system-domain') return actual === "'system-quarantine-v1'::text";
  return actual === "'owner_admin_only'::text";
}

const expectedIndexes = new Set([
  'Candidate_tenantId_visibility_aclVersion_idx',
  'Note_tenantId_createdByUserId_visibility_idx',
  'Note_tenantId_visibility_aclVersion_idx',
  'Transcript_tenantId_createdByUserId_visibility_idx',
  'Transcript_tenantId_idempotencyDomain_source_externalRef_key',
  'Transcript_tenantId_visibility_aclVersion_idx',
  'SourceArtifact_tenantId_accountId_idx',
  'SourceArtifact_tenantId_matterId_idx',
  'SourceArtifact_tenantId_personId_idx',
  'SourceArtifact_tenantId_createdByUserId_visibility_idx',
  'SourceArtifact_tenantId_visibility_aclVersion_idx',
  'SourceArtifact_tenantId_backingKind_backingId_key',
  'SensitiveResourceGrant_tenantId_resourceKind_resourceId_res_idx',
  'SensitiveResourceGrant_tenantId_granteeUserId_grantKind_rev_idx',
  'SensitiveResourceGrant_tenantId_resourceKind_resourceId_gra_key',
]);

type SourceColumnExpectation = {
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue?: string | null;
};
const sourceArtifactBaseColumns = new Map<string, SourceColumnExpectation>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['accountId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['matterId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['personId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['backingKind', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['backingId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['createdByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['visibility', { type: 'text', nullable: 'NO', defaultValue: "'owner_admin_only'::text" }],
  ['aclVersion', { type: 'integer', nullable: 'NO', defaultValue: '1' }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO' }],
  ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
]);
const sourceArtifactSuccessorColumns = new Map(sourceArtifactBaseColumns);
for (const [name, expectation] of [
  ['artifactKind', { type: 'text', nullable: 'NO', defaultValue: "'external_reference'::text" }],
  ['source', { type: 'text', nullable: 'NO', defaultValue: "'legacy'::text" }],
  ['externalRef', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['idempotencyDomain', { type: 'text', nullable: 'NO', defaultValue: "'system-quarantine-v1'::text" }],
  ['title', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
  ['occurredAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['fingerprintKind', { type: 'text', nullable: 'NO', defaultValue: "'reference_sha256_v1'::text" }],
  ['sourceFingerprint', {
    type: 'text', nullable: 'NO',
    defaultValue: "'0000000000000000000000000000000000000000000000000000000000000000'::text",
  }],
  ['retentionState', { type: 'text', nullable: 'NO', defaultValue: "'reference_only'::text" }],
  ['retentionUpdatedAt', { type: 'timestamp without time zone', nullable: 'NO' }],
] satisfies Array<[string, SourceColumnExpectation]>) {
  sourceArtifactSuccessorColumns.set(name, expectation);
}
const sourceArtifactBaseIndexes = new Set([
  'SourceArtifact_pkey',
  'SourceArtifact_tenantId_accountId_idx',
  'SourceArtifact_tenantId_matterId_idx',
  'SourceArtifact_tenantId_personId_idx',
  'SourceArtifact_tenantId_createdByUserId_visibility_idx',
  'SourceArtifact_tenantId_visibility_aclVersion_idx',
  'SourceArtifact_tenantId_backingKind_backingId_key',
]);
const sourceArtifactSuccessorIndexes = new Set([
  ...sourceArtifactBaseIndexes,
  'SourceArtifact_tenantId_domain_source_externalRef_key',
  'SourceArtifact_tenantId_artifactKind_createdAt_idx',
  'SourceArtifact_tenantId_retentionState_updatedAt_idx',
]);

function exactSourceArtifactShape(
  columns: ColumnRow[],
  indexNames: Set<string>,
  expectedColumns: Map<string, SourceColumnExpectation>,
  expectedSourceIndexes: Set<string>,
): boolean {
  return columns.length === expectedColumns.size
    && columns.every((column) => {
      const expected = expectedColumns.get(column.column_name);
      if (!expected || expected.type !== column.data_type || expected.nullable !== column.is_nullable) return false;
      if ('defaultValue' in expected) return column.column_default === expected.defaultValue;
      return typeof column.column_default === 'string' && column.column_default.includes('CURRENT_TIMESTAMP');
    })
    && indexNames.size === expectedSourceIndexes.size
    && [...expectedSourceIndexes].every((name) => indexNames.has(name));
}

try {
  const [tableRow] = await prisma.$queryRawUnsafe<TableRow[]>(`
    SELECT
      to_regclass('public."Tenant"') IS NOT NULL AS tenant_exists,
      to_regclass('public."Candidate"') IS NOT NULL AS candidate_exists,
      to_regclass('public."Note"') IS NOT NULL AS note_exists,
      to_regclass('public."Transcript"') IS NOT NULL AS transcript_exists,
      to_regclass('public."SourceArtifact"') IS NOT NULL AS artifact_exists,
      to_regclass('public."SensitiveResourceGrant"') IS NOT NULL AS grant_exists
  `);
  const base = Boolean(tableRow?.tenant_exists && tableRow.note_exists && tableRow.transcript_exists);
  if (!tableRow?.tenant_exists && !tableRow?.candidate_exists && !tableRow?.note_exists
    && !tableRow?.transcript_exists && !tableRow?.artifact_exists && !tableRow?.grant_exists) {
    process.stdout.write('uninitialized');
  } else if (!base) {
    process.stdout.write('partial');
  } else {
    const [columns, sourceArtifactColumns, indexes, foreignKeys] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'Candidate' AND column_name IN ('aclVersion', 'visibility'))
            OR (table_name = 'Note'
              AND column_name IN ('createdByUserId', 'visibility', 'aclVersion'))
            OR (table_name = 'Transcript'
              AND column_name IN ('createdByUserId', 'visibility', 'aclVersion', 'idempotencyDomain'))
          )
        ORDER BY table_name, column_name
      `),
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'SourceArtifact'
        ORDER BY ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('Candidate', 'Note', 'Transcript', 'SourceArtifact', 'SensitiveResourceGrant')
        ORDER BY indexname
      `),
      prisma.$queryRawUnsafe<ForeignKeyRow[]>(`
        SELECT relation.relname AS table_name,
               pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN ('SourceArtifact', 'SensitiveResourceGrant')
          AND constraint_row.contype = 'f'
        ORDER BY relation.relname, constraint_row.conname
      `),
    ]);
    const expansionColumns = columns.filter((column) =>
      !(column.table_name === 'Candidate' && column.column_name === 'visibility'));
    // A pre-CORE-201 database legitimately has no Candidate table yet. All
    // historical migrations are deployed in one Prisma invocation, so this
    // probe runs before the Candidate DDL during legacy adoption. Treat that
    // exact no-ACL shape as legacy; any ACL column/table fragment remains a
    // fail-closed partial state.
    const candidateVisibility = columns.find((column) =>
      column.table_name === 'Candidate' && column.column_name === 'visibility');
    const candidateHasLegacyShape = !tableRow.candidate_exists
      || (candidateVisibility?.data_type === 'text'
        && candidateVisibility.is_nullable === 'NO'
        && candidateVisibility.column_default === "'private'::text");
    const legacy = candidateHasLegacyShape
      && expansionColumns.length === 0
      && !tableRow.artifact_exists
      && !tableRow.grant_exists;
    if (legacy) {
      process.stdout.write('legacy');
    } else {
      const columnsMatch = columns.length === expectedColumns.size
        && columns.every((column) => {
          const expected = expectedColumns.get(`${column.table_name}.${column.column_name}`);
          return expected?.type === column.data_type
            && expected.nullable === column.is_nullable
            && defaultMatches(column.column_default, expected.default);
        });
      const indexNames = new Set(indexes.map((row) => row.indexname));
      const indexesMatch = [...expectedIndexes].every((name) => indexNames.has(name))
        && !indexNames.has('Transcript_tenantId_source_externalRef_key');
      const sourceArtifactIndexNames = new Set(
        indexes.filter((row) => row.indexname.startsWith('SourceArtifact_')).map((row) => row.indexname),
      );
      const sourceArtifactShapeMatches = exactSourceArtifactShape(
        sourceArtifactColumns,
        sourceArtifactIndexNames,
        sourceArtifactBaseColumns,
        sourceArtifactBaseIndexes,
      ) || exactSourceArtifactShape(
        sourceArtifactColumns,
        sourceArtifactIndexNames,
        sourceArtifactSuccessorColumns,
        sourceArtifactSuccessorIndexes,
      );
      const foreignKeysMatch = ['SourceArtifact', 'SensitiveResourceGrant'].every((table) =>
        foreignKeys.some((row) => row.table_name === table
          && row.definition.includes('FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id)')
          && row.definition.includes('ON UPDATE CASCADE ON DELETE CASCADE')));
      process.stdout.write(
        tableRow.candidate_exists && tableRow.artifact_exists && tableRow.grant_exists
          && columnsMatch && indexesMatch && sourceArtifactShapeMatches && foreignKeysMatch
          ? 'expanded'
          : 'partial',
      );
    }
  }
} finally {
  await prisma.$disconnect();
}
