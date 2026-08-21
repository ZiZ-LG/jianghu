import { prisma } from '../src/prisma.js';

type CountRow = { columnCount: number | bigint | string; indexCount: number | bigint | string };

try {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT
      (SELECT COUNT(*)
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Opportunity'
          AND column_name IN (
            'kind', 'lifecycleStatus', 'outcomeKey', 'priority', 'targetDate',
            'primaryOwnerUserId', 'activeMethodologyBindingId'
          )) AS "columnCount",
      (SELECT COUNT(*)
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'Opportunity'
          AND indexname IN (
            'Opportunity_tenantId_kind_lifecycleStatus_idx',
            'Opportunity_tenantId_primaryOwnerUserId_idx',
            'Opportunity_tenantId_targetDate_idx',
            'Opportunity_tenantId_activeMethodologyBindingId_idx'
          )) AS "indexCount"
  `);
  const columnCount = Number(rows[0]?.columnCount ?? 0);
  const indexCount = Number(rows[0]?.indexCount ?? 0);
  if (columnCount === 0 && indexCount === 0) process.stdout.write('legacy');
  else if (columnCount === 7 && indexCount === 4) process.stdout.write('expanded');
  else process.stdout.write('partial');
} finally {
  await prisma.$disconnect();
}
