import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const serverDir = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, serverDir), 'utf8');

describe('PostgreSQL schema delivery', () => {
  it('renders deterministically from the SQLite source and detects committed drift', async () => {
    const source = await read('prisma/schema.prisma');
    const committed = await read('prisma/postgres/schema.prisma').catch(() => '');
    const expected = source.replace('provider = "sqlite"', 'provider = "postgresql"');

    expect(committed).toBe(expected);
    expect(source.match(/provider = "sqlite"/g)).toHaveLength(1);
    expect(committed.match(/provider = "postgresql"/g)).toHaveLength(1);

    const first = await mkdtemp(join(tmpdir(), 'jianghu-schema-a-'));
    const second = await mkdtemp(join(tmpdir(), 'jianghu-schema-b-'));
    try {
      await execFileAsync('node', ['scripts/render-postgres-schema.mjs', '--output', join(first, 'schema.prisma')], { cwd: serverDir });
      await execFileAsync('node', ['scripts/render-postgres-schema.mjs', '--output', join(second, 'schema.prisma')], { cwd: serverDir });
      expect(await readFile(join(first, 'schema.prisma'), 'utf8')).toBe(expected);
      expect(await readFile(join(second, 'schema.prisma'), 'utf8')).toBe(expected);
      await expect(execFileAsync('node', ['scripts/render-postgres-schema.mjs', '--check'], { cwd: serverDir })).resolves.toBeDefined();
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it('commits a PostgreSQL baseline migration for an empty database', async () => {
    const migrationsDir = new URL('prisma/postgres/migrations/', serverDir);
    const migrationNames = (await readdir(migrationsDir).catch(() => [])).filter((name) => /^\d+_baseline$/.test(name));
    expect(migrationNames).toHaveLength(1);
    const sql = await readFile(new URL(`${migrationNames[0]}/migration.sql`, migrationsDir), 'utf8');
    expect(sql).toContain('CREATE TABLE "Tenant"');
    expect(sql).toContain('CREATE TABLE "CommandRun"');
    expect(sql).toContain('CREATE TABLE "EvidenceEvent"');
    expect(sql).toContain('FOREIGN KEY');
    expect(await read('prisma/postgres/migrations/migration_lock.toml')).toContain('provider = "postgresql"');
  });

  it('deploys migrations only after the sync-anchor fail-closed scan', async () => {
    const entrypoint = await read('docker-entrypoint.sh');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const scan = deployScript.indexOf('migrate:sync-anchor-report');
    const deploy = deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"');
    expect(entrypoint).toContain('scripts/deploy-postgres-migrations.sh');
    expect(scan).toBeGreaterThan(-1);
    expect(scan).toBeLessThan(deploy);
    expect(deployScript.indexOf('migrate:wecom-bind-report')).toBeLessThan(deploy);
    expect(deployScript).not.toContain('migrate:account-owners');
    expect(entrypoint).not.toContain('prisma db push');
    expect(deployScript).not.toContain('prisma db push');
  });

  it('adopts an exact pre-migration production schema without replaying the baseline', async () => {
    const entrypoint = await read('docker-entrypoint.sh');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const legacySchema = await read('prisma/postgres/legacy/20260712_pre_int501.prisma');
    const bridge = await read('prisma/postgres/migrations/20260715030000_adopt_pre_int501_schema/migration.sql');
    expect(entrypoint).toContain('scripts/deploy-postgres-migrations.sh');
    expect(deployScript).toContain('20260712_pre_int501.prisma');
    expect(deployScript).toContain('20260715000000_baseline');
    expect(deployScript).toContain('20260715010000_hash_command_run_idempotency_keys');
    expect(deployScript).toContain('20260715020000_add_person_created_at');
    expect(deployScript).toContain('list-applied-postgres-migrations.ts');
    expect(deployScript).toContain('list-incomplete-postgres-migrations.ts');
    expect(deployScript).toContain('migrate resolve --rolled-back "$BRIDGE_MIGRATION"');
    expect(deployScript).toContain('resolve_missing_pre_bridge_migrations');
    expect(deployScript).toContain('assert-untracked-command-runs-empty.ts');
    expect(deployScript).toContain('prisma migrate deploy --schema "$SCHEMA"');
    expect(legacySchema).toContain('model Tenant');
    expect(legacySchema).not.toContain('model SyncRun');
    expect(bridge).toContain('CREATE TABLE IF NOT EXISTS "SyncRun"');
    expect(bridge).toContain('ADD COLUMN IF NOT EXISTS');
    expect(bridge).toContain('64-hex stored');
    expect(bridge).toContain('account owner mapping is ambiguous');
    expect(bridge).toContain('account owner id is not tenant-local');
    expect(bridge).toContain('UPDATE "Account" AS account');
  });

  it('packages generated schema, migrations, and the Prisma CLI for empty-schema deploys', async () => {
    const dockerfile = await read('Dockerfile');
    const packageJson = JSON.parse(await read('package.json')) as { devDependencies?: Record<string, string> };
    expect(dockerfile).toContain('prisma/postgres/schema.prisma');
    expect(dockerfile).toContain('/api/health/ready');
    expect(packageJson.devDependencies?.prisma).toBeTruthy();
  });

  it('delivers the CORE-103 Matter expansion as an atomic, fail-closed PostgreSQL migration', async () => {
    const migration = await read('prisma/postgres/migrations/20260821000000_expand_matter_fields/migration.sql');
    const schema = await read('prisma/postgres/schema.prisma');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Opportunity" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain("NOT IN ('active', 'paused', 'won', 'lost')");
    expect(migration.indexOf('unsupported legacy Opportunity status'))
      .toBeLessThan(migration.indexOf('ADD COLUMN "kind"'));
    for (const column of [
      'kind', 'lifecycleStatus', 'outcomeKey', 'priority', 'targetDate',
      'primaryOwnerUserId', 'activeMethodologyBindingId',
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}"`);
      expect(schema).toContain(`${column}`);
    }
    expect(migration).toContain("WHEN 'won' THEN 'completed'");
    expect(migration).toContain("WHEN 'lost' THEN 'completed'");
    expect(migration).toContain("WHEN 'won' THEN 'won'");
    expect(migration).toContain("WHEN 'lost' THEN 'lost'");
    expect(migration).toContain('WHERE "status" <> \'active\'');
    expect(migration).toContain('matter lifecycle backfill parity failed');
    expect(migration).toContain('"Opportunity_tenantId_kind_lifecycleStatus_idx"');
    expect(migration).toContain('"Opportunity_tenantId_primaryOwnerUserId_idx"');

    expect(packageJson.scripts?.['migrate:matter-report']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:matter-verify']).toBeTruthy();
    expect(packageJson.scripts?.['db:push']).toContain('upgrade-sqlite-schema.ts');
    expect(deployScript).toContain('recover_incomplete_matter_migration');
    expect(deployScript).toContain('adopt_existing_matter_schema_if_safe');
    expect(deployScript).toContain('postgres-matter-schema-state.ts');
    expect(deployScript).toContain('matter_migration_pending=1');
    expect(deployScript.indexOf('npm run migrate:matter-report'))
      .toBeLessThan(deployScript.indexOf('prisma migrate deploy'));
    expect(deployScript.lastIndexOf('npm run migrate:matter-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
  });

  it('exposes CORE-104 ownership migration as a dry-run-only report', async () => {
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };
    const reportScript = await read('scripts/report-matter-owner-suggestions.ts');
    expect(packageJson.scripts?.['migrate:matter-owner-report']).toBe('tsx scripts/report-matter-owner-suggestions.ts');
    expect(packageJson.scripts?.['migrate:matter-owner-apply']).toBeUndefined();
    expect(reportScript).toContain('inspectMatterOwnerAssignments');
    expect(reportScript).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
  });

  it('delivers CORE-105 participants and open Relation kinds as an atomic fail-closed expansion', async () => {
    const migration = await read('prisma/postgres/migrations/20260821010000_expand_matter_participants_relations/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain('LOCK TABLE "OppRole", "OpportunityMember", "Opportunity", "Person", "Edge"');
    expect(migration).toContain('invalid MatterParticipant legacy parentage');
    expect(migration.indexOf('invalid MatterParticipant legacy parentage'))
      .toBeLessThan(migration.indexOf('CREATE TABLE "MatterParticipant"'));
    expect(migration).toContain('CREATE TABLE "MatterParticipant"');
    expect(migration).toContain('CREATE TABLE "DataMigrationState"');
    expect(migration).toContain('CORE-105-matter-participant-backfill-v1');
    expect(migration).toContain('ADD COLUMN "kind" TEXT NOT NULL DEFAULT');
    expect(migration).toContain('FROM "OppRole"');
    expect(migration).toContain('FROM "OpportunityMember"');
    expect(migration).toContain('NOT EXISTS');
    expect(migration).toContain('"MatterParticipant_tenantId_opportunityId_personId_key"');
    expect(migration).toContain('"MatterParticipant_tenantId_accountId_fkey"');
    expect(migration).toContain('"MatterParticipant_tenantId_opportunityId_fkey"');
    expect(migration).toContain('"MatterParticipant_tenantId_personId_fkey"');
    expect(migration).toContain('MatterParticipant backfill parity failed');

    expect(schema).toContain('model MatterParticipant');
    expect(schema).toContain('model DataMigrationState');
    expect(schema).toContain('kind          String');
    expect(packageJson.scripts?.['migrate:matter-participant-report']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:matter-participant-verify']).toBeTruthy();
    expect(deployScript).toContain('migrate:matter-participant-report');
    expect(deployScript).toContain('migrate:matter-participant-verify');
    expect(deployScript).toMatch(/matter_schema_matches_known_state\(\) \{[\s\S]*schema_matches "\$PRE_PARTICIPANT_SCHEMA"[\s\S]*\|\| schema_matches "\$SCHEMA"/);
    expect(deployScript.match(/if ! matter_schema_matches_known_state/g)).toHaveLength(2);
    expect(deployScript.indexOf('migrate:matter-participant-report'))
      .toBeLessThan(deployScript.indexOf('prisma migrate deploy'));
    expect(deployScript.lastIndexOf('migrate:matter-participant-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
  });
});
