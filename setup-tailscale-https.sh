#!/bin/bash
# 江湖 · 给 Mac mini 配 Tailscale 私有 HTTPS（团队走 https 访问）
# ────────────────────────────────────────────────────────────────
# 为什么需要：团队此前走纯 HTTP（http://Leons-Mac-mini.local / Tailscale IP），
# 浏览器把它当“非安全上下文”——禁用 navigator.clipboard 等能力、登录密码明文传输。
# 用 Tailscale 自带的 `tailscale serve` 反代到 web 容器(:80)，团队改走
#   https://leons-mac-mini.<tailnet>.ts.net
# 证书由 Tailscale 自动签发(Let's Encrypt，*.ts.net)，零成本、零额外端口、不上公网（仅 tailnet 内）。
#
# 用法：
#   bash setup-tailscale-https.sh          # 配置 + 验证（幂等）
#   bash setup-tailscale-https.sh reset     # 撤销，恢复纯 HTTP
#
# ⚠️ 唯一手动前置（tailnet owner 在网页后台点一次，无 CLI）：
#   登录 https://login.tailscale.com/admin/dns → 打开「HTTPS Certificates / Enable HTTPS」
#   （MagicDNS 必须已开，本机已满足）。开了之后本脚本全自动。
set -euo pipefail
cd "$(dirname "$0")"

# 定位 tailscale CLI（PATH 里没有就用 App 包内的）
TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [ -z "$TS" ]; then echo "✗ 未找到 tailscale CLI。请先安装并登录 Tailscale。"; exit 1; fi

# web 容器对外端口（与 .env 一致，默认 80）
WEB_PORT=80
[ -f .env ] && WEB_PORT=$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 80)
WEB_PORT=${WEB_PORT:-80}

# reset 分支：撤销 serve，团队回到纯 HTTP
if [ "${1:-}" = "reset" ]; then
  echo "→ 撤销 tailscale serve 配置…"
  "$TS" serve reset 2>/dev/null || true
  echo "✓ 已撤销。团队恢复走 http://<主机或Tailscale IP>:${WEB_PORT}"
  exit 0
fi

echo "=== 江湖 · Tailscale HTTPS 配置 ==="

# 1) Tailscale 在线？
if ! "$TS" status >/dev/null 2>&1; then
  echo "✗ Tailscale 未运行/未登录。请先登录 Tailscale 后重试。"; exit 1
fi
echo "✓ Tailscale 在线"

# 2) 取本机 MagicDNS 名（如 leons-mac-mini.tail7ac96b.ts.net）
DNS=$("$TS" status --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || true)
if [ -z "$DNS" ]; then echo "✗ 取不到 MagicDNS 名。请确认 Tailscale 后台已开启 MagicDNS。"; exit 1; fi
echo "✓ 本机 MagicDNS：$DNS"

# 3) web 容器健康？serve 要反代到它
if ! curl -fsS "http://localhost:${WEB_PORT}/api/health" >/dev/null 2>&1; then
  echo "✗ 本机 :${WEB_PORT} 上的 web 服务不可达。请先 bash deploy-macmini.sh 把栈跑起来。"; exit 1
fi
echo "✓ web 容器健康（localhost:${WEB_PORT}）"

# 4) tailnet 是否已开启 HTTPS 证书（唯一需手动的前置；未开则 serve 会一直卡住，这里用「对本域名探一次 cert」即时判定——
#    成功=证书已就绪(顺带签好，serve 直接复用)；报错含 does not support / not enabled = 还没开。探测在 /tmp 进行，避免把证书文件写进仓库。）
CERT_PROBE=$( (cd /tmp && "$TS" cert "$DNS") 2>&1 || true )
rm -f "/tmp/${DNS}.crt" "/tmp/${DNS}.key" 2>/dev/null || true
if echo "$CERT_PROBE" | grep -qiE "does not support|not enabled|not configured"; then
  cat <<EOF

✗ tailnet 还没开启「HTTPS Certificates」——这是 Tailscale 网页后台的一次性开关（没有 CLI，需手动点一次）：

   1) 用 tailnet owner 账号登录 → https://login.tailscale.com/admin/dns
   2) 找到「HTTPS Certificates」区块，点 **Enable HTTPS**（确保 MagicDNS 也是开的）
   3) 回到这台 Mac mini 重新执行：  bash setup-tailscale-https.sh

开启后本脚本会自动签发证书、配置 serve、验证可达。整个 tailnet 只需开这一次。
EOF
  exit 2
fi
echo "✓ tailnet 已开启 HTTPS 证书"

# 5) 配置 serve：https://<DNS>/ → http://localhost:WEB_PORT（后台常驻）。
#    用「后台启动 + 轮询 serve status」做有界超时，避免任何情况下把脚本挂死。
echo "→ 配置 tailscale serve（首次会自动签发证书，约数秒）…"
"$TS" serve --bg "${WEB_PORT}" >/dev/null 2>&1 &
SERVE_PID=$!
served=0
for i in $(seq 1 20); do
  if ! kill -0 "$SERVE_PID" 2>/dev/null; then served=1; break; fi          # CLI 已返回
  if "$TS" serve status 2>/dev/null | grep -qi "https"; then served=1; break; fi  # 配置已生效
  sleep 1
done
if [ "$served" = 0 ]; then
  kill "$SERVE_PID" 2>/dev/null || true; pkill -f "[Tt]ailscale serve --bg" 2>/dev/null || true
  "$TS" serve reset 2>/dev/null || true
  echo "✗ tailscale serve 超时未生效（通常仍是 HTTPS 证书未开启）。请按上面的后台开关指引开启后重试。"
  exit 1
fi

# 6) 验证：从本机 curl https 入口（触发证书签发 + 确认反代）
echo "→ 验证 https 可达…"
ok=0
for i in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://${DNS}/api/health" 2>/dev/null || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done

echo ""
echo "=== serve 当前配置 ==="
"$TS" serve status 2>&1 | head -20
echo ""
if [ "$ok" = "1" ]; then
  echo "✓ 完成！团队（在同一 tailnet 内）现在走："
  echo ""
  echo "      https://${DNS}"
  echo ""
  echo "  · 安全上下文已满足：复制按钮 / 登录密码加密传输等问题从根上消失。"
  echo "  · 纯 HTTP 入口（http://Leons-Mac-mini.local / Tailscale IP:${WEB_PORT}）仍可用（办公室局域网、未装 Tailscale 时）。"
  echo "  · 撤销：bash setup-tailscale-https.sh reset"
else
  echo "⚠ serve 已配置，但 https 自检未返回 200（可能证书还在签发，稍等 1 分钟再开浏览器试）。"
  echo "  团队地址： https://${DNS}"
  echo "  排查：     $TS serve status   /   docker compose logs web | tail -30"
fi
