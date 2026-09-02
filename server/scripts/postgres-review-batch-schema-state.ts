import { prisma } from '../src/prisma.js';

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};
type IndexRow = { tablename: string; indexname: string };

type ExpectedColumn = {
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null | 'CURRENT_TIMESTAMP';
};

const expectedColumns = new Map<string, Map<string, ExpectedColumn>>([
  ['ReviewBatch', new Map([
    ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['sourceArtifactId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['accountId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['matterId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['status', { type: 'text', nullable: 'NO', defaultValue: "'pending'::text" }],
    ['activityKind', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
    ['occurredAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
    ['interactionId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['createdByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['visibility', { type: 'text', nullable: 'NO', defaultValue: "'owner_admin_only'::text" }],
    ['aclVersion', { type: 'integer', nullable: 'NO', defaultValue: '1' }],
    ['acceptanceVersion', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
    ['version', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
    ['lastAcceptanceVersion', { type: 'integer', nullable: 'YES', defaultValue: null }],
    ['lastAcceptanceHash', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
    ['lastAcceptanceResult', { type: 'text', nullable: 'NO', defaultValue: "'{}'::text" }],
    ['reviewedByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['reviewedAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
    ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
    ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ])],
  ['Interaction', new Map([
    ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['accountId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['matterId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['sourceArtifactId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['activityKind', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['occurredAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
    ['title', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
    ['createdByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['confirmedByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['version', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
    ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
    ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ])],
]);

const expectedIndexes = new Set([
  'ReviewBatch_pkey',
  'ReviewBatch_tenantId_sourceArtifactId_status_idx',
  'ReviewBatch_tenantId_accountId_status_createdAt_idx',
  'ReviewBatch_tenantId_matterId_status_createdAt_idx',
  'ReviewBatch_tenantId_createdByUserId_visibility_idx',
  'ReviewBatch_tenantId_interactionId_idx',
  'Interaction_pkey',
  'Interaction_tenantId_sourceArtifactId_idx',
  'Interaction_tenantId_accountId_occurredAt_idx',
  'Interaction_tenantId_matterId_occurredAt_idx',
  'Interaction_tenantId_createdByUserId_idx',
]);

try {
  const exists = await prisma.$queryRawUnsafe<Array<{
    candidate: boolean;
    source_artifact: boolean;
    review_batch: boolean;
    interaction: boolean;
  }>>(`
    SELECT to_regclass('public."Candidate"') IS NOT NULL AS candidate,
           to_regclass('public."SourceArtifact"') IS NOT NULL AS source_artifact,
           to_regclass('public."ReviewBatch"') IS NOT NULL AS review_batch,
           to_regclass('public."Interaction"') IS NOT NULL AS interaction
  `);
  const state = exists[0];
  if (!state?.candidate && !state?.source_artifact && !state?.review_batch && !state?.interaction) {
    process.stdout.write('uninitialized');
  } else if (!state?.candidate || !state?.source_artifact) {
    process.stdout.write('partial');
  } else if (!state.review_batch && !state.interaction) {
    process.stdout.write('legacy');
  } else if (!state.review_batch || !state.interaction) {
    process.stdout.write('partial');
  } else {
    const [columns, indexes] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('ReviewBatch', 'Interaction')
         ORDER BY table_name, ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT tablename, indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ('ReviewBatch', 'Interaction')
         ORDER BY tablename, indexname
      `),
    ]);
    const columnsMatch = [...expectedColumns].every(([table, expected]) => {
      const actual = columns.filter((column) => column.table_name === table);
      return actual.length === expected.size && actual.every((column) => {
        const value = expected.get(column.column_name);
        if (!value || value.type !== column.data_type || value.nullable !== column.is_nullable) return false;
        return value.defaultValue === 'CURRENT_TIMESTAMP'
          ? Boolean(column.column_default?.includes('CURRENT_TIMESTAMP'))
          : value.defaultValue === column.column_default;
      });
    });
    const indexNames = new Set(indexes.map((index) => index.indexname));
    const indexesMatch = indexNames.size === expectedIndexes.size
      && [...expectedIndexes].every((name) => indexNames.has(name));
    process.stdout.write(columnsMatch && indexesMatch ? 'expanded' : 'partial');
  }
} finally {
  await prisma.$disconnect();
}
