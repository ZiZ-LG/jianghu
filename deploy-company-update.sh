#!/bin/bash
# 公司内网服务器（/data/jianghu）就地更新。首次进入 INT-501 前必须先跑 bootstrap。
set -Eeuo pipefail
cd /data/jianghu
source scripts/lib/deploy-common.sh
source scripts/lib/backup-crypto.sh
source scripts/lib/bootstrap-marker.sh

BOOTSTRAP_MARKER=/data/jianghu-backups/.int501-bootstrap-verified
RUNTIME_REVISION_FILE=/data/jianghu-rollbacks/.runtime-sha
deployment_require_env_value .env OUTBOUND_ALLOWED_HOSTS
resolve_deployment_db_state || { echo "无法确认现有数据库状态，禁止部署。" >&2; exit 1; }
existing_db=$DEPLOYMENT_HAS_EXISTING_DB

env_value() {
  deployment_env_value .env "$1"
}

write_runtime_revision() {
  local sha=$1 directory tmp
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid runtime revision" >&2; return 1; }
  directory=$(dirname "$RUNTIME_REVISION_FILE")
  mkdir -p "$directory"
  chmod 700 "$directory"
  tmp=$(mktemp "$directory/.runtime-sha.XXXXXX")
  printf '%s\n' "$sha" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$RUNTIME_REVISION_FILE"
}

pre_pull_sha=$(git rev-parse HEAD)
if [[ -n "${RUNTIME_SHA_OVERRIDE:-}" ]]; then
  runtime_sha=$RUNTIME_SHA_OVERRIDE
elif [[ -s "$RUNTIME_REVISION_FILE" ]]; then
  runtime_sha=$(tr -d '[:space:]' < "$RUNTIME_REVISION_FILE")
else
  runtime_sha=$pre_pull_sha
fi
[[ "$runtime_sha" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$runtime_sha^{commit}" || {
  echo "无法确认当前运行版本；首次迁移请设置 RUNTIME_SHA_OVERRIDE=<完整40位SHA>。" >&2; exit 1
}
# Persist before pull so a failed post-pull attempt cannot relabel the still
# running old images as the newer checkout on retry.
write_runtime_revision "$runtime_sha"

echo "── 1/6 快进拉取待部署版本 ──"
git pull --ff-only
current_commit=$(git rev-parse HEAD)
git diff --quiet --ignore-submodules -- \
  && git diff --cached --quiet --ignore-submodules -- \
  || { echo "tracked deployment files are dirty; refusing update" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all -- app server packages)" ]] || {
  echo "untracked Docker build inputs exist; refusing update" >&2; exit 1
}

echo "── 2/6 验证 bootstrap、代码绑定与备份认证 ──"
if [[ "$existing_db" == 1 ]]; then
  deployment_project=$(compose_project_name)
  live_database=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_DB"')
  live_password=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_PASSWORD"')
  migration_history=$(docker compose exec -T db sh -c \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('\''public._prisma_migrations'\'') IS NOT NULL"' \
    | tr -d '[:space:]')
  bridge_complete=f
  if [[ "$migration_history" == t ]]; then
    bridge_complete=$(docker compose exec -T db sh -c \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '\''20260715030000_adopt_pre_int501_schema'\'' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)"' \
      | tr -d '[:space:]')
  fi
  expected_bootstrap_commit=''
  [[ "$bridge_complete" == t ]] || expected_bootstrap_commit=$current_commit
  verify_bootstrap_marker "$BOOTSTRAP_MARKER" "$deployment_project" "$live_database" /data/jianghu-backups "$expected_bootstrap_commit" || {
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
  rollback_output=$(ROLLBACK_ROOT=/data/jianghu-rollbacks ROLLBACK_SHA_OVERRIDE="$runtime_sha" \
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
services_stopped=0
restart_stopped_services() {
  local status=$?
  if [[ "$services_stopped" == 1 ]]; then
    echo "更新在候选容器确认启动前中断；正在恢复 server/web 运行状态。" >&2
    docker compose start server web || docker compose up -d --no-build server web || true
  fi
  trap - EXIT HUP INT TERM
  exit "$status"
}
if [[ "$existing_db" == 1 ]]; then
  services_stopped=1
  trap restart_stopped_services EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  docker compose stop web server
  if ! docker compose run --rm --no-deps --entrypoint ./scripts/deploy-postgres-migrations.sh server; then
    echo "生产 migration 失败；数据库事务已失败关闭，重启原 server/web 容器。" >&2
    [[ -z "$rollback_point" ]] || echo "回滚命令：bash deploy-company-rollback.sh '$rollback_point' --confirm" >&2
    exit 1
  fi
fi
docker compose up -d --no-build
services_stopped=0
trap - EXIT HUP INT TERM
write_runtime_revision "$current_commit"

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
