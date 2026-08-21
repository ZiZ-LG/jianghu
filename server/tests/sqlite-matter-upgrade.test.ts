import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const serverRoot = resolve('.');
const prismaBin = resolve('node_modules/.bin/prisma');
const tsxBin = resolve('node_modules/.bin/tsx');

function run(command: string, args: string[], databaseUrl: string) {
  const result = spawnSync(command, args, {
    cwd: serverRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function createLegacyFixture(databasePath: string, databaseUrl: string): Promise<void> {
  // Prisma's schema engine cannot create a brand-new SQLite file on the
  // external workspace volume, but it can initialize an existing file.
  await writeFile(databasePath, '');
  run(prismaBin, ['db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'], databaseUrl);

  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await client.$executeRawUnsafe('DROP TABLE "MatterParticipant"');
    await client.$executeRawUnsafe('DROP TABLE "DataMigrationState"');
    await client.$executeRawUnsafe('ALTER TABLE "Edge" DROP COLUMN "kind"');
    for (const indexName of [
      'Opportunity_tenantId_kind_lifecycleStatus_idx',
      'Opportunity_tenantId_primaryOwnerUserId_idx',
      'Opportunity_tenantId_targetDate_idx',
      'Opportunity_tenantId_activeMethodologyBindingId_idx',
    ]) {
      await client.$executeRawUnsafe(`DROP INDEX "${indexName}"`);
    }
    for (const column of [
      'kind', 'lifecycleStatus', 'outcomeKey', 'priority', 'targetDate',
      'primaryOwnerUserId', 'activeMethodologyBindingId',
    ]) {
      await client.$executeRawUnsafe(`ALTER TABLE "Opportunity" DROP COLUMN "${column}"`);
    }
    await client.$executeRawUnsafe(
      `INSERT INTO "Tenant" (id, name) VALUES ('sqlite-upgrade-tenant', 'SQLite Upgrade Tenant')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Account" (id, "tenantId", name, "customerType")
       VALUES ('sqlite-upgrade-account', 'sqlite-upgrade-tenant', 'SQLite Upgrade Account', 1)`,
    );
    for (const status of ['active', 'paused', 'won', 'lost']) {
      await client.$executeRawUnsafe(
        `INSERT INTO "Opportunity"
           (id, "tenantId", "accountId", name, "customerType", "pipelineStage", "engageStage", status)
         VALUES (?, 'sqlite-upgrade-tenant', 'sqlite-upgrade-account', ?, 1, 'qualify', 'discover', ?)`,
        `sqlite-upgrade-${status}`,
        `SQLite ${status}`,
        status,
      );
    }
    await client.$executeRawUnsafe(
      `INSERT INTO "Person" (id, "tenantId", "accountId", name, title)
       VALUES
         ('sqlite-upgrade-person-one', 'sqlite-upgrade-tenant', 'sqlite-upgrade-account', 'One', 'One'),
         ('sqlite-upgrade-person-two', 'sqlite-upgrade-tenant', 'sqlite-upgrade-account', 'Two', 'Two')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "OppRole" (id, "tenantId", "opportunityId", "personId", role, sentiment, confidence)
       VALUES ('sqlite-upgrade-role-one', 'sqlite-upgrade-tenant', 'sqlite-upgrade-active', 'sqlite-upgrade-person-one', 'R', 'plus', '明确')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "OpportunityMember" (id, "tenantId", "opportunityId", "personId")
       VALUES
         ('sqlite-upgrade-member-one', 'sqlite-upgrade-tenant', 'sqlite-upgrade-active', 'sqlite-upgrade-person-one'),
         ('sqlite-upgrade-member-two', 'sqlite-upgrade-tenant', 'sqlite-upgrade-active', 'sqlite-upgrade-person-two')`,
    );
  } finally {
    await client.$disconnect();
  }
}

describe('CORE-103/105 SQLite schema upgrade', () => {
  it('initializes a fresh SQLite database through the standard db:push wrapper', async () => {
    const directory = await mkdtemp(resolve('prisma/.matter-fresh-test-'));
    const relativeDirectory = basename(directory);
    const databaseUrl = `file:./${relativeDirectory}/fresh.db`;
    let client: PrismaClient | null = null;
    try {
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        'PRAGMA table_info("Opportunity")',
      );
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'kind', 'lifecycleStatus', 'outcomeKey', 'priority', 'targetDate',
        'primaryOwnerUserId', 'activeMethodologyBindingId',
      ]));
      const edgeColumns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Edge")');
      expect(edgeColumns.map((column) => column.name)).toContain('kind');
      await expect(client.matterParticipant.count()).resolves.toBe(0);
      await expect(readdir(join(directory, 'backups'))).rejects.toThrow();
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('backs up, upgrades, backfills, verifies, and leaves a restorable legacy snapshot', async () => {
    // Prisma resolves relative SQLite URLs from the schema directory. Keeping
    // the fixture there also exercises the same URL shape as server/.env.
    const directory = await mkdtemp(resolve('prisma/.matter-upgrade-test-'));
    const relativeDirectory = basename(directory);
    const databasePath = join(directory, 'legacy.db');
    const restoredPath = join(directory, 'restored.db');
    const databaseUrl = `file:./${relativeDirectory}/legacy.db`;
    let upgradedClient: PrismaClient | null = null;
    let restoredClient: PrismaClient | null = null;
    try {
      await createLegacyFixture(databasePath, databaseUrl);

      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);

      upgradedClient = new PrismaClient({ datasourceUrl: databaseUrl });
      const rows = await upgradedClient.$queryRawUnsafe<Array<{
        status: string;
        kind: string;
        lifecycleStatus: string;
        outcomeKey: string | null;
      }>>(
        `SELECT status, kind, "lifecycleStatus", "outcomeKey"
           FROM "Opportunity" ORDER BY status`,
      );
      expect(rows).toEqual([
        { status: 'active', kind: 'sales_opportunity', lifecycleStatus: 'active', outcomeKey: null },
        { status: 'lost', kind: 'sales_opportunity', lifecycleStatus: 'completed', outcomeKey: 'lost' },
        { status: 'paused', kind: 'sales_opportunity', lifecycleStatus: 'paused', outcomeKey: null },
        { status: 'won', kind: 'sales_opportunity', lifecycleStatus: 'completed', outcomeKey: 'won' },
      ]);
      await expect(upgradedClient.matterParticipant.findMany({
        orderBy: { personId: 'asc' },
        select: { opportunityId: true, personId: true },
      })).resolves.toEqual([
        { opportunityId: 'sqlite-upgrade-active', personId: 'sqlite-upgrade-person-one' },
        { opportunityId: 'sqlite-upgrade-active', personId: 'sqlite-upgrade-person-two' },
      ]);
      await upgradedClient.$disconnect();
      upgradedClient = null;

      const backupsDirectory = join(directory, 'backups');
      const backups = (await readdir(backupsDirectory)).filter((name) => name.endsWith('.bak'));
      expect(backups).toHaveLength(1);
      await copyFile(join(backupsDirectory, backups[0]!), restoredPath);
      restoredClient = new PrismaClient({
        datasourceUrl: `file:./${relativeDirectory}/restored.db`,
      });
      const restoredColumns = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        'PRAGMA table_info("Opportunity")',
      );
      expect(restoredColumns.map((column) => column.name)).not.toContain('lifecycleStatus');
      const restoredEdgeColumns = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        'PRAGMA table_info("Edge")',
      );
      expect(restoredEdgeColumns.map((column) => column.name)).not.toContain('kind');
      const restoredParticipantTables = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'MatterParticipant'`,
      );
      expect(restoredParticipantTables).toEqual([]);
      const restoredStatuses = await restoredClient.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM "Opportunity" ORDER BY status',
      );
      expect(restoredStatuses.map((row) => row.status)).toEqual(['active', 'lost', 'paused', 'won']);
    } finally {
      await upgradedClient?.$disconnect();
      await restoredClient?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('resumes safely when schema expansion committed before the Matter backfill', async () => {
    const directory = await mkdtemp(resolve('prisma/.matter-resume-test-'));
    const relativeDirectory = basename(directory);
    const databasePath = join(directory, 'interrupted.db');
    const databaseUrl = `file:./${relativeDirectory}/interrupted.db`;
    let client: PrismaClient | null = null;
    try {
      await createLegacyFixture(databasePath, databaseUrl);

      // Simulate a process kill after Prisma committed the column expansion but
      // before upgrade-sqlite-schema.ts could run the lifecycle backfill.
      run(prismaBin, ['db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await expect(client.opportunity.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-won' },
        select: { status: true, lifecycleStatus: true, outcomeKey: true },
      })).resolves.toEqual({ status: 'won', lifecycleStatus: 'active', outcomeKey: null });
      await expect(client.matterParticipant.count()).resolves.toBe(0);
      await client.$disconnect();
      client = null;

      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);

      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await expect(client.opportunity.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-won' },
        select: { status: true, kind: true, lifecycleStatus: true, outcomeKey: true },
      })).resolves.toEqual({
        status: 'won', kind: 'sales_opportunity', lifecycleStatus: 'completed', outcomeKey: 'won',
      });
      const backups = (await readdir(join(directory, 'backups'))).filter((name) => name.endsWith('.bak'));
      expect(backups).toHaveLength(1);
      await expect(client.matterParticipant.count()).resolves.toBe(2);
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not re-derive generic participation from new legacy visibility rows after cutover', async () => {
    const directory = await mkdtemp(resolve('prisma/.participant-cutover-test-'));
    const relativeDirectory = basename(directory);
    const databasePath = join(directory, 'cutover.db');
    const databaseUrl = `file:./${relativeDirectory}/cutover.db`;
    let client: PrismaClient | null = null;
    try {
      await createLegacyFixture(databasePath, databaseUrl);
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.person.create({ data: {
        id: 'sqlite-post-cutover-person', tenantId: 'sqlite-upgrade-tenant',
        accountId: 'sqlite-upgrade-account', name: 'Post cutover', title: 'Visibility only',
      } });
      await client.opportunityMember.create({ data: {
        id: 'sqlite-post-cutover-member', tenantId: 'sqlite-upgrade-tenant',
        opportunityId: 'sqlite-upgrade-active', personId: 'sqlite-post-cutover-person',
      } });
      await client.$disconnect();
      client = null;

      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);

      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await expect(client.matterParticipant.findMany({
        orderBy: { personId: 'asc' }, select: { personId: true },
      })).resolves.toEqual([
        { personId: 'sqlite-upgrade-person-one' },
        { personId: 'sqlite-upgrade-person-two' },
      ]);
      const backups = (await readdir(join(directory, 'backups'))).filter((name) => name.endsWith('.bak'));
      expect(backups).toHaveLength(1);
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
