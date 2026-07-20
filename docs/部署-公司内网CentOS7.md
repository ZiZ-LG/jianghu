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

## 8. 版本更新（就地·日常）

服务器上 `/data/jianghu/update.sh`（源已入库 = 仓库根 `deploy-company-update.sh`）：持久化当前运行 SHA → `git pull`（main）→ 校验 bootstrap/认证备份 → 固定旧 server/web 镜像和数据库回滚点 → 构建候选镜像但不替换容器 → 停写并单独执行版本化 migration → 成功后才切换容器和执行 readiness。migration 失败或停服区间收到退出信号时，history 未改变则恢复原 server/web，history 已改变或无法确认则自动执行认证回滚；`pgdata` 不动，固定回滚点不受 prune/14 天轮转影响。

### 从 pre-INT501 版本首次升级（只做一次）

RC7 的 bridge 必须从完整候选仓库运行，因为它要构建候选 server 镜像并在隔离恢复库执行真实 migration。`git pull` 只更新工作树，不会重建容器或改数据库；拉取后禁止手工执行 Compose 更新，必须先完成下列链路：

```bash
cd /data/jianghu
git pull --ff-only
git rev-parse --short HEAD
sudo bash deploy-company-bootstrap-int501.sh && \
  sudo install -m 0755 deploy-company-update.sh /data/jianghu/update.sh && \
  sudo test -s /data/jianghu-backups/.int501-bootstrap-verified && \
  echo "INT-501 marker OK" && \
  sudo bash /data/jianghu/update.sh
```

bridge 会先拒绝 tracked 修改和 Docker 构建输入中的未跟踪文件，再为旧 `.env` 生成独立 64-hex master secret，发布认证加密备份，恢复到随机 `jianghu_restore_bootstrap_*`，比较源/恢复表签名，再让候选镜像完成 migration、当前 schema 零漂移和严格 readiness；隔离库验证删除后才写 marker。marker 严格绑定 Compose project、生产库、认证备份和本次候选 commit。只有 bridge migration 已成功完成才解除 commit 绑定；仅出现部分 `_prisma_migrations` 记录时仍要求原候选 commit。后续日常更新仍重验 marker 身份与认证备份。

如果误先运行了旧版 `update.sh`，并在 `OUTBOUND_ALLOWED_HOSTS is missing a value` 处停止：该失败发生在 Compose 构建和数据库迁移之前，旧容器继续运行。此时不要重跑旧脚本，也不要执行 `down -v`；先拉取包含环境迁移的 bridge，再完成一次 bootstrap 和新版脚本安装：

```bash
cd /data/jianghu
git pull --ff-only
sudo bash deploy-company-bootstrap-int501.sh && \
  sudo install -m 0755 deploy-company-update.sh /data/jianghu/update.sh && \
  sudo test -s /data/jianghu-backups/.int501-bootstrap-verified && \
  sudo bash /data/jianghu/update.sh
```

bridge 仅在旧 `.env` 缺少字段时补入默认公网白名单 `open.feishu.cn,agent.qcc.com,openapi.biji.com,qyapi.weixin.qq.com` 和空的内网白名单；不会覆盖已有部署值。自定义 AI / MCP 主机仍需运维显式加入白名单。

如果 bootstrap 输出 `unknown option '-pbkdf2'`，说明服务器仍是 CentOS 7/OpenSSL 1.0.2，失败发生在备份加密阶段；RC3 已兼容该环境。如果输出 `restored database failed required table readiness`，说明备份、解密和 `pg_restore` 已成功，但旧 RC 对 pre-INT501 schema 的识别仍不匹配。公司旧库只读盘点确认其没有后期新增的 `SyncRun`；RC5 改为核验初始稳定核心表，并要求生产库与隔离恢复库的有序 `public` 表清单签名完全相同。预推送审查随后发现，仅验证恢复仍不足：41 表旧库不能直接被当前 baseline 接管。RC6 因此把 2026-07-12 公司旧 schema 固化为只读兼容基线，并要求候选镜像先在隔离恢复库完整执行版本化 migration、迁移后精确无漂移，marker 还必须绑定当前 Git commit。正式更新会先构建镜像，再停写并单独执行 migration；只有成功才切换候选容器。若失败时 migration history 未改变，脚本恢复原 server/web；若 history 已改变或无法确认，脚本自动执行认证回滚，绝不让旧代码连接新 schema。拉取 RC7 后重跑 bootstrap；无需升级系统 OpenSSL，也不要删除 `.env` 中已经生成的 `BACKUP_MASTER_SECRET`：

```bash
cd /data/jianghu
git pull --ff-only
git rev-parse --short HEAD
sudo bash deploy-company-bootstrap-int501.sh && \
  sudo install -m 0755 deploy-company-update.sh /data/jianghu/update.sh && \
  sudo test -s /data/jianghu-backups/.int501-bootstrap-verified && \
  echo "INT-501 marker OK" && \
  sudo env RUNTIME_SHA_OVERRIDE=102988ad43907c5733bac0f5aacce69be395fede bash /data/jianghu/update.sh
```

上面的 `RUNTIME_SHA_OVERRIDE` 仅用于本次已手工把工作树从 `102988a` 拉到后续 RC、但旧容器仍运行 `102988a` 的恢复场景；脚本会把它原子写入 `/data/jianghu-rollbacks/.runtime-sha`。部署成功后该文件自动更新为新 SHA，后续日常更新不再传 override。

任何一步失败都停止，不删除 `pgdata`，也不使用 `db push` 绕过。首次 bridge migration 成功完成前，更新脚本会强制检查 marker、认证备份和 marker 绑定的 Git commit；若 bootstrap 后又拉到了新 commit，必须在新 commit 上重跑 bootstrap。仅创建 migration history 或留下未完成 bridge 记录时不会放宽；事务回滚且 schema 仍精确匹配批准模型时，脚本会把该 bridge 记录安全登记为 rolled back 后重放。唯一索引前会检查同步锚和企微绑定冲突；bridge 事务内只自动回填租户内唯一同名的负责人稳定 ID，重名/无效稳定 ID 会让整个 bridge 回滚并失败关闭。bridge 成功后，后续日常更新只重验 marker 身份与认证备份，不再要求 one-time marker 跟随每个新 commit。

```bash
cd /data/jianghu && sudo bash update.sh
```

readiness 失败时脚本会打印本次回滚点。确认需要回滚后显式执行（命令会停写、恢复备份到新的隔离库、切回旧 SHA 对应的镜像，再跑 readiness，并把 `.runtime-sha` 同步恢复为 manifest 中的运行 SHA；工作树保留当前 `main` 便于继续 fast-forward，失败后的数据库保留取证）：

```bash
cd /data/jianghu
sudo bash deploy-company-rollback.sh /data/jianghu-rollbacks/release-TIMESTAMP-ID --confirm
```

正式发布前须在隔离 Compose project 完成一次同版本演练，并把回滚点、旧/新镜像 digest、恢复库、RTO/RPO 和 smoke 结果写入 `docs/内部版-发布验收记录.md`。

> ⚠️ 拉的是 **main**；功能分支（如 `feat/*`）的改动必须先合 main，`update.sh` 才会部署到。
> 已经完成上述 bootstrap 的新部署，之后更新 detached 脚本可用：`scp deploy-company-update.sh <用户>@10.0.171.152:/data/jianghu/update.sh`。

## 已知注意项

1. **schema 变更的版本更新**：server 容器 entrypoint 只执行版本化 `prisma migrate deploy`；未纳管数据库只接受当前模型或已固化的 2026-07-12 公司旧模型，其他差异失败关闭。旧模型先在隔离恢复库完整演练 migration；不得用 `db push` 绕过。
2. **CentOS 7 内核 3.10 较老**：Docker 24.x 运行正常，但 overlay2 在极老内核上偶有兼容问题——`docker info | grep Storage` 确认是 overlay2 即可。
3. **公司代理**：若服务器走公司 HTTP 代理上外网，给 Docker 配代理（`/etc/systemd/system/docker.service.d/http-proxy.conf`）后路径 A 可用。
4. 内网纯 HTTP 下浏览器剪贴板 API 受限（复制按钮自动回退手动复制，已兼容）；若公司有内部 HTTPS/证书体系可后续加。
