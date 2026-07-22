#!/bin/bash
# 公司内网服务器（默认 /data/jianghu，可用 JIANGHU_ROOT 覆盖）就地更新。
# 空库（首装 / ADR-INT-502 清库重装）：构建 → 容器 entrypoint 迁移空库 → 起服务，
#   readiness 通过后自动创建首个认证备份并写 bootstrap marker（后续更新的验证锚）。
# 已有库：验证 bootstrap marker + 认证备份后走停写迁移流程。
set -Eeuo pipefail
APP_DIR=${JIANGHU_ROOT:-/data/jianghu}
cd "$APP_DIR"
source scripts/lib/deploy-common.sh
source scripts/lib/backup-crypto.sh
source scripts/lib/bootstrap-marker.sh

env_value() {
  deployment_env_value .env "$1"
}

# 备份目录解析与 scripts/backup-postgres.sh 完全同源（env BACKUP_DIR → .env → ../jianghu-backups），
# 保证 marker 与备份天然同目录（bootstrap-marker 库对两者同目录有硬性要求）。
BACKUP_ROOT=${BACKUP_DIR:-$(env_value BACKUP_DIR)}
BACKUP_ROOT=${BACKUP_ROOT:-"$(cd "$APP_DIR/.." && pwd)/jianghu-backups"}
ROLLBACK_ROOT=${ROLLBACK_ROOT:-"$(cd "$APP_DIR/.." && pwd)/jianghu-rollbacks"}
BOOTSTRAP_MARKER=$BACKUP_ROOT/.int501-bootstrap-verified
RUNTIME_REVISION_FILE=$ROLLBACK_ROOT/.runtime-sha
deployment_require_env_value .env OUTBOUND_ALLOWED_HOSTS
resolve_deployment_db_state || { echo "无法确认现有数据库状态，禁止部署。" >&2; exit 1; }
existing_db=$DEPLOYMENT_HAS_EXISTING_DB

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

migration_history_snapshot() {
  local has_history
  has_history=$(docker compose exec -T db sh -c \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('\''public._prisma_migrations'\'') IS NOT NULL"' \
    | tr -d '[:space:]') || return 1
  case "$has_history" in
    f) printf '%s' absent ;;
    t)
      docker compose exec -T db sh -c \
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F "|" -tAc "SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count FROM \"_prisma_migrations\" ORDER BY started_at, migration_name"'
      ;;
    *) echo "unexpected migration history state" >&2; return 1 ;;
  esac
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
  verify_bootstrap_marker "$BOOTSTRAP_MARKER" "$deployment_project" "$live_database" "$BACKUP_ROOT" "$expected_bootstrap_commit" || {
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
  rollback_output=$(ROLLBACK_ROOT="$ROLLBACK_ROOT" ROLLBACK_SHA_OVERRIDE="$runtime_sha" \
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
migration_started=0
migration_history_before=''
restart_stopped_services() {
  local status=$? migration_history_after='' rollback_required=0
  if [[ "$services_stopped" == 1 ]]; then
    if [[ "$migration_started" == 1 ]]; then
      if ! migration_history_after=$(migration_history_snapshot); then
        echo "无法确认失败后的 migration history；按已改变处理。" >&2
        rollback_required=1
      elif [[ "$migration_history_after" != "$migration_history_before" ]]; then
        rollback_required=1
      fi
    fi
    if [[ "$rollback_required" == 1 ]]; then
      echo "数据库 migration history 已改变；自动执行认证回滚，禁止启动旧代码连接新 schema。" >&2
      services_stopped=0
      trap - EXIT HUP INT TERM
      if [[ -n "$rollback_point" ]] \
          && bash deploy-company-rollback.sh "$rollback_point" --confirm; then
        echo "认证回滚已完成；本次更新仍以失败状态退出。" >&2
        exit "$status"
      fi
      echo "CRITICAL: 自动认证回滚失败；保持服务停止，请勿直接启动旧容器。" >&2
      exit 70
    fi
    echo "更新在 schema 改变前中断；正在恢复原 server/web 运行状态。" >&2
    docker compose start server web || docker compose up -d --no-build server web || true
  fi
  trap - EXIT HUP INT TERM
  exit "$status"
}
if [[ "$existing_db" == 1 ]]; then
  migration_history_before=$(migration_history_snapshot) || {
    echo "无法记录 migration history，禁止停写部署。" >&2; exit 1
  }
  services_stopped=1
  trap restart_stopped_services EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  docker compose stop web server
  migration_started=1
  if ! docker compose run --rm --no-deps --entrypoint ./scripts/deploy-postgres-migrations.sh server; then
    echo "生产 migration 失败；将按 migration history 决定恢复原服务或执行认证回滚。" >&2
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

if [[ "$existing_db" == 0 ]]; then
  echo "── 7/7 首装收尾：创建首个认证备份并写入 bootstrap marker ──"
  first_install_finalize() {
    local backup_output backup_path project database
    backup_output=$(JIANGHU_ROOT="$APP_DIR" BACKUP_DIR="$BACKUP_ROOT" bash scripts/backup-postgres.sh) || return 1
    printf '%s\n' "$backup_output"
    backup_path=$(printf '%s\n' "$backup_output" | sed -n 's/^Authenticated encrypted backup created: //p' | tail -n 1)
    [[ -d "$backup_path" ]] || { echo "无法定位首装备份产物" >&2; return 1; }
    project=$(compose_project_name) || return 1
    database=$(docker compose exec -T db sh -c 'printf "%s" "$POSTGRES_DB"') || return 1
    write_bootstrap_marker "$BOOTSTRAP_MARKER" "$project" "$database" "$backup_path" "$current_commit"
  }
  if ! first_install_finalize; then
    echo "服务已部署成功，但首装备份/bootstrap marker 收尾失败——下一次更新会被 marker 验证拒绝。" >&2
    echo "补救（在 $APP_DIR 下依次执行）：" >&2
    echo "  bash scripts/backup-postgres.sh" >&2
    echo "  source scripts/lib/deploy-common.sh && source scripts/lib/bootstrap-marker.sh \\" >&2
    echo "    && write_bootstrap_marker '$BOOTSTRAP_MARKER' \"\$(compose_project_name)\" \"\$(docker compose exec -T db sh -c 'printf %s \"\$POSTGRES_DB\"')\" '<上一步输出的 .backup 目录>' '$current_commit'" >&2
    exit 1
  fi
  echo "✓ 首装认证备份 + bootstrap marker 已写入：$BOOTSTRAP_MARKER"
fi
docker image prune -f >/dev/null
