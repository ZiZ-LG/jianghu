import { prisma } from '../src/prisma.js';
import {
  applyAgentJobMigration,
  reportAgentJobMigration,
  verifyAgentJobMigration,
} from '../src/agents/migration.js';

const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode ?? '')) {
  console.error('usage: tsx scripts/migrate-agent-jobs.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  try {
    const result = mode === '--dry-run'
      ? await reportAgentJobMigration(prisma)
      : mode === '--apply'
        ? await applyAgentJobMigration(prisma)
        : await verifyAgentJobMigration(prisma);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
