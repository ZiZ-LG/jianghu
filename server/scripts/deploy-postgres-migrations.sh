#!/bin/sh
set -eu

SCHEMA=prisma/postgres/schema.prisma
LEGACY_SCHEMA=prisma/postgres/legacy/20260712_pre_int501.prisma
PRE_BRIDGE_MIGRATIONS='20260715000000_baseline 20260715010000_hash_command_run_idempotency_keys 20260715020000_add_person_created_at'

wait_for_migration_state() {
  i=0
  while true; do
    if state=$(npx tsx scripts/postgres-migration-state.ts 2>/tmp/postgres-migration-state.log); then
      printf '%s' "$state"
      return 0
    fi
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "[migration] 数据库始终不可用，放弃：" >&2
      cat /tmp/postgres-migration-state.log >&2
      return 1
    fi
    echo "[migration] 第 $i 次未就绪，2s 后重试…" >&2
    sleep 2
  done
}

schema_matches() {
  target_schema=$1
  npx prisma migrate diff \
    --from-schema-datasource "$SCHEMA" \
    --to-schema-datamodel "$target_schema" \
    --exit-code >/tmp/postgres-schema-drift.log 2>&1
}

state=$(wait_for_migration_state)
case "$state" in
  untracked)
    if schema_matches "$SCHEMA"; then
      echo "[migration] 检测到与当前模型一致的未纳管 schema。"
    elif schema_matches "$LEGACY_SCHEMA"; then
      echo "[migration] 检测到已批准的 2026-07-12 公司旧 schema。"
    else
      echo "[migration] 未纳管 schema 不匹配当前模型或批准的旧模型，拒绝接管：" >&2
      cat /tmp/postgres-schema-drift.log >&2
      exit 1
    fi
    for migration in $PRE_BRIDGE_MIGRATIONS; do
      npx prisma migrate resolve --applied "$migration" --schema "$SCHEMA"
    done
    ;;
  empty|tracked) ;;
  *) echo "[migration] 无法识别迁移状态：$state" >&2; exit 1 ;;
esac

echo "[migration] 部署版本化迁移…"
npx prisma migrate deploy --schema "$SCHEMA"

if ! schema_matches "$SCHEMA"; then
  echo "[migration] 迁移后 schema 与当前模型仍不一致，拒绝启动：" >&2
  cat /tmp/postgres-schema-drift.log >&2
  exit 1
fi

echo "[migration] 执行同步锚冲突扫描…"
npm run migrate:sync-anchor-report
echo "[migration] 版本化迁移与冲突扫描通过。"
