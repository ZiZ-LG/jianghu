#!/bin/bash
# 江湖 · Mac mini（或任意单机）一键部署脚本
# 用途：在内网/Tailscale 环境给团队做验证与迭代。复用生产 docker-compose 栈。
# 与公网上线的区别：不开启备案介绍页（VITE_BEIAN_MODE 留空）——团队要用的是完整应用。
#
# 用法：  bash deploy-macmini.sh
# 幂等：  重复执行不会重置已有 .env / 数据；只在缺失时生成。
set -euo pipefail
cd "$(dirname "$0")"

echo "=== 江湖 · 单机部署 ==="

# 1) 前置检查：Docker 是否就绪
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ 未找到 docker。请先安装并启动 Docker Desktop。"; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker daemon 未运行。请打开 Docker Desktop 等它变绿后重试。"; exit 1
fi
echo "✓ Docker 就绪"

# 2) 生成 .env（仅当不存在时；已存在则保留，避免覆盖密钥/数据连接）
if [ -f .env ]; then
  echo "✓ 已存在 .env，沿用（如需重置请先手动删除）"
else
  echo "→ 生成 .env（随机密钥；完整应用模式，不开备案介绍页）"
  PGPW=$(openssl rand -hex 16)
  JWT=$(openssl rand -hex 32)
  AIK=$(openssl rand -hex 32)
  cat > .env <<EOF
# 江湖 单机部署环境变量（自动生成于 deploy-macmini.sh；.env 已被 gitignore）
POSTGRES_USER=jianghu
POSTGRES_PASSWORD=${PGPW}
POSTGRES_DB=jianghu

JWT_SECRET=${JWT}
AI_KEY_SECRET=${AIK}

# 同源部署，留空
CORS_ORIGIN=
VITE_API_URL=

# 单机/内网：不开启备案介绍页，团队直接用完整应用
VITE_BEIAN_MODE=
VITE_ICP_BEIAN=

# 对外端口（Mac 上 80 通常可用；若被占改成 8080 再访问 http://主机:8080）
WEB_PORT=80

# 捐赠入口
DONATE_URL=https://ifdian.net/a/zizaiLG
DONATE_QR_URL=
DONATE_NOTE=江湖是免费的。如果它帮到了你的销售作战，欢迎在爱发电请作者喝杯咖啡 ☕
EOF
  echo "✓ .env 已生成"
fi

# 3) 构建并启动
echo "→ docker compose up -d --build（首次构建约 3-8 分钟）"
docker compose up -d --build

# 4) 等待健康并自检
echo "→ 等待服务就绪…"
PORT=$(grep -E '^WEB_PORT=' .env | cut -d= -f2); PORT=${PORT:-80}
ok=0
for i in $(seq 1 40); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

echo ""
echo "=== 部署结果 ==="
docker compose ps
echo ""
if [ "$ok" = "1" ]; then
  echo "✓ 后端健康：$(curl -s http://localhost:${PORT}/api/health)"
  echo "✓ 前端首页：HTTP $(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/)"
  echo ""
  echo "团队访问地址（任选）："
  echo "  · 同局域网：    http://$(scutil --get LocalHostName 2>/dev/null || hostname).local${PORT:+$([ "$PORT" = 80 ] && echo '' || echo ":$PORT")}"
  LANIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  [ -n "$LANIP" ] && echo "  · 局域网 IP：   http://${LANIP}$([ "$PORT" = 80 ] && echo '' || echo ":$PORT")"
  TSIP=$(tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null || true)
  [ -n "$TSIP" ] && echo "  · Tailscale：   http://${TSIP}$([ "$PORT" = 80 ] && echo '' || echo ":$PORT")  （远程成员用）"
else
  echo "✗ 健康检查超时。查看日志：docker compose logs server | tail -40"
fi
