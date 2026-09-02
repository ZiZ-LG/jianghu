import { prisma } from '../src/prisma.js';

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};
type IndexRow = { indexname: string };

const expectedColumns = new Map<string, { type: string; nullable: 'YES' | 'NO'; defaultValue?: string | null }>([
  ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['accountId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['matterId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['personId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['backingKind', { type: 'text', nullable: 'NO', defaultValue: null }],
  ['backingId', { type: 'text', nullable: 'NO', defaultValue: null }],
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
  ['createdByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['visibility', { type: 'text', nullable: 'NO', defaultValue: "'owner_admin_only'::text" }],
  ['aclVersion', { type: 'integer', nullable: 'NO', defaultValue: '1' }],
  ['createdAt', { type: 'timestamp without time zone', nullable: 'NO' }],
  ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
]);

const expectedIndexes = new Set([
  'SourceArtifact_pkey',
  'SourceArtifact_tenantId_accountId_idx',
  'SourceArtifact_tenantId_matterId_idx',
  'SourceArtifact_tenantId_personId_idx',
  'SourceArtifact_tenantId_createdByUserId_visibility_idx',
  'SourceArtifact_tenantId_visibility_aclVersion_idx',
  'SourceArtifact_tenantId_backingKind_backingId_key',
  'SourceArtifact_tenantId_domain_source_externalRef_key',
  'SourceArtifact_tenantId_artifactKind_createdAt_idx',
  'SourceArtifact_tenantId_retentionState_updatedAt_idx',
]);

try {
  const exists = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public."SourceArtifact"') IS NOT NULL AS exists`,
  );
  if (!exists[0]?.exists) {
    process.stdout.write('uninitialized');
  } else {
    const [columns, indexes] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'SourceArtifact'
         ORDER BY ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'SourceArtifact'
         ORDER BY indexname
      `),
    ]);
    const expansionNames = new Set([
      'artifactKind', 'source', 'externalRef', 'idempotencyDomain', 'title', 'occurredAt',
      'fingerprintKind', 'sourceFingerprint', 'retentionState', 'retentionUpdatedAt',
    ]);
    const expansionCount = columns.filter((column) => expansionNames.has(column.column_name)).length;
    if (expansionCount === 0) {
      process.stdout.write('legacy');
    } else {
      const columnsMatch = columns.length === expectedColumns.size && columns.every((column) => {
        const expected = expectedColumns.get(column.column_name);
        if (!expected || expected.type !== column.data_type || expected.nullable !== column.is_nullable) return false;
        if ('defaultValue' in expected) return column.column_default === expected.defaultValue;
        return typeof column.column_default === 'string' && column.column_default.includes('CURRENT_TIMESTAMP');
      });
      const indexNames = new Set(indexes.map((index) => index.indexname));
      const indexesMatch = indexNames.size === expectedIndexes.size
        && [...expectedIndexes].every((name) => indexNames.has(name));
      process.stdout.write(columnsMatch && indexesMatch ? 'expanded' : 'partial');
    }
  }
} finally {
  await prisma.$disconnect();
}
