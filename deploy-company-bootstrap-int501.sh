#!/bin/bash
# One-time bridge for a pre-INT501 /data/jianghu deployment.
# Run this uploaded bundle BEFORE git pull/build introduces migrate deploy.
set -Eeuo pipefail
umask 077

APP_DIR=${JIANGHU_ROOT:-/data/jianghu}
BUNDLE_DIR=$(cd "$(dirname "$0")" && pwd)
BACKUP_DIR=${COMPANY_BACKUP_DIR:-/data/jianghu-backups}
MARKER=${INT501_BOOTSTRAP_MARKER:-"$BACKUP_DIR/.int501-bootstrap-verified"}

[[ -d "$APP_DIR" && -f "$APP_DIR/docker-compose.yml" && -f "$APP_DIR/.env" ]] || {
  echo "expected existing deployment at $APP_DIR" >&2; exit 1
}
for required in backup-postgres.sh restore-postgres.sh lib/backup-crypto.sh; do
  [[ -f "$BUNDLE_DIR/scripts/$required" ]] || { echo "bootstrap bundle missing scripts/$required" >&2; exit 1; }
done
for required in lib/deploy-common.sh lib/postgres-db-safety.sh lib/bootstrap-marker.sh lib/backup-lock.sh; do
  [[ -f "$BUNDLE_DIR/scripts/$required" ]] || { echo "bootstrap bundle missing scripts/$required" >&2; exit 1; }
done
source "$BUNDLE_DIR/scripts/lib/deploy-common.sh"
source "$BUNDLE_DIR/scripts/lib/postgres-db-safety.sh"
source "$BUNDLE_DIR/scripts/lib/bootstrap-marker.sh"

# INT-106 made the outbound allowlist mandatory. Pre-INT501 deployments do not
# have these keys, and Compose refuses even `exec` before the bridge can back up.
deployment_ensure_env_default "$APP_DIR/.env" OUTBOUND_ALLOWED_HOSTS 'open.feishu.cn,agent.qcc.com,openapi.biji.com,qyapi.weixin.qq.com'
deployment_ensure_env_default "$APP_DIR/.env" OUTBOUND_ALLOWED_PRIVATE_HOSTS ''

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
if ! grep -q '^BACKUP_MASTER_SECRET=' "$APP_DIR/.env"; then
  {
    echo ""
    echo "# INT-501 authenticated encrypted backup"
    printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
    echo "BACKUP_RETENTION_DAYS=14"
    printf 'BACKUP_MASTER_SECRET=%s\n' "$(openssl rand -hex 32)"
  } >> "$APP_DIR/.env"
fi

cd "$APP_DIR"
db_user=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_USER"')
production_database=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_DB"')
deployment_project=$(compose_project_name)
schema_signature_sql=$(postgres_public_schema_signature_sql)

query_schema_signature() {
  local database=$1
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$database" -tAc \
    "$schema_signature_sql" | tr -d '[:space:]'
}
source_schema_signature=$(query_schema_signature "$production_database")
[[ "$source_schema_signature" =~ ^[0-9a-f]{32}$ ]] || {
  echo "production database public schema signature is unavailable" >&2; exit 1
}

export JIANGHU_ROOT="$APP_DIR"
export BACKUP_DIR
backup_output=$(bash "$BUNDLE_DIR/scripts/backup-postgres.sh")
backup=$(printf '%s\n' "$backup_output" | sed -n 's/^Authenticated encrypted backup created: //p' | tail -n 1)
[[ -d "$backup" ]] || { echo "bootstrap backup was not published" >&2; exit 1; }

postgres_query_database_presence() {
  local database=$1
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$database'"
}
terminate_bootstrap_target() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$target' AND pid <> pg_backend_pid();" >/dev/null
}
drop_bootstrap_target() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d postgres -c \
    "DROP DATABASE IF EXISTS \"$target\";" >/dev/null
}
remove_bootstrap_target() {
  local status
  set +e
  postgres_database_exists "$target"
  status=$?
  set -e
  case "$status" in
    1) return 0 ;;
    2) return 2 ;;
  esac
  terminate_bootstrap_target || return $?
  drop_bootstrap_target || return $?
  postgres_assert_database_absent "$target"
}
bootstrap_cleanup_done=0
bootstrap_cleanup() {
  local original=$? cleanup_status=0
  if [[ "$bootstrap_cleanup_done" != 1 ]]; then
    set +e
    postgres_require_verified_cleanup remove_bootstrap_target
    cleanup_status=$?
    set -e
    if [[ "$cleanup_status" != 0 ]]; then
      echo "CRITICAL: bootstrap isolated database cleanup could not be verified: $target" >&2
      trap - EXIT
      exit 70
    fi
  fi
  trap - EXIT
  exit "$original"
}

target="jianghu_restore_bootstrap_$(date -u +%Y%m%d%H%M%S)_$(openssl rand -hex 4)"
trap bootstrap_cleanup EXIT
bash "$BUNDLE_DIR/scripts/restore-postgres.sh" "$backup" --database "$target" \
  --readiness-profile pre-int501

restored_schema_signature=$(query_schema_signature "$target")
[[ "${INT501_BOOTSTRAP_TEST_FAIL_SMOKE:-0}" != 1 ]] || restored_schema_signature=''
[[ "$restored_schema_signature" == "$source_schema_signature" ]] || {
  echo "bootstrap isolated restore schema signature mismatch" >&2; exit 1
}
remove_bootstrap_target || { echo "bootstrap restore database cleanup failed" >&2; exit 1; }
bootstrap_cleanup_done=1
write_bootstrap_marker "$MARKER" "$deployment_project" "$production_database" "$backup"
echo "INT-501 bootstrap verified. Now git pull --ff-only, replace detached update.sh, then run it."
