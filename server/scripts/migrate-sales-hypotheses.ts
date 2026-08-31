import { prisma } from '../src/prisma.js';
import {
  applySalesHypothesisMigration,
  reportSalesHypothesisMigration,
  verifySalesHypothesisMigration,
} from '../src/hypotheses/migration.js';

const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode ?? '')) {
  console.error('usage: tsx scripts/migrate-sales-hypotheses.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  try {
    const result = mode === '--dry-run'
      ? await reportSalesHypothesisMigration(prisma)
      : mode === '--apply'
        ? await applySalesHypothesisMigration(prisma)
        : await verifySalesHypothesisMigration(prisma);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
