import { prisma } from '../src/prisma.js';
import {
  applyCandidateMigration,
  inspectCandidateMigration,
  verifyCandidateMigration,
} from '../src/candidates/migration.js';

type Mode = 'dry-run' | 'apply' | 'verify';

function selectedMode(args: readonly string[]): Mode {
  if (args.length !== 1 || !['--dry-run', '--apply', '--verify'].includes(args[0]!)) {
    throw new Error('usage: migrate-candidates.ts --dry-run|--apply|--verify');
  }
  return args[0]!.slice(2) as Mode;
}

async function run(mode: Mode): Promise<void> {
  if (mode === 'dry-run') {
    const report = await inspectCandidateMigration(prisma);
    const ok = report.invalidRows.length === 0 && report.sourceRows === report.projectedRows;
    console.log(JSON.stringify({
      ok,
      mode,
      authority: 'legacy_candidate_tables',
      markerPresent: false,
      writes: 0,
      ...report,
    }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  const result = mode === 'apply'
    ? await applyCandidateMigration(prisma)
    : { ...await verifyCandidateMigration(prisma), writes: 0 };
  console.log(JSON.stringify({
    ok: result.ok,
    mode,
    authority: 'Candidate',
    markerPresent: result.markerPresent,
    writes: result.writes,
    conflicts: result.conflicts,
    ...result.report,
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
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
