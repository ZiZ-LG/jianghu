import { prisma } from '../src/prisma.js';

type Row = { migration_name: string };

try {
  const table = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present
  `;
  if (table[0]?.present) {
    const rows = await prisma.$queryRawUnsafe<Row[]>(`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
      ORDER BY migration_name
    `);
    process.stdout.write(rows.map((row) => row.migration_name).join('\n'));
  }
} finally {
  await prisma.$disconnect();
}
