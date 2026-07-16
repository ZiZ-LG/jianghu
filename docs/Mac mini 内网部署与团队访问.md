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

脚本会自动：生成/保留 `.env`（含独立备份密钥）→ 若有现有数据库则先做加密备份（失败即停止）→ `docker compose up -d --build` → readiness 自检 → 打印团队访问地址。

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

## 三·五、让团队走 HTTPS（强烈推荐）

纯 HTTP（`http://Leons-Mac-mini.local` / Tailscale IP）被浏览器判定为**非安全上下文**，会带来两个真实问题：
- 复制按钮（如「🔌 接入 AI」里的令牌/配置复制）**静默失败**——`navigator.clipboard` 仅在 HTTPS/localhost 可用；
- 登录**密码明文传输**（同 tailnet 内已加密，但浏览器仍会标记不安全、且不利于将来搬公网）。

用 **Tailscale 自带 HTTPS** 一键解决（证书由 Tailscale 自动签发，`*.ts.net`，**零成本、不开端口、不上公网，仅 tailnet 内可达**）：

```bash
cd /Volumes/PowerData/江湖APP
bash setup-tailscale-https.sh
```

> **唯一手动前置（owner 在网页后台点一次，整个 tailnet 只需开这一次）**：
> 登录 [https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) →
> 找到 **HTTPS Certificates** → 点 **Enable HTTPS**（MagicDNS 也要是开的）。
> 没开时脚本会即时检测到并打印这段指引；开了之后脚本全自动（签证 → `tailscale serve` 反代到 web 容器 → 自检）。

完成后团队改走：

```
https://leons-mac-mini.tail7ac96b.ts.net
```

- 原 HTTP 入口（局域网 `http://Leons-Mac-mini.local`、未装 Tailscale 时）**仍然可用**，二者并存。
- 撤销 HTTPS、回到纯 HTTP：`bash setup-tailscale-https.sh reset`
- 原理：`tailscale serve` 把 `https://<本机>.<tailnet>.ts.net`(:443) 反向代理到本机 `:80` 的 web 容器，应用用同源相对 `/api`，全程透明、无需改代码或重建镜像。

---

## 四、日常运维

```bash
cd /Volumes/PowerData/江湖APP

# 看状态 / 日志
docker compose ps
docker compose logs -f server

# 迭代更新（推荐；脚本检测既有卷并先加密备份，成功后才 build/up）
bash deploy-macmini.sh

# 停止 / 重启
docker compose stop
docker compose start

# 加密备份与隔离恢复演练
bash scripts/backup-postgres.sh
bash scripts/restore-postgres.sh "$HOME/JianghuBackups/<备份>.backup" --database jianghu_restore_drill
```

详细的密钥保管、校验、`--replace` 和清理步骤见 [内部版-备份恢复手册.md](内部版-备份恢复手册.md)。禁止把明文 dump 留在磁盘，也禁止直接恢复覆盖生产数据库。

> **数据安全**：Postgres 数据存在 Docker 具名卷 `pgdata`，`stop`/`restart`/重启 Mac 都不丢。只有显式 `docker compose down -v` 才会删卷——别加 `-v`。

---

## 五、稳定性 / 自愈（让 Mac mini 当稳定服务器）

目标：团队随时可达，掉线能自动恢复。已配好的几层：

| 层 | 设置 | 状态 |
|---|---|---|
| 永不睡眠 | `sudo pmset -a sleep 0`（睡眠时服务不可达） | ✅ 已配 `sleep 0` |
| 断电后自启 | `sudo pmset -a autorestart 1` | ✅ 已开 |
| Docker 引擎自启 | Docker Desktop → Settings → General → AutoStart | ✅ 已开 |
| **Docker 开机拉起** | 看门狗 LaunchAgent（见下） | ✅ 已装 |
| 容器自恢复 | compose 里 `restart: unless-stopped` | ✅ 已配 |

**看门狗 LaunchAgent**（登录时 + 每 5 分钟后台 `open -a Docker`，已运行则无操作；Docker 一起来引擎自启 + 容器重启策略接力把栈带回）：

```bash
cp com.jianghu.watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jianghu.watchdog.plist
# 卸载： launchctl bootout gui/$(id -u)/com.jianghu.watchdog
```

> 为什么不做「检查栈+自动 `docker compose up`」的完整看门狗：项目在外置卷 `/Volumes/PowerData`，macOS TCC 禁止 launchd 访问外置卷（`Operation not permitted`），且 launchd 的 PATH 没有 `docker`。故只 `open -a Docker`（不碰外置卷、不依赖 docker 路径），靠引擎自启 + 容器重启策略接力。

**⚠️ 唯一前提 = 自动登录**：用户级 LaunchAgent 与 Docker 都要**登录后**才跑。本机 **FileVault 已开启**（保护敏感干系人数据，PIPL 红线，建议保持）→ macOS 因此**禁止自动登录**。所以：
- **无人值守重启后，机器会停在 FileVault 解锁/登录界面，在有人登录前栈不会起**（团队会暂时不可达）。
- 重启很少见（已永不睡眠）。真重启了，**有人登录一次**即触发全链自愈，无需手动敲 docker 命令。
- 不建议为图省事关掉 FileVault 换自动登录——敏感数据加密更重要。

手动一键恢复（任何时候栈掉了，登录后跑）：`cd /Volumes/PowerData/江湖APP && open -a Docker && sleep 20 && docker compose up -d`

---

## 六、备案通过后，搬到公网

同一套代码，在阿里云服务器上：把 `.env` 的 `VITE_BEIAN_MODE` 留空、填入 `VITE_ICP_BEIAN` 备案号，`docker compose up -d --build` 即可。详见 [部署上线指南.md](部署上线指南.md)。
