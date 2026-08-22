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

  it('delivers CORE-106 Commitment fields as an atomic fail-closed PlanAction expansion', async () => {
    const migration = await read('prisma/postgres/migrations/20260821020000_expand_commitment_fields/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain('LOCK TABLE "PlanAction"');
    expect(migration).toContain('invalid legacy PlanAction parentage');
    expect(migration).toContain('invalid legacy PlanAction business date');
    expect(migration.indexOf('invalid legacy PlanAction parentage'))
      .toBeLessThan(migration.indexOf('ADD COLUMN "executionStatus"'));
    expect(migration).toContain("ADD COLUMN \"kind\" TEXT NOT NULL DEFAULT 'task'");
    expect(migration).toContain('ADD COLUMN "executionStatus"');
    expect(migration).toContain('ADD COLUMN "confirmationStatus"');
    expect(migration).toContain('ADD COLUMN "scheduledAtUtc"');
    expect(migration).toContain('ADD COLUMN "dueAtUtc"');
    expect(migration).toContain('ADD COLUMN "timeZone"');
    expect(migration).toContain('ADD COLUMN "isAllDay"');
    expect(migration).toContain('ADD COLUMN "localDate"');
    expect(migration).toContain('ADD COLUMN "confirmationDueAtUtc"');
    expect(migration).toContain('ADD COLUMN "confirmedAtUtc"');
    expect(migration).toContain('ADD COLUMN "confirmedByUserId"');
    expect(migration).toContain('ADD COLUMN "scheduleVersion"');
    expect(migration).toContain('ADD COLUMN "nextCommitmentId"');
    expect(migration).toContain('ADD COLUMN "source"');
    expect(migration).toContain('ADD COLUMN "sourceRef"');
    expect(migration).toContain('ADD COLUMN "archivedAt"');
    expect(migration).toContain('ADD COLUMN "version"');
    expect(migration).toContain('CORE-106-commitment-backfill-v1');
    expect(migration).toContain('Commitment backfill parity failed');

    for (const field of [
      'kind', 'ownerUserId', 'executionStatus', 'confirmationStatus', 'scheduledAtUtc', 'dueAtUtc',
      'timeZone', 'isAllDay', 'localDate', 'confirmationDueAtUtc', 'confirmedAtUtc',
      'confirmedByUserId', 'scheduleVersion', 'nextCommitmentId', 'source', 'sourceRef',
      'archivedAt', 'version',
    ]) expect(schema).toContain(field);

    expect(packageJson.scripts?.['migrate:commitment-report']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:commitment-verify']).toBeTruthy();
    expect(deployScript).toContain('recover_incomplete_commitment_migration');
    expect(deployScript).toContain('adopt_existing_commitment_schema_if_safe');
    expect(deployScript).toContain('postgres-commitment-schema-state.ts');
    expect(deployScript.indexOf('migrate:commitment-report'))
      .toBeLessThan(deployScript.indexOf('prisma migrate deploy'));
    expect(deployScript.lastIndexOf('migrate:commitment-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
    const preCommitment = await read('prisma/postgres/legacy/20260821_pre_core106.prisma');
    expect(preCommitment).toContain('model MatterParticipant');
    expect(preCommitment).not.toContain('executionStatus');
    expect(deployScript).toContain('PRE_COMMITMENT_SCHEMA=prisma/postgres/legacy/20260821_pre_core106.prisma');
  });

  it('releases customer-level Commitments only after the CORE-108 cutover preflight', async () => {
    const migration = await read('prisma/postgres/migrations/20260821030000_release_customer_level_commitments/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const preCutoverSchema = await read('prisma/postgres/legacy/20260821_pre_core108.prisma');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const schemaState = await read('scripts/postgres-commitment-schema-state.ts');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain('LOCK TABLE "PlanAction"');
    expect(migration).toContain('CORE-106-commitment-backfill-v1');
    expect(migration).toContain('Commitment cutover preflight failed');
    expect(migration.indexOf('Commitment cutover preflight failed'))
      .toBeLessThan(migration.indexOf('ALTER COLUMN "opportunityId" DROP NOT NULL'));
    expect(migration).toContain('ALTER COLUMN "opportunityId" DROP NOT NULL');
    expect(migration).toContain('CORE-108-commitment-consumer-cutover-v1');
    expect(schema).toMatch(/model PlanAction \{[^}]*opportunityId\s+String\?/);
    expect(preCutoverSchema).toMatch(/model PlanAction \{[^}]*opportunityId\s+String\s/);
    expect(preCutoverSchema).not.toMatch(/model PlanAction \{[^}]*opportunityId\s+String\?/);
    expect(deployScript).toContain('PRE_COMMITMENT_CUTOVER_SCHEMA=prisma/postgres/legacy/20260821_pre_core108.prisma');
    expect(deployScript).toContain('COMMITMENT_CUTOVER_MIGRATION=20260821030000_release_customer_level_commitments');
    expect(deployScript).toContain('recover_incomplete_commitment_cutover_migration');
    expect(deployScript).toContain('adopt_existing_commitment_cutover_schema_if_safe');
    expect(deployScript.indexOf('recover_incomplete_commitment_migration'))
      .toBeLessThan(deployScript.indexOf('recover_incomplete_commitment_cutover_migration'));
    expect(deployScript.lastIndexOf('migrate:commitment-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
    expect(schemaState).toContain("process.stdout.write('expanded_required')");
    expect(schemaState).toContain("process.stdout.write('expanded_nullable')");
    expect(sqliteUpgrade).toContain("['tsx', 'scripts/migrate-commitment-fields.ts', '--cutover']");
  });

  it('adds the CORE-109 tenant data-scope policy as an atomic portable expansion', async () => {
    const migration = await read('prisma/postgres/migrations/20260821040000_add_tenant_data_scope_policy/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const preScopeSchema = await read('prisma/postgres/legacy/20260821_pre_core109.prisma').catch(() => '');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const schemaState = await read('scripts/postgres-scope-schema-state.ts').catch(() => '');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain(
      'ADD COLUMN "dataScopePolicy" TEXT NOT NULL DEFAULT \'legacy_tenant_shared\'',
    );
    expect(schema).toMatch(
      /model Tenant \{[^}]*dataScopePolicy\s+String\s+@default\("legacy_tenant_shared"\)/,
    );
    expect(preScopeSchema).toContain('model Tenant');
    expect(preScopeSchema).not.toContain('dataScopePolicy');
    expect(deployScript).toContain(
      'PRE_SCOPE_SCHEMA=prisma/postgres/legacy/20260821_pre_core109.prisma',
    );
    expect(deployScript).toContain('SCOPE_MIGRATION=20260821040000_add_tenant_data_scope_policy');
    expect(deployScript).toContain('recover_incomplete_scope_migration');
    expect(deployScript).toContain('adopt_existing_scope_schema_if_safe');
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("process.stdout.write('expanded')");
    expect(schemaState).toContain("process.stdout.write('partial')");
    expect(deployScript).toMatch(
      /matter_schema_matches_known_state\(\) \{[\s\S]*schema_matches "\$PRE_SCOPE_SCHEMA"[\s\S]*\|\| schema_matches "\$SCHEMA"/,
    );
    expect(deployScript).toMatch(
      /participant_schema_matches_known_state\(\) \{[\s\S]*schema_matches "\$PRE_SCOPE_SCHEMA"[\s\S]*\|\| schema_matches "\$SCHEMA"/,
    );
  });

  it('adds the CORE-110 methodology foundation with fail-closed active-pointer adoption', async () => {
    const migration = await read('prisma/postgres/migrations/20260821050000_add_methodology_foundation/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const preMethodologySchema = await read('prisma/postgres/legacy/20260821_pre_core110.prisma').catch(() => '');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const schemaState = await read('scripts/postgres-methodology-schema-state.ts').catch(() => '');
    const integrity = await read('scripts/check-methodology-foundation.ts').catch(() => '');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Opportunity" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain('unmanaged active methodology binding pointer');
    expect(migration.indexOf('unmanaged active methodology binding pointer'))
      .toBeLessThan(migration.indexOf('CREATE TABLE "MethodologyPack"'));
    for (const table of [
      'MethodologyPack',
      'MethodologyPackVersion',
      'MethodologyBinding',
      'MethodologyPilotAssignment',
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`model ${table}`);
    }
    expect(migration).toContain('FOREIGN KEY ("tenantId", "opportunityId")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "packId", "versionId")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "candidatePackId", "candidateVersionId")');
    expect(migration).toContain('FOREIGN KEY ("baselineBindingId")');
    expect(migration).toContain('FOREIGN KEY ("decisionProfileRef")');
    expect(schema).toMatch(/model MethodologyBinding \{[^}]*decisionProfileRef\s+String\?/);
    expect(schema).toMatch(/model MethodologyBinding \{[^}]*createdAt\s+DateTime\s+@default\(now\(\)\)/);
    expect(schema).not.toMatch(/model MethodologyBinding \{[^}]*active\s+Boolean/);
    expect(schema).toMatch(/model MethodologyPilotAssignment \{[^}]*baselineBindingId\s+String\?/);
    expect(schema).toMatch(/model MethodologyPilotAssignment \{[^}]*matterVersion\s+Int/);
    expect(preMethodologySchema).toContain('activeMethodologyBindingId');
    expect(preMethodologySchema).not.toContain('model MethodologyPack');

    expect(deployScript).toContain('PRE_METHODOLOGY_SCHEMA=prisma/postgres/legacy/20260821_pre_core110.prisma');
    expect(deployScript).toContain('METHODOLOGY_MIGRATION=20260821050000_add_methodology_foundation');
    expect(deployScript).toContain('recover_incomplete_methodology_migration');
    expect(deployScript).toContain('adopt_existing_methodology_schema_if_safe');
    expect(deployScript).toContain('if [ "$matter_migration_pending" -eq 0 ]');
    expect(deployScript).toContain('Matter 扩展后由方法论迁移事务内预检');
    expect(deployScript.indexOf('migrate:methodology-report'))
      .toBeLessThan(deployScript.indexOf('prisma migrate deploy'));
    expect(deployScript.lastIndexOf('migrate:methodology-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("process.stdout.write('expanded')");
    expect(schemaState).toContain("process.stdout.write('partial')");
    expect(integrity).toContain('unmanaged active methodology binding pointer');
    expect(integrity).toContain('methodology foundation integrity failed');
    expect(sqliteUpgrade).toContain('inspectMethodologySchemaState');
    expect(sqliteUpgrade).toContain("['tsx', 'scripts/check-methodology-foundation.ts', '--verify']");
    expect(packageJson.scripts?.['migrate:methodology-report']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:methodology-verify']).toBeTruthy();
  });

  it('adds the CORE-111 methodology data foundation with portable snapshots and recoverable deployment', async () => {
    const migration = await read('prisma/postgres/migrations/20260821060000_add_methodology_data_foundation/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const preDataSchema = await read('prisma/postgres/legacy/20260821_pre_core111.prisma').catch(() => '');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const schemaState = await read('scripts/postgres-methodology-data-schema-state.ts').catch(() => '');
    const integrity = await read('scripts/check-methodology-data.ts').catch(() => '');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "MethodologyPackVersion"');
    expect(migration).toContain('LOCK TABLE "MethodologyBinding"');

    const models = [
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
    ];
    for (const model of models) {
      expect(migration).toContain(`CREATE TABLE "${model}"`);
      expect(schema).toContain(`model ${model}`);
      expect(preDataSchema).not.toContain(`model ${model}`);
    }
    expect(preDataSchema).toContain('model MethodologyPackVersion');
    expect(preDataSchema).toContain('model MethodologyBinding');

    expect(schema).toMatch(/model MethodologyFieldDefinition \{[\s\S]*?storageBindingKind\s+String/);
    expect(schema).toMatch(/model MethodologyFieldDefinition \{[\s\S]*?storageBindingPath\s+String/);
    expect(schema).toMatch(/@@unique\(\[tenantId, packId, versionId, storageBindingKind, storageBindingPath\]\)/);
    expect(schema).toMatch(/model MethodologyStageState \{[\s\S]*?binding\s+MethodologyBinding/);
    expect(schema).toMatch(/model MethodologyRoleAssignment \{[\s\S]*?person\s+Person/);
    expect(schema).toMatch(/model MethodologyValue \{[\s\S]*?normalizedValueJson\s+String/);
    expect(schema).toMatch(/model MethodologyEvaluation \{[\s\S]*?inputsJson\s+String[\s\S]*?resultJson\s+String/);
    expect(schema).toMatch(/model MethodologyMigrationRun \{[\s\S]*?dryRunJson\s+String[\s\S]*?rollbackJson\s+String/);
    expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
    expect(schema).not.toMatch(/^enum\s+/m);

    expect(migration).toContain('FOREIGN KEY ("tenantId", "opportunityId", "bindingId", "packId", "versionId")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "packId", "versionId", "fieldKey")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "packId", "versionId", "stageKey")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "packId", "versionId", "roleKey")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "personId")');

    expect(deployScript).toContain('PRE_METHODOLOGY_DATA_SCHEMA=prisma/postgres/legacy/20260821_pre_core111.prisma');
    expect(deployScript).toContain('METHODOLOGY_DATA_MIGRATION=20260821060000_add_methodology_data_foundation');
    expect(deployScript).toContain('recover_incomplete_methodology_data_migration');
    expect(deployScript).toContain('adopt_existing_methodology_data_schema_if_safe');
    expect(deployScript.lastIndexOf('migrate:methodology-data-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("process.stdout.write('expanded')");
    expect(schemaState).toContain("process.stdout.write('partial')");
    expect(integrity).toContain('methodology data integrity failed');
    expect(integrity).toContain('invalidMethodologyValueTargets');
    expect(sqliteUpgrade).toContain('inspectMethodologyDataSchemaState');
    expect(sqliteUpgrade).toContain("['tsx', 'scripts/check-methodology-data.ts', '--verify']");
    expect(packageJson.scripts?.['migrate:methodology-data-report']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:methodology-data-verify']).toBeTruthy();
  });

  it('adds the CORE-113 tenant-scoped PDE decision context with shadow parity and recovery gates', async () => {
    const migration = await read('prisma/postgres/migrations/20260821070000_add_pde_decision_context/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const preContextSchema = await read('prisma/postgres/legacy/20260821_pre_core113.prisma').catch(() => '');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const schemaState = await read('scripts/postgres-pde-context-schema-state.ts').catch(() => '');
    const migrationScript = await read('scripts/migrate-pde-decision-context.ts').catch(() => '');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('LOCK TABLE "Opportunity"');
    expect(migration).toContain('CREATE TABLE "PdeDecisionContext"');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "opportunityId")');
    expect(migration).toContain('FOREIGN KEY ("tenantId", "decisionProfileRef")');
    expect(migration).toContain("WHEN '预算批复' THEN 'budget_approval'");
    expect(migration).toContain("ELSE 'initiation'");
    expect(migration).toContain('PDE decision context backfill parity failed');

    expect(schema).toMatch(/model PdeDecisionContext \{[\s\S]*?stageKey\s+String/);
    expect(schema).toMatch(/model PdeDecisionContext \{[\s\S]*?decisionProfileRef\s+String\?/);
    expect(schema).toMatch(/model PdeDecisionContext \{[\s\S]*?@@unique\(\[tenantId, opportunityId\]\)/);
    expect(preContextSchema).not.toContain('model PdeDecisionContext');
    expect(preContextSchema).toContain('model MethodologyMigrationRun');

    expect(deployScript).toContain('PRE_PDE_CONTEXT_SCHEMA=prisma/postgres/legacy/20260821_pre_core113.prisma');
    expect(deployScript).toContain('PDE_CONTEXT_MIGRATION=20260821070000_add_pde_decision_context');
    expect(deployScript).toContain('recover_incomplete_pde_context_migration');
    expect(deployScript).toContain('adopt_existing_pde_context_schema_if_safe');
    expect(deployScript.lastIndexOf('migrate:pde-context-verify'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy'));
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("process.stdout.write('expanded')");
    expect(schemaState).toContain("process.stdout.write('partial')");
    expect(migrationScript).toContain('--dry-run');
    expect(migrationScript).toContain('--apply');
    expect(migrationScript).toContain('--verify');
    expect(sqliteUpgrade).toContain('inspectPdeDecisionContextSchemaState');
    expect(sqliteUpgrade).toContain("['tsx', 'scripts/migrate-pde-decision-context.ts', '--verify']");
    expect(packageJson.scripts?.['migrate:pde-context-report']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:pde-context-apply']).toBeTruthy();
    expect(packageJson.scripts?.['migrate:pde-context-verify']).toBeTruthy();
  });
});
