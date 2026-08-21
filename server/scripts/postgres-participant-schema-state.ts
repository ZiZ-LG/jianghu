import { prisma } from '../src/prisma.js';

type CountRow = {
  tableCount: number | bigint | string;
  edgeColumnCount: number | bigint | string;
  participantIndexCount: number | bigint | string;
  foreignKeyCount: number | bigint | string;
};

try {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT
      (SELECT COUNT(*)
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('MatterParticipant', 'DataMigrationState')) AS "tableCount",
      (SELECT COUNT(*)
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Edge'
          AND column_name = 'kind') AS "edgeColumnCount",
      (SELECT COUNT(*)
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'MatterParticipant'
          AND indexname IN (
            'MatterParticipant_tenantId_opportunityId_personId_key',
            'MatterParticipant_tenantId_accountId_opportunityId_idx',
            'MatterParticipant_tenantId_accountId_personId_idx',
            'MatterParticipant_tenantId_personId_idx'
          )) AS "participantIndexCount",
      (SELECT COUNT(*)
         FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'MatterParticipant'
          AND constraint_type = 'FOREIGN KEY'
          AND constraint_name IN (
            'MatterParticipant_tenantId_accountId_fkey',
            'MatterParticipant_tenantId_opportunityId_fkey',
            'MatterParticipant_tenantId_personId_fkey'
          )) AS "foreignKeyCount"
  `);
  const counts = rows[0];
  const tableCount = Number(counts?.tableCount ?? 0);
  const edgeColumnCount = Number(counts?.edgeColumnCount ?? 0);
  const participantIndexCount = Number(counts?.participantIndexCount ?? 0);
  const foreignKeyCount = Number(counts?.foreignKeyCount ?? 0);
  const total = tableCount + edgeColumnCount + participantIndexCount + foreignKeyCount;
  if (total === 0) process.stdout.write('legacy');
  else if (tableCount === 2 && edgeColumnCount === 1
    && participantIndexCount === 4 && foreignKeyCount === 3) process.stdout.write('expanded');
  else process.stdout.write('partial');
} finally {
  await prisma.$disconnect();
}
