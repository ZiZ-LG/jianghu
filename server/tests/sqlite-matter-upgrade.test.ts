import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const serverRoot = resolve('.');
const prismaBin = resolve('node_modules/.bin/prisma');
const tsxBin = resolve('node_modules/.bin/tsx');
const methodologyFoundationTables = [
  'MethodologyPack',
  'MethodologyPackVersion',
  'MethodologyBinding',
  'MethodologyPilotAssignment',
] as const;
const methodologyDataTables = [
  'MethodologyFieldDefinition',
  'MethodologyStageDefinition',
  'MethodologyRoleDefinition',
  'MethodologyRuleDefinition',
  'MethodologyActionTemplate',
  'MethodologyStageState',
  'MethodologyRoleAssignment',
  'MethodologyValue',
  'MethodologyEvaluation',
  'MethodologyMigrationRun',
] as const;
const methodologyTables = [...methodologyFoundationTables, ...methodologyDataTables] as const;

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

async function listMethodologyTables(client: {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}): Promise<Array<{ name: string }>> {
  return client.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'MethodologyPack', 'MethodologyPackVersion',
          'MethodologyBinding', 'MethodologyPilotAssignment',
          'MethodologyFieldDefinition', 'MethodologyStageDefinition',
          'MethodologyRoleDefinition', 'MethodologyRuleDefinition',
          'MethodologyActionTemplate', 'MethodologyStageState',
          'MethodologyRoleAssignment', 'MethodologyValue',
          'MethodologyEvaluation', 'MethodologyMigrationRun'
        )
      ORDER BY name`,
  );
}

async function createLegacyFixture(databasePath: string, databaseUrl: string): Promise<void> {
  // Prisma's schema engine cannot create a brand-new SQLite file on the
  // external workspace volume, but it can initialize an existing file.
  await writeFile(databasePath, '');
  run(prismaBin, ['db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'], databaseUrl);

  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await client.$executeRawUnsafe('DROP TABLE IF EXISTS "Candidate"');
    await client.$executeRawUnsafe('DROP TABLE "PdeDecisionContext"');
    for (const table of [...methodologyTables].reverse()) {
      await client.$executeRawUnsafe(`DROP TABLE "${table}"`);
    }
    const tenantColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("Tenant")',
    );
    if (tenantColumns.some((column) => column.name === 'dataScopePolicy')) {
      await client.$executeRawUnsafe('ALTER TABLE "Tenant" DROP COLUMN "dataScopePolicy"');
    }
    await client.$executeRawUnsafe('DROP TABLE "MatterParticipant"');
    await client.$executeRawUnsafe('DROP TABLE "DataMigrationState"');
    await client.$executeRawUnsafe('ALTER TABLE "Edge" DROP COLUMN "kind"');
    for (const indexName of [
      'PlanAction_tenantId_ownerUserId_executionStatus_idx',
      'PlanAction_tenantId_confirmationStatus_confirmationDueAtUtc_idx',
      'PlanAction_tenantId_executionStatus_dueAtUtc_idx',
      'PlanAction_tenantId_executionStatus_localDate_idx',
      'PlanAction_tenantId_nextCommitmentId_idx',
    ]) {
      await client.$executeRawUnsafe(`DROP INDEX "${indexName}"`);
    }
    for (const column of [
      'kind', 'ownerUserId', 'executionStatus', 'confirmationStatus',
      'scheduledAtUtc', 'dueAtUtc', 'timeZone', 'isAllDay', 'localDate',
      'confirmationDueAtUtc', 'confirmedAtUtc', 'confirmedByUserId',
      'scheduleVersion', 'nextCommitmentId', 'source', 'sourceRef',
      'archivedAt', 'version',
    ]) {
      await client.$executeRawUnsafe(`ALTER TABLE "PlanAction" DROP COLUMN "${column}"`);
    }
    // Preserve the actual pre-CORE-108 contract in this fixture. The current
    // Prisma schema is already nullable, so reconstruct the otherwise-empty
    // legacy table with a required opportunityId before inserting old rows.
    await client.$executeRawUnsafe('DROP TABLE "PlanAction"');
    await client.$executeRawUnsafe(`CREATE TABLE "PlanAction" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "accountId" TEXT NOT NULL,
      "opportunityId" TEXT NOT NULL,
      "gapItem" TEXT NOT NULL DEFAULT '',
      "personId" TEXT,
      "title" TEXT NOT NULL,
      "scene" TEXT NOT NULL DEFAULT '',
      "scripts" TEXT NOT NULL DEFAULT '',
      "target" TEXT NOT NULL DEFAULT '',
      "ownerId" TEXT NOT NULL DEFAULT '',
      "startDate" TEXT NOT NULL DEFAULT '',
      "endDate" TEXT NOT NULL DEFAULT '',
      "half" TEXT NOT NULL DEFAULT 'am',
      "done" BOOLEAN NOT NULL DEFAULT false,
      "doneAt" TEXT,
      "draft" BOOLEAN NOT NULL DEFAULT false,
      "review" TEXT NOT NULL DEFAULT '',
      "resources" TEXT NOT NULL DEFAULT '',
      "cautions" TEXT NOT NULL DEFAULT '',
      "props" TEXT NOT NULL DEFAULT '',
      "origin" TEXT NOT NULL DEFAULT 'manual',
      "createdBy" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
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
    // Reconstruct the actual pre-CORE-115 Account contract. Dropping only the
    // two new fields would leave customerType nullable and create a false
    // legacy fixture that never proves the constraint release.
    // Explicitly remove global SQLite index names before replacing the table.
    // A slow CI run once retained one of these names after DROP TABLE, so the
    // fixture clears its exact namespace instead of relying on implicit cleanup.
    for (const indexName of [
      'Account_tenantId_id_key',
      'Account_tenantId_externalRef_key',
      'Account_tenantId_unifiedCreditCode_key',
      'Account_tenantId_idx',
      'Account_tenantId_primaryOwnerUserId_idx',
      'Account_tenantId_archivedAt_idx',
    ]) {
      await client.$executeRawUnsafe(`DROP INDEX IF EXISTS "${indexName}"`);
    }
    await client.$executeRawUnsafe('DROP TABLE "Account"');
    await client.$executeRawUnsafe(`CREATE TABLE "Account" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "customerType" INTEGER NOT NULL,
      "unifiedCreditCode" TEXT,
      "externalRef" TEXT,
      "region" TEXT NOT NULL DEFAULT '',
      "group" TEXT NOT NULL DEFAULT '',
      "primaryOwner" TEXT NOT NULL DEFAULT '',
      "primaryOwnerUserId" TEXT,
      "profile" TEXT NOT NULL DEFAULT '{}',
      "archivedAt" DATETIME,
      "archivedBy" TEXT,
      "archiveReason" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`);
    await client.$executeRawUnsafe('CREATE UNIQUE INDEX "Account_tenantId_id_key" ON "Account"("tenantId", "id")');
    await client.$executeRawUnsafe('CREATE UNIQUE INDEX "Account_tenantId_externalRef_key" ON "Account"("tenantId", "externalRef")');
    await client.$executeRawUnsafe('CREATE UNIQUE INDEX "Account_tenantId_unifiedCreditCode_key" ON "Account"("tenantId", "unifiedCreditCode")');
    await client.$executeRawUnsafe('CREATE INDEX "Account_tenantId_idx" ON "Account"("tenantId")');
    await client.$executeRawUnsafe('CREATE INDEX "Account_tenantId_primaryOwnerUserId_idx" ON "Account"("tenantId", "primaryOwnerUserId")');
    await client.$executeRawUnsafe('CREATE INDEX "Account_tenantId_archivedAt_idx" ON "Account"("tenantId", "archivedAt")');
    await client.$executeRawUnsafe(
      `INSERT INTO "Tenant" (id, name) VALUES ('sqlite-upgrade-tenant', 'SQLite Upgrade Tenant')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "User" (id, "tenantId", email, "passwordHash", name, role)
       VALUES ('sqlite-upgrade-user', 'sqlite-upgrade-tenant', 'sqlite-upgrade@example.test', 'unused', 'Owner', 'owner')`,
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
      `INSERT INTO "PersonSuggestion"
         (id, "tenantId", "accountId", "opportunityId", name, origin, evidence, confidence, status, "proposedBy")
       VALUES
         ('sqlite-upgrade-person-suggestion', 'sqlite-upgrade-tenant', 'sqlite-upgrade-account',
          'sqlite-upgrade-active', 'Legacy candidate', 'mcp', 'legacy evidence stays in source', 0.8,
          'pending', 'sqlite-upgrade-user')`,
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
    await client.$executeRawUnsafe(
      `INSERT INTO "PlanAction"
         (id, "tenantId", "accountId", "opportunityId", "personId", title,
          "ownerId", "startDate", "endDate", half, done, origin, "createdBy")
       VALUES
         ('sqlite-upgrade-action-planned', 'sqlite-upgrade-tenant', 'sqlite-upgrade-account',
          'sqlite-upgrade-active', 'sqlite-upgrade-person-one', 'Planned action',
          'sqlite-upgrade-user', '2026-10-07', '2026-10-08', 'am', false, 'workbuddy', ''),
         ('sqlite-upgrade-action-done', 'sqlite-upgrade-tenant', 'sqlite-upgrade-account',
          'sqlite-upgrade-won', NULL, 'Completed action',
          '', '2026-09-01', '2026-09-01', 'pm', true, '', 'sqlite-upgrade-user')`,
    );
  } finally {
    await client.$disconnect();
  }
}

describe('CORE-103/105/106/108/109/110/111/113/115 SQLite schema upgrade', () => {
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
      const accountColumns = await client.$queryRawUnsafe<Array<{
        name: string; notnull: number; dflt_value: string | null;
      }>>('PRAGMA table_info("Account")');
      expect(accountColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'categoryKey', 'customerType', 'version',
      ]));
      expect(Number(accountColumns.find((column) => column.name === 'customerType')?.notnull)).toBe(0);
      expect(Number(accountColumns.find((column) => column.name === 'version')?.notnull)).toBe(1);
      expect(accountColumns.find((column) => column.name === 'version')?.dflt_value).toBe('0');
      const tenantColumns = await client.$queryRawUnsafe<Array<{ name: string; dflt_value: string | null }>>(
        'PRAGMA table_info("Tenant")',
      );
      expect(tenantColumns.map((column) => column.name)).toContain('dataScopePolicy');
      expect(tenantColumns.find((column) => column.name === 'dataScopePolicy')?.dflt_value)
        .toBe("'legacy_tenant_shared'");
      const edgeColumns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Edge")');
      expect(edgeColumns.map((column) => column.name)).toContain('kind');
      const planColumns = await client.$queryRawUnsafe<Array<{ name: string; notnull: number }>>('PRAGMA table_info("PlanAction")');
      expect(planColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'kind', 'ownerUserId', 'executionStatus', 'confirmationStatus',
        'scheduledAtUtc', 'dueAtUtc', 'timeZone', 'isAllDay', 'localDate',
        'confirmationDueAtUtc', 'confirmedAtUtc', 'confirmedByUserId',
        'scheduleVersion', 'nextCommitmentId', 'source', 'sourceRef', 'archivedAt', 'version',
      ]));
      expect(Number(planColumns.find((column) => column.name === 'opportunityId')?.notnull)).toBe(0);
      await expect(client.matterParticipant.count()).resolves.toBe(0);
      await expect(listMethodologyTables(client)).resolves.toHaveLength(methodologyTables.length);
      await expect(client.methodologyPack.count()).resolves.toBe(0);
      await expect(client.methodologyPackVersion.count()).resolves.toBe(0);
      await expect(client.methodologyBinding.count()).resolves.toBe(0);
      await expect(client.methodologyPilotAssignment.count()).resolves.toBe(0);
      await expect(client.pdeDecisionContext.count()).resolves.toBe(0);
      const candidateColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        'PRAGMA table_info("Candidate")',
      );
      expect(candidateColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'id', 'tenantId', 'kind', 'status', 'accountId', 'matterId', 'targetKind', 'targetId',
        'fieldKey', 'oldValue', 'newValue', 'payload', 'source', 'sourceRef', 'evidence',
        'confidence', 'sourceArtifactId', 'reviewBatchId', 'createdByUserId', 'visibility',
        'dedupeKey', 'legacySourceKind', 'legacySourceId', 'version', 'createdAt', 'updatedAt',
      ]));
      await expect(client.candidate.count()).resolves.toBe(0);
      await expect(client.dataMigrationState.findUnique({
        where: { key: 'CORE-113-pde-decision-context-shadow-v1' },
      })).resolves.toMatchObject({ key: 'CORE-113-pde-decision-context-shadow-v1' });
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
      await expect(upgradedClient.$queryRawUnsafe<Array<{ dataScopePolicy: string }>>(
        'SELECT dataScopePolicy FROM "Tenant" WHERE id = \'sqlite-upgrade-tenant\'',
      )).resolves.toEqual([{ dataScopePolicy: 'legacy_tenant_shared' }]);
      await expect(upgradedClient.account.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-account' },
        select: { customerType: true, categoryKey: true, version: true },
      })).resolves.toEqual({ customerType: 1, categoryKey: null, version: 0 });
      const upgradedAccountColumns = await upgradedClient.$queryRawUnsafe<Array<{ name: string; notnull: number }>>(
        'PRAGMA table_info("Account")',
      );
      expect(Number(upgradedAccountColumns.find((column) => column.name === 'customerType')?.notnull)).toBe(0);
      await expect(upgradedClient.matterParticipant.findMany({
        orderBy: { personId: 'asc' },
        select: { opportunityId: true, personId: true },
      })).resolves.toEqual([
        { opportunityId: 'sqlite-upgrade-active', personId: 'sqlite-upgrade-person-one' },
        { opportunityId: 'sqlite-upgrade-active', personId: 'sqlite-upgrade-person-two' },
      ]);
      await expect(upgradedClient.planAction.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true, kind: true, ownerUserId: true, executionStatus: true,
          confirmationStatus: true, scheduledAtUtc: true, dueAtUtc: true,
          timeZone: true, isAllDay: true, localDate: true, scheduleVersion: true,
          source: true, version: true,
        },
      })).resolves.toEqual([
        {
          id: 'sqlite-upgrade-action-done', kind: 'task', ownerUserId: null,
          executionStatus: 'completed', confirmationStatus: 'not_required',
          scheduledAtUtc: null, dueAtUtc: null, timeZone: 'Asia/Shanghai',
          isAllDay: true, localDate: '2026-09-01', scheduleVersion: 0,
          source: 'manual', version: 0,
        },
        {
          id: 'sqlite-upgrade-action-planned', kind: 'task', ownerUserId: 'sqlite-upgrade-user',
          executionStatus: 'planned', confirmationStatus: 'not_required',
          scheduledAtUtc: null, dueAtUtc: null, timeZone: 'Asia/Shanghai',
          isAllDay: true, localDate: '2026-10-08', scheduleVersion: 0,
          source: 'workbuddy', version: 0,
        },
      ]);
      await expect(listMethodologyTables(upgradedClient)).resolves.toHaveLength(methodologyTables.length);
      await expect(upgradedClient.methodologyBinding.count()).resolves.toBe(0);
      await expect(upgradedClient.pdeDecisionContext.findMany({
        orderBy: { opportunityId: 'asc' },
        select: { opportunityId: true, stageKey: true, decisionProfileRef: true, source: true },
      })).resolves.toEqual([
        { opportunityId: 'sqlite-upgrade-active', stageKey: 'initiation', decisionProfileRef: null, source: 'legacy_shadow' },
        { opportunityId: 'sqlite-upgrade-lost', stageKey: 'initiation', decisionProfileRef: null, source: 'legacy_shadow' },
        { opportunityId: 'sqlite-upgrade-paused', stageKey: 'initiation', decisionProfileRef: null, source: 'legacy_shadow' },
        { opportunityId: 'sqlite-upgrade-won', stageKey: 'initiation', decisionProfileRef: null, source: 'legacy_shadow' },
      ]);
      await expect(upgradedClient.candidate.count()).resolves.toBe(1);
      await expect(upgradedClient.candidate.findFirstOrThrow({
        where: {
          tenantId: 'sqlite-upgrade-tenant',
          legacySourceKind: 'PersonSuggestion',
          legacySourceId: 'sqlite-upgrade-person-suggestion',
        },
      })).resolves.toMatchObject({
        kind: 'person_create', status: 'pending', accountId: 'sqlite-upgrade-account',
        matterId: 'sqlite-upgrade-active', evidence: 'legacy evidence stays in source',
      });
      await expect(upgradedClient.dataMigrationState.findUnique({
        where: { key: 'CORE-203-candidate-backfill-v1' },
      })).resolves.toMatchObject({ key: 'CORE-203-candidate-backfill-v1' });
      await expect(upgradedClient.personSuggestion.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-person-suggestion' },
        select: { status: true, evidence: true },
      })).resolves.toEqual({ status: 'pending', evidence: 'legacy evidence stays in source' });
      const upgradedPlanColumns = await upgradedClient.$queryRawUnsafe<Array<{ name: string; notnull: number }>>(
        'PRAGMA table_info("PlanAction")',
      );
      expect(Number(upgradedPlanColumns.find((column) => column.name === 'opportunityId')?.notnull)).toBe(0);
      await upgradedClient.$executeRawUnsafe(
        `INSERT INTO "PlanAction"
           (id, "tenantId", "accountId", "opportunityId", title, "ownerId", "startDate", "endDate", half, done, origin, "createdBy")
         VALUES
           ('sqlite-customer-level-commitment', 'sqlite-upgrade-tenant', 'sqlite-upgrade-account', NULL,
            'Customer-level commitment', 'sqlite-upgrade-user', '2026-10-10', '2026-10-10', 'am', false, 'manual', 'sqlite-upgrade-user')`,
      );
      await expect(upgradedClient.planAction.findUniqueOrThrow({
        where: { id: 'sqlite-customer-level-commitment' }, select: { opportunityId: true },
      })).resolves.toEqual({ opportunityId: null });
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
      const restoredTenantColumns = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        'PRAGMA table_info("Tenant")',
      );
      expect(restoredTenantColumns.map((column) => column.name)).not.toContain('dataScopePolicy');
      const restoredAccountColumns = await restoredClient.$queryRawUnsafe<Array<{ name: string; notnull: number }>>(
        'PRAGMA table_info("Account")',
      );
      expect(restoredAccountColumns.map((column) => column.name)).not.toContain('categoryKey');
      expect(restoredAccountColumns.map((column) => column.name)).not.toContain('version');
      expect(Number(restoredAccountColumns.find((column) => column.name === 'customerType')?.notnull)).toBe(1);
      await expect(restoredClient.$queryRawUnsafe<Array<{ customerType: number }>>(
        'SELECT "customerType" FROM "Account" WHERE id = \'sqlite-upgrade-account\'',
      )).resolves.toEqual([{ customerType: 1 }]);
      const restoredEdgeColumns = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        'PRAGMA table_info("Edge")',
      );
      expect(restoredEdgeColumns.map((column) => column.name)).not.toContain('kind');
      const restoredPlanColumns = await restoredClient.$queryRawUnsafe<Array<{ name: string; notnull: number }>>(
        'PRAGMA table_info("PlanAction")',
      );
      expect(restoredPlanColumns.map((column) => column.name)).not.toContain('executionStatus');
      expect(Number(restoredPlanColumns.find((column) => column.name === 'opportunityId')?.notnull)).toBe(1);
      const restoredParticipantTables = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'MatterParticipant'`,
      );
      expect(restoredParticipantTables).toEqual([]);
      await expect(listMethodologyTables(restoredClient)).resolves.toEqual([]);
      const restoredPdeContextTables = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'PdeDecisionContext'`,
      );
      expect(restoredPdeContextTables).toEqual([]);
      const restoredCandidateTables = await restoredClient.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Candidate'`,
      );
      expect(restoredCandidateTables).toEqual([]);
      await expect(restoredClient.personSuggestion.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-person-suggestion' },
        select: { status: true, evidence: true },
      })).resolves.toEqual({ status: 'pending', evidence: 'legacy evidence stays in source' });
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
      await expect(client.account.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-account' },
        select: { customerType: true, categoryKey: true, version: true },
      })).resolves.toEqual({ customerType: 1, categoryKey: null, version: 0 });
      await expect(client.matterParticipant.count()).resolves.toBe(0);
      await expect(client.pdeDecisionContext.count()).resolves.toBe(0);
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
      await expect(client.pdeDecisionContext.count()).resolves.toBe(4);
      await expect(client.planAction.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-action-planned' },
        select: { localDate: true, executionStatus: true, source: true },
      })).resolves.toEqual({ localDate: '2026-10-08', executionStatus: 'planned', source: 'workbuddy' });
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when only part of the Customer expansion exists', async () => {
    const directory = await mkdtemp(resolve('prisma/.customer-partial-test-'));
    const relativeDirectory = basename(directory);
    const databaseUrl = `file:./${relativeDirectory}/partial.db`;
    let client: PrismaClient | null = null;
    try {
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.$executeRawUnsafe('ALTER TABLE "Account" DROP COLUMN "version"');
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain(
        'partial Customer category expansion detected; restore the latest backup before retrying',
      );
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

  it('fails before DDL for an invalid legacy PlanAction date and succeeds after repair', async () => {
    const directory = await mkdtemp(resolve('prisma/.commitment-invalid-test-'));
    const relativeDirectory = basename(directory);
    const databasePath = join(directory, 'invalid.db');
    const databaseUrl = `file:./${relativeDirectory}/invalid.db`;
    let client: PrismaClient | null = null;
    try {
      await createLegacyFixture(databasePath, databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.$executeRawUnsafe(
        `UPDATE "PlanAction" SET "endDate" = '2026-02-31' WHERE id = 'sqlite-upgrade-action-planned'`,
      );
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain('invalid_end_date');

      client = new PrismaClient({ datasourceUrl: databaseUrl });
      const failedColumns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("PlanAction")');
      expect(failedColumns.map((column) => column.name)).not.toContain('executionStatus');
      await client.$executeRawUnsafe(
        `UPDATE "PlanAction" SET "endDate" = '2026-02-28' WHERE id = 'sqlite-upgrade-action-planned'`,
      );
      await client.$disconnect();
      client = null;

      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await expect(client.planAction.findUniqueOrThrow({
        where: { id: 'sqlite-upgrade-action-planned' }, select: { localDate: true },
      })).resolves.toEqual({ localDate: '2026-02-28' });
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails before methodology DDL for an unmanaged active pointer and succeeds after repair', async () => {
    const directory = await mkdtemp(resolve('prisma/.methodology-pointer-test-'));
    const relativeDirectory = basename(directory);
    const databasePath = join(directory, 'pointer.db');
    const databaseUrl = `file:./${relativeDirectory}/pointer.db`;
    let client: PrismaClient | null = null;
    try {
      await createLegacyFixture(databasePath, databaseUrl);
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);

      client = new PrismaClient({ datasourceUrl: databaseUrl });
      for (const table of [...methodologyTables].reverse()) {
        await client.$executeRawUnsafe(`DROP TABLE "${table}"`);
      }
      await client.$executeRawUnsafe(
        `UPDATE "Opportunity"
            SET "activeMethodologyBindingId" = 'unmanaged-binding'
          WHERE id = 'sqlite-upgrade-active'`,
      );
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain('unmanaged active methodology binding pointer');

      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await expect(listMethodologyTables(client)).resolves.toEqual([]);
      await client.$executeRawUnsafe(
        `UPDATE "Opportunity" SET "activeMethodologyBindingId" = NULL
          WHERE id = 'sqlite-upgrade-active'`,
      );
      await client.$disconnect();
      client = null;

      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await expect(listMethodologyTables(client)).resolves.toHaveLength(methodologyTables.length);
      await expect(client.methodologyBinding.count()).resolves.toBe(0);
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when only part of the methodology schema exists', async () => {
    const directory = await mkdtemp(resolve('prisma/.methodology-partial-test-'));
    const relativeDirectory = basename(directory);
    const databaseUrl = `file:./${relativeDirectory}/partial.db`;
    let client: PrismaClient | null = null;
    try {
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      for (const table of [...methodologyDataTables].reverse()) {
        await client.$executeRawUnsafe(`DROP TABLE "${table}"`);
      }
      for (const table of ['MethodologyPilotAssignment', 'MethodologyBinding', 'MethodologyPackVersion']) {
        await client.$executeRawUnsafe(`DROP TABLE "${table}"`);
      }
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain(
        'partial methodology foundation detected; restore the latest backup before retrying',
      );
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when only part of the methodology data schema exists', async () => {
    const directory = await mkdtemp(resolve('prisma/.methodology-data-partial-test-'));
    const relativeDirectory = basename(directory);
    const databaseUrl = `file:./${relativeDirectory}/partial.db`;
    let client: PrismaClient | null = null;
    try {
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.$executeRawUnsafe('DROP TABLE "MethodologyEvaluation"');
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain(
        'partial methodology data foundation detected; restore the latest backup before retrying',
      );
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when only part of the PDE decision context schema exists', async () => {
    const directory = await mkdtemp(resolve('prisma/.pde-context-partial-test-'));
    const relativeDirectory = basename(directory);
    const databaseUrl = `file:./${relativeDirectory}/partial.db`;
    let client: PrismaClient | null = null;
    try {
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.$executeRawUnsafe('ALTER TABLE "PdeDecisionContext" DROP COLUMN "source"');
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain(
        'partial PDE decision context detected; restore the latest backup before retrying',
      );
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when only part of the Candidate foundation exists', async () => {
    const directory = await mkdtemp(resolve('prisma/.candidate-partial-test-'));
    const relativeDirectory = basename(directory);
    const databaseUrl = `file:./${relativeDirectory}/partial.db`;
    let client: PrismaClient | null = null;
    try {
      run(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], databaseUrl);
      client = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.$executeRawUnsafe('ALTER TABLE "Candidate" DROP COLUMN "sourceRef"');
      await client.$disconnect();
      client = null;

      const failed = spawnSync(tsxBin, ['scripts/upgrade-sqlite-schema.ts'], {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl, JIANGHU_SKIP_PRISMA_GENERATE: '1' },
      });
      expect(failed.status).not.toBe(0);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain(
        'partial Candidate foundation detected; restore the latest backup before retrying',
      );
    } finally {
      await client?.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
