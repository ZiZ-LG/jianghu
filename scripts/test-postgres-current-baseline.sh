#!/usr/bin/env bash
# CORE-215: current empty-install baseline; never adopts existing user databases.
set -Eeuo pipefail
umask 077
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
[[ "$endpoint" == unix://* ]] || { echo 'CORE-215 requires a local Docker endpoint' >&2; exit 2; }
docker info >/dev/null
task_dir=$(mktemp -d "${TMPDIR:-/tmp}/core215-postgres.XXXXXXXX")
nonce=$(openssl rand -hex 8)
export COMPOSE_PROJECT_NAME="core215_${nonce}"
export COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
export COMPOSE_DISABLE_ENV_FILE=1
export COMPOSE_ENV_FILES=/dev/null
unset COMPOSE_PROFILES
export POSTGRES_USER=core215_test POSTGRES_DB=core215_baseline
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export JWT_SECRET=$(openssl rand -hex 32)
export AI_KEY_SECRET=$(openssl rand -hex 32)
export BACKUP_MASTER_SECRET=$(openssl rand -hex 32)
export OUTBOUND_ALLOWED_HOSTS=example.com OUTBOUND_ALLOWED_PRIVATE_HOSTS=''
export PUBLIC_BASE_URL=https://crm.example.test CORS_ORIGIN=''
export PRODUCT_EDITION=commercial PRODUCT_ENTITLEMENTS=sales.workspace
export CUSTOMER_COMMANDS_ENABLED=1 COMMITMENT_COMMANDS_ENABLED=1 METHODOLOGY_COMMANDS_ENABLED=0
export BACKUP_DIR="$task_dir/backups" BACKUP_RETENTION_DAYS=14
export JIANGHU_ROOT="$ROOT_DIR"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
created=0
stage_name=preflight
stage_started=$SECONDS
stage() {
  echo "CURRENT_BASELINE_TIMING stage=$stage_name seconds=$((SECONDS-stage_started))"
  stage_name=$1; stage_started=$SECONDS
  echo "CURRENT_BASELINE_STAGE=$stage_name"
}
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$created" == 1 ]]; then
    if ! docker compose down --volumes --remove-orphans >"$task_dir/cleanup.log" 2>&1; then
      echo "CORE-215 isolated cleanup failed: $COMPOSE_PROJECT_NAME ($task_dir)" >&2
      exit 70
    fi
    [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]] || exit 70
    [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]] || exit 70
  fi
  rm -rf "$task_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'echo "CURRENT_BASELINE_FAILURE stage=$stage_name line=$LINENO" >&2' ERR
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]]
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]]
[[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]]
echo "CURRENT_BASELINE_IDENTITY sha=$(git rev-parse HEAD) project=$COMPOSE_PROJECT_NAME database=$POSTGRES_DB"

query() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${2:-$POSTGRES_DB}" -tAc "$1" | tr -d '\r'; }
ready() {
  local container
  container=$(docker compose ps -aq server)
  for _ in $(seq 1 180); do
    if docker exec "$container" wget -qO- http://127.0.0.1:3001/api/health/ready >/dev/null 2>&1; then return 0; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || break
    sleep 1
  done
  echo 'CORE-215 application readiness failed' >&2
  docker compose logs --no-color --tail=80 server >&2
  return 1
}
verify_migrations() {
  local expected actual
  expected=$(find server/prisma/postgres/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')
  actual=$(query 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')
  [[ "$actual" == "$expected" ]]
  [[ "$(query 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')" == 0 ]]
}
smoke() {
  docker compose cp scripts/ci/postgres-baseline-smoke.mjs server:/app/ci-baseline-smoke.mjs >/dev/null
  docker compose exec -T -e CI_CURRENT_BASELINE=1 server npx tsx ci-baseline-smoke.mjs "$1"
}
assert_absent() {
  [[ -z "$(query "SELECT 1 FROM pg_database WHERE datname = '$1'" postgres)" ]]
}

stage build
docker compose build server
stage empty-install
created=1
docker compose up -d db server
ready
verify_migrations
server_image=$(docker inspect -f '{{.Image}}' "$(docker compose ps -q server)")
[[ "$server_image" =~ ^sha256:[a-f0-9]{64}$ ]]
echo "CURRENT_BASELINE_IMAGE=$server_image"
echo 'CURRENT_BASELINE_EMPTY_INSTALL_OK=1'

stage synthetic-security-fixture
smoke seed | tee "$task_dir/seed.log"
data_hash=$(sed -n 's/^CURRENT_BASELINE_DATA_SHA256=//p' "$task_dir/seed.log")
[[ "$data_hash" =~ ^[a-f0-9]{64}$ ]]

stage repeat-migration-and-persistence
docker compose stop server >/dev/null
docker compose run --rm --no-deps --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
docker compose up -d server >/dev/null
ready
verify_migrations
smoke verify | tee "$task_dir/restart.log"
grep -Fxq "CURRENT_BASELINE_DATA_SHA256=$data_hash" "$task_dir/restart.log"
echo 'CURRENT_BASELINE_REPEAT_AND_PERSISTENCE_OK=1'

stage authenticated-backup-restore
bash scripts/backup-postgres.sh >"$task_dir/backup.log" & first_pid=$!
bash scripts/backup-postgres.sh >"$task_dir/backup-second.log" & second_pid=$!
wait "$first_pid"
wait "$second_pid"
[[ "$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'jianghu-*.backup' | wc -l | tr -d '[:space:]')" == 2 ]]
backup=$(sed -n 's/^Authenticated encrypted backup created: //p' "$task_dir/backup.log")
[[ "$backup" == "$BACKUP_DIR"/jianghu-*.backup && -d "$backup" ]]
bash scripts/restore-postgres.sh "$backup" --database jianghu_restore_core215
# Run the same exact application data verifier against the restored database.
docker compose exec -T -e CI_CURRENT_BASELINE=1 \
  -e "DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/jianghu_restore_core215?schema=public" \
  server npx tsx ci-baseline-smoke.mjs verify >"$task_dir/restore.log"
grep -Fxq "CURRENT_BASELINE_DATA_SHA256=$data_hash" "$task_dir/restore.log"
query 'CREATE TABLE core215_replace_sentinel(id integer)' jianghu_restore_core215 >/dev/null
bash scripts/restore-postgres.sh "$backup" --database jianghu_restore_core215 --replace
[[ "$(query "SELECT to_regclass('public.core215_replace_sentinel') IS NULL" jianghu_restore_core215 | tr -d '[:space:]')" == t ]]
echo 'CURRENT_BASELINE_ENCRYPTED_RESTORE_OK=1'

stage restore-rejection-and-cleanup
for refused in "$POSTGRES_DB" postgres template0 template1 arbitrary_name; do
  if bash scripts/restore-postgres.sh "$backup" --database "$refused" >"$task_dir/rejected.log" 2>&1; then
    echo "unsafe restore target accepted: $refused" >&2; exit 1
  fi
done
if BACKUP_MASTER_SECRET=$(openssl rand -hex 32) bash scripts/restore-postgres.sh "$backup" --database jianghu_restore_wrong_key >"$task_dir/rejected.log" 2>&1; then
  echo 'wrong backup key accepted' >&2; exit 1
fi
assert_absent jianghu_restore_wrong_key
cp -R "$backup" "$BACKUP_DIR/jianghu-tampered.backup"
printf tamper >> "$BACKUP_DIR/jianghu-tampered.backup/payload.enc"
if bash scripts/restore-postgres.sh "$BACKUP_DIR/jianghu-tampered.backup" --database jianghu_restore_tampered >"$task_dir/rejected.log" 2>&1; then
  echo 'tampered backup accepted' >&2; exit 1
fi
assert_absent jianghu_restore_tampered
source scripts/lib/backup-crypto.sh
source scripts/lib/postgres-db-safety.sh
cp -R "$backup" "$BACKUP_DIR/jianghu-bad-archive.backup"
derive_backup_keys "$BACKUP_MASTER_SECRET"
printf 'not a PostgreSQL archive' | backup_encrypt_payload "$BACKUP_DIR/jianghu-bad-archive.backup/payload.enc"
write_artifact_integrity "$BACKUP_DIR/jianghu-bad-archive.backup"
if bash scripts/restore-postgres.sh "$BACKUP_DIR/jianghu-bad-archive.backup" --database jianghu_restore_bad_archive >"$task_dir/rejected.log" 2>&1; then
  echo 'invalid archive accepted' >&2; exit 1
fi
assert_absent jianghu_restore_bad_archive
(
  postgres_query_database_presence() { return 42; }
  set +e
  postgres_assert_database_absent jianghu_restore_query_failure
  failure=$?
  set -e
  [[ "$failure" == 2 ]]
)
echo 'CURRENT_BASELINE_RESTORE_NEGATIVE_CASES_OK=1'

stage application-image-rollback
cat > "$task_dir/failed-start.yml" <<'YAML'
services:
  server:
    entrypoint: ["/bin/sh", "-c", "exit 42"]
    restart: "no"
YAML
docker compose -f "$COMPOSE_FILE" -f "$task_dir/failed-start.yml" up -d --no-deps --force-recreate server >/dev/null
failed_container=$(docker compose ps -aq server)
[[ "$(docker wait "$failed_container")" == 42 ]]
cat > "$task_dir/rollback.yml" <<YAML
services:
  server:
    image: $server_image
YAML
docker compose -f "$COMPOSE_FILE" -f "$task_dir/rollback.yml" up -d --no-build --no-deps --force-recreate server >/dev/null
ready
[[ "$(docker inspect -f '{{.Image}}' "$(docker compose ps -q server)")" == "$server_image" ]]
smoke verify >"$task_dir/rollback.log"
grep -Fxq "CURRENT_BASELINE_DATA_SHA256=$data_hash" "$task_dir/rollback.log"
echo 'CURRENT_BASELINE_APPLICATION_ROLLBACK_OK=1'
stage complete
echo 'POSTGRES_CURRENT_BASELINE_OK=1'
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '\n## CORE-215 PostgreSQL current baseline\n\n- SHA: `%s`\n- Image: `%s`\n- Empty install, repeated migration, tenant/review/idempotency, persistence, authenticated recovery and failed-start image rollback passed.\n- Synthetic data only; no historical database adoption or deployment.\n- Elapsed seconds: %s\n' \
    "$(git rev-parse HEAD)" "$server_image" "$SECONDS" >> "$GITHUB_STEP_SUMMARY"
fi
