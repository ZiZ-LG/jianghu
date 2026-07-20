#!/bin/sh
set -e

./scripts/deploy-postgres-migrations.sh
echo "[entrypoint] 迁移预检通过。启动后端…"

exec npm run start
