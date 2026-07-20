#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=${JIANGHU_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}
source "$SCRIPT_DIR/lib/backup-crypto.sh"
source "$SCRIPT_DIR/lib/postgres-db-safety.sh"
cd "$ROOT_DIR"

usage() {
  echo "Usage: $0 BACKUP.backup --database jianghu_restore_NAME [--replace]" >&2
  exit 2
}

[[ $# -ge 3 ]] || usage
BACKUP=$1
shift
TARGET_DB=
REPLACE=0
READINESS_PROFILE=current
while [[ $# -gt 0 ]]; do
  case "$1" in
    --database) [[ $# -ge 2 ]] || usage; TARGET_DB=$2; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --readiness-profile) [[ $# -ge 2 ]] || usage; READINESS_PROFILE=$2; shift 2 ;;
    *) usage ;;
  esac
done
READINESS_SQL=$(postgres_restore_readiness_sql "$READINESS_PROFILE")

env_value() {
  local key=$1 fallback=${2-} line
  if [[ "${!key+x}" == x ]]; then printf '%s' "${!key}"; return; fi
  line=$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 || true)
  if [[ -n "$line" ]]; then printf '%s' "${line#*=}"; else printf '%s' "$fallback"; fi
}

container_env() {
  case "$1" in
    POSTGRES_USER) docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_USER"' ;;
    POSTGRES_DB) docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_DB"' ;;
    POSTGRES_PASSWORD) docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_PASSWORD"' ;;
    *) return 2 ;;
  esac
}

[[ -d "$BACKUP" && "$BACKUP" == *.backup ]] || { echo "authenticated backup directory not found: $BACKUP" >&2; exit 1; }
case "$TARGET_DB" in postgres|template0|template1) echo "refusing system database restore: $TARGET_DB" >&2; exit 1 ;; esac
[[ "$TARGET_DB" =~ ^jianghu_restore_[A-Za-z0-9_]+$ ]] || {
  echo "isolated database must use the strict jianghu_restore_ prefix" >&2
  exit 1
}

POSTGRES_USER=$(container_env POSTGRES_USER)
PROTECTED_PRODUCTION_DB=$(container_env POSTGRES_DB)
POSTGRES_PASSWORD_LIVE=$(container_env POSTGRES_PASSWORD)
BACKUP_MASTER_SECRET=$(env_value BACKUP_MASTER_SECRET)
validate_backup_master_secret "$BACKUP_MASTER_SECRET" "$POSTGRES_PASSWORD_LIVE"
[[ "$TARGET_DB" != "$PROTECTED_PRODUCTION_DB" ]] || { echo "refusing production database restore: $TARGET_DB" >&2; exit 1; }
derive_backup_keys "$BACKUP_MASTER_SECRET"

# Authenticate metadata and ciphertext before parsing metadata, decrypting, or mutating PostgreSQL.
verify_artifact_auth "$BACKUP"
validate_backup_cipher_metadata "$BACKUP"

postgres_query_database_presence() {
  local database=$1
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$database'"
}
database_exists() {
  postgres_database_exists "$TARGET_DB"
}
terminate_target_connections() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid();" >/dev/null
}
drop_target_database() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
    "DROP DATABASE IF EXISTS \"$TARGET_DB\";" >/dev/null
}
assert_target_absent() {
  postgres_assert_database_absent "$TARGET_DB"
}
remove_target_database() {
  terminate_target_connections || return $?
  drop_target_database || return $?
  assert_target_absent
}

set +e
database_exists
db_status=$?
set -e
[[ "$db_status" != 2 ]] || exit 1
if [[ "$db_status" == 0 && "$REPLACE" != 1 ]]; then
  echo "target database already exists; use --replace only for a jianghu_restore_ database" >&2
  exit 1
fi
if [[ "$db_status" == 0 ]]; then remove_target_database; fi

created=0
completed=0
cleanup() {
  local status=$?
  set +e
  if [[ "$completed" != 1 && "$created" == 1 ]]; then
    postgres_require_verified_cleanup remove_target_database
    cleanup_status=$?
    if [[ "$cleanup_status" != 0 ]]; then
      echo "CRITICAL: partial isolated restore database could not be removed: $TARGET_DB" >&2
      trap - EXIT
      exit 70
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
  "CREATE DATABASE \"$TARGET_DB\";" >/dev/null
created=1

backup_decrypt_payload "$BACKUP" \
  | docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$TARGET_DB" \
      --exit-on-error --no-owner --no-privileges

ready=$(docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$TARGET_DB" -tAc \
  "$READINESS_SQL" | tr -d '[:space:]')
[[ "$ready" == 1 ]] || { echo "restored database failed required table readiness" >&2; exit 1; }

completed=1
echo "Restore verified in isolated database: $TARGET_DB"
