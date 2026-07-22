# 部署到公司内网服务器（CentOS 7.9 / jsf-zhul-a-private）

> 目标机：`jsf-zhul-a-private`，内网 IP `10.0.171.152`，4核 32G，CentOS 7.9，产品落 `/data` 下。
> 复用现有 Docker 生产栈（Postgres + 后端 + Nginx 前端，`docker-compose.yml`）。内网部署无需域名/ICP。
> ⚠️ 两个环境特殊点：① CentOS 7 已 EOL（2024-06），默认 yum 源已下线，须切归档/镜像源；② 若用 Mac mini（Apple M 芯片，arm64）离线打包镜像，必须交叉构建 **linux/amd64**，否则服务器上跑不起来。

---

## 0. 前置检查（在服务器上跑，决定走路径 A 还是 B）

```bash
docker -v && docker compose version        # ① 有无 Docker（公司机常预装）
curl -m 5 -s https://registry.npmmirror.com >/dev/null && echo 外网OK || echo 无外网   # ② 外网/代理
ss -tlnp | grep -E ':80 |:8080 '           # ③ 80 端口是否被占（被占则 .env 里 WEB_PORT 换）
df -h /data                                 # ④ /data 空间（建议 ≥ 20G）
```

- ②外网 OK → 走 **路径 A（在线构建，最简单）**；无外网 → 走 **路径 B（离线镜像）**。
- ①没有 Docker → 先做第 1 步；已有（≥ 20.x 且有 compose 插件）→ 跳过。

## 1. 装 Docker（仅当没有；CentOS 7 EOL 源处理）

```bash
# 1.1 yum 基础源切阿里云 vault 归档（CentOS7 官方源已 404）
sudo curl -o /etc/yum.repos.d/CentOS-Base.repo https://mirrors.aliyun.com/repo/Centos-7.repo
sudo sed -i 's/mirrors.cloud.aliyuncs.com/mirrors.aliyun.com/g' /etc/yum.repos.d/CentOS-Base.repo
sudo yum clean all && sudo yum makecache

# 1.2 docker-ce（阿里云镜像源，el7 最高支持到 24.x，够用）
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
sudo sed -i 's+download.docker.com+mirrors.aliyun.com/docker-ce+' /etc/yum.repos.d/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

## 2. Docker 数据根迁到 /data（镜像、卷、库数据都落数据盘）

```bash
sudo mkdir -p /data/docker /etc/docker
echo '{ "data-root": "/data/docker", "registry-mirrors": ["https://docker.m.daocloud.io", "https://dockerproxy.net"] }' | sudo tee /etc/docker/daemon.json
sudo systemctl enable --now docker && docker info | grep "Docker Root Dir"   # 应显示 /data/docker
```

> 这样 Postgres 数据卷 `pgdata` 物理上就在 `/data/docker/volumes/jianghu_pgdata/`，满足「数据在 /data」。

## 3. 取代码到 /data/jianghu

服务器能连 GitHub（私有库需 fine-grained PAT）：
```bash
sudo mkdir -p /data && cd /data
git clone https://<PAT>@github.com/ZiZ-LG/jianghu.git jianghu && cd jianghu
```

服务器连不上 GitHub（更常见）——在 Mac mini 打包后 scp：
```bash
# Mac mini 上（主仓目录）：
cd /Volumes/PowerData/江湖APP && git archive --format=tar.gz -o /tmp/jianghu-src.tar.gz main
scp /tmp/jianghu-src.tar.gz <你的用户名>@10.0.171.152:/tmp/
# 服务器上：
sudo mkdir -p /data/jianghu && sudo tar xzf /tmp/jianghu-src.tar.gz -C /data/jianghu && cd /data/jianghu
```

## 4. 配置环境变量

```bash
cd /data/jianghu
cp .env.production.example .env
# 编辑 .env：三处必改 + 内网两处确认
#   POSTGRES_PASSWORD=$(openssl rand -hex 16)
#   JWT_SECRET=$(openssl rand -hex 32)
#   AI_KEY_SECRET=$(openssl rand -hex 32)
#   VITE_BEIAN_MODE=   （留空！内网无需备案页，要完整应用）
#   WEB_PORT=80        （若 80 被占改成 8080 等）
sed -i "s/__改成强密码__/$(openssl rand -hex 16)/; 0,/__改成64位随机十六进制__/s//$(openssl rand -hex 32)/; s/__改成另一段64位随机十六进制__/$(openssl rand -hex 32)/" .env
sed -i 's/^VITE_BEIAN_MODE=.*/VITE_BEIAN_MODE=/' .env
```

## 5A. 路径 A · 在线构建启动（服务器有外网/代理）

```bash
cd /data/jianghu
docker compose up -d --build      # 首次构建 5-15 分钟（Dockerfile 已配 npmmirror 加速）
```

## 5B. 路径 B · 离线镜像（服务器无外网）

Mac mini 上交叉构建并导出（⚠️ M 芯片必须指定 amd64；compose project 名固定为 jianghu 保证镜像名匹配）：
```bash
cd /Volumes/PowerData/江湖APP/.claude/worktrees/jianghu-deploy
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -p jianghu build       # 交叉构建，比本机慢数倍属正常
docker pull --platform linux/amd64 postgres:16-alpine
docker save jianghu-server jianghu-web postgres:16-alpine | gzip > /tmp/jianghu-images-amd64.tar.gz
scp /tmp/jianghu-images-amd64.tar.gz <你的用户名>@10.0.171.152:/tmp/
```

服务器上加载并启动（代码已按第 3 步就位）：
```bash
docker load -i /tmp/jianghu-images-amd64.tar.gz
cd /data/jianghu && docker compose -p jianghu up -d --no-build
```

> 以后每次更新版本：Mac 重复 5B 的 build/save/scp/load，服务器 `docker compose -p jianghu up -d --no-build` 滚动替换，`pgdata` 卷数据不受影响。

## 6. 验证与团队访问

```bash
docker compose ps                                   # 三容器 healthy（db 首次初始化约 30 秒）
curl -s http://localhost/api/health                 # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/   # 200
# CentOS7 防火墙放行（若开着 firewalld）：
sudo firewall-cmd --permanent --add-port=80/tcp && sudo firewall-cmd --reload
```

团队浏览器访问：`http://10.0.171.152`（WEB_PORT 改过则带端口）。注册首个账号即自动成为工作区 owner。

## 7. 日常运维

```bash
docker compose logs -f server                       # 看后端日志
bash scripts/backup-postgres.sh                        # 加密备份（建议 cron 每日）
# 红线：绝不执行 docker compose down -v（-v 会删 pgdata 数据卷）
```

每日自动备份 cron（root crontab，`sudo crontab -e` 加入）：

```bash
0 2 * * * cd /data/jianghu && bash scripts/backup-postgres.sh >> /var/log/jianghu-backup.log 2>&1
```

## 8. 版本更新（就地·日常）

服务器上 `/data/jianghu/update.sh`（源已入库 = 仓库根 `deploy-company-update.sh`）：持久化当前运行 SHA → `git pull`（main）→ 校验 bootstrap/认证备份 → 固定旧 server/web 镜像和数据库回滚点 → 构建候选镜像但不替换容器 → 停写并单独执行版本化 migration → 成功后才切换容器和执行 readiness。migration 失败或停服区间收到退出信号时，history 未改变则恢复原 server/web，history 已改变或无法确认则自动执行认证回滚；`pgdata` 不动，固定回滚点不受 prune/14 天轮转影响。

### 从 pre-INT501 版本首次升级 → 已由清库重装取代（ADR-INT-502）

> 2026-07-21 起本节旧流程（`deploy-company-bootstrap-int501.sh` 旧库 bridge 接管，RC1–RC9）**不再是公司路径**：项目所有者确认旧库数据可弃，改走下方 §8A「清库重装」。历史流程与五次 fail-closed 尝试记录见 git 历史与 `docs/内部版-发布验收记录.md` §5。bootstrap 脚本仅为存档与集成测试兼容保留，2026-10 随 legacy 清退包删除。

### 8A. 清库重装（一次性，约 1–2 小时，ADR-INT-502）

前置检查：

```bash
cd /data/jianghu
df -h /data                      # 余量 ≥ 旧库体积 3 倍
docker info >/dev/null && echo docker-ok
git status --porcelain           # 应为空；有脏文件先清理
docker compose ps                # 确认旧栈现状
```

**第 1 步 · 留档（先于一切破坏性动作，缺一不可）**：

```bash
cd /data/jianghu
mkdir -p /data/jianghu-backups
cp .env "/data/jianghu-backups/env-final-$(date +%Y%m%d)"     # 必须含 BACKUP_MASTER_SECRET——丢失即历史备份永不可解
bash scripts/backup-postgres.sh                                # 旧库最终认证加密备份，记下输出的 .backup 目录名
ls -la /data/jianghu-backups/
```

然后把「最终备份目录 + env 副本」拷回 Mac mini 异地留档（在 **Mac mini** 上执行）：

```bash
scp -r "<用户>@10.0.171.152:/data/jianghu-backups/jianghu-*.backup" ~/jianghu-company-final-backup/
scp "<用户>@10.0.171.152:/data/jianghu-backups/env-final-*" ~/jianghu-company-final-backup/
```

检查点：两地各一份最终备份 + env 副本。**未确认双份留档前不得进入第 2 步。**

**第 2 步 · 停栈**（绝不带 `-v`，此刻数据仍在卷里可反悔）：

```bash
cd /data/jianghu && docker compose down
```

**第 3 步 · 清库（唯一破坏性动作）**：

```bash
docker volume ls | grep pgdata                 # 确认卷名（预期 jianghu_pgdata）
docker volume rm jianghu_pgdata
rm -f /data/jianghu-backups/.int501-bootstrap-verified   # 清历史 marker 残迹（五次失败均未写到此步，预期本就不存在）
```

**第 4 步 · 取版本并安装新脚本**：

```bash
cd /data/jianghu
git pull --ff-only
git rev-parse --short HEAD                     # 应与验收记录 §1 的 rc10 SHA 一致
sudo install -m 0755 deploy-company-update.sh /data/jianghu/update.sh
```

**第 5 步 · 首装**：

```bash
sudo bash /data/jianghu/update.sh
```

预期输出顺序：`first install: nothing to back up` → 镜像构建 → 容器启动（entrypoint 对空库按序执行 4 条版本化迁移）→ readiness 200 → `── 7/7 首装收尾 ──` → `✓ 首装认证备份 + bootstrap marker 已写入`。

失败处置：任何一步失败都不会伤及已留档备份；旧库数据可随时恢复到隔离库取证：

```bash
bash scripts/restore-postgres.sh "/data/jianghu-backups/<最终备份>.backup" \
  --database "jianghu_restore_bootstrap_$(date +%s)" --readiness-profile pre-int501
```

### 8B. 上线验收 runbook（rc10，ADR-INT-502 简化口径）

1. **冒烟清单**：按 `docs/内部版-发布验收记录.md` §4 的 10 项逐项执行并勾选（两名真实用户 + 一名 viewer）。
2. **备份恢复真机演练**（Owner 底线，不可省）：

   ```bash
   cd /data/jianghu
   bash scripts/backup-postgres.sh                                  # 新库首次内容备份
   bash scripts/restore-postgres.sh "/data/jianghu-backups/<刚生成>.backup" \
     --database "jianghu_restore_drill_$(date +%s)"                 # 恢复到隔离库
   # 抽查隔离库行数后删演练库；把 RTO/RPO 记入验收记录 §5
   ```

3. **二次更新演练**（验证日常更新通路 + 回滚点生成）：

   ```bash
   cd /data/jianghu && sudo bash update.sh
   ```

   预期：走 existing_db=1 路径（marker 验证 → 回滚点 → no-op 迁移 → readiness）。
4. **每日备份 cron**：按 §7 配置。
5. **48–72 小时受控运行**，每日点检（约 10 分钟）：

   ```bash
   docker compose ps                                          # 三容器 healthy
   docker compose logs server --since 24h 2>&1 | grep -iE "error|fatal" | head
   cd /data/jianghu/server && npm run release:metrics -- --tenant <TENANT_ID> \
     --start <窗口起点ISO> --end <当天ISO>                     # 数字抄入验收记录 §6 表
   ls -lt /data/jianghu-backups | head -3                     # 当日新备份存在
   ```

6. **窗口结束**：`npm run release:metrics -- … --final`（rc10 阈值 = 48h / ≥20 条）退出 0，或样本不足且零失败时由项目所有者按 ADR-INT-502 人工判定 → 填验收记录 §8 签署表 → 状态改 **GO** → 待办清单 INT-502 勾 DONE → commit `release: certify internal workbuddy-first baseline (rc10)`。

readiness 失败时脚本会打印本次回滚点。确认需要回滚后显式执行（停写 → 恢复备份到新的隔离库 → 切回旧 SHA 镜像 → readiness；失败后的数据库保留取证）：

```bash
cd /data/jianghu
sudo bash deploy-company-rollback.sh /data/jianghu-rollbacks/release-TIMESTAMP-ID --confirm
```

> ⚠️ 拉的是 **main**；功能分支（如 `feat/*`）的改动必须先合 main，`update.sh` 才会部署到。
> 之后更新 detached 脚本可用：`scp deploy-company-update.sh <用户>@10.0.171.152:/data/jianghu/update.sh`。

## 已知注意项

1. **schema 变更的版本更新**：server 容器 entrypoint 只执行版本化 `prisma migrate deploy`；未纳管数据库只接受当前模型或已固化的 2026-07-12 公司旧模型，其他差异失败关闭。旧模型先在隔离恢复库完整演练 migration；不得用 `db push` 绕过。
2. **CentOS 7 内核 3.10 较老**：Docker 24.x 运行正常，但 overlay2 在极老内核上偶有兼容问题——`docker info | grep Storage` 确认是 overlay2 即可。
3. **公司代理**：若服务器走公司 HTTP 代理上外网，给 Docker 配代理（`/etc/systemd/system/docker.service.d/http-proxy.conf`）后路径 A 可用。
4. 内网纯 HTTP 下浏览器剪贴板 API 受限（复制按钮自动回退手动复制，已兼容）；若公司有内部 HTTPS/证书体系可后续加。
