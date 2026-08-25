import { prisma } from '../src/prisma.js';
import { inspectCandidateMigration } from '../src/candidates/migration.js';

type Mode = 'dry-run' | 'verify';

function selectedMode(args: readonly string[]): Mode {
  if (args.length !== 1 || (args[0] !== '--dry-run' && args[0] !== '--verify')) {
    throw new Error('usage: migrate-candidates.ts --dry-run|--verify');
  }
  return args[0] === '--dry-run' ? 'dry-run' : 'verify';
}

async function run(mode: Mode): Promise<void> {
  const report = await inspectCandidateMigration(prisma);
  const ok = report.invalidRows.length === 0
    && report.sourceRows === report.projectedRows;
  console.log(JSON.stringify({
    ok,
    mode,
    authority: 'legacy_candidate_tables',
    writes: 0,
    ...report,
  }, null, 2));
  if (mode === 'verify' && !ok) process.exitCode = 1;
}

try {
  const mode = selectedMode(process.argv.slice(2));
  await run(mode);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
