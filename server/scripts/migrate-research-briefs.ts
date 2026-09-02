import { prisma } from '../src/prisma.js';
import {
  applyResearchBriefMigration,
  reportResearchBriefMigration,
  verifyResearchBriefMigration,
} from '../src/researchBriefs/migration.js';

const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode ?? '')) {
  console.error('usage: tsx scripts/migrate-research-briefs.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  try {
    const result = mode === '--dry-run'
      ? await reportResearchBriefMigration(prisma)
      : mode === '--apply'
        ? await applyResearchBriefMigration(prisma)
        : await verifyResearchBriefMigration(prisma);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
