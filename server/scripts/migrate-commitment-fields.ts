import { prisma } from '../src/prisma.js';
import {
  applyCommitmentBackfill,
  hasCommitmentMigrationMarker,
  inspectCommitmentMigration,
  verifyCommitmentBackfill,
} from '../src/commitment/migration.js';

type Mode = 'dry-run' | 'apply' | 'verify';

function selectedMode(args: readonly string[]): Mode {
  const modes = [
    args.includes('--dry-run') ? 'dry-run' : null,
    args.includes('--apply') ? 'apply' : null,
    args.includes('--verify') ? 'verify' : null,
  ].filter((value): value is Mode => value !== null);
  if (modes.length !== 1) throw new Error('choose exactly one of --dry-run, --apply, or --verify');
  return modes[0];
}

function isMissingTable(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2021';
}

async function run(mode: Mode): Promise<void> {
  try {
    await prisma.tenant.findFirst({ select: { id: true } });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.log(JSON.stringify({ ok: true, mode, schemaState: 'uninitialized' }, null, 2));
    return;
  }

  if (mode === 'dry-run') {
    const report = await inspectCommitmentMigration(prisma);
    const ok = report.invalidRows.length === 0;
    console.log(JSON.stringify({ ok, mode, report }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  if (mode === 'apply') {
    const result = await applyCommitmentBackfill(prisma);
    const conflicts = await verifyCommitmentBackfill(prisma);
    const markerPresent = await hasCommitmentMigrationMarker(prisma);
    const ok = markerPresent && conflicts.length === 0;
    console.log(JSON.stringify({ ok, mode, result, markerPresent, conflicts }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  const conflicts = await verifyCommitmentBackfill(prisma);
  const markerPresent = await hasCommitmentMigrationMarker(prisma);
  const ok = markerPresent && conflicts.length === 0;
  console.log(JSON.stringify({ ok, mode, markerPresent, conflictCount: conflicts.length, conflicts }, null, 2));
  if (!ok) process.exitCode = 1;
}

let mode: Mode;
try {
  mode = selectedMode(process.argv.slice(2));
  await run(mode);
} catch (error) {
  console.error('[commitment-migration] failed', error);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
