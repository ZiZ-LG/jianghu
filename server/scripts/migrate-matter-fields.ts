import { prisma } from '../src/prisma.js';
import {
  applyMatterFieldBackfillForTenants,
  assertMatterMigrationIntegrity,
  countMatterParityConflicts,
  inspectMatterMigrationForTenants,
  inspectMatterMigrationIntegrity,
  verifyMatterParity,
} from '../src/matter/migration.js';

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
  let tenants: Array<{ id: string }>;
  try {
    tenants = await prisma.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.log(JSON.stringify({ ok: true, mode, schemaState: 'uninitialized', tenants: [] }, null, 2));
    return;
  }
  const integrity = await inspectMatterMigrationIntegrity(prisma);
  assertMatterMigrationIntegrity(integrity);
  const tenantIds = tenants.map((tenant) => tenant.id);

  if (mode === 'verify') {
    const conflictCount = await countMatterParityConflicts(prisma, tenantIds);
    const conflicts = conflictCount > 0 ? await verifyMatterParity(prisma, tenantIds) : [];
    console.log(JSON.stringify({ ok: conflictCount === 0, mode, integrity, conflictCount, conflicts }, null, 2));
    if (conflictCount > 0) process.exitCode = 1;
  } else {
    const reports = await inspectMatterMigrationForTenants(prisma, tenantIds);
    const totalRows = reports.reduce((sum, report) => sum + report.totalRows, 0);
    if (totalRows !== integrity.totalRows) throw new Error('Matter migration tenant coverage does not match total rows');
    const unsupportedRows = reports.reduce((sum, report) => sum + report.unsupportedRows, 0);
    if (mode === 'apply' && unsupportedRows === 0) {
      await applyMatterFieldBackfillForTenants(prisma, tenantIds);
    }
    console.log(JSON.stringify({
      ok: unsupportedRows === 0,
      mode,
      integrity,
      totalRows,
      unsupportedRows,
      tenants: reports,
    }, null, 2));
    if (unsupportedRows > 0) process.exitCode = 1;
  }
}

const mode = selectedMode(process.argv.slice(2));

try {
  await run(mode);
} catch (error) {
  console.error('[matter-migration] failed', error);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
