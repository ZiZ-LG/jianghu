# 江湖 · Mac mini 内网部署与团队访问

> 场景：ICP 备案审批期间，先用 **Mac mini 当服务器**，在内网 / Tailscale 环境给团队做验证与持续迭代。
> 复用与公网上线**完全相同**的 Docker 栈——这里跑通的，备案过后原样搬到大陆服务器，零返工。

---

## 一、为什么这样部署（与公网上线的区别）

| | Mac mini 内网验证 | 阿里云公网上线 |
|---|---|---|
| 访问方式 | 局域网 / Tailscale（私有网络） | 公网域名 |
| 是否需备案 | **否**（不上公网） | 是（ICP 备案） |
| 备案介绍页 | **关闭**（`VITE_BEIAN_MODE` 留空，团队用完整应用） | 审核期开启 |
| 部署栈 | `docker-compose`（同一套） | `docker-compose`（同一套） |
| 数据库 | Postgres（容器，数据卷持久） | Postgres（同） |

---

## 二、首次部署（在 Mac mini 上）

**前置**：已装 Docker Desktop 并启动（图标变绿）、已装 Tailscale 并登录。

```bash
cd /Volumes/PowerData/江湖APP   # 项目目录
bash deploy-macmini.sh
```

脚本会自动：生成 `.env`（随机密钥、完整应用模式）→ `docker compose up -d --build` → 健康自检 → 打印团队访问地址。

> 首次构建约 3–8 分钟（含 npm 安装、Vite 构建）。完成后三个容器（db / server / web）应为 Up。

---

## 三、团队怎么访问

### 场景 A：办公室同一局域网
浏览器直接打开（任选其一）：
- `http://Leons-Mac-mini.local` （Bonjour 主机名，Mac/iPhone 最稳）
- `http://<Mac mini 的局域网IP>` （如 `http://10.2.206.255`，脚本会打印）

### 场景 B：远程成员（在家 / 出差 / 异地）
1. 成员设备装 **Tailscale**（手机/电脑均可，App Store 或 tailscale.com）。
2. 用**同一个 Tailscale 账号**登录（或你在 Tailscale 后台把成员邀请进同一 tailnet）。
3. 浏览器打开 `http://100.65.205.9`（Mac mini 的 Tailscale IP，脚本会打印）。

> Tailscale = 免费的零配置 VPN，设备间像在同一局域网，全程加密，**不需要公网 IP、不需要备案、不需要在路由器开端口**。这是国内家用/办公宽带（多为运营商 NAT、无公网 IP）下最省心的远程方案。

### 让团队加入你的 tailnet（推荐做法）
- 打开 Tailscale 后台 → **Settings → Invite members**，发邀请链接给团队；或
- 用 **Tailscale Share**：对这台 Mac mini 节点生成共享链接，定向分享给特定成员。
- 想用更短的地址：Tailscale 后台开启 **MagicDNS**，即可用 `http://leons-mac-mini`（无需记 IP）。

---

## 四、日常运维

```bash
cd /Volumes/PowerData/江湖APP

# 看状态 / 日志
docker compose ps
docker compose logs -f server

# 迭代更新（你改完代码后）
git pull            # 如果代码在别处改的
docker compose up -d --build

# 停止 / 重启
docker compose stop
docker compose start

# 备份数据库（建议定期）
docker compose exec db pg_dump -U jianghu jianghu > ~/jianghu-backup-$(date +%F).sql
```

> **数据安全**：Postgres 数据存在 Docker 具名卷 `pgdata`，`stop`/`restart`/重启 Mac 都不丢。只有显式 `docker compose down -v` 才会删卷——别加 `-v`。

---

## 五、开机自启（可选，让 Mac mini 当稳定服务器）

Docker Desktop：设置 → General → 勾选 **Start Docker Desktop when you sign in**。
容器：compose 里已设 `restart: unless-stopped`，Docker 一起来容器就自动恢复。
另建议：Mac mini 设为**永不睡眠**（系统设置 → 节能 / 锁屏 → 关闭自动睡眠），否则睡眠时服务不可达。

---

## 六、备案通过后，搬到公网

同一套代码，在阿里云服务器上：把 `.env` 的 `VITE_BEIAN_MODE` 留空、填入 `VITE_ICP_BEIAN` 备案号，`docker compose up -d --build` 即可。详见 [部署上线指南.md](部署上线指南.md)。
