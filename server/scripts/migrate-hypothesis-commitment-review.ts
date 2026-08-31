import { prisma } from '../src/prisma.js';
import {
  applyHypothesisCommitmentReviewMigration,
  reportHypothesisCommitmentReviewMigration,
  verifyHypothesisCommitmentReviewMigration,
} from '../src/relationshipWorkspace/migration.js';

const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode ?? '')) {
  console.error('usage: tsx scripts/migrate-hypothesis-commitment-review.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  try {
    const result = mode === '--dry-run'
      ? await reportHypothesisCommitmentReviewMigration(prisma)
      : mode === '--apply'
        ? await applyHypothesisCommitmentReviewMigration(prisma)
        : await verifyHypothesisCommitmentReviewMigration(prisma);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
