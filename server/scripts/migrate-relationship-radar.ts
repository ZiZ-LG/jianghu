import { prisma } from '../src/prisma.js';
import {
  applyRelationshipRadarMigration,
  reportRelationshipRadarMigration,
  verifyRelationshipRadarMigration,
} from '../src/relationshipRadar/migration.js';

const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode ?? '')) {
  console.error('usage: tsx scripts/migrate-relationship-radar.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  try {
    const result = mode === '--dry-run'
      ? await reportRelationshipRadarMigration(prisma)
      : mode === '--apply'
        ? await applyRelationshipRadarMigration(prisma)
        : await verifyRelationshipRadarMigration(prisma);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
