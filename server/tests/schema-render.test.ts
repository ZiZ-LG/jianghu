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
    const scan = entrypoint.indexOf('migrate:sync-anchor-report');
    const deploy = entrypoint.indexOf('prisma migrate deploy --schema prisma/postgres/schema.prisma');
    expect(scan).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(scan);
    expect(entrypoint).not.toContain('prisma db push');
  });

  it('adopts an exact pre-migration production schema without replaying the baseline', async () => {
    const entrypoint = await read('docker-entrypoint.sh');
    const stateCheck = entrypoint.indexOf('postgres-migration-state');
    const driftCheck = entrypoint.indexOf('prisma migrate diff');
    const resolve = entrypoint.indexOf('prisma migrate resolve --applied 20260715000000_baseline');
    const deploy = entrypoint.indexOf('prisma migrate deploy');
    expect(stateCheck).toBeGreaterThan(-1);
    expect(driftCheck).toBeGreaterThan(stateCheck);
    expect(resolve).toBeGreaterThan(driftCheck);
    expect(deploy).toBeGreaterThan(resolve);
  });

  it('packages generated schema, migrations, and the Prisma CLI for empty-schema deploys', async () => {
    const dockerfile = await read('Dockerfile');
    const packageJson = JSON.parse(await read('package.json')) as { devDependencies?: Record<string, string> };
    expect(dockerfile).toContain('prisma/postgres/schema.prisma');
    expect(dockerfile).toContain('/api/health/ready');
    expect(packageJson.devDependencies?.prisma).toBeTruthy();
  });
});
