import { prisma } from '../src/prisma.js';

type RelationState = { business_schema: boolean; migration_history: boolean };

try {
  const [state] = await prisma.$queryRawUnsafe<RelationState[]>(`
    SELECT
      to_regclass('public."Tenant"') IS NOT NULL AS business_schema,
      to_regclass('public._prisma_migrations') IS NOT NULL AS migration_history
  `);
  if (!state?.business_schema) process.stdout.write('empty');
  else if (state.migration_history) process.stdout.write('tracked');
  else process.stdout.write('untracked');
} finally {
  await prisma.$disconnect();
}
