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

服务器上 `/data/jianghu/update.sh`（源已入库 = 仓库根 `deploy-company-update.sh`）：加密备份库（目录/保留天数由 `.env` 配置）→ `git pull`（main）→ `docker compose up -d --build` 滚动更新 → readiness 自检 → 清理悬空镜像。`pgdata` 不动。

### 从 pre-INT501 版本首次升级（只做一次）

旧 `/data/jianghu/update.sh` 和旧仓库还没有认证备份/恢复脚本，不能先 `git pull` 或 build。先在开发机把 bridge 与所需脚本按原目录打包并上传到服务器临时目录（bundle 内不得包含 `.env`）：

```bash
mkdir -p /tmp/int501-bundle/scripts/lib
cp deploy-company-bootstrap-int501.sh /tmp/int501-bundle/
cp scripts/backup-postgres.sh scripts/restore-postgres.sh /tmp/int501-bundle/scripts/
cp scripts/lib/backup-crypto.sh scripts/lib/backup-lock.sh \
  scripts/lib/deploy-common.sh scripts/lib/postgres-db-safety.sh \
  scripts/lib/bootstrap-marker.sh /tmp/int501-bundle/scripts/lib/
scp -r /tmp/int501-bundle <用户>@10.0.171.152:/tmp/
```

在服务器运行一次 bridge。它会为旧 `.env` 生成独立 64-hex master secret，向 `/data/jianghu-backups` 发布认证加密备份，真实恢复到随机 `jianghu_restore_bootstrap_*`，验证关键表，再删除隔离库；全部成功后才写 marker：

```bash
sudo bash /tmp/int501-bundle/deploy-company-bootstrap-int501.sh
test -s /data/jianghu-backups/.int501-bootstrap-verified
```

marker 不是“文件存在即可”的开关：日常更新会严格校验格式、Compose project、运行中生产库名和所引用的同目录备份，并用当前独立 master secret 重新认证 metadata 与密文；任一不符都在 `git pull`/build 前停止。

只有 marker 存在后，才允许拉取 INT-501 代码并替换 detached 更新脚本：

```bash
cd /data/jianghu
git pull --ff-only
sudo cp deploy-company-update.sh /data/jianghu/update.sh
sudo chmod 700 /data/jianghu/update.sh
sudo bash /data/jianghu/update.sh
```

任何一步失败都停止，不删除 `pgdata`，也不使用 `db push` 绕过。bootstrap 可安全重跑；日常更新脚本会在既有数据部署上强制检查 marker。

```bash
cd /data/jianghu && sudo bash update.sh
```

> ⚠️ 拉的是 **main**；功能分支（如 `feat/*`）的改动必须先合 main，`update.sh` 才会部署到。
> 已经完成上述 bootstrap 的新部署，之后更新 detached 脚本可用：`scp deploy-company-update.sh <用户>@10.0.171.152:/data/jianghu/update.sh`。

## 已知注意项

1. **schema 变更的版本更新**：server 容器 entrypoint 启动时自动 `prisma migrate deploy`；历史 `db push` schema 只有与 baseline 完全一致才会被接管，任何差异都会失败关闭。先按 `docs/内部版-备份恢复手册.md` 完成加密备份和隔离恢复演练，不得用 `db push` 绕过。
2. **CentOS 7 内核 3.10 较老**：Docker 24.x 运行正常，但 overlay2 在极老内核上偶有兼容问题——`docker info | grep Storage` 确认是 overlay2 即可。
3. **公司代理**：若服务器走公司 HTTP 代理上外网，给 Docker 配代理（`/etc/systemd/system/docker.service.d/http-proxy.conf`）后路径 A 可用。
4. 内网纯 HTTP 下浏览器剪贴板 API 受限（复制按钮自动回退手动复制，已兼容）；若公司有内部 HTTPS/证书体系可后续加。
