#!/bin/bash
# 公司内网服务器（jsf-zhul-a-private / 10.0.171.152，部署在 /data/jianghu）就地更新脚本。
# 这是服务器上 /data/jianghu/update.sh 的仓库存档副本（防丢 + 可追溯）。
#
# 用法（在服务器上）：
#   首次放置： scp deploy-company-update.sh <用户>@10.0.171.152:/data/jianghu/update.sh
#   日常更新： cd /data/jianghu && sudo bash update.sh
#
# 做的事：备份数据库（保留最近 14 份）→ git pull（main）→ docker compose 重建滚动更新
#         → 健康自检 → 清理悬空镜像。数据卷 pgdata 不动。
# ⚠️ git pull 拉的是 main；功能分支（feat/*）的改动必须先合 main，本脚本才会部署到。
# ⚠️ 红线：绝不 docker compose down -v（会删 pgdata 数据卷）。
set -e
cd /data/jianghu
echo "── 1/4 备份数据库 ──"
docker exec jianghu-db-1 pg_dump -U jianghu jianghu > /data/jianghu-backups/backup-$(date +%F-%H%M).sql
ls -t /data/jianghu-backups/*.sql | tail -n +15 | xargs -r rm -f
echo "── 2/4 拉取最新版本 ──"
git pull
echo "── 3/4 重建并滚动更新 ──"
docker compose up -d --build
echo "── 4/4 健康自检 ──"
sleep 6
docker compose ps
curl -s http://localhost/api/health && echo " ✓ 已更新到：$(git log --oneline -1)"
docker image prune -f >/dev/null
