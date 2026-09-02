import { prisma } from '../src/prisma.js';
import {
  applyIntelligenceFocusMigration,
  reportIntelligenceFocusMigration,
  verifyIntelligenceFocusMigration,
} from '../src/intelligenceFocus/migration.js';

const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode ?? '')) {
  console.error('usage: tsx scripts/migrate-intelligence-focus.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  try {
    const result = mode === '--dry-run'
      ? await reportIntelligenceFocusMigration(prisma)
      : mode === '--apply'
        ? await applyIntelligenceFocusMigration(prisma)
        : await verifyIntelligenceFocusMigration(prisma);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
