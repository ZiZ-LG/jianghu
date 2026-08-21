import { prisma } from '../src/prisma.js';

type CountRow = {
  presentCount: number | bigint | string;
  validCount: number | bigint | string;
};

try {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT
      COUNT(*) AS "presentCount",
      COUNT(*) FILTER (
        WHERE data_type = 'text'
          AND is_nullable = 'NO'
          AND column_default LIKE '%legacy_tenant_shared%'
      ) AS "validCount"
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'Tenant'
       AND column_name = 'dataScopePolicy'
  `);
  const presentCount = Number(rows[0]?.presentCount ?? 0);
  const validCount = Number(rows[0]?.validCount ?? 0);
  if (presentCount === 0) {
    process.stdout.write('legacy');
  } else if (presentCount === 1 && validCount === 1) {
    process.stdout.write('expanded');
  } else {
    process.stdout.write('partial');
  }
} finally {
  await prisma.$disconnect();
}
