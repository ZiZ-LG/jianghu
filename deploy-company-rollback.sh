#!/usr/bin/env bash
# Explicit production rollback: old code/images + authenticated pre-release DB restored to an isolated DB, then switched live.
set -Eeuo pipefail
umask 077

[[ $# -eq 2 && "$2" == "--confirm" ]] || {
  echo "Usage: $0 /data/jianghu-rollbacks/release-TIMESTAMP-ID --confirm" >&2
  exit 2
}

POINT=$1
ROOT_DIR=${JIANGHU_ROOT:-/data/jianghu}
cd "$ROOT_DIR"
source scripts/lib/deploy-common.sh
source scripts/lib/backup-crypto.sh

ROLLBACK_ROOT=${ROLLBACK_ROOT:-$(cd "$ROOT_DIR/.." && pwd)/jianghu-rollbacks}
point_real=$(cd "$POINT" 2>/dev/null && pwd) || { echo "rollback point not found" >&2; exit 1; }
root_real=$(cd "$ROLLBACK_ROOT" 2>/dev/null && pwd) || { echo "rollback root not found" >&2; exit 1; }
[[ "$point_real" == "$root_real"/release-* ]] || { echo "rollback point is outside the approved root" >&2; exit 1; }
manifest="$point_real/manifest"
[[ -f "$manifest" ]] || { echo "rollback manifest missing" >&2; exit 1; }

field() { sed -n "s/^$1=//p" "$manifest"; }
[[ $(field format) == jianghu-release-rollback-v1 ]] || { echo "unsupported rollback manifest" >&2; exit 1; }
sha=$(field rollback_sha)
project=$(field project)
server_image=$(field server_image)
server_tag=$(field server_tag)
web_image=$(field web_image)
web_tag=$(field web_tag)
backup_name=$(field database_backup)
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid rollback SHA" >&2; exit 1; }
[[ "$project" == "$(compose_project_name)" ]] || { echo "rollback point belongs to a different deployment" >&2; exit 1; }
[[ "$server_image" =~ ^sha256:[0-9a-f]{64}$ && "$web_image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid rollback images" >&2; exit 1; }
[[ "$server_tag" =~ ^[A-Za-z0-9_./:-]+$ && "$web_tag" =~ ^[A-Za-z0-9_./:-]+$ ]] || { echo "invalid rollback image tags" >&2; exit 1; }
[[ "$backup_name" == database.backup && -d "$point_real/$backup_name" ]] || { echo "rollback backup missing" >&2; exit 1; }
docker image inspect "$server_image" "$web_image" >/dev/null
git cat-file -e "$sha^{commit}"

target="jianghu_restore_rollback_$(date -u +%Y%m%dT%H%M%SZ)_$(openssl rand -hex 4)"
echo "Stopping writes before restoring rollback database..."
docker compose stop web server
bash scripts/restore-postgres.sh "$point_real/$backup_name" --database "$target"

env_tmp=.env.rollback.$$
awk -v db="$target" '
  BEGIN { replaced=0 }
  /^POSTGRES_DB=/ { print "POSTGRES_DB=" db; replaced=1; next }
  { print }
  END { if (!replaced) print "POSTGRES_DB=" db }
' .env > "$env_tmp"
chmod --reference=.env "$env_tmp" 2>/dev/null || chmod 600 "$env_tmp"
mv "$env_tmp" .env

docker tag "$server_image" "$server_tag"
docker tag "$web_image" "$web_tag"
docker compose up -d --no-build db server web
PORT=$(grep -E '^WEB_PORT=' .env | tail -n 1 | cut -d= -f2); PORT=${PORT:-80}
wait_for_http_readiness "http://localhost:${PORT}/api/health/ready" 40
echo "Rollback complete: runtime_sha=$sha database=$target point=$point_real"
echo "Working tree stays on the current main branch so the next forward-fix update can fast-forward normally."
