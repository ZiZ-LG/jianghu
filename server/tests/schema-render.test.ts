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

  it('delivers CORE-115 Customer fields as an atomic nullable expansion with recovery gates', async () => {
    const migration = await read('prisma/postgres/migrations/20260823000000_expand_customer_fields/migration.sql').catch(() => '');
    const schema = await read('prisma/postgres/schema.prisma');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const schemaState = await read('scripts/postgres-customer-schema-state.ts').catch(() => '');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const integrationDrill = await read('../scripts/test-postgres-ops-integration.sh');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Account" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain('ADD COLUMN "categoryKey" TEXT');
    expect(migration).toContain('ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('ALTER COLUMN "customerType" DROP NOT NULL');
    expect(migration).not.toMatch(/UPDATE\s+"Account"[\s\S]*"categoryKey"/i);
    expect(migration).toContain('Customer expansion parity failed');
    expect(migration.indexOf('CREATE TEMP TABLE "_core115_account_legacy"'))
      .toBeLessThan(migration.indexOf('ADD COLUMN "categoryKey"'));

    expect(schema).toMatch(/model Account \{[^}]*categoryKey\s+String\?/);
    expect(schema).toMatch(/model Account \{[^}]*customerType\s+Int\?/);
    expect(schema).toMatch(/model Account \{[^}]*version\s+Int\s+@default\(0\)/);
    expect(deployScript).toContain('CUSTOMER_MIGRATION=20260823000000_expand_customer_fields');
    expect(deployScript).toContain('PRE_CUSTOMER_SCHEMA=$(mktemp /tmp/jianghu-pre-core115.prisma.XXXXXX)');
    expect(deployScript).toContain('trap cleanup_pre_customer_schema EXIT');
    expect(deployScript).not.toContain('PRE_CUSTOMER_SCHEMA=/tmp/jianghu-pre-core115.prisma');
    expect(deployScript).toContain('recover_incomplete_customer_migration');
    expect(deployScript).toContain('adopt_existing_customer_schema_if_safe');
    expect(deployScript).toContain('postgres-customer-schema-state.ts');
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("process.stdout.write('expanded')");
    expect(schemaState).toContain("process.stdout.write('partial')");
    expect(sqliteUpgrade).toContain('inspectCustomerSchemaState');
    expect(sqliteUpgrade).toContain('customerStateBefore');
    expect(sqliteUpgrade).toContain('partial Customer category expansion detected');
    expect(integrationDrill).toContain('for path in prisma/postgres/migrations/20*; do');
    expect(integrationDrill).toContain('[ -d "$path" ] || continue');
    expect(integrationDrill).not.toContain('for path in prisma/postgres/migrations/*; do');
  });

  it('keeps the CORE-201 schema expansion portable and adds the CORE-203 versioned data cutover', async () => {
    const sqliteSchema = await read('prisma/schema.prisma');
    const postgresSchema = await read('prisma/postgres/schema.prisma');
    const preCandidateSchema = await read('prisma/postgres/legacy/20260824_pre_core201.prisma').catch(() => '');
    const migration = await read(
      'prisma/postgres/migrations/20260824000000_expand_candidate_foundation/migration.sql',
    ).catch(() => '');
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const schemaState = await read('scripts/postgres-candidate-schema-state.ts').catch(() => '');
    const packageJson = JSON.parse(await read('package.json')) as {
      scripts?: Record<string, string>;
    };

    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toMatch(/model Tenant \{[\s\S]*?candidates\s+Candidate\[\]/);
      expect(schema).toMatch(/model Candidate \{[\s\S]*?tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
      for (const field of [
        'kind', 'status', 'accountId', 'matterId', 'targetKind', 'targetId', 'fieldKey',
        'oldValue', 'newValue', 'payload', 'source', 'sourceRef', 'evidence', 'confidence',
        'sourceArtifactId', 'reviewBatchId', 'createdByUserId', 'visibility', 'dedupeKey',
        'legacySourceKind', 'legacySourceId', 'version', 'createdAt', 'updatedAt',
      ]) expect(schema).toMatch(new RegExp(`model Candidate \\{[\\s\\S]*?\\b${field}\\s+`));
      expect(schema).toMatch(/model Candidate \{[\s\S]*?@@unique\(\[tenantId, dedupeKey\]\)/);
      expect(schema).toMatch(/model Candidate \{[\s\S]*?@@unique\(\[tenantId, legacySourceKind, legacySourceId\]\)/);
      for (const index of [
        '@@index([tenantId, status, createdAt])',
        '@@index([tenantId, accountId, status, createdAt])',
        '@@index([tenantId, matterId, status, createdAt])',
        '@@index([tenantId, sourceArtifactId])',
        '@@index([tenantId, reviewBatchId])',
        '@@index([tenantId, createdByUserId, visibility])',
      ]) expect(schema).toContain(index);
      expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
      expect(schema).not.toMatch(/^enum\s+/m);
    }

    expect(preCandidateSchema).not.toContain('model Candidate');
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('CREATE TABLE "Candidate"');
    expect(migration).toContain('FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")');
    for (const identity of [
      'Candidate_tenantId_dedupeKey_key',
      'Candidate_tenantId_legacySourceKind_legacySourceId_key',
      'Candidate_tenantId_status_createdAt_idx',
      'Candidate_tenantId_accountId_status_createdAt_idx',
      'Candidate_tenantId_matterId_status_createdAt_idx',
      'Candidate_tenantId_sourceArtifactId_idx',
      'Candidate_tenantId_reviewBatchId_idx',
      'Candidate_tenantId_createdByUserId_visibility_idx',
    ]) expect(migration).toContain(`"${identity}"`);
    expect(migration).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:PersonSuggestion|RelSuggestion|ChangeProposal|Reminder|EvidenceEvent|Candidate)"/i,
    );

    expect(packageJson.scripts?.['migrate:candidate-report']).toBe(
      'tsx scripts/migrate-candidates.ts --dry-run',
    );
    expect(packageJson.scripts?.['migrate:candidate-verify']).toBe(
      'tsx scripts/migrate-candidates.ts --verify',
    );
    expect(packageJson.scripts?.['migrate:candidate-apply']).toBe(
      'tsx scripts/migrate-candidates.ts --apply',
    );
    expect(deployScript).toContain('CANDIDATE_MIGRATION=20260824000000_expand_candidate_foundation');
    expect(deployScript).toContain('PRE_CANDIDATE_SCHEMA=prisma/postgres/legacy/20260824_pre_core201.prisma');
    expect(deployScript).toContain('recover_incomplete_candidate_migration');
    expect(deployScript).toContain('adopt_existing_candidate_schema_if_safe');
    expect(deployScript).toContain('postgres-candidate-schema-state.ts');
    expect(deployScript).toContain('npm run migrate:candidate-report');
    expect(deployScript).toContain('npm run migrate:candidate-apply');
    expect(deployScript).toContain('npm run migrate:candidate-verify');
    expect(deployScript).toContain('uninitialized|legacy) return 0 ;;');
    expect(schemaState).toContain("process.stdout.write('uninitialized')");
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("process.stdout.write('expanded')");
    expect(schemaState).toContain("process.stdout.write('partial')");
    expect(schemaState).not.toMatch(/\bAS\s+constraint\b/i);
    expect(schemaState).toContain('FROM pg_constraint AS candidate_constraint');
    expect(sqliteUpgrade).toContain('inspectCandidateSchemaState');
    expect(sqliteUpgrade).toContain('partial Candidate foundation detected');
    expect(sqliteUpgrade).toContain('candidateBackfillRequired');
    expect(sqliteUpgrade).toContain("['run', 'migrate:candidate-apply']");
  });

  it('delivers CORE-204 sensitive creator/share ACL as an expand-only dual-database cutover', async () => {
    const sqliteSchema = await read('prisma/schema.prisma');
    const postgresSchema = await read('prisma/postgres/schema.prisma');
    const preAclSchema = await read('prisma/postgres/legacy/20260825_pre_core204.prisma');
    const migration = await read(
      'prisma/postgres/migrations/20260825000000_expand_sensitive_resource_acl/migration.sql',
    );
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const aclState = await read('scripts/postgres-sensitive-acl-schema-state.ts');
    const candidateState = await read('scripts/postgres-candidate-schema-state.ts');
    const migrationCli = await read('scripts/migrate-sensitive-acl.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toMatch(/model SourceArtifact \{[\s\S]*?createdByUserId\s+String\?/);
      expect(schema).toMatch(/model SourceArtifact \{[\s\S]*?visibility\s+String\s+@default\("owner_admin_only"\)/);
      expect(schema).toMatch(/model SourceArtifact \{[\s\S]*?aclVersion\s+Int\s+@default\(1\)/);
      expect(schema).toMatch(/model SensitiveResourceGrant \{[\s\S]*?resourceAclVersion\s+Int/);
      expect(schema).toMatch(/model Note \{[\s\S]*?createdByUserId\s+String\?[\s\S]*?visibility\s+String[\s\S]*?aclVersion\s+Int/);
      expect(schema).toMatch(/model Transcript \{[\s\S]*?createdByUserId\s+String\?[\s\S]*?visibility\s+String[\s\S]*?aclVersion\s+Int/);
      expect(schema).toMatch(/model Transcript \{[\s\S]*?idempotencyDomain\s+String\s+@default\("system-quarantine-v1"\)/);
      expect(schema).toContain('@@unique([tenantId, idempotencyDomain, source, externalRef])');
      expect(schema).toMatch(/model Candidate \{[\s\S]*?aclVersion\s+Int\s+@default\(1\)/);
      expect(schema).not.toMatch(/^enum\s+/m);
      expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
    }
    expect(preAclSchema).toContain('model Candidate');
    expect(preAclSchema).not.toContain('model SourceArtifact');
    expect(preAclSchema).not.toContain('model SensitiveResourceGrant');
    expect(preAclSchema).not.toMatch(/model Candidate \{[^}]*aclVersion/);
    expect(preAclSchema).not.toContain('idempotencyDomain');
    expect(preAclSchema).toContain('@@unique([tenantId, source, externalRef])');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Candidate", "Note", "Transcript"');
    expect(migration.indexOf('sensitive ACL columns partially exist'))
      .toBeLessThan(migration.indexOf('ALTER TABLE "Candidate"'));
    expect(migration).toContain('CREATE TABLE "SourceArtifact"');
    expect(migration).toContain('CREATE TABLE "SensitiveResourceGrant"');
    expect(migration).toContain('ADD COLUMN "idempotencyDomain" TEXT NOT NULL DEFAULT \'system-quarantine-v1\'');
    expect(migration).toContain('DROP INDEX "Transcript_tenantId_source_externalRef_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Transcript_tenantId_idempotencyDomain_source_externalRef_key"');
    expect(migration).toContain('FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")');
    expect(migration).toContain('sensitive ACL expansion parity failed');
    expect(migration).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:Note|Transcript|Candidate)"/i);

    expect(packageJson.scripts?.['migrate:sensitive-acl-report'])
      .toBe('tsx scripts/migrate-sensitive-acl.ts --dry-run');
    expect(packageJson.scripts?.['migrate:sensitive-acl-apply'])
      .toBe('tsx scripts/migrate-sensitive-acl.ts --apply');
    expect(packageJson.scripts?.['migrate:sensitive-acl-verify'])
      .toBe('tsx scripts/migrate-sensitive-acl.ts --verify');
    expect(migrationCli).toContain('reportSensitiveAclMigration');
    expect(migrationCli).toContain('applySensitiveAclMigration');
    expect(migrationCli).toContain('verifySensitiveAclMigration');
    expect(migrationCli).not.toContain('contentEnc');
    expect(migrationCli).not.toContain('payload');

    expect(deployScript).toContain('PRE_SENSITIVE_SCHEMA=prisma/postgres/legacy/20260825_pre_core204.prisma');
    expect(deployScript).toContain('SENSITIVE_ACL_MIGRATION=20260825000000_expand_sensitive_resource_acl');
    expect(deployScript).toContain('recover_incomplete_sensitive_acl_migration');
    expect(deployScript).toContain('adopt_existing_sensitive_acl_schema_if_safe');
    expect(deployScript).toContain('postgres-sensitive-acl-schema-state.ts');
    expect(deployScript.lastIndexOf('npm run migrate:sensitive-acl-report'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:sensitive-acl-apply'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:sensitive-acl-verify'))
      .toBeGreaterThan(deployScript.lastIndexOf('npm run migrate:sensitive-acl-apply'));
    for (const state of ['uninitialized', 'legacy', 'partial']) {
      expect(aclState).toContain(`process.stdout.write('${state}')`);
    }
    expect(aclState).toContain("'expanded'");
    expect(aclState).toContain('Transcript.idempotencyDomain');
    expect(aclState).toContain('Transcript_tenantId_idempotencyDomain_source_externalRef_key');
    expect(candidateState).toContain('expectedBaseColumns');
    expect(candidateState).toContain('expectedAclColumns');
    expect(sqliteUpgrade).toContain('inspectSensitiveAclSchemaState');
    expect(sqliteUpgrade).toContain('partial sensitive resource ACL expansion detected');
    expect(sqliteUpgrade).toContain("['run', 'migrate:sensitive-acl-apply']");
    expect(sqliteUpgrade).toContain("['run', 'migrate:sensitive-acl-verify']");
  });

  it('delivers SAAS-201 as a body-free SourceArtifact projection with guarded dual-database cutover', async () => {
    const sqliteSchema = await read('prisma/schema.prisma');
    const postgresSchema = await read('prisma/postgres/schema.prisma');
    const preSourceSchema = await read('prisma/postgres/legacy/20260825_pre_saas201.prisma');
    const migration = await read(
      'prisma/postgres/migrations/20260825010000_expand_source_artifact_projection/migration.sql',
    );
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const schemaState = await read('scripts/postgres-source-artifact-schema-state.ts');
    const sensitiveState = await read('scripts/postgres-sensitive-acl-schema-state.ts');
    const migrationCli = await read('scripts/migrate-source-artifacts.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    for (const schema of [sqliteSchema, postgresSchema]) {
      for (const field of [
        'artifactKind', 'source', 'externalRef', 'idempotencyDomain', 'title', 'occurredAt',
        'fingerprintKind', 'sourceFingerprint', 'retentionState', 'retentionUpdatedAt',
      ]) expect(schema).toMatch(new RegExp(`model SourceArtifact \\{[\\s\\S]*?${field}\\s+`));
      expect(schema).toContain(
        '@@unique([tenantId, idempotencyDomain, source, externalRef], map: "SourceArtifact_tenantId_domain_source_externalRef_key")',
      );
      expect(schema).toContain('@@index([tenantId, artifactKind, createdAt])');
      expect(schema).toContain('@@index([tenantId, retentionState, updatedAt])');
      expect(schema).not.toMatch(/model SourceArtifact \{[^}]*\b(?:content|contentEnc|body|payload)\b/);
      expect(schema).not.toMatch(/^enum\s+/m);
      expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
    }
    expect(preSourceSchema).toContain('model SourceArtifact');
    expect(preSourceSchema).not.toMatch(/model SourceArtifact \{[^}]*artifactKind/);
    expect(preSourceSchema).not.toContain('SourceArtifact_tenantId_domain_source_externalRef_key');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "SourceArtifact" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration.indexOf('projection columns partially exist'))
      .toBeLessThan(migration.indexOf('ADD COLUMN "artifactKind"'));
    expect(migration.match(/ADD COLUMN/g)).toHaveLength(10);
    expect(migration).toContain('SourceArtifact_tenantId_domain_source_externalRef_key');
    expect(migration).toContain('SourceArtifact_tenantId_artifactKind_createdAt_idx');
    expect(migration).toContain('SourceArtifact_tenantId_retentionState_updatedAt_idx');
    expect(migration).toContain('projection expansion parity failed');
    expect(migration).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:Note|Transcript|SourceArtifact)"/i);

    expect(packageJson.scripts?.['migrate:source-artifact-report'])
      .toBe('tsx scripts/migrate-source-artifacts.ts --dry-run');
    expect(packageJson.scripts?.['migrate:source-artifact-apply'])
      .toBe('tsx scripts/migrate-source-artifacts.ts --apply');
    expect(packageJson.scripts?.['migrate:source-artifact-verify'])
      .toBe('tsx scripts/migrate-source-artifacts.ts --verify');
    expect(migrationCli).toContain('reportSourceArtifactMigration');
    expect(migrationCli).toContain('applySourceArtifactMigration');
    expect(migrationCli).toContain('verifySourceArtifactMigration');
    expect(migrationCli).not.toContain('contentEnc');
    expect(migrationCli).not.toContain('Note.content');

    expect(deployScript).toContain('PRE_SOURCE_ARTIFACT_SCHEMA=prisma/postgres/legacy/20260825_pre_saas201.prisma');
    expect(deployScript).toContain('SOURCE_ARTIFACT_MIGRATION=20260825010000_expand_source_artifact_projection');
    expect(deployScript).toContain('recover_incomplete_source_artifact_migration');
    expect(deployScript).toContain('adopt_existing_source_artifact_schema_if_safe');
    expect(deployScript).toContain('postgres-source-artifact-schema-state.ts');
    expect(deployScript.lastIndexOf('npm run migrate:source-artifact-report'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:source-artifact-apply'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:source-artifact-verify'))
      .toBeGreaterThan(deployScript.lastIndexOf('npm run migrate:source-artifact-apply'));
    expect(schemaState).toContain("process.stdout.write('uninitialized')");
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("'expanded'");
    expect(schemaState).toContain("'partial'");
    expect(schemaState).toContain('expectedColumns');
    expect(schemaState).toContain('expectedIndexes');
    expect(sensitiveState).toContain('sourceArtifactBaseColumns');
    expect(sensitiveState).toContain('sourceArtifactSuccessorColumns');
    expect(sqliteUpgrade).toContain('inspectSourceArtifactSchemaState');
    expect(sqliteUpgrade).toContain('partial SourceArtifact projection expansion detected');
    expect(sqliteUpgrade).toContain("['run', 'migrate:source-artifact-apply']");
    expect(sqliteUpgrade).toContain("['run', 'migrate:source-artifact-verify']");
  });
});

describe('CORE-205 ReviewBatch and Interaction expansion', () => {
  it('keeps Candidate single-authority and wires guarded SQLite/PostgreSQL migration gates', async () => {
    const sqliteSchema = await read('prisma/schema.prisma');
    const postgresSchema = await read('prisma/postgres/schema.prisma');
    const preReviewSchema = await read('prisma/postgres/legacy/20260825_pre_core205.prisma');
    const migration = await read(
      'prisma/postgres/migrations/20260825020000_expand_review_batch_interaction/migration.sql',
    );
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const schemaState = await read('scripts/postgres-review-batch-schema-state.ts');
    const migrationCli = await read('scripts/migrate-review-batches.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema.match(/^model Candidate \{/gm)).toHaveLength(1);
      expect(schema).not.toContain('model ReviewCandidate {');
      expect(schema).toContain('model ReviewBatch {');
      expect(schema).toContain('model Interaction {');
      expect(schema).toContain('@@index([tenantId, sourceArtifactId, status])');
      expect(schema).toContain('@@index([tenantId, interactionId])');
      expect(schema).toContain('@@index([tenantId, sourceArtifactId])');
      expect(schema).not.toMatch(/model (?:ReviewBatch|Interaction) \{[^}]*(?:contentEnc|body|evidence|payload)/);
      expect(schema).not.toMatch(/^enum\s+/m);
      expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
    }
    expect(preReviewSchema).toContain('model SourceArtifact {');
    expect(preReviewSchema).not.toContain('model ReviewBatch {');
    expect(preReviewSchema).not.toContain('model Interaction {');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Candidate", "SourceArtifact" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration.indexOf('LOCK TABLE "Candidate", "SourceArtifact" IN SHARE ROW EXCLUSIVE MODE'))
      .toBeLessThan(migration.indexOf('pre-expansion Candidate attachment drift detected'));
    expect(migration.indexOf('pre-expansion Candidate attachment drift detected'))
      .toBeLessThan(migration.indexOf('CREATE TABLE "ReviewBatch"'));
    expect(migration).toContain('CREATE TABLE "Interaction"');
    expect(migration).toContain('ReviewBatch table expansion parity failed');
    expect(migration).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+"(?:Candidate|SourceArtifact|Person|Edge|PlanAction)"/i);

    expect(packageJson.scripts?.['migrate:review-batch-report'])
      .toBe('tsx scripts/migrate-review-batches.ts --dry-run');
    expect(packageJson.scripts?.['migrate:review-batch-apply'])
      .toBe('tsx scripts/migrate-review-batches.ts --apply');
    expect(packageJson.scripts?.['migrate:review-batch-verify'])
      .toBe('tsx scripts/migrate-review-batches.ts --verify');
    expect(migrationCli).toContain('reportReviewBatchMigration');
    expect(migrationCli).toContain('applyReviewBatchMigration');
    expect(migrationCli).toContain('verifyReviewBatchMigration');

    expect(deployScript).toContain('PRE_REVIEW_BATCH_SCHEMA=prisma/postgres/legacy/20260825_pre_core205.prisma');
    expect(deployScript).toContain('REVIEW_BATCH_MIGRATION=20260825020000_expand_review_batch_interaction');
    expect(deployScript).toContain('recover_incomplete_review_batch_migration');
    expect(deployScript).toContain('adopt_existing_review_batch_schema_if_safe');
    expect(deployScript).toContain('review_batch_schema_matches_known_state');
    expect(deployScript).toMatch(
      /source_artifact_schema_matches_known_state\(\) \{[\s\S]*schema_matches "\$PRE_REVIEW_BATCH_SCHEMA"[\s\S]*schema_matches "\$SCHEMA"/,
    );
    expect(deployScript.lastIndexOf('npm run migrate:review-batch-report'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:review-batch-apply'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:review-batch-verify'))
      .toBeGreaterThan(deployScript.lastIndexOf('npm run migrate:review-batch-apply'));
    expect(schemaState).toContain("process.stdout.write('uninitialized')");
    expect(schemaState).toContain("process.stdout.write('legacy')");
    expect(schemaState).toContain("'expanded'");
    expect(schemaState).toContain("'partial'");
    expect(schemaState).toContain('expectedColumns');
    expect(schemaState).toContain('expectedIndexes');
    expect(sqliteUpgrade).toContain('inspectReviewBatchSchemaState');
    expect(sqliteUpgrade).toContain('partial ReviewBatch/Interaction expansion detected');
    expect(sqliteUpgrade).toContain("['run', 'migrate:review-batch-apply']");
    expect(sqliteUpgrade).toContain("['run', 'migrate:review-batch-verify']");
    expect(sqliteUpgrade.indexOf("['run', 'migrate:review-batch-report']"))
      .toBeLessThan(sqliteUpgrade.indexOf("const dbPushArgs = ['prisma', 'db', 'push'"));
  });
});

describe('CORE-206 Agent Job control and run audit expansion', () => {
  it('wires exact body-free models into guarded SQLite and PostgreSQL migration gates', async () => {
    const sqliteSchema = await read('prisma/schema.prisma');
    const postgresSchema = await read('prisma/postgres/schema.prisma');
    const preAgentSchema = await read('prisma/postgres/legacy/20260825_pre_core206.prisma');
    const migration = await read(
      'prisma/postgres/migrations/20260825030000_expand_agent_job_run/migration.sql',
    );
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const schemaState = await read('scripts/postgres-agent-job-schema-state.ts');
    const migrationCli = await read('scripts/migrate-agent-jobs.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toContain('model AgentJobDefinition {');
      expect(schema).toContain('model AgentRun {');
      expect(schema).toContain('@@unique([tenantId, jobKey, jobVersion])');
      expect(schema).toContain('@@unique([tenantId, actorId, jobKey, jobVersion, idempotencyKey])');
      expect(schema).toContain('@@index([tenantId, status, createdAt])');
      expect(schema).not.toMatch(/model Agent(?:JobDefinition|Run) \{[^}]*(?:contentEnc|body|prompt|response|rawResponse|token|secret)/);
      expect(schema).not.toMatch(/^enum\s+/m);
      expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
    }
    expect(preAgentSchema).toContain('model ReviewBatch {');
    expect(preAgentSchema).not.toContain('model AgentJobDefinition {');
    expect(preAgentSchema).not.toContain('model AgentRun {');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Tenant", "User", "Account", "Opportunity", "SourceArtifact", "ReviewBatch"');
    expect(migration).toContain('CREATE TABLE "AgentJobDefinition"');
    expect(migration).toContain('CREATE TABLE "AgentRun"');
    expect(migration).toContain('Agent Job table expansion parity failed');
    expect(migration).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+"(?:Account|Opportunity|SourceArtifact|ReviewBatch|Candidate|Person|Edge|PlanAction)"/i);

    expect(packageJson.scripts?.['migrate:agent-job-report'])
      .toBe('tsx scripts/migrate-agent-jobs.ts --dry-run');
    expect(packageJson.scripts?.['migrate:agent-job-apply'])
      .toBe('tsx scripts/migrate-agent-jobs.ts --apply');
    expect(packageJson.scripts?.['migrate:agent-job-verify'])
      .toBe('tsx scripts/migrate-agent-jobs.ts --verify');
    expect(migrationCli).toContain('reportAgentJobMigration');
    expect(migrationCli).toContain('applyAgentJobMigration');
    expect(migrationCli).toContain('verifyAgentJobMigration');

    expect(deployScript).toContain('PRE_AGENT_JOB_SCHEMA=prisma/postgres/legacy/20260825_pre_core206.prisma');
    expect(deployScript).toContain('AGENT_JOB_MIGRATION=20260825030000_expand_agent_job_run');
    expect(deployScript).toContain('recover_incomplete_agent_job_migration');
    expect(deployScript).toContain('adopt_existing_agent_job_schema_if_safe');
    expect(deployScript).toContain('agent_job_schema_matches_known_state');
    expect(deployScript.lastIndexOf('npm run migrate:agent-job-report'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:agent-job-apply'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:agent-job-verify'))
      .toBeGreaterThan(deployScript.lastIndexOf('npm run migrate:agent-job-apply'));
    expect(schemaState).toContain("? 'legacy' : 'uninitialized'");
    expect(schemaState).toContain("'expanded'");
    expect(schemaState).toContain("'partial'");
    expect(schemaState.indexOf('!state?.agent_definition && !state?.agent_run'))
      .toBeLessThan(schemaState.indexOf('!state?.tenant || !state.review_batch'));
    expect(schemaState).toContain('expectedColumns');
    expect(schemaState).toContain('expectedIndexes');
    expect(sqliteUpgrade).toContain('inspectAgentJobSchemaState');
    expect(sqliteUpgrade).toContain('partial AgentJobDefinition/AgentRun expansion detected');
    expect(sqliteUpgrade).toContain("['run', 'migrate:agent-job-apply']");
    expect(sqliteUpgrade).toContain("['run', 'migrate:agent-job-verify']");
    expect(sqliteUpgrade.indexOf("['run', 'migrate:agent-job-report']"))
      .toBeLessThan(sqliteUpgrade.indexOf("const dbPushArgs = ['prisma', 'db', 'push'"));
  });

  it('registers only approved meeting handlers while keeping narrow ports outside formal CRM writers', async () => {
    const app = await read('src/app.ts');
    const routes = await read('src/agents/routes.ts');
    const model = await read('src/agents/model.ts');
    const runner = await read('src/agents/runner.ts');
    const registry = await read('src/agents/registry.ts');
    const handler = await read('src/postMeeting/handler.ts');
    const candidateCommit = await read('src/postMeeting/commit.ts');
    const preMeetingHandler = await read('src/preMeeting/handler.ts');
    const briefCommit = await read('src/preMeeting/commit.ts');

    expect(app).toContain('productionPostMeetingHandlers(prisma, product.policy)');
    expect(app).toContain('createPostMeetingCandidateCommitAdapter({ policy: product.policy })');
    expect(app).toContain('productionPreMeetingHandlers(prisma, product.policy)');
    expect(app).toContain('createPreMeetingResearchBriefCommitAdapter({ policy: product.policy })');
    expect(app).toContain('agentResearchBriefCommitAdapter');
    expect(app).toContain('...(options.agentHandlers ?? {})');
    expect(routes).toContain("app.get('/api/agent-jobs'");
    expect(routes).toContain("app.put('/api/agent-jobs/:jobKey/control'");
    expect(routes).toContain("app.post('/api/agent-jobs/:jobKey/runs'");
    expect(routes).toContain("app.get('/api/agent-runs'");
    expect(routes).toContain("app.get('/api/agent-runs/:id'");
    expect(registry).toContain("jobKey: 'pre_meeting_brief'");
    expect(registry).toContain("jobKey: 'post_meeting_extract'");
    expect(registry).toContain("jobKey: 'relationship_radar'");
    const handlerCommitContext = model.slice(
      model.indexOf('export interface AgentCommitContext'),
      model.indexOf('export interface AgentCandidateCommitAdapterContext'),
    );
    expect(handlerCommitContext).not.toContain('tx:');
    expect(handler).toContain("'post_meeting_extract@core-206.v1'");
    expect(preMeetingHandler).toContain("'pre_meeting_brief@core-206.v1'");
    expect(handler).not.toMatch(/\.(?:account|opportunity|person|edge|planAction|interaction)\.(?:create|update|upsert|delete)/);
    expect(preMeetingHandler).not.toMatch(/\.(?:account|opportunity|person|edge|planAction|interaction|candidate|curatedSummary)\.(?:create|update|upsert|delete)/);
    expect(candidateCommit).not.toMatch(/\.(?:account|opportunity|person|edge|planAction|interaction)\.(?:create|update|upsert|delete)/);
    expect(briefCommit).not.toMatch(/\.(?:account|opportunity|person|edge|planAction|interaction|candidate|curatedSummary)\.(?:create|update|upsert|delete)/);
    expect(runner).not.toMatch(/\.(?:account|opportunity|person|edge|planAction|interaction|candidate)\.(?:create|update|upsert|delete)/);
    expect(runner).not.toContain('../jobs.js');
    expect(runner).not.toContain('../enrich.js');
  });
});

describe('SAAS-204 ResearchBriefSnapshot expansion', () => {
  it('creates one encrypted portable authority through guarded SQLite and PostgreSQL gates', async () => {
    const sqliteSchema = await read('prisma/schema.prisma');
    const postgresSchema = await read('prisma/postgres/schema.prisma');
    const predecessor = await read('prisma/postgres/legacy/20260826_pre_saas204.prisma');
    const migration = await read(
      'prisma/postgres/migrations/20260826000000_expand_research_brief_snapshot/migration.sql',
    );
    const deployScript = await read('scripts/deploy-postgres-migrations.sh');
    const sqliteUpgrade = await read('scripts/upgrade-sqlite-schema.ts');
    const schemaState = await read('scripts/postgres-research-brief-schema-state.ts');
    const migrationCli = await read('scripts/migrate-research-briefs.ts');
    const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toContain('model ResearchBriefSnapshot {');
      for (const field of [
        'tenantId', 'customerId', 'matterId', 'createdByUserId', 'generationKey', 'status',
        'subjectStatus', 'payloadEnc', 'payloadFingerprint', 'sourceSetHash', 'sourceCount',
        'sectionCount', 'unknownCount', 'failureCount', 'version', 'basedOnAt', 'freshUntil',
        'generatedAt', 'createdAt',
      ]) expect(schema).toMatch(new RegExp(`model ResearchBriefSnapshot \\{[\\s\\S]*?${field}\\s+`));
      expect(schema).toContain('@@unique([tenantId, createdByUserId, generationKey])');
      expect(schema).toContain('@@index([tenantId, createdByUserId, customerId, generatedAt])');
      expect(schema).toContain('@@index([tenantId, createdByUserId, matterId, generatedAt])');
      expect(schema).not.toMatch(/model ResearchBriefSnapshot \{[^}]*(?:rawResponse|prompt|secret|token)/);
      expect(schema).not.toMatch(/^enum\s+/m);
      expect(schema).not.toMatch(/^\s*\w+\s+Json[?\[\]]*/m);
    }
    expect(predecessor).toContain('model AgentRun {');
    expect(predecessor).not.toContain('model ResearchBriefSnapshot {');

    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).toContain('LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain('CREATE TABLE "ResearchBriefSnapshot"');
    expect(migration).toContain('ResearchBriefSnapshot table expansion parity failed');
    expect(migration).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:Account|Opportunity|CuratedSummary|SourceArtifact|Candidate|ReviewBatch|AgentRun|Person|Edge|PlanAction)"/i);

    expect(packageJson.scripts?.['migrate:research-brief-report'])
      .toBe('tsx scripts/migrate-research-briefs.ts --dry-run');
    expect(packageJson.scripts?.['migrate:research-brief-apply'])
      .toBe('tsx scripts/migrate-research-briefs.ts --apply');
    expect(packageJson.scripts?.['migrate:research-brief-verify'])
      .toBe('tsx scripts/migrate-research-briefs.ts --verify');
    expect(migrationCli).toContain('reportResearchBriefMigration');
    expect(migrationCli).toContain('applyResearchBriefMigration');
    expect(migrationCli).toContain('verifyResearchBriefMigration');

    expect(deployScript).toContain('PRE_RESEARCH_BRIEF_SCHEMA=prisma/postgres/legacy/20260826_pre_saas204.prisma');
    expect(deployScript).toContain('RESEARCH_BRIEF_MIGRATION=20260826000000_expand_research_brief_snapshot');
    expect(deployScript).toContain('recover_incomplete_research_brief_migration');
    expect(deployScript).toContain('adopt_existing_research_brief_schema_if_safe');
    expect(deployScript).toContain('research_brief_schema_matches_known_state');
    expect(deployScript).toContain('agent_job_schema_matches_known_state');
    expect(deployScript.lastIndexOf('npm run migrate:research-brief-report'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:research-brief-apply'))
      .toBeGreaterThan(deployScript.indexOf('prisma migrate deploy --schema "$SCHEMA"'));
    expect(deployScript.lastIndexOf('npm run migrate:research-brief-verify'))
      .toBeGreaterThan(deployScript.lastIndexOf('npm run migrate:research-brief-apply'));
    expect(schemaState).toContain("? 'legacy' : 'uninitialized'");
    expect(schemaState).toContain("'expanded'");
    expect(schemaState).toContain("'partial'");
    expect(schemaState).toContain('expectedColumns');
    expect(schemaState).toContain('expectedIndexes');
    expect(sqliteUpgrade).toContain('inspectResearchBriefSchemaState');
    expect(sqliteUpgrade).toContain('partial ResearchBriefSnapshot expansion detected');
    expect(sqliteUpgrade).toContain("['run', 'migrate:research-brief-apply']");
    expect(sqliteUpgrade).toContain("['run', 'migrate:research-brief-verify']");
    expect(sqliteUpgrade.indexOf("['run', 'migrate:research-brief-report']"))
      .toBeLessThan(sqliteUpgrade.indexOf("const dbPushArgs = ['prisma', 'db', 'push'"));
  });
});
