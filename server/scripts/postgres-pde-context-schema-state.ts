import { prisma } from '../src/prisma.js';

type CountRow = {
  tableCount: number | bigint | string;
  indexCount: number | bigint | string;
  foreignKeyCount: number | bigint | string;
};

try {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT
      (SELECT COUNT(*)
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'PdeDecisionContext') AS "tableCount",
      (SELECT COUNT(*)
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'PdeDecisionContext_pkey',
            'PdeDecisionContext_tenantId_id_key',
            'PdeDecisionContext_tenantId_opportunityId_key',
            'PdeDecisionContext_tenantId_decisionProfileRef_idx',
            'PdeDecisionContext_tenantId_stageKey_idx',
            'IndustryPack_tenantId_id_key'
          )) AS "indexCount",
      (SELECT COUNT(*)
         FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND constraint_type = 'FOREIGN KEY'
          AND table_name = 'PdeDecisionContext') AS "foreignKeyCount"
  `);
  const tableCount = Number(rows[0]?.tableCount ?? 0);
  const indexCount = Number(rows[0]?.indexCount ?? 0);
  const foreignKeyCount = Number(rows[0]?.foreignKeyCount ?? 0);
  if (tableCount === 0 && indexCount === 0 && foreignKeyCount === 0) {
    process.stdout.write('legacy');
  } else if (tableCount === 1 && indexCount === 6 && foreignKeyCount === 2) {
    process.stdout.write('expanded');
  } else {
    process.stdout.write('partial');
  }
} finally {
  await prisma.$disconnect();
}
