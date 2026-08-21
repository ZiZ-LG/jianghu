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
          AND table_name IN (
            'MethodologyPack', 'MethodologyPackVersion',
            'MethodologyBinding', 'MethodologyPilotAssignment'
          )) AS "tableCount",
      (SELECT COUNT(*)
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'MethodologyPack_tenantId_currentPublishedVersionId_idx',
            'MethodologyPack_tenantId_archivedAt_idx',
            'MethodologyPack_tenantId_id_key',
            'MethodologyPack_tenantId_key_key',
            'MethodologyPackVersion_tenantId_packId_status_idx',
            'MethodologyPackVersion_tenantId_sourceTemplateRef_idx',
            'MethodologyPackVersion_tenantId_id_key',
            'MethodologyPackVersion_tenantId_packId_id_key',
            'MethodologyPackVersion_tenantId_packId_versionKey_key',
            'MethodologyBinding_tenantId_opportunityId_createdAt_idx',
            'MethodologyBinding_tenantId_packId_versionId_idx',
            'MethodologyBinding_tenantId_decisionProfileRef_idx',
            'MethodologyBinding_tenantId_id_key',
            'MethodologyPilotAssignment_tenantId_opportunityId_status_idx',
            'MethodologyPilotAssignment_tenantId_candidatePackId_candida_idx',
            'MethodologyPilotAssignment_tenantId_baselineBindingId_idx',
            'MethodologyPilotAssignment_tenantId_id_key'
          )) AS "indexCount",
      (SELECT COUNT(*)
         FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND constraint_type = 'FOREIGN KEY'
          AND table_name IN (
            'MethodologyPackVersion', 'MethodologyBinding', 'MethodologyPilotAssignment'
          )) AS "foreignKeyCount"
  `);
  const tableCount = Number(rows[0]?.tableCount ?? 0);
  const indexCount = Number(rows[0]?.indexCount ?? 0);
  const foreignKeyCount = Number(rows[0]?.foreignKeyCount ?? 0);
  if (tableCount === 0 && indexCount === 0 && foreignKeyCount === 0) {
    process.stdout.write('legacy');
  } else if (tableCount === 4 && indexCount === 17 && foreignKeyCount === 7) {
    process.stdout.write('expanded');
  } else {
    process.stdout.write('partial');
  }
} finally {
  await prisma.$disconnect();
}
