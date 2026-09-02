import { prisma } from '../src/prisma.js';
import {
  applyReviewBatchMigration,
  reportReviewBatchMigration,
  verifyReviewBatchMigration,
} from '../src/reviewBatches/migration.js';

type Mode = 'dry-run' | 'apply' | 'verify';

function selectedMode(args: readonly string[]): Mode {
  if (args.length !== 1 || !['--dry-run', '--apply', '--verify'].includes(args[0]!)) {
    throw new Error('usage: migrate-review-batches.ts --dry-run|--apply|--verify');
  }
  return args[0]!.slice(2) as Mode;
}

async function run(mode: Mode): Promise<void> {
  const result = mode === 'dry-run'
    ? await reportReviewBatchMigration(prisma)
    : mode === 'apply'
      ? await applyReviewBatchMigration(prisma)
      : await verifyReviewBatchMigration(prisma);
  console.log(JSON.stringify({
    ...result,
    mode,
    authority: 'review_batch_interaction',
    writes: 'writes' in result ? result.writes : 0,
  }, null, 2));
  if (!result.ok || (mode === 'verify' && !result.markerPresent)) process.exitCode = 1;
}

try {
  await run(selectedMode(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
