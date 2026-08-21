import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

type MatterSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';
type ParticipantSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';
type CommitmentSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

const MATTER_COLUMNS = [
  'kind',
  'lifecycleStatus',
  'outcomeKey',
  'priority',
  'targetDate',
  'primaryOwnerUserId',
  'activeMethodologyBindingId',
] as const;

const COMMITMENT_COLUMNS = [
  'kind', 'ownerUserId', 'executionStatus', 'confirmationStatus',
  'scheduledAtUtc', 'dueAtUtc', 'timeZone', 'isAllDay', 'localDate',
  'confirmationDueAtUtc', 'confirmedAtUtc', 'confirmedByUserId',
  'scheduleVersion', 'nextCommitmentId', 'source', 'sourceRef',
  'archivedAt', 'version',
] as const;

async function databaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  let contents = '';
  try {
    contents = await readFile(resolve('.env'), 'utf8');
  } catch {
    throw new Error('DATABASE_URL is required (set it or create server/.env)');
  }
  const line = contents.split(/\r?\n/).find((candidate) => /^\s*DATABASE_URL\s*=/.test(candidate));
  if (!line) throw new Error('DATABASE_URL is missing from server/.env');
  const raw = line.slice(line.indexOf('=') + 1).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function sqliteDatabasePath(url: string): string {
  if (!url.startsWith('file:')) throw new Error('npm run db:push is SQLite-only; production PostgreSQL must use migrate deploy');
  const reference = decodeURIComponent(url.slice('file:'.length).split('?')[0] ?? '');
  if (!reference || reference === ':memory:') throw new Error('SQLite schema upgrade requires a persistent database file');
  return isAbsolute(reference) ? reference : resolve('prisma', reference);
}

function run(command: string, args: readonly string[], url: string): void {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`);
}

function schemaHasChanges(url: string): boolean {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = [
    'prisma', 'migrate', 'diff',
    '--from-schema-datasource', 'prisma/schema.prisma',
    '--to-schema-datamodel', 'prisma/schema.prisma',
    '--exit-code',
  ];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
  });
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  if (result.status === 2) return true;
  throw new Error(
    `${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}\n`
    + `${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
}

async function inspectSchemaState(prisma: {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}): Promise<MatterSchemaState> {
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Opportunity'`,
  );
  if (tables.length === 0) return 'uninitialized';
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Opportunity")');
  const names = new Set(columns.map((column) => column.name));
  const present = MATTER_COLUMNS.filter((column) => names.has(column)).length;
  if (present === 0) return 'legacy';
  if (present === MATTER_COLUMNS.length) return 'expanded';
  return 'partial';
}

async function inspectParticipantSchemaState(prisma: {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}): Promise<ParticipantSchemaState> {
  const baseTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Opportunity', 'Edge')`,
  );
  if (baseTables.length === 0) return 'uninitialized';
  if (baseTables.length !== 2) return 'partial';
  const expansionTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('MatterParticipant', 'DataMigrationState')`,
  );
  const edgeColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Edge")');
  const hasKind = edgeColumns.some((column) => column.name === 'kind');
  if (expansionTables.length === 0 && !hasKind) return 'legacy';
  if (expansionTables.length === 2 && hasKind) return 'expanded';
  return 'partial';
}

async function inspectCommitmentSchemaState(prisma: {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}): Promise<CommitmentSchemaState> {
  const planActionTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'PlanAction'`,
  );
  if (planActionTables.length === 0) return 'uninitialized';
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("PlanAction")');
  const names = new Set(columns.map((column) => column.name));
  const present = COMMITMENT_COLUMNS.filter((column) => names.has(column)).length;
  if (present === 0) return 'legacy';
  if (present === COMMITMENT_COLUMNS.length) return 'expanded';
  return 'partial';
}

async function createConsistentBackup(
  prisma: { $executeRawUnsafe(query: string): Promise<number> },
  databasePath: string,
): Promise<string> {
  const directory = join(dirname(databasePath), 'backups');
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
  const backupPath = join(directory, `${basename(databasePath)}.${stamp}.bak`);
  const sqlPath = backupPath.replaceAll("'", "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${sqlPath}'`);
  return backupPath;
}

const url = await databaseUrl();
const databasePath = sqliteDatabasePath(url);
process.env.DATABASE_URL = url;

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
let state: MatterSchemaState;
let participantState: ParticipantSchemaState;
let commitmentState: CommitmentSchemaState;
let backupPath: string | null = null;
let schemaChanges = false;
let matterBackfillRequired = false;
let participantBackfillRequired = false;
let commitmentBackfillRequired = false;

try {
  state = await inspectSchemaState(prisma);
  participantState = await inspectParticipantSchemaState(prisma);
  commitmentState = await inspectCommitmentSchemaState(prisma);
  if (state === 'partial') {
    throw new Error('partial Matter column expansion detected; restore the latest backup before retrying');
  }
  if (participantState === 'partial') {
    throw new Error('partial MatterParticipant/Relation expansion detected; restore the latest backup before retrying');
  }
  if (commitmentState === 'partial') {
    throw new Error('partial Commitment field expansion detected; restore the latest backup before retrying');
  }
  if (state === 'legacy') {
    run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-fields.ts', '--dry-run'], url);
    matterBackfillRequired = true;
  } else if (state === 'expanded') {
    const {
      assertMatterMigrationIntegrity,
      countMatterParityConflicts,
      inspectMatterMigrationIntegrity,
    } = await import('../src/matter/migration.js');
    assertMatterMigrationIntegrity(await inspectMatterMigrationIntegrity(prisma));
    const tenantIds = (await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))
      .map((tenant) => tenant.id);
    const conflictCount = await countMatterParityConflicts(prisma, tenantIds);
    if (conflictCount > 0) {
      // This is the recoverable state left by a kill after db push committed
      // the columns but before the legacy-authority shadow backfill ran.
      run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-fields.ts', '--dry-run'], url);
      const nonSalesMatter = await prisma.opportunity.findFirst({
        where: { NOT: { kind: 'sales_opportunity' } },
        select: { tenantId: true },
      });
      if (nonSalesMatter) {
        throw new Error(
          `Matter recovery is no longer safe after non-sales kinds exist for tenant ${nonSalesMatter.tenantId}`,
        );
      }
      matterBackfillRequired = true;
    }
  }
  if (participantState === 'uninitialized') {
    participantBackfillRequired = true;
  } else if (participantState === 'legacy') {
    run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-participants.ts', '--dry-run'], url);
    participantBackfillRequired = true;
  } else {
    const { hasMatterParticipantMigrationMarker } = await import('../src/matter/participants.js');
    if (!(await hasMatterParticipantMigrationMarker(prisma))) {
      // Recover the atomic data step after a kill that occurred after db push.
      run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-participants.ts', '--dry-run'], url);
      participantBackfillRequired = true;
    }
  }
  if (commitmentState === 'uninitialized') {
    commitmentBackfillRequired = true;
  } else if (commitmentState === 'legacy') {
    run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-commitment-fields.ts', '--dry-run'], url);
    commitmentBackfillRequired = true;
  } else {
    const { hasCommitmentMigrationMarker, verifyCommitmentBackfill } = await import('../src/commitment/migration.js');
    const markerPresent = await hasCommitmentMigrationMarker(prisma);
    if (!markerPresent) {
      run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-commitment-fields.ts', '--dry-run'], url);
      commitmentBackfillRequired = true;
    } else {
      const conflicts = await verifyCommitmentBackfill(prisma);
      if (conflicts.length > 0) {
        throw new Error(`Commitment legacy shadow parity failed (${conflicts.length} sampled conflicts)`);
      }
    }
  }
  schemaChanges = state === 'uninitialized' ? true : schemaHasChanges(url);
  if (state !== 'uninitialized' && (schemaChanges || matterBackfillRequired || participantBackfillRequired || commitmentBackfillRequired)) {
    backupPath = await createConsistentBackup(prisma, databasePath);
  }
} finally {
  await prisma.$disconnect();
}

const dbPushArgs = ['prisma', 'db', 'push', '--schema', 'prisma/schema.prisma'];
if (process.env.JIANGHU_SKIP_PRISMA_GENERATE === '1') dbPushArgs.push('--skip-generate');
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', dbPushArgs, url);

if (matterBackfillRequired) {
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-fields.ts', '--apply'], url);
}
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-fields.ts', '--verify'], url);
if (participantBackfillRequired) {
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-participants.ts', '--apply'], url);
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-matter-participants.ts', '--verify'], url);
}
if (commitmentBackfillRequired) {
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-commitment-fields.ts', '--apply'], url);
}
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/migrate-commitment-fields.ts', '--verify'], url);

console.log(JSON.stringify({
  ok: true,
  stateBefore: state,
  participantStateBefore: participantState,
  commitmentStateBefore: commitmentState,
  schemaChanges,
  matterBackfillRequired,
  participantBackfillRequired,
  commitmentBackfillRequired,
  backupPath,
}, null, 2));
