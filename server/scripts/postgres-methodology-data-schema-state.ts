import { prisma } from '../src/prisma.js';

type CountRow = {
  tableCount: number | bigint | string;
  indexCount: number | bigint | string;
  foreignKeyCount: number | bigint | string;
};

const tables = `
  'MethodologyFieldDefinition',
  'MethodologyStageDefinition',
  'MethodologyRoleDefinition',
  'MethodologyRuleDefinition',
  'MethodologyActionTemplate',
  'MethodologyStageState',
  'MethodologyRoleAssignment',
  'MethodologyValue',
  'MethodologyEvaluation',
  'MethodologyMigrationRun'
`;

try {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT
      (SELECT COUNT(*)
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (${tables})) AS "tableCount",
      (SELECT COUNT(*)
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN (${tables})) AS "indexCount",
      (SELECT COUNT(*)
         FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND constraint_type = 'FOREIGN KEY'
          AND table_name IN (${tables})) AS "foreignKeyCount"
  `);
  const tableCount = Number(rows[0]?.tableCount ?? 0);
  const indexCount = Number(rows[0]?.indexCount ?? 0);
  const foreignKeyCount = Number(rows[0]?.foreignKeyCount ?? 0);
  if (tableCount === 0 && indexCount === 0 && foreignKeyCount === 0) {
    process.stdout.write('legacy');
  } else if (tableCount === 10 && indexCount === 48 && foreignKeyCount === 20) {
    process.stdout.write('expanded');
  } else {
    process.stdout.write('partial');
  }
} finally {
  await prisma.$disconnect();
}
