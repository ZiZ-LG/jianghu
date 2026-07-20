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
});
