#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=${JIANGHU_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}
source "$SCRIPT_DIR/lib/backup-crypto.sh"
source "$SCRIPT_DIR/lib/backup-lock.sh"
cd "$ROOT_DIR"

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

default_backup_dir="$(cd "$ROOT_DIR/.." && pwd)/jianghu-backups"
BACKUP_DIR=$(env_value BACKUP_DIR "$default_backup_dir")
BACKUP_RETENTION_DAYS=$(env_value BACKUP_RETENTION_DAYS 14)
BACKUP_MASTER_SECRET=$(env_value BACKUP_MASTER_SECRET)

[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

POSTGRES_USER=$(container_env POSTGRES_USER)
POSTGRES_DB=$(container_env POSTGRES_DB)
POSTGRES_PASSWORD_LIVE=$(container_env POSTGRES_PASSWORD)
validate_backup_master_secret "$BACKUP_MASTER_SECRET" "$POSTGRES_PASSWORD_LIVE"
derive_backup_keys "$BACKUP_MASTER_SECRET"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)
work_dir=''
init_backup_lock "$BACKUP_DIR"

cleanup() {
  [[ -z "$work_dir" ]] || rm -rf "$work_dir"
  release_backup_lock || true
}
trap cleanup EXIT
acquire_backup_lock

stamp=$(date -u +%Y%m%dT%H%M%SZ)
random_id=$(openssl rand -hex 8)
final="$BACKUP_DIR/jianghu-${stamp}-${random_id}.backup"
work_dir="$BACKUP_DIR/.backup-work.${stamp}.${random_id}"
mkdir "$work_dir"

docker compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass fd:3 -out "$work_dir/payload.enc" \
      3<<<"$BACKUP_ENCRYPTION_PASSPHRASE"
[[ -s "$work_dir/payload.enc" ]] || { echo "encrypted backup payload is empty" >&2; exit 1; }

cat > "$work_dir/metadata" <<EOF
format=jianghu-backup-v2
cipher=aes-256-cbc
kdf=sha256-domain-separated-v2
mac=hmac-sha256
source_database=$POSTGRES_DB
created_at=$stamp
EOF
write_artifact_integrity "$work_dir"
verify_artifact_auth "$work_dir"

# A single same-filesystem rename publishes payload and all authenticated markers atomically.
mv "$work_dir" "$final"
work_dir=''

find "$BACKUP_DIR" -type d -name 'jianghu-*.backup' -mtime "+$BACKUP_RETENTION_DAYS" -prune -exec rm -rf {} +
echo "Authenticated encrypted backup created: $final"
