import { prisma } from '../src/prisma.js';
import {
  applyCommitmentBackfill,
  hasCommitmentCutoverMarker,
  hasCommitmentMigrationMarker,
  inspectCommitmentMigration,
  isCommitmentMatterNullable,
  markCommitmentCutover,
  verifyCommitmentBackfill,
  verifyCurrentCommitmentIntegrity,
} from '../src/commitment/migration.js';

type Mode = 'dry-run' | 'apply' | 'cutover' | 'verify';

function selectedMode(args: readonly string[]): Mode {
  const modes = [
    args.includes('--dry-run') ? 'dry-run' : null,
    args.includes('--apply') ? 'apply' : null,
    args.includes('--cutover') ? 'cutover' : null,
    args.includes('--verify') ? 'verify' : null,
  ].filter((value): value is Mode => value !== null);
  if (modes.length !== 1) throw new Error('choose exactly one of --dry-run, --apply, --cutover, or --verify');
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
    if (await hasCommitmentCutoverMarker(prisma)) {
      const conflicts = await verifyCurrentCommitmentIntegrity(prisma);
      const ok = conflicts.length === 0;
      console.log(JSON.stringify({ ok, mode, authority: 'generic', conflicts }, null, 2));
      if (!ok) process.exitCode = 1;
      return;
    }
    const report = await inspectCommitmentMigration(prisma);
    const ok = report.invalidRows.length === 0;
    console.log(JSON.stringify({ ok, mode, report }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  if (mode === 'apply') {
    if (await hasCommitmentCutoverMarker(prisma)) {
      throw new Error('legacy Commitment backfill is disabled after CORE-108 cutover');
    }
    const result = await applyCommitmentBackfill(prisma);
    const conflicts = await verifyCommitmentBackfill(prisma);
    const markerPresent = await hasCommitmentMigrationMarker(prisma);
    const ok = markerPresent && conflicts.length === 0;
    console.log(JSON.stringify({ ok, mode, result, markerPresent, conflicts }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  if (mode === 'cutover') {
    if (!(await hasCommitmentMigrationMarker(prisma))) {
      throw new Error('CORE-106 Commitment migration marker is required before CORE-108 cutover');
    }
    await markCommitmentCutover(prisma);
    const conflicts = await verifyCurrentCommitmentIntegrity(prisma);
    const markerPresent = await hasCommitmentCutoverMarker(prisma);
    const ok = markerPresent && conflicts.length === 0;
    console.log(JSON.stringify({ ok, mode, markerPresent, conflicts }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  const cutoverMarkerPresent = await hasCommitmentCutoverMarker(prisma);
  const matterNullable = await isCommitmentMatterNullable(prisma);
  const conflicts = cutoverMarkerPresent
    ? await verifyCurrentCommitmentIntegrity(prisma)
    : await verifyCommitmentBackfill(prisma);
  const markerPresent = await hasCommitmentMigrationMarker(prisma);
  const cutoverStateMatches = cutoverMarkerPresent === matterNullable;
  const ok = markerPresent && cutoverStateMatches && conflicts.length === 0;
  console.log(JSON.stringify({
    ok, mode, markerPresent, cutoverMarkerPresent, matterNullable, cutoverStateMatches,
    authority: cutoverMarkerPresent ? 'generic' : 'legacy-shadow',
    conflictCount: conflicts.length, conflicts,
  }, null, 2));
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
