#!/bin/bash
# 江湖 · Mac mini（或任意单机）一键部署脚本
set -Eeuo pipefail
cd "$(dirname "$0")"
source scripts/lib/backup-crypto.sh
source scripts/lib/deploy-common.sh

echo "=== 江湖 · 单机部署 ==="
command -v docker >/dev/null 2>&1 || { echo "✗ 未找到 docker。请先安装并启动 Docker Desktop。"; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ Docker daemon 未运行。请打开 Docker Desktop 等它变绿后重试。"; exit 1; }
echo "✓ Docker 就绪"

if [ -f .env ]; then
  echo "✓ 已存在 .env，沿用（如需重置请先手动删除）"
else
  echo "→ 生成 .env（随机密钥；完整应用模式，不开备案介绍页）"
  PGPW=$(openssl rand -hex 16)
  JWT=$(openssl rand -hex 32)
  AIK=$(openssl rand -hex 32)
  BACKUP_SECRET=$(openssl rand -hex 32)
  MAC_BACKUP_DIR="${HOME}/JianghuBackups"
  cat > .env <<EOF
# 江湖 单机部署环境变量（自动生成；.env 已被 gitignore）
POSTGRES_USER=jianghu
POSTGRES_PASSWORD=${PGPW}
POSTGRES_DB=jianghu
BACKUP_DIR=${MAC_BACKUP_DIR}
BACKUP_RETENTION_DAYS=14
BACKUP_MASTER_SECRET=${BACKUP_SECRET}
JWT_SECRET=${JWT}
AI_KEY_SECRET=${AIK}
CORS_ORIGIN=
VITE_API_URL=
VITE_BEIAN_MODE=
VITE_ICP_BEIAN=
WEB_PORT=80
DONATE_URL=https://ifdian.net/a/zizaiLG
DONATE_QR_URL=
DONATE_NOTE=江湖是免费的。如果它帮到了你的销售作战，欢迎在爱发电请作者喝杯咖啡 ☕
EOF
  echo "✓ .env 已生成"
fi

if ! grep -q '^BACKUP_MASTER_SECRET=' .env; then
  {
    echo ""
    grep -q '^BACKUP_DIR=' .env || printf 'BACKUP_DIR=%s\n' "${HOME}/JianghuBackups"
    grep -q '^BACKUP_RETENTION_DAYS=' .env || echo "BACKUP_RETENTION_DAYS=14"
    printf 'BACKUP_MASTER_SECRET=%s\n' "$(openssl rand -hex 32)"
  } >> .env
  echo "✓ 已生成并保存 64-hex 本地备份主密钥"
fi

file_env() {
  local key=$1 line
  line=$(grep -E "^${key}=" .env | tail -n 1 || true)
  printf '%s' "${line#*=}"
}
validate_backup_master_secret "$(file_env BACKUP_MASTER_SECRET)" "$(file_env POSTGRES_PASSWORD)"

resolve_deployment_db_state || { echo "✗ 无法确认 Compose 数据库/卷状态，部署中止" >&2; exit 1; }
existing_db=$DEPLOYMENT_HAS_EXISTING_DB

if [[ "$existing_db" == 1 ]]; then
  echo "→ 发现现有数据库，先执行认证加密备份…"
  docker compose up -d db
  DB_USER=$(file_env POSTGRES_USER); DB_USER=${DB_USER:-jianghu}
  db_ready=0
  for _ in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U "$DB_USER" >/dev/null 2>&1; then db_ready=1; break; fi
    sleep 1
  done
  [[ "$db_ready" == 1 ]] || { echo "✗ 数据库未就绪，部署前备份未执行" >&2; exit 1; }
  bash scripts/backup-postgres.sh
else
  echo "✓ first install: nothing to back up（无现有数据库容器或 Compose 标记卷）"
fi

echo "→ docker compose up -d --build（首次构建约 3-8 分钟）"
docker compose up -d --build

PORT=$(file_env WEB_PORT); PORT=${PORT:-80}
echo "→ 等待数据库 readiness…"
wait_for_http_readiness "http://localhost:${PORT}/api/health/ready" 40 || {
  docker compose ps
  docker compose logs server | tail -40
  exit 1
}
health=$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 \
  "http://localhost:${PORT}/api/health/ready")

echo ""
echo "=== 部署结果 ==="
docker compose ps
echo "✓ 后端 readiness：$health"
echo "✓ 前端首页：HTTP $(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/")"
echo "团队访问：局域网 http://$(scutil --get LocalHostName 2>/dev/null || hostname).local$([ "$PORT" = 80 ] && echo '' || echo ":$PORT")"
LANIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
[ -n "$LANIP" ] && echo "局域网 IP：http://${LANIP}$([ "$PORT" = 80 ] && echo '' || echo ":$PORT")"
TSIP=$(tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null || true)
[ -n "$TSIP" ] && echo "Tailscale：http://${TSIP}$([ "$PORT" = 80 ] && echo '' || echo ":$PORT")"
