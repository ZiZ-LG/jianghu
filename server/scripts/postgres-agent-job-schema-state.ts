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
  ['AgentJobDefinition', new Map([
    ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['jobKey', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['jobVersion', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['definitionJson', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['definitionHash', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['enabled', { type: 'boolean', nullable: 'NO', defaultValue: 'false' }],
    ['tenantLimitsJson', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['version', { type: 'integer', nullable: 'NO', defaultValue: '1' }],
    ['createdByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['updatedByUserId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
    ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ])],
  ['AgentRun', new Map([
    ['id', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['tenantId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['definitionId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['jobKey', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['jobVersion', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['definitionHash', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['definitionControlVersion', { type: 'integer', nullable: 'NO', defaultValue: null }],
    ['actionMode', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['trigger', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['status', { type: 'text', nullable: 'NO', defaultValue: "'running'::text" }],
    ['customerId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['matterId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['sourceArtifactId', { type: 'text', nullable: 'YES', defaultValue: null }],
    ['actorId', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['idempotencyKey', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['requestHash', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['attemptCount', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
    ['maxAttempts', { type: 'integer', nullable: 'NO', defaultValue: null }],
    ['leaseToken', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
    ['leaseExpiresAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
    ['budgetLimit', { type: 'integer', nullable: 'NO', defaultValue: null }],
    ['costUsed', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
    ['timeoutMs', { type: 'integer', nullable: 'NO', defaultValue: null }],
    ['authorizationFingerprint', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['inputRefs', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['evidenceRefs', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
    ['outputRefs', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
    ['modelRef', { type: 'text', nullable: 'NO', defaultValue: null }],
    ['connectorRefs', { type: 'text', nullable: 'NO', defaultValue: "'[]'::text" }],
    ['failureCode', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
    ['startedAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
    ['completedAt', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
    ['version', { type: 'integer', nullable: 'NO', defaultValue: '0' }],
    ['createdAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP' }],
    ['updatedAt', { type: 'timestamp without time zone', nullable: 'NO', defaultValue: null }],
  ])],
]);

const expectedIndexes = new Set([
  'AgentJobDefinition_pkey',
  'AgentJobDefinition_tenantId_jobKey_jobVersion_key',
  'AgentJobDefinition_tenantId_enabled_jobKey_idx',
  'AgentJobDefinition_tenantId_updatedAt_idx',
  'AgentRun_pkey',
  'AgentRun_tenantId_actorId_jobKey_jobVersion_idempotencyKey_key',
  'AgentRun_tenantId_status_createdAt_idx',
  'AgentRun_tenantId_customerId_createdAt_idx',
  'AgentRun_tenantId_matterId_createdAt_idx',
  'AgentRun_tenantId_sourceArtifactId_createdAt_idx',
  'AgentRun_tenantId_actorId_createdAt_idx',
  'AgentRun_tenantId_definitionId_idx',
]);

try {
  const exists = await prisma.$queryRawUnsafe<Array<{
    tenant: boolean;
    review_batch: boolean;
    agent_definition: boolean;
    agent_run: boolean;
  }>>(`
    SELECT to_regclass('public."Tenant"') IS NOT NULL AS tenant,
           to_regclass('public."ReviewBatch"') IS NOT NULL AS review_batch,
           to_regclass('public."AgentJobDefinition"') IS NOT NULL AS agent_definition,
           to_regclass('public."AgentRun"') IS NOT NULL AS agent_run
  `);
  const state = exists[0];
  // A predecessor older than CORE-205 legitimately has neither ReviewBatch nor
  // either Agent table. Treat that as pre-foundation/uninitialized; dependency
  // absence becomes partial only once an Agent table has appeared.
  if (!state?.agent_definition && !state?.agent_run) {
    process.stdout.write(state?.tenant && state.review_batch ? 'legacy' : 'uninitialized');
  } else if (!state?.tenant || !state.review_batch
    || !state.agent_definition || !state.agent_run) {
    process.stdout.write('partial');
  } else {
    const [columns, indexes] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('AgentJobDefinition', 'AgentRun')
         ORDER BY table_name, ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT tablename, indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ('AgentJobDefinition', 'AgentRun')
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
