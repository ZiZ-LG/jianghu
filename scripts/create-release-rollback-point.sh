#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=${JIANGHU_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}
ROLLBACK_ROOT=${ROLLBACK_ROOT:-$(cd "$ROOT_DIR/.." && pwd)/jianghu-rollbacks}
cd "$ROOT_DIR"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
git diff --quiet --ignore-submodules -- \
  && git diff --cached --quiet --ignore-submodules -- \
  || { echo "tracked deployment files are dirty; refusing rollback snapshot" >&2; exit 1; }

sha=${ROLLBACK_SHA_OVERRIDE:-$(git rev-parse HEAD)}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deployment SHA" >&2; exit 1; }
project=$(docker compose config 2>/dev/null | awk '$1 == "name:" { print $2; exit }')
[[ "$project" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "invalid Compose project" >&2; exit 1; }

server_ref=$(docker compose images -q server | head -n 1)
web_ref=$(docker compose images -q web | head -n 1)
server_image=$(docker image inspect --format '{{.Id}}' "$server_ref" 2>/dev/null || true)
web_image=$(docker image inspect --format '{{.Id}}' "$web_ref" 2>/dev/null || true)
[[ "$server_image" =~ ^sha256:[0-9a-f]{64}$ && "$web_image" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "server/web images are not available; refusing rollback snapshot" >&2; exit 1
}
server_tag=$(docker image inspect --format '{{index .RepoTags 0}}' "$server_image")
web_tag=$(docker image inspect --format '{{index .RepoTags 0}}' "$web_image")
[[ "$server_tag" =~ ^[A-Za-z0-9_./:-]+$ && "$web_tag" =~ ^[A-Za-z0-9_./:-]+$ ]] || {
  echo "invalid Compose image tag" >&2; exit 1
}

mkdir -p "$ROLLBACK_ROOT"
ROLLBACK_ROOT=$(cd "$ROLLBACK_ROOT" && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
nonce=$(openssl rand -hex 8)
point="$ROLLBACK_ROOT/release-${stamp}-${nonce}"
work="$ROLLBACK_ROOT/.release-${stamp}-${nonce}.tmp"
mkdir "$work"
cleanup() { [[ ! -d "$work" ]] || rm -rf "$work"; }
trap cleanup EXIT

backup_output=$(bash scripts/backup-postgres.sh)
printf '%s\n' "$backup_output"
backup=$(printf '%s\n' "$backup_output" | sed -n 's/^Authenticated encrypted backup created: //p' | tail -n 1)
[[ -d "$backup" && "$backup" == *.backup ]] || { echo "could not identify authenticated backup" >&2; exit 1; }
cp -a "$backup" "$work/database.backup"

cat > "$work/manifest" <<EOF
format=jianghu-release-rollback-v1
created_at=$stamp
project=$project
rollback_sha=$sha
server_image=$server_image
server_tag=$server_tag
web_image=$web_image
web_tag=$web_tag
database_backup=database.backup
EOF

mv "$work" "$point"
trap - EXIT
echo "ROLLBACK_POINT=$point"
