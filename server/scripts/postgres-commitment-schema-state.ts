import { prisma } from '../src/prisma.js';

type CountRow = {
  columnCount: number | bigint | string;
  indexCount: number | bigint | string;
  opportunityNullable: string | null;
};

try {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT
      (SELECT COUNT(*)
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'PlanAction'
          AND column_name IN (
            'kind', 'ownerUserId', 'executionStatus', 'confirmationStatus',
            'scheduledAtUtc', 'dueAtUtc', 'timeZone', 'isAllDay', 'localDate',
            'confirmationDueAtUtc', 'confirmedAtUtc', 'confirmedByUserId',
            'scheduleVersion', 'nextCommitmentId', 'source', 'sourceRef',
            'archivedAt', 'version'
          )) AS "columnCount",
      (SELECT COUNT(*)
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'PlanAction'
          AND indexname IN (
            'PlanAction_tenantId_ownerUserId_executionStatus_idx',
            'PlanAction_tenantId_confirmationStatus_confirmationDueAtUtc_idx',
            'PlanAction_tenantId_executionStatus_dueAtUtc_idx',
            'PlanAction_tenantId_executionStatus_localDate_idx',
            'PlanAction_tenantId_nextCommitmentId_idx'
          )) AS "indexCount",
      (SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'PlanAction'
          AND column_name = 'opportunityId') AS "opportunityNullable"
  `);
  const columnCount = Number(rows[0]?.columnCount ?? 0);
  const indexCount = Number(rows[0]?.indexCount ?? 0);
  if (columnCount === 0 && indexCount === 0) process.stdout.write('legacy');
  else if (columnCount === 18 && indexCount === 5 && rows[0]?.opportunityNullable === 'NO') {
    process.stdout.write('expanded_required');
  } else if (columnCount === 18 && indexCount === 5 && rows[0]?.opportunityNullable === 'YES') {
    process.stdout.write('expanded_nullable');
  } else process.stdout.write('partial');
} finally {
  await prisma.$disconnect();
}
