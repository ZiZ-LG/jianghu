#!/bin/sh
set -eu

SCHEMA=prisma/postgres/schema.prisma
LEGACY_SCHEMA=prisma/postgres/legacy/20260712_pre_int501.prisma
PRE_BRIDGE_MIGRATIONS='20260715000000_baseline 20260715010000_hash_command_run_idempotency_keys 20260715020000_add_person_created_at'
BRIDGE_MIGRATION=20260715030000_adopt_pre_int501_schema
legacy_adoption=0

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

refresh_applied_migrations() {
  applied_migrations=$(npx tsx scripts/list-applied-postgres-migrations.ts)
}

migration_is_applied() {
  printf '%s\n' "$applied_migrations" | grep -Fxq "$1"
}

resolve_missing_pre_bridge_migrations() {
  refresh_applied_migrations
  for migration in $PRE_BRIDGE_MIGRATIONS; do
    if ! migration_is_applied "$migration"; then
      npx prisma migrate resolve --applied "$migration" --schema "$SCHEMA"
      refresh_applied_migrations
    fi
  done
}

rollback_incomplete_bridge() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if printf '%s\n' "$incomplete_migrations" | grep -Fxq "$BRIDGE_MIGRATION"; then
    echo "[migration] 检测到中断的 bridge 事务，登记为 rolled back 后安全重放。"
    npx prisma migrate resolve --rolled-back "$BRIDGE_MIGRATION" --schema "$SCHEMA"
  fi
}

state=$(wait_for_migration_state)
case "$state" in
  untracked)
    legacy_adoption=1
    if schema_matches "$SCHEMA"; then
      echo "[migration] 检测到与当前模型一致的未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$LEGACY_SCHEMA"; then
      echo "[migration] 检测到已批准的 2026-07-12 公司旧 schema。"
    else
      echo "[migration] 未纳管 schema 不匹配当前模型或批准的旧模型，拒绝接管：" >&2
      cat /tmp/postgres-schema-drift.log >&2
      exit 1
    fi
    resolve_missing_pre_bridge_migrations
    ;;
  tracked)
    # A kill between individual `migrate resolve` calls leaves migration history
    # present while the business schema is still exactly legacy/current. Resume
    # only that recognized adoption state; arbitrary tracked drift stays managed
    # by normal Prisma failure semantics.
    refresh_applied_migrations
    if ! migration_is_applied "$BRIDGE_MIGRATION"; then
      if schema_matches "$LEGACY_SCHEMA"; then
        legacy_adoption=1
        echo "[migration] 继续中断的旧 schema 接管。"
        rollback_incomplete_bridge
        resolve_missing_pre_bridge_migrations
      elif schema_matches "$SCHEMA"; then
        legacy_adoption=1
        rollback_incomplete_bridge
        if ! migration_is_applied 20260715010000_hash_command_run_idempotency_keys; then
          npx tsx scripts/assert-untracked-command-runs-empty.ts
        fi
        echo "[migration] 继续中断的当前 schema 接管。"
        resolve_missing_pre_bridge_migrations
      fi
    fi
    ;;
  empty) ;;
  *) echo "[migration] 无法识别迁移状态：$state" >&2; exit 1 ;;
esac

echo "[migration] 在唯一索引迁移前执行同步锚与企微绑定冲突扫描…"
npm run migrate:sync-anchor-report
npm run migrate:wecom-bind-report

echo "[migration] 冲突扫描通过，部署版本化迁移…"
npx prisma migrate deploy --schema "$SCHEMA"

if ! schema_matches "$SCHEMA"; then
  echo "[migration] 迁移后 schema 与当前模型仍不一致，拒绝启动：" >&2
  cat /tmp/postgres-schema-drift.log >&2
  exit 1
fi

if [ "$legacy_adoption" = 1 ]; then
  echo "[migration] 旧库接管：回填稳定负责人 ID；歧义映射失败关闭…"
  npm run migrate:account-owners -- --fail-on-ambiguous
else
  echo "[migration] 非旧库接管：跳过一次性负责人姓名回填。"
fi

echo "[migration] 版本化迁移与冲突扫描通过。"
