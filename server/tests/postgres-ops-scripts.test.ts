import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFile(new URL(path, new URL('../../', import.meta.url)), 'utf8');
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: rootPath,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('PostgreSQL backup cryptography', () => {
  it('rejects weak/reused secrets and authenticates metadata plus ciphertext before decrypt', async () => {
    const result = bash(`
      set -euo pipefail
      source scripts/lib/backup-crypto.sh
      good=$(openssl rand -hex 32)
      expect_rejected() {
        if validate_backup_master_secret "$1" "$2"; then
          echo "unexpectedly accepted weak or reused backup secret" >&2
          exit 1
        fi
      }
      validate_backup_master_secret "$good" different-password
      expect_rejected short different-password
      expect_rejected __CHANGE_ME__ different-password
      expect_rejected 0000000000000000000000000000000000000000000000000000000000000000 different-password
      expect_rejected 0123456701234567012345670123456701234567012345670123456701234567 different-password
      expect_rejected deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef different-password
      expect_rejected 0123456789abcdefdeadbeefcafebabe0123456789abcdefdeadbeefcafebabe different-password
      expect_rejected "$good" "$good"
      derive_backup_keys "$good"
      test "$BACKUP_ENCRYPTION_PASSPHRASE" != "$BACKUP_MAC_KEY_HEX"
      artifact=$(mktemp -d)
      printf 'format=jianghu-backup-v2\n' > "$artifact/metadata"
      printf 'ciphertext' > "$artifact/payload.enc"
      write_artifact_integrity "$artifact"
      verify_artifact_auth "$artifact"
      printf 'tamper' >> "$artifact/payload.enc"
      if verify_artifact_auth "$artifact"; then
        echo "unexpectedly accepted tampered backup" >&2
        exit 1
      fi
      rm -rf "$artifact"
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('deadbeefdeadbeef');
  });

  it('round-trips the portable backup format when OpenSSL has no PBKDF2 option', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'jianghu-openssl-legacy-'));
    temporaryPaths.push(temp);
    const fakeOpenSsl = join(temp, 'openssl');
    await writeFile(fakeOpenSsl, `#!/usr/bin/env bash
if [[ "${'$'}1 ${'$'}2" == "enc -help" ]]; then
  echo "options: -md digest -pass source -salt"
  exit 0
fi
for arg in "${'$'}@"; do
  if [[ "${'$'}arg" == -pbkdf2 || "${'$'}arg" == -iter ]]; then
    echo "unknown option '${'$'}arg'" >&2
    exit 64
  fi
done
exec "${'$'}REAL_OPENSSL" "${'$'}@"
`);
    await chmod(fakeOpenSsl, 0o755);
    const realOpenSsl = bash('command -v openssl').stdout.trim();
    const result = bash(`
      set -euo pipefail
      source scripts/lib/backup-crypto.sh
      master=$($REAL_OPENSSL rand -hex 32)
      derive_backup_keys "$master"
      artifact=$(mktemp -d)
      printf 'portable-centos7-backup' | backup_encrypt_payload "$artifact/payload.enc"
      backup_cipher_metadata > "$artifact/metadata"
      write_artifact_integrity "$artifact"
      verify_artifact_auth "$artifact"
      validate_backup_cipher_metadata "$artifact"
      backup_decrypt_payload "$artifact" > "$artifact/plaintext"
      test "$(cat "$artifact/plaintext")" = portable-centos7-backup
      sed -i.bak 's/format=jianghu-backup-v3/format=jianghu-backup-v2/' "$artifact/metadata"
      ! validate_backup_cipher_metadata "$artifact"
      rm -rf "$artifact"
    `, {
      PATH: `${temp}:${process.env.PATH ?? ''}`,
      REAL_OPENSSL: realOpenSsl,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps PBKDF2 v2 restore compatibility and validates ciphers before database mutation', async () => {
    const backup = await read('scripts/backup-postgres.sh');
    const restore = await read('scripts/restore-postgres.sh');
    const drill = await read('scripts/test-postgres-ops-integration.sh');
    expect(backup).toContain('backup_encrypt_payload');
    expect(backup).toContain('backup_cipher_metadata');
    expect(backup).not.toContain('-pbkdf2');
    expect(restore).toContain('validate_backup_cipher_metadata');
    expect(restore).toContain('backup_decrypt_payload');
    expect(restore.indexOf('validate_backup_cipher_metadata'))
      .toBeLessThan(restore.indexOf('CREATE DATABASE'));
    expect(drill).toContain('backup_encrypt_payload');
    expect(drill).not.toContain('-pbkdf2');

    const result = bash(`
      set -euo pipefail
      source scripts/lib/backup-crypto.sh
      openssl_supports_pbkdf2 || exit 0
      master=$(openssl rand -hex 32)
      derive_backup_keys "$master"
      artifact=$(mktemp -d)
      printf 'legacy-pbkdf2-backup' \
        | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass fd:3 \
            -out "$artifact/payload.enc" 3<<<"$BACKUP_ENCRYPTION_PASSPHRASE"
      cat > "$artifact/metadata" <<'EOF'
format=jianghu-backup-v2
cipher=aes-256-cbc
kdf=sha256-domain-separated-v2
mac=hmac-sha256
EOF
      write_artifact_integrity "$artifact"
      verify_artifact_auth "$artifact"
      validate_backup_cipher_metadata "$artifact"
      backup_decrypt_payload "$artifact" > "$artifact/plaintext"
      test "$(cat "$artifact/plaintext")" = legacy-pbkdf2-backup
      rm -rf "$artifact"
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it('reaps a stale lock without deleting an ABA successor lock', async () => {
    const result = bash(`
      set -euo pipefail
      source scripts/lib/backup-lock.sh
      root=$(mktemp -d)
      BACKUP_LOCK_WAIT_ATTEMPTS=2
      BACKUP_LOCK_RETRY_DELAY=0
      init_backup_lock "$root"

      mkdir "$BACKUP_LOCK_DIR"
      printf 'pid=999999\nstart=dead\nnonce=stale\n' > "$BACKUP_LOCK_DIR/owner.stale"
      acquire_backup_lock
      test -f "$BACKUP_LOCK_DIR/owner.$BACKUP_LOCK_NONCE"
      first_nonce=$BACKUP_LOCK_NONCE
      first_record=$BACKUP_LOCK_RECORD

      quarantine="$root/old-lock"
      mv "$BACKUP_LOCK_DIR" "$quarantine"
      mkdir "$BACKUP_LOCK_DIR"
      printf 'pid=%s\nstart=%s\nnonce=successor\n' "$$" "$(backup_process_start_identity $$)" > "$BACKUP_LOCK_DIR/owner.successor"
      release_backup_lock "$first_nonce" "$first_record"
      test -f "$BACKUP_LOCK_DIR/owner.successor"
      rm -rf "$quarantine" "$BACKUP_LOCK_DIR" "$root"
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it('never auto-reaps the operation guard and delayed cleanup cannot remove its successor', () => {
    const result = bash(`
      set -euo pipefail
      source scripts/lib/backup-lock.sh
      root=$(mktemp -d)
      BACKUP_LOCK_WAIT_ATTEMPTS=1
      BACKUP_LOCK_RETRY_DELAY=0
      init_backup_lock "$root"
      mkdir "$BACKUP_LOCK_GUARD"
      printf 'pid=999999\nstart=dead\nnonce=stale\n' > "$BACKUP_LOCK_GUARD/owner.stale"

      set +e; backup_acquire_operation_guard; first_reaper=$?; set -e
      set +e; backup_acquire_operation_guard; second_reaper=$?; set -e
      test "$first_reaper" != 0
      test "$second_reaper" != 0
      test -f "$BACKUP_LOCK_GUARD/owner.stale"

      rm -rf "$BACKUP_LOCK_GUARD"
      backup_acquire_operation_guard
      successor_nonce=$BACKUP_GUARD_NONCE
      successor_record=$BACKUP_GUARD_RECORD
      test -f "$BACKUP_LOCK_GUARD/owner.$successor_nonce"

      BACKUP_GUARD_NONCE=stale
      BACKUP_GUARD_RECORD='pid=999999\nstart=dead\nnonce=stale'
      backup_release_operation_guard
      test -f "$BACKUP_LOCK_GUARD/owner.$successor_nonce"

      BACKUP_GUARD_NONCE=$successor_nonce
      BACKUP_GUARD_RECORD=$successor_record
      backup_release_operation_guard
      test ! -e "$BACKUP_LOCK_GUARD"
      rm -rf "$root"
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it('uses collision-proof locked directory publication for a complete artifact', async () => {
    const backup = await read('scripts/backup-postgres.sh');
    expect(backup).toContain('acquire_backup_lock');
    expect(backup).toContain('openssl rand -hex');
    expect(backup).toContain('.backup');
    expect(backup).toContain('write_artifact_integrity');
    expect(backup).toMatch(/mv\s+"\$work_dir"\s+"\$final"/);
    expect(backup).not.toMatch(/-pass\s+(?:pass:|env:)/);
  });
});

describe('PostgreSQL restore safety', () => {
  it('distinguishes exists, confirmed absence, and query failure', () => {
    const result = bash(`
      set -euo pipefail
      source scripts/lib/postgres-db-safety.sh
      query_mode=exists
      postgres_query_database_presence() {
        case "$query_mode" in
          exists) printf '1\n' ;;
          absent) printf '\n' ;;
          fail) return 42 ;;
        esac
      }
      postgres_database_exists target
      query_mode=absent
      set +e; postgres_database_exists target; absent_status=$?; set -e
      test "$absent_status" = 1
      postgres_assert_database_absent target
      query_mode=fail
      set +e; postgres_database_exists target; query_status=$?; set -e
      test "$query_status" = 2
      set +e; postgres_assert_database_absent target; assert_status=$?; set -e
      test "$assert_status" = 2
      cleanup_fails() { return 2; }
      set +e; postgres_require_verified_cleanup cleanup_fails; cleanup_status=$?; set -e
      test "$cleanup_status" = 70
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it('derives the protected database from the running service and uses separate drop connections', async () => {
    const restore = await read('scripts/restore-postgres.sh');
    expect(restore).toContain('container_env POSTGRES_DB');
    expect(restore).toContain('^jianghu_restore_');
    expect(restore).toContain('postgres|template0|template1');
    expect(restore).toContain('terminate_target_connections');
    expect(restore).toContain('drop_target_database');
    expect(restore).toContain('assert_target_absent');
    expect(restore).not.toMatch(/pg_terminate_backend[^\n]+DROP DATABASE/);
    expect(restore.indexOf('verify_artifact_auth')).toBeLessThan(restore.indexOf('CREATE DATABASE'));
  });

  it('uses a pre-migration readiness profile only for the INT-501 bootstrap bridge', async () => {
    const bootstrap = await read('deploy-company-bootstrap-int501.sh');
    const restore = await read('scripts/restore-postgres.sh');
    expect(bootstrap).toContain('--readiness-profile pre-int501');
    expect(bootstrap).toContain('postgres_public_schema_signature_sql');
    expect(bootstrap).toContain('source_schema_signature');
    expect(bootstrap).toContain('restored_schema_signature');
    expect(bootstrap.indexOf('source_schema_signature=')).toBeLessThan(bootstrap.indexOf('backup_output='));
    expect(restore).toContain('READINESS_PROFILE=current');
    expect(restore).toContain('postgres_validate_restore_readiness_scope "$READINESS_PROFILE" "$TARGET_DB"');
    expect(restore).toContain('postgres_restore_readiness_sql "$READINESS_PROFILE"');

    const result = bash(`
      set -euo pipefail
      source scripts/lib/postgres-db-safety.sh
      current=$(postgres_restore_readiness_sql current)
      bridge=$(postgres_restore_readiness_sql pre-int501)
      [[ "$current" == *'"Tenant"'* ]]
      [[ "$current" == *'"CommandRun"'* ]]
      [[ "$current" == *'"EvidenceEvent"'* ]]
      [[ "$current" == *'_prisma_migrations'* ]]
      [[ "$bridge" == *'"Tenant"'* ]]
      [[ "$bridge" == *'"User"'* ]]
      [[ "$bridge" == *'"Account"'* ]]
      [[ "$bridge" != *'"SyncRun"'* ]]
      [[ "$bridge" != *'"CommandRun"'* ]]
      [[ "$bridge" != *'_prisma_migrations'* ]]
      schema_signature=$(postgres_public_schema_signature_sql)
      [[ "$schema_signature" == *'pg_catalog.pg_tables'* ]]
      [[ "$schema_signature" == *"schemaname = 'public'"* ]]
      [[ "$schema_signature" == *'ORDER BY tablename'* ]]
      [[ "$schema_signature" == *'md5('* ]]
      postgres_validate_restore_readiness_scope current jianghu_restore_drill
      postgres_validate_restore_readiness_scope pre-int501 jianghu_restore_bootstrap_20260720
      set +e
      postgres_validate_restore_readiness_scope pre-int501 jianghu_restore_drill
      wrong_target_status=$?
      set -e
      test "$wrong_target_status" != 0
      set +e
      postgres_restore_readiness_sql unknown >/dev/null
      unknown_status=$?
      set -e
      test "$unknown_status" != 0
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it('ships an executable isolated PostgreSQL failure drill', async () => {
    const drill = await read('scripts/test-postgres-ops-integration.sh');
    expect(drill).toContain('--replace');
    expect(drill).toContain('WRONG_MASTER_SECRET');
    expect(drill).toContain('bad_archive');
    expect(drill).toContain('assert_database_absent');
    expect(drill).toContain('CONCURRENT_BACKUPS=2');
  });
});

describe('deployment safety helpers', () => {
  it('captures immutable code, image and authenticated database rollback anchors', async () => {
    const capture = await read('scripts/create-release-rollback-point.sh');
    const rollback = await read('deploy-company-rollback.sh');
    const update = await read('deploy-company-update.sh');
    expect(capture).toContain('rollback_sha=');
    expect(capture).toContain('ROLLBACK_SHA_OVERRIDE');
    expect(capture).toContain('server_image=');
    expect(capture).toContain('web_image=');
    expect(capture).toContain('database.backup');
    expect(capture).toContain('scripts/backup-postgres.sh');
    expect(rollback).toContain('--confirm');
    expect(rollback).toContain('docker compose stop web server');
    expect(rollback).toContain('scripts/restore-postgres.sh');
    expect(rollback).not.toContain('git switch --detach');
    expect(rollback).toContain('docker compose up -d --no-build db server web');
    expect(rollback).toContain('RUNTIME_REVISION_FILE');
    expect(rollback.indexOf('write_runtime_revision "$sha"')).toBeGreaterThan(rollback.indexOf('wait_for_http_readiness'));
    expect(update).toContain('scripts/create-release-rollback-point.sh');
    expect(update).toContain('pre_pull_sha=$(git rev-parse HEAD)');
    expect(update).toContain('RUNTIME_SHA_OVERRIDE');
    expect(update).toContain('RUNTIME_REVISION_FILE');
    expect(update).toContain('write_runtime_revision "$runtime_sha"');
    expect(update).toContain('ROLLBACK_SHA_OVERRIDE="$runtime_sha"');
    expect(update).toContain('write_runtime_revision "$current_commit"');
    expect(update).toContain('deploy-company-rollback.sh');
  });

  it('uses bounded fail-closed readiness retries', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'jianghu-curl-'));
    temporaryPaths.push(temp);
    const fakeCurl = join(temp, 'curl');
    await writeFile(fakeCurl, `#!/usr/bin/env bash
count=$(cat "$CURL_COUNT" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > "$CURL_COUNT"
if [ "$count" -le "${'$'}{CURL_FAILS:-0}" ]; then exit 22; fi
exit 0
`);
    await chmod(fakeCurl, 0o755);

    const successCounter = join(temp, 'success-count');
    const success = bash('source scripts/lib/deploy-common.sh; READINESS_RETRY_DELAY=0 wait_for_http_readiness http://example.test/ready 3', {
      PATH: `${temp}:${process.env.PATH ?? ''}`,
      CURL_COUNT: successCounter,
      CURL_FAILS: '2',
    });
    expect(success.status, success.stderr).toBe(0);
    expect(await readFile(successCounter, 'utf8')).toBe('3');

    const failureCounter = join(temp, 'failure-count');
    const failure = bash('source scripts/lib/deploy-common.sh; READINESS_RETRY_DELAY=0; ! wait_for_http_readiness http://example.test/ready 3', {
      PATH: `${temp}:${process.env.PATH ?? ''}`,
      CURL_COUNT: failureCounter,
      CURL_FAILS: '9',
    });
    expect(failure.status, failure.stderr).toBe(0);
    expect(await readFile(failureCounter, 'utf8')).toBe('3');
  });

  it('uses Compose config and volume labels rather than one hardcoded volume name', async () => {
    const macDeploy = await read('deploy-macmini.sh');
    expect(macDeploy).not.toContain('docker volume inspect jianghu_pgdata');
    const temp = await mkdtemp(join(tmpdir(), 'jianghu-docker-'));
    temporaryPaths.push(temp);
    const fakeDocker = join(temp, 'docker');
    await writeFile(fakeDocker, `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "compose ps -a" ]]; then exit 0; fi
if [[ "$1 $2" == "compose config" ]]; then printf 'name: custom-project\n'; exit 0; fi
if [[ "$1 $2" == "volume ls" ]]; then
  printf '%s\n' "$*" | grep -q 'label=com.docker.compose.project=custom-project'
  printf '%s\n' "$*" | grep -q 'label=com.docker.compose.volume=pgdata'
  printf 'custom-project_pgdata\n'
  exit 0
fi
exit 1
`);
    await chmod(fakeDocker, 0o755);
    const result = bash('source scripts/lib/deploy-common.sh; deployment_has_existing_db', {
      PATH: `${temp}:${process.env.PATH ?? ''}`,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('treats compose ps, config, and volume inspection errors as unknown, never absent', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'jianghu-docker-tristate-'));
    temporaryPaths.push(temp);
    const fakeDocker = join(temp, 'docker');
    await writeFile(fakeDocker, `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "compose ps -a" ]]; then
  [[ "${'$'}{FAIL_AT:-}" == ps ]] && exit 31
  [[ "${'$'}{HAS_CONTAINER:-0}" == 1 ]] && printf 'db-container\n'
  exit 0
fi
if [[ "$1 $2" == "compose config" ]]; then
  [[ "${'$'}{FAIL_AT:-}" == config ]] && exit 32
  printf 'name: test-project\n'
  exit 0
fi
if [[ "$1 $2" == "volume ls" ]]; then
  [[ "${'$'}{FAIL_AT:-}" == volume ]] && exit 33
  [[ "${'$'}{HAS_VOLUME:-0}" == 1 ]] && printf 'test-project_pgdata\n'
  exit 0
fi
exit 1
`);
    await chmod(fakeDocker, 0o755);
    const path = `${temp}:${process.env.PATH ?? ''}`;
    for (const failAt of ['ps', 'config', 'volume']) {
      const result = bash('source scripts/lib/deploy-common.sh; set +e; resolve_deployment_db_state; status=$?; set -e; test "$status" = 2; test -z "${DEPLOYMENT_HAS_EXISTING_DB:-}"', {
        PATH: path,
        FAIL_AT: failAt,
      });
      expect(result.status, `${failAt}: ${result.stderr}`).toBe(0);
    }
    const absent = bash('source scripts/lib/deploy-common.sh; resolve_deployment_db_state; test "$DEPLOYMENT_HAS_EXISTING_DB" = 0', { PATH: path });
    expect(absent.status, absent.stderr).toBe(0);
    const present = bash('source scripts/lib/deploy-common.sh; deployment_has_existing_db', { PATH: path, HAS_VOLUME: '1' });
    expect(present.status, present.stderr).toBe(0);
  });

  it('writes an atomic strict deployment marker and rejects identity/path drift', () => {
    const result = bash(`
      set -euo pipefail
      source scripts/lib/bootstrap-marker.sh
      root=$(mktemp -d)
      mkdir "$root/backups" "$root/backups/jianghu-valid.backup"
      marker="$root/backups/verified"
      commit=0123456789abcdef0123456789abcdef01234567
      write_bootstrap_marker "$marker" project-a jianghu "$root/backups/jianghu-valid.backup" "$commit"
      verify_bootstrap_marker "$marker" project-a jianghu "$root/backups" "$commit"
      test "$VERIFIED_BOOTSTRAP_BACKUP" = "$root/backups/jianghu-valid.backup"
      test -z "$(find "$root/backups" -maxdepth 1 -name '.bootstrap-marker.*' -print)"
      set +e; verify_bootstrap_marker "$marker" project-b jianghu "$root/backups" "$commit"; wrong_identity=$?; set -e
      test "$wrong_identity" != 0
      set +e; verify_bootstrap_marker "$marker" project-a jianghu "$root/backups" ffffffffffffffffffffffffffffffffffffffff; wrong_commit=$?; set -e
      test "$wrong_commit" != 0
      verify_bootstrap_marker "$marker" project-a jianghu "$root/backups"
      rm -rf "$root/backups/jianghu-valid.backup"
      set +e; verify_bootstrap_marker "$marker" project-a jianghu "$root/backups" "$commit"; missing_backup=$?; set -e
      test "$missing_backup" != 0
      rm -rf "$root"
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it('provides a one-time company bootstrap before migration build', async () => {
    const bootstrap = await read('deploy-company-bootstrap-int501.sh');
    const companyDeploy = await read('deploy-company-update.sh');
    expect(bootstrap).toContain('bootstrap-verified');
    expect(bootstrap).toContain('scripts/backup-postgres.sh');
    expect(bootstrap).toContain('scripts/restore-postgres.sh');
    expect(bootstrap).toContain('scripts/deploy-postgres-migrations.sh');
    expect(bootstrap).toContain('docker compose build server');
    expect(bootstrap).toContain('tracked deployment files are dirty; refusing bootstrap');
    expect(bootstrap.indexOf('restore-postgres.sh')).toBeLessThan(bootstrap.indexOf('write_bootstrap_marker'));
    expect(bootstrap.indexOf('deploy-postgres-migrations.sh')).toBeLessThan(bootstrap.indexOf('write_bootstrap_marker'));
    expect(companyDeploy).toContain('bootstrap-verified');
    expect(companyDeploy).toContain('wait_for_http_readiness');
    expect(companyDeploy).toContain('resolve_deployment_db_state');
    expect(companyDeploy).toContain('docker compose build server web');
    expect(companyDeploy).toContain('docker compose stop web server');
    expect(companyDeploy).toContain('restart_stopped_services');
    expect(companyDeploy).toContain("trap 'exit 143' TERM");
    expect(companyDeploy).toContain('--entrypoint ./scripts/deploy-postgres-migrations.sh server');
    expect(companyDeploy).toContain('migration_history_snapshot');
    expect(companyDeploy).toContain('migration_history_before=');
    expect(companyDeploy).toContain('migration_history_after=');
    expect(companyDeploy).toContain('数据库 migration history 已改变；自动执行认证回滚');
    expect(companyDeploy).toContain('bash deploy-company-rollback.sh "$rollback_point" --confirm');
    expect(companyDeploy).toContain('docker compose start server web');
    expect(companyDeploy).toContain('docker compose up -d --no-build');
    expect(companyDeploy.indexOf('docker compose build server web')).toBeLessThan(companyDeploy.indexOf('docker compose stop web server'));
    expect(companyDeploy.indexOf('deploy-postgres-migrations.sh')).toBeLessThan(companyDeploy.lastIndexOf('docker compose up -d --no-build'));
    expect(await read('deploy-macmini.sh')).toContain('resolve_deployment_db_state');
    expect(companyDeploy.indexOf('git pull --ff-only')).toBeLessThan(companyDeploy.indexOf('verify_bootstrap_marker'));
    expect(companyDeploy).toContain('git rev-parse HEAD');
    expect(companyDeploy).toContain("expected_bootstrap_commit=''");
    expect(companyDeploy).toContain('bridge_complete');
    expect(companyDeploy).toContain('migration_name =');
    expect(companyDeploy).toContain('20260715030000_adopt_pre_int501_schema');
  });

  it('migrates the pre-INT501 outbound allowlist before any Compose inspection', async () => {
    const bootstrap = await read('deploy-company-bootstrap-int501.sh');
    const companyDeploy = await read('deploy-company-update.sh');
    expect(bootstrap).toContain('deployment_ensure_env_default "$APP_DIR/.env" OUTBOUND_ALLOWED_HOSTS');
    expect(bootstrap).toContain('deployment_ensure_env_default "$APP_DIR/.env" OUTBOUND_ALLOWED_PRIVATE_HOSTS');
    expect(bootstrap.indexOf('deployment_ensure_env_default "$APP_DIR/.env" OUTBOUND_ALLOWED_HOSTS'))
      .toBeLessThan(bootstrap.indexOf('backup_output='));
    expect(companyDeploy).toContain('deployment_require_env_value .env OUTBOUND_ALLOWED_HOSTS');
    expect(companyDeploy.indexOf('deployment_require_env_value .env OUTBOUND_ALLOWED_HOSTS'))
      .toBeLessThan(companyDeploy.indexOf('resolve_deployment_db_state'));

    const result = bash(`
      set -euo pipefail
      source scripts/lib/deploy-common.sh
      env_file=$(mktemp)
      printf 'JWT_SECRET=already-present\n' > "$env_file"
      deployment_ensure_env_default "$env_file" OUTBOUND_ALLOWED_HOSTS 'api.example.com'
      deployment_ensure_env_default "$env_file" OUTBOUND_ALLOWED_HOSTS 'must-not-overwrite.example.com'
      deployment_ensure_env_default "$env_file" OUTBOUND_ALLOWED_PRIVATE_HOSTS ''
      test "$(deployment_env_value "$env_file" OUTBOUND_ALLOWED_HOSTS)" = api.example.com
      test "$(grep -c '^OUTBOUND_ALLOWED_HOSTS=' "$env_file")" = 1
      grep -q '^OUTBOUND_ALLOWED_PRIVATE_HOSTS=$' "$env_file"
      deployment_require_env_value "$env_file" OUTBOUND_ALLOWED_HOSTS
      ! deployment_require_env_value "$env_file" MISSING_REQUIRED_VALUE
      empty_env=$(mktemp)
      printf 'OUTBOUND_ALLOWED_HOSTS=' > "$empty_env"
      deployment_ensure_env_default "$empty_env" OUTBOUND_ALLOWED_HOSTS 'api.example.com'
      test "$(deployment_env_value "$empty_env" OUTBOUND_ALLOWED_HOSTS)" = api.example.com
      rm -f "$env_file" "$empty_env"
    `);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('backup artifacts stay outside source and Docker contexts', () => {
  it('ignores backup directories, encrypted payloads, metadata, MACs, and temporary work', () => {
    const candidates = [
      'backups/example.backup/payload.enc',
      '.backup-work.example/payload.enc',
      'example.dump.enc',
      'example.backup/auth.hmac',
      'example.backup/metadata',
    ];
    const ignored = spawnSync('git', ['check-ignore', '--no-index', ...candidates], { cwd: rootPath, encoding: 'utf8' });
    expect(ignored.status, ignored.stderr).toBe(0);
    expect(ignored.stdout.trim().split('\n')).toHaveLength(candidates.length);
  });

  it('excludes the same artifacts from every relevant Docker context', async () => {
    for (const path of ['.dockerignore', 'app/.dockerignore', 'server/.dockerignore']) {
      const ignore = await read(path);
      expect(ignore).toContain('*.backup');
      expect(ignore).toContain('*.dump.enc');
      expect(ignore).toContain('.backup-work');
    }
  });
});
