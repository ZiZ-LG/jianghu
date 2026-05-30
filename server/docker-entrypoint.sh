#!/bin/sh
set -e

echo "[entrypoint] 等待数据库就绪并同步表结构 (prisma db push)…"
# 等待 Postgres 起来：最多重试 ~60s。compose 已用 depends_on healthcheck 把关，这里再兜底。
i=0
until npx prisma db push --skip-generate >/tmp/dbpush.log 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "[entrypoint] 数据库始终不可用，放弃。最后日志："
    cat /tmp/dbpush.log
    exit 1
  fi
  echo "[entrypoint] 第 $i 次未就绪，2s 后重试…"
  sleep 2
done
echo "[entrypoint] 表结构已同步。启动后端…"

exec npm run start
