#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

[[ -f scripts/lib/backup-crypto.sh ]] || { echo "missing backup crypto helper" >&2; exit 1; }
source scripts/lib/backup-crypto.sh
source scripts/lib/postgres-db-safety.sh
source scripts/lib/bootstrap-marker.sh

export COMPOSE_PROJECT_NAME="jianghu_int501_ops_${$}"
export POSTGRES_USER=jianghu_ops
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export POSTGRES_DB=jianghu_ops
export JWT_SECRET=$(openssl rand -hex 32)
export AI_KEY_SECRET=$(openssl rand -hex 32)
export OUTBOUND_ALLOWED_HOSTS=example.com
export BACKUP_MASTER_SECRET=$(openssl rand -hex 32)
export BACKUP_DIR="/tmp/jianghu-int501-ops-${$}"
export BACKUP_RETENTION_DAYS=14
export NO_PROXY=127.0.0.1,localhost
export no_proxy=$NO_PROXY

cleanup() {
  set +e
  POSTGRES_PASSWORD=x JWT_SECRET=x AI_KEY_SECRET=x OUTBOUND_ALLOWED_HOSTS=example.com \
    docker compose -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

postgres_query_database_presence() {
  local database=$1
  docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$database'"
}
database_exists() {
  postgres_database_exists "$1"
}
assert_database_absent() {
  postgres_assert_database_absent "$1" || exit $?
}

docker compose -p "$COMPOSE_PROJECT_NAME" build server >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" up -d db >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260712_pre_int501.prisma --skip-generate' >/dev/null
legacy_table_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]')
[[ "$legacy_table_count" == 41 ]]
docker compose -p "$COMPOSE_PROJECT_NAME" up -d server >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-server-1" 2>/dev/null || true)" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-server-1")" == healthy ]]
migration_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')
[[ "$migration_count" == 4 ]]
legacy_bridge_ready=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT (to_regclass('\''public."AuditEvent"'\'') IS NOT NULL
       AND to_regclass('\''public."CommandRun"'\'') IS NOT NULL
       AND to_regclass('\''public."SyncRun"'\'') IS NOT NULL
       AND to_regclass('\''public."WeComOAuthState"'\'') IS NOT NULL)::int' | tr -d '[:space:]')
[[ "$legacy_bridge_ready" == 1 ]]
echo "LEGACY_SCHEMA_MIGRATION_PREFLIGHT_OK=1"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('ops-tenant','Ops Tenant');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\") VALUES ('ops-account','ops-tenant','WorkBuddy Customer',1);
   INSERT INTO \"Opportunity\" (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\")
     VALUES ('ops-opportunity','ops-tenant','ops-account','WorkBuddy Opportunity',1,'qualify','discover');
   INSERT INTO \"SyncRun\" (id,\"tenantId\",\"actorId\",\"idempotencyKey\",\"requestHash\",status,\"createdAt\",\"updatedAt\")
     VALUES ('ops-sync','ops-tenant','ops-actor','ops-key','ops-hash','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);" >/dev/null

# INT-502 mixed legacy migration: ordinary rows were raw, person-merge rows were already SHA-256.
legacy_key='ops-legacy-command-key'
legacy_hash=$(printf '%s' "$legacy_key" | openssl dgst -sha256 -r | awk '{print $1}')
person_hash=$(printf '%s' 'ops-person-merge-key' | openssl dgst -sha256 -r | awk '{print $1}')
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"CommandRun\" (id,\"tenantId\",\"actorId\",kind,\"idempotencyKey\",\"requestHash\",status,\"createdAt\",\"updatedAt\")
     VALUES ('ops-command-legacy','ops-tenant','ops-actor','action-feedback','$legacy_key','request-a','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('ops-command-person','ops-tenant','ops-actor','person-merge','$person_hash','request-b','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);" >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < server/prisma/postgres/migrations/20260715010000_hash_command_run_idempotency_keys/migration.sql >/dev/null
migrated_keys=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT "idempotencyKey" FROM "CommandRun" ORDER BY id' | tr -d '\r')
[[ "$migrated_keys" == "$legacy_hash"$'\n'"$person_hash" ]]

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"CommandRun\" (id,\"tenantId\",\"actorId\",kind,\"idempotencyKey\",\"requestHash\",status,\"createdAt\",\"updatedAt\")
     VALUES ('ops-command-invalid-person','ops-tenant','ops-actor','person-merge','raw-invalid-person-key','request-c','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);" >/dev/null
if docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    < server/prisma/postgres/migrations/20260715010000_hash_command_run_idempotency_keys/migration.sql >/dev/null 2>&1; then
  echo "invalid legacy person-merge key unexpectedly migrated" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "DELETE FROM \"CommandRun\" WHERE id = 'ops-command-invalid-person';" >/dev/null
echo "COMMAND_KEY_MIXED_MIGRATION_OK=1"

# Exercise the one-time pre-INT501 bridge against the same isolated Compose project.
bootstrap_root=$(mktemp -d "/tmp/jianghu-int501-bootstrap.${$}.XXXXXX")
cp docker-compose.yml "$bootstrap_root/docker-compose.yml"
cp .dockerignore "$bootstrap_root/.dockerignore"
tar -cf - --exclude='node_modules' --exclude='dist' --exclude='*.db' server packages \
  | tar -xf - -C "$bootstrap_root"
cat > "$bootstrap_root/.env" <<EOF
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB
JWT_SECRET=$JWT_SECRET
AI_KEY_SECRET=$AI_KEY_SECRET
OUTBOUND_ALLOWED_HOSTS=$OUTBOUND_ALLOWED_HOSTS
EOF
bootstrap_backups="$bootstrap_root/backups"
if env -u BACKUP_MASTER_SECRET \
  JIANGHU_ROOT="$bootstrap_root" \
  COMPANY_BACKUP_DIR="$bootstrap_backups" \
  INT501_BOOTSTRAP_MARKER="$bootstrap_backups/verified" \
  INT501_BOOTSTRAP_TEST_FAIL_SMOKE=1 \
  bash deploy-company-bootstrap-int501.sh >/dev/null 2>&1; then
  echo "bootstrap smoke failure unexpectedly succeeded" >&2; exit 1
fi
[[ ! -e "$bootstrap_backups/verified" ]]
bootstrap_leftovers=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT count(*) FROM pg_database WHERE datname LIKE 'jianghu_restore_bootstrap_%'" | tr -d '[:space:]')
[[ "$bootstrap_leftovers" == 0 ]]
echo "BOOTSTRAP_SMOKE_FAILURE_CLEANUP=1"

env -u BACKUP_MASTER_SECRET \
  JIANGHU_ROOT="$bootstrap_root" \
  COMPANY_BACKUP_DIR="$bootstrap_backups" \
  INT501_BOOTSTRAP_MARKER="$bootstrap_backups/verified" \
  bash deploy-company-bootstrap-int501.sh >/dev/null
[[ -s "$bootstrap_backups/verified" ]]
bootstrap_master=$(grep '^BACKUP_MASTER_SECRET=' "$bootstrap_root/.env" | tail -n1 | cut -d= -f2)
derive_backup_keys "$bootstrap_master"
bootstrap_commit=$(git rev-parse HEAD)
verify_bootstrap_marker "$bootstrap_backups/verified" "$COMPOSE_PROJECT_NAME" "$POSTGRES_DB" "$bootstrap_backups" "$bootstrap_commit"
verify_artifact_auth "$VERIFIED_BOOTSTRAP_BACKUP"
rm -rf "$bootstrap_root"
echo "PRE_INT501_BOOTSTRAP_OK=1"

(
  postgres_query_database_presence() { return 42; }
  set +e
  postgres_assert_database_absent jianghu_restore_query_failure
  query_failure_status=$?
  set -e
  [[ "$query_failure_status" == 2 ]]
  cleanup_query_failure() { postgres_assert_database_absent jianghu_restore_query_failure; }
  set +e
  postgres_require_verified_cleanup cleanup_query_failure
  cleanup_failure_status=$?
  set -e
  [[ "$cleanup_failure_status" == 70 ]]
)
echo "DATABASE_QUERY_FAILURE_FAILS_CLOSED=1"

bash scripts/backup-postgres.sh & first_pid=$!
bash scripts/backup-postgres.sh & second_pid=$!
wait "$first_pid"
wait "$second_pid"
backup_count=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'jianghu-*.backup' | wc -l | tr -d ' ')
[[ "$backup_count" == 2 ]]
echo "CONCURRENT_BACKUPS=2"
backup=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'jianghu-*.backup' | sort | head -n 1)

target=jianghu_restore_success
bash scripts/restore-postgres.sh "$backup" --database "$target"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$target" -c \
  'CREATE TABLE replace_sentinel(id integer);' >/dev/null
bash scripts/restore-postgres.sh "$backup" --database "$target" --replace
sentinel=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$target" -tAc \
  "SELECT to_regclass('public.replace_sentinel') IS NULL" | tr -d '[:space:]')
[[ "$sentinel" == t ]]
workbuddy_smoke=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$target" -tAc \
  'SELECT ((SELECT count(*) FROM "Account" WHERE id = '\''ops-account'\'') = 1
       AND (SELECT count(*) FROM "Opportunity" WHERE id = '\''ops-opportunity'\'') = 1
       AND (SELECT count(*) FROM "SyncRun" WHERE id = '\''ops-sync'\'') = 1)::int' | tr -d '[:space:]')
[[ "$workbuddy_smoke" == 1 ]]
echo "WORKBUDDY_DATA_SMOKE=1"

if POSTGRES_DB=caller_override bash scripts/restore-postgres.sh "$backup" --database "$POSTGRES_DB" >/dev/null 2>&1; then
  echo "production database override bypassed" >&2; exit 1
fi
for refused in postgres template0 template1 arbitrary_name; do
  if bash scripts/restore-postgres.sh "$backup" --database "$refused" >/dev/null 2>&1; then
    echo "unsafe target accepted: $refused" >&2; exit 1
  fi
done

WRONG_MASTER_SECRET=$(openssl rand -hex 32)
if BACKUP_MASTER_SECRET=$WRONG_MASTER_SECRET bash scripts/restore-postgres.sh "$backup" --database jianghu_restore_wrong_key >/dev/null 2>&1; then
  echo "wrong key accepted" >&2; exit 1
fi
assert_database_absent jianghu_restore_wrong_key

tampered="$BACKUP_DIR/jianghu-tampered.backup"
cp -R "$backup" "$tampered"
printf tamper >> "$tampered/payload.enc"
if bash scripts/restore-postgres.sh "$tampered" --database jianghu_restore_tampered >/dev/null 2>&1; then
  echo "tampered backup accepted" >&2; exit 1
fi
assert_database_absent jianghu_restore_tampered

bad_archive="$BACKUP_DIR/jianghu-bad-archive.backup"
cp -R "$backup" "$bad_archive"
derive_backup_keys "$BACKUP_MASTER_SECRET"
printf 'not a PostgreSQL archive' \
  | backup_encrypt_payload "$bad_archive/payload.enc"
write_artifact_integrity "$bad_archive"
if bash scripts/restore-postgres.sh "$bad_archive" --database jianghu_restore_bad_archive >/dev/null 2>&1; then
  echo "bad archive accepted" >&2; exit 1
fi
assert_database_absent jianghu_restore_bad_archive
echo "BAD_ARCHIVE_PARTIAL_CLEANUP=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$target' AND pid <> pg_backend_pid();" >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -c \
  "DROP DATABASE \"$target\";" >/dev/null
assert_database_absent "$target"

docker compose -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null
rm -rf "$BACKUP_DIR"
trap - EXIT
echo "POSTGRES_OPS_INTEGRATION_OK=1"
