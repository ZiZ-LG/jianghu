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

echo "[entrypoint] 冲突扫描通过，开始同步表结构 (prisma db push)…"
npx prisma db push --skip-generate
echo "[entrypoint] 表结构已同步。启动后端…"

exec npm run start
