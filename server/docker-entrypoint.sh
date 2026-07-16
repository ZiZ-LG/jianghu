#!/bin/sh
set -e

echo "[entrypoint] 等待数据库就绪并检查同步锚冲突…"
# 唯一约束落库前必须先扫描存量冲突。退出码 1=发现冲突，立即停止；2=数据库未就绪，可重试。
i=0
while true; do
  set +e
  npm run migrate:sync-anchor-report >/tmp/sync-anchor-report.log 2>&1
  report_status=$?
  set -e
  if [ "$report_status" -eq 0 ]; then break; fi
  if [ "$report_status" -eq 1 ]; then
    echo "[entrypoint] 检测到同步锚冲突，停止自动迁移："
    cat /tmp/sync-anchor-report.log
    exit 1
  fi
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "[entrypoint] 数据库始终不可用，放弃。最后扫描日志："
    cat /tmp/sync-anchor-report.log
    exit 1
  fi
  echo "[entrypoint] 第 $i 次未就绪，2s 后重试…"
  sleep 2
done

# Existing deployments were created by db push and have no migration history.
# Adopt the baseline only when the live schema exactly matches the generated model;
# any drift fails closed for manual review. Empty databases replay the baseline.
migration_state=$(npx tsx scripts/postgres-migration-state.ts)
if [ "$migration_state" = "untracked" ]; then
  echo "[entrypoint] 检测到未纳管的存量 schema，验证与 baseline 完全一致…"
  if ! npx prisma migrate diff \
    --from-schema-datasource prisma/postgres/schema.prisma \
    --to-schema-datamodel prisma/postgres/schema.prisma \
    --exit-code >/tmp/postgres-baseline-drift.log 2>&1; then
    echo "[entrypoint] 存量 schema 与版本化 baseline 不一致，拒绝自动接管："
    cat /tmp/postgres-baseline-drift.log
    exit 1
  fi
  npx prisma migrate resolve --applied 20260715000000_baseline --schema prisma/postgres/schema.prisma
elif [ "$migration_state" != "empty" ] && [ "$migration_state" != "tracked" ]; then
  echo "[entrypoint] 无法识别迁移状态，拒绝继续。" >&2
  exit 1
fi

echo "[entrypoint] 冲突扫描通过，开始部署版本化迁移 (prisma migrate deploy)…"
npx prisma migrate deploy --schema prisma/postgres/schema.prisma
echo "[entrypoint] 版本化迁移已部署。启动后端…"

exec npm run start
