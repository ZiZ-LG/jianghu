#!/bin/bash
# 公司内网服务器（/data/jianghu）就地更新。首次进入 INT-501 前必须先跑 bootstrap。
set -Eeuo pipefail
cd /data/jianghu
source scripts/lib/deploy-common.sh
source scripts/lib/backup-crypto.sh
source scripts/lib/bootstrap-marker.sh

BOOTSTRAP_MARKER=/data/jianghu-backups/.int501-bootstrap-verified
deployment_require_env_value .env OUTBOUND_ALLOWED_HOSTS
resolve_deployment_db_state || { echo "无法确认现有数据库状态，禁止部署。" >&2; exit 1; }
existing_db=$DEPLOYMENT_HAS_EXISTING_DB

env_value() {
  deployment_env_value .env "$1"
}

pre_pull_sha=$(git rev-parse HEAD)
echo "── 1/6 快进拉取待部署版本 ──"
git pull --ff-only
current_commit=$(git rev-parse HEAD)

echo "── 2/6 验证 bootstrap、代码绑定与备份认证 ──"
if [[ "$existing_db" == 1 ]]; then
  deployment_project=$(compose_project_name)
  live_database=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_DB"')
  live_password=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_PASSWORD"')
  verify_bootstrap_marker "$BOOTSTRAP_MARKER" "$deployment_project" "$live_database" /data/jianghu-backups "$current_commit" || {
    echo "INT-501 bootstrap marker 无效，禁止 migration build。" >&2; exit 1
  }
  backup_master=$(env_value BACKUP_MASTER_SECRET)
  validate_backup_master_secret "$backup_master" "$live_password"
  derive_backup_keys "$backup_master"
  verify_artifact_auth "$VERIFIED_BOOTSTRAP_BACKUP" || {
    echo "bootstrap marker 引用的备份认证失败，禁止 migration build。" >&2; exit 1
  }
fi

rollback_point=''
echo "── 3/6 创建认证备份和可执行回滚点 ──"
if [[ "$existing_db" == 1 ]]; then
  rollback_output=$(ROLLBACK_ROOT=/data/jianghu-rollbacks ROLLBACK_SHA_OVERRIDE="$pre_pull_sha" \
    bash scripts/create-release-rollback-point.sh)
  printf '%s\n' "$rollback_output"
  rollback_point=$(printf '%s\n' "$rollback_output" | sed -n 's/^ROLLBACK_POINT=//p' | tail -n 1)
  [[ -d "$rollback_point" ]] || { echo "回滚点创建失败，禁止部署。" >&2; exit 1; }
else
  echo "first install: nothing to back up"
fi

echo "── 4/6 构建候选镜像（不替换运行中容器） ──"
docker compose build server web

echo "── 5/6 停写、部署 migration，再切换候选容器 ──"
if [[ "$existing_db" == 1 ]]; then
  docker compose stop web server
  if ! docker compose run --rm --no-deps --entrypoint ./scripts/deploy-postgres-migrations.sh server; then
    echo "生产 migration 失败；数据库事务已失败关闭，重启原 server/web 容器。" >&2
    docker compose start server web
    [[ -z "$rollback_point" ]] || echo "回滚命令：bash deploy-company-rollback.sh '$rollback_point' --confirm" >&2
    exit 1
  fi
fi
docker compose up -d --no-build

echo "── 6/6 readiness 自检 ──"
PORT=$(grep -E '^WEB_PORT=' .env | tail -n 1 | cut -d= -f2); PORT=${PORT:-80}
wait_for_http_readiness "http://localhost:${PORT}/api/health/ready" 40 || {
  docker compose ps
  docker compose logs server | tail -40
  [[ -z "$rollback_point" ]] || echo "回滚命令：bash deploy-company-rollback.sh '$rollback_point' --confirm"
  exit 1
}
docker compose ps
health=$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 \
  "http://localhost:${PORT}/api/health/ready")
echo "$health ✓ 已更新到：$(git log --oneline -1)"
[[ -z "$rollback_point" ]] || echo "本次回滚点：$rollback_point"
docker image prune -f >/dev/null
