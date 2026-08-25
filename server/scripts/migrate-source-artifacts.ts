import { prisma } from '../src/prisma.js';
import {
  applySourceArtifactMigration,
  reportSourceArtifactMigration,
  verifySourceArtifactMigration,
} from '../src/sourceArtifacts/migration.js';

type Mode = 'dry-run' | 'apply' | 'verify';

function selectedMode(args: readonly string[]): Mode {
  if (args.length !== 1 || !['--dry-run', '--apply', '--verify'].includes(args[0]!)) {
    throw new Error('usage: migrate-source-artifacts.ts --dry-run|--apply|--verify');
  }
  return args[0]!.slice(2) as Mode;
}

async function run(mode: Mode): Promise<void> {
  const result = mode === 'dry-run'
    ? await reportSourceArtifactMigration(prisma)
    : mode === 'apply'
      ? await applySourceArtifactMigration(prisma)
      : await verifySourceArtifactMigration(prisma);
  console.log(JSON.stringify({
    ...result,
    mode,
    authority: 'source_artifact_projection',
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
