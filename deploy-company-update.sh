#!/bin/bash
# 公司内网服务器（/data/jianghu）就地更新。首次进入 INT-501 前必须先跑 bootstrap。
set -Eeuo pipefail
cd /data/jianghu
source scripts/lib/deploy-common.sh
source scripts/lib/backup-crypto.sh
source scripts/lib/bootstrap-marker.sh

BOOTSTRAP_MARKER=/data/jianghu-backups/.int501-bootstrap-verified
resolve_deployment_db_state || { echo "无法确认现有数据库状态，禁止部署。" >&2; exit 1; }
existing_db=$DEPLOYMENT_HAS_EXISTING_DB

env_value() {
  local key=$1 line
  line=$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 || true)
  printf '%s' "${line#*=}"
}

if [[ "$existing_db" == 1 ]]; then
  deployment_project=$(compose_project_name)
  live_database=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_DB"')
  live_password=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_PASSWORD"')
  verify_bootstrap_marker "$BOOTSTRAP_MARKER" "$deployment_project" "$live_database" /data/jianghu-backups || {
    echo "INT-501 bootstrap marker 无效，禁止 migration build。" >&2; exit 1
  }
  backup_master=$(env_value BACKUP_MASTER_SECRET)
  validate_backup_master_secret "$backup_master" "$live_password"
  derive_backup_keys "$backup_master"
  verify_artifact_auth "$VERIFIED_BOOTSTRAP_BACKUP" || {
    echo "bootstrap marker 引用的备份认证失败，禁止 migration build。" >&2; exit 1
  }
fi

echo "── 1/4 认证加密备份数据库 ──"
if [[ "$existing_db" == 1 ]]; then
  bash scripts/backup-postgres.sh
else
  echo "first install: nothing to back up"
fi

echo "── 2/4 快进拉取最新版本 ──"
git pull --ff-only

echo "── 3/4 重建并滚动更新 ──"
docker compose up -d --build

echo "── 4/4 readiness 自检 ──"
PORT=$(grep -E '^WEB_PORT=' .env | tail -n 1 | cut -d= -f2); PORT=${PORT:-80}
wait_for_http_readiness "http://localhost:${PORT}/api/health/ready" 40 || {
  docker compose ps
  docker compose logs server | tail -40
  exit 1
}
docker compose ps
health=$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 \
  "http://localhost:${PORT}/api/health/ready")
echo "$health ✓ 已更新到：$(git log --oneline -1)"
docker image prune -f >/dev/null
