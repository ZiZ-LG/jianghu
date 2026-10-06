# Stephen 生产入口恢复审核方案

**当前状态（2026-10-06）：项目所有者已明确“授权批准”一次共享入口恢复及失败回退；远端准备与候选验证已完成，公网尚未切换。**

此次批准同时覆盖五份私有锁文件的兼容安全补丁。CRM 应用、数据库、DNS、证书、服务器 helper 和自动发布开关继续排除；日常内容发布也不因此取得共享基础设施变更权限。

已发生的远端写入包括保存快照、配置和主站 artifact，以及创建并运行 loopback 候选容器。公网仍由原容器提供，新 Stephen 内容尚未上传或激活。最初的只读诊断和待批准方案保留在下文，并明确标为历史阶段。

## 0. 追加批准后的当前证据

| 对象 | 当前已核验状态 |
| --- | --- |
| 原公网容器 | `98060575aa75dbbb4532cef57ef4c058b4cf780f3d4bc7a519efd0553cfc1dcd`，仍提供既有 80/443，未切换。 |
| 恢复快照镜像 | `sha256:8912b80785bff8f5a59f2279d42c7031ef6d78947b4c9db28a8ee0982ce0e20b`，保留原容器可写层中的配置和文件。 |
| 候选容器 | `ee578ca66cc0a7125a6cc1337424a11896624f872433c38843448a7bef844587`；仅监听 `127.0.0.1:18086` 和 `127.0.0.1:18446`。 |
| 候选检查 | `nginx -t` 通过；34 个严格 TLS 请求通过，未跳过 CA 或域名校验。8 个既有入口的状态、正文 SHA-256 和重定向与恢复前基线一致。 |
| 既有入口对照 | `zizai.tech /` 200、`www.zizai.tech /` 301、BJJ `/` 200、梅花 `/` 302、`/app/` 200、`/privacy.html` 200、`/feedback/` 200、`/feedback/manage/` 401。重定向和受保护入口的 401 均按原基线保留。 |
| Stephen 版本 | 仍为 `ff6705c66cfde95577be21a7b4b48158d1d3d648`，无 pending；候选恢复的是该旧版本的入口，新内容尚未上传或激活。 |
| 主站内容来源 | 从已核验的宿主机备份恢复 4 个文件，未从旧镜像提取。来源为 `/home/admin/jianghu/deployments/edge-corrected-81da993d76ce422eac89227aa6e8183314812d04/main`。 |

主站 4 个文件为 `index.html`、`assets/index-CD7zswD5.js`、`assets/index-Cx5BA80u.css` 和 `beian-police.png`。准备脚本逐项检查普通文件类型、相对路径、大小及 SHA-256，并要求来源与候选的完整 manifest 相同。远端证据目录为 `/srv/jianghu/edge-recovery/20261006-hvhj0cbv`，包含 `public-home-manifest.json`、配置、快照和候选检查结果。

本机操作目录为 `/private/var/folders/bh/8x2l2lzs03x97vxpqbjyfcc40000gn/T/stephen-approved-release-20261006-hvhj0cbv`。其中 `prepare-candidate.sh` 保存完整文件校验和候选准备逻辑，`baseline-public.json` 保存 8 个既有入口基线。`handoff.json` 已记录 `productionTouched:true`、`runtimeSwitched:false`、`contentActivated:false`，与远端准备已发生、公网和内容尚未切换的边界一致。凭据和这些操作产物不进入公开仓库。

**尚未完成：** 公网容器切换及两层回读验收；私有最终提交的完整 CI；随后新 Stephen 内容的预检、上传、激活、真实浏览器验收和 finalize。候选结果不能替代这些阶段。

## 1. 追加授权前的只读诊断（历史）

以下第 1、2 节保留 2026-10-06 追加授权前的观察，服务器时间均为 UTC。“当前”“本次”均指当时的只读检查。该阶段只读取配置、进行 TLS 握手和 HTTP GET/HEAD，并查看 helper status；未修改服务器，也未取得本次恢复授权。后续批准和写入以第 0 节为准。

### 1.1 不是仅有本机代理故障

| 检查 | 观察 | 支持的结论 |
| --- | --- | --- |
| macOS 系统代理 | HTTP、HTTPS、SOCKS 均启用 `127.0.0.1:12450` | 本机存在明确代理路径。 |
| 本机 DNS | nameserver 为 `223.5.5.5`；本次普通解析超时 | 不能依赖本机直连解析完成发布核验。 |
| 经代理读取 Google DNS JSON | Stephen 的 A 记录为 `47.95.13.214` | 与私有发布注册表目标一致；该观察不等于完整 DNS 配置审计。 |
| 直连固定 IP | 本机到 `47.95.13.214:443` 连接超时 | 本机问题也涉及直连网络，不只是 DNS。 |
| 代理 CONNECT 域名 | 收到 `CN=zizai.tech`，Stephen 的 SAN 校验失败 | HTTPS 未通过，未继续取得页面。 |
| 代理 CONNECT 固定 `47.95.13.214:443`，仍保留 Stephen SNI 和域名校验 | 同样失败 | 代理对 Stephen 的域名解析不是唯一原因。 |
| 可信 SSH 后，在服务器以 `--resolve stephen.lake2ocean.top:443:127.0.0.1` 请求 | 同样收到 `CN=zizai.tech`，SAN 校验失败 | 服务器本机即可复现错误，故共享 HTTPS 入口必须检查。 |

只读 SSH 已成功：使用已有 `~/.ssh/id_ed25519`、已有 `known_hosts`、`StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`、`BatchMode=yes`，通过本机 SOCKS 代理连接注册表中的 `admin@47.95.13.214`。旧记录提到的专用 identity 文件在本机不存在；未创建或替换认证材料。

### 1.2 当前边缘容器与注册表不一致

容器：`zizai-site`。

- 镜像标签：`zizai-site:20260923180400-privacy`。
- 镜像 ID：`sha256:008f51ca1c5e17f6ec1e3cbfa1126bc25e98ef3fd1279d15db869e05db8abe9f`。
- 容器创建：`2026-09-23T18:05:18.250370105Z`；启动：`2026-09-23T18:05:18.620224926Z`。
- 端口：宿主机 `80 → 80/tcp`、`443 → 443/tcp`；restart policy 为 `unless-stopped`。
- 网络：`bridge`、`meihua-feedback-net`。当前未加入 `jianghu_default`。
- 挂载仅有 `/home/admin/letsencrypt → /etc/letsencrypt:ro` 和 `/home/admin/zizai-site/certbot-www → /var/www/certbot:rw`。
- 容器内 `/srv/stephen` 不存在；`/usr/share/nginx/jianghu/index.html` 也不存在。

`nginx -T` 展开的当前配置仅含：

- `/etc/nginx/conf.d/default.conf`：`zizai.tech`、`www.zizai.tech`、`bjj.zizai.tech`。
- `/etc/nginx/conf.d/meihua.conf`：`meihua.zizai.tech`。
- HTTPS 的 `default_server` 为 `zizai.tech _`，使用 `/etc/letsencrypt/live/zizai.tech/fullchain.pem`。
- 未找到 Stephen、`lake2ocean.top`、`www.lake2ocean.top` 或 `crm.lake2ocean.top` 的 server block。

配置展开与本机 TLS 结果一致：Stephen 请求落入默认站点。尚未追查是哪次操作造成缺失，容器创建时间不能证明责任或具体变更原因。

现有 [发布注册表](../../deploy/public-site-targets.json) 仍要求 `/srv/jianghu/stephen → /srv/stephen:ro`，Nginx root 为 `/srv/stephen/current`。[Stephen Nginx 配置](../../deploy/stephen.nginx.conf) 与 [服务器 helper](../../deploy/stephen-remote-release.sh) 也依赖该路径。现在缺少这个运行条件，发布器必须失败关闭。

### 1.3 证书存在，当前不需要重新签发

以下仅读取了 `fullchain.pem` 的公开证书元数据，未读取私钥。

| `/home/admin/letsencrypt/live/` 下的证书目录 | SAN | 有效期（UTC） |
| --- | --- | --- |
| `stephen.lake2ocean.top` | `stephen.lake2ocean.top` | 2026-08-21 16:16:06 至 2026-11-19 16:16:05 |
| `lake2ocean.top` | `lake2ocean.top`、`www.lake2ocean.top` | 2026-08-20 13:17:14 至 2026-11-18 13:17:13 |
| `crm.lake2ocean.top` | `crm.lake2ocean.top` | 2026-08-20 14:01:03 至 2026-11-18 14:01:02 |
| `zizai.tech` | `zizai.tech`、`www.zizai.tech` | 2026-09-26 18:19:18 至 2026-12-25 18:19:17 |
| `bjj.zizai.tech` | `bjj.zizai.tech` | 2026-09-30 18:20:50 至 2026-12-29 18:20:49 |
| `meihua.zizai.tech` | `meihua.zizai.tech` | 2026-09-04 09:27:52 至 2026-12-03 09:27:51 |

截至核查日均未过期。公开证书存在不证明对应私钥可读、匹配或完整链最终可用；这部分由候选配置的 `nginx -t` 及严格 TLS 实测验证，不通过时停止，不自动申请或改证书。

### 1.4 内容和其他服务的当前边界

Stephen helper status：

```text
current_sha=ff6705c66cfde95577be21a7b4b48158d1d3d648
previous_sha=81da993d76ce422eac89227aa6e8183314812d04
pending_source_sha=none
pending_lease_id=none
```

这是版本指针状态，不代表该内容正在被公网边缘提供。

服务器本机固定 loopback、保留正确域名校验的结果：

| 入口 | 本次结果 |
| --- | --- |
| Stephen、`lake2ocean.top`、`crm.lake2ocean.top` | SAN mismatch；未取得 HTTP 页面 |
| `zizai.tech` | TLS 通过，HTTP 200 |
| `bjj.zizai.tech` | TLS 通过，HTTP 200 |
| `meihua.zizai.tech` | TLS 通过，HTTP 302；重定向是本次观察，不擅自改为 200 |

`jianghu-web-1`、`jianghu-server-1`、`jianghu-db-1` 正在运行。前两者属于 `jianghu_default`；web 发布于宿主机 `127.0.0.1:18084`。本机 `http://127.0.0.1:18084/api/health` 返回 200。这只支持现有上游健康端点可响应，不证明登录、数据库业务或全部 CRM 功能通过。

主站当前容器内无注册表所指 artifact，且本次未在 `/home/admin/jianghu/deployments` 找到 `edge-public-home-*` 目录。旧镜像 `zizai-site:public-security-filing-corrected-81da993` 仍存在，ID 为 `sha256:8b3a525a702dd22275c33e9603fcde59c2bd65cff091ebcaa412c4f5551576ce`。它是可检查的恢复候选，尚未提取、核对或批准其主站内容；不能直接作为恢复完成证据。

## 2. 只读诊断中的配置来源与恢复约束（历史）

当前容器没有挂载 Nginx 配置目录。宿主机 `/home/admin/zizai-site/nginx.conf`、`nginx-prod.conf`、`nginx-review-bridge.conf` 的时间均早于本轮上线，且所查旧配置不含 Stephen。它们不是已确认的当前配置源，不能拿来覆盖运行配置。

`docker diff zizai-site` 明确显示 `default.conf` 被修改、`meihua.conf` 为新增文件。因此当前配置既不是一个可直接修改的宿主机挂载，也不能仅凭镜像标签复原。直接按现有镜像重建将丢失这些容器可写层变更。

本次读取到的配置 SHA-256：

```text
/etc/nginx/nginx.conf
4dee6b0c7c8278f6a9b827261c25d3215c9ea8955e41ff7fe3eabdd5297edce7
/etc/nginx/conf.d/default.conf
8868759ae8cb591211b1ec759f55d25b1cb94ba6493bb3a9f00b606c41084ad4
/etc/nginx/conf.d/meihua.conf
61eed22abda2fbbb6d0f5e763d823e672ed3f965002c113e0a7a1f71c35a3a3a
```

`meihua.conf` 的容器内修改时间为 2026-10-06 04:47。执行前必须重新读取哈希并协调其他运维工作；如配置发生变化，停止并以最新现状重新准备，不能覆盖新变更。

Nginx reload 可以重新加载配置，但不能给现有 Docker 容器增加缺失的 bind mount。恢复既有 Stephen 发布路径至少需要一次边缘容器重建或等效的、另行设计的运行时变更。本方案采用保留当前镜像与配置的受控重建，不通过复制网站文件到容器可写层绕过发布指针。

## 3. 已批准的最小恢复范围

| 选择 | 能恢复什么 | 对此次内容发布的影响 |
| --- | --- | --- |
| 仅恢复 Stephen server block 与只读挂载 | 可恢复 Stephen 的旧版本入口；仍需重建共享容器并保留其他配置 | 主站与 CRM 仍失败，既有发布器的共享站点检查仍会阻断。不得删除检查来强行发布。 |
| 恢复缺失的三组入口：Stephen、主站（含 www）、CRM | 修复同一共享边缘的已确认缺口 | 已批准为一次独立基础设施维护；公网恢复验证通过后，才继续内容发布。 |

项目所有者追加授权精确限定为：恢复 `zizai-site` 的上述域名路由、Stephen 只读挂载、主站已核对静态 artifact，以及连接现有 CRM 上游所需的边缘网络；保留现有 `zizai.tech`、BJJ、梅花及反馈服务的内容、配置和网络。不得修改 CRM 应用、数据库、证书、DNS、helper 或内容发布指针。

主站宿主机备份和 CRM 边缘路由已用于候选验证，结果见第 0 节。旧镜像仅是只读诊断阶段考虑过的来源，未被用于本次主站恢复。后续若材料或配置发生变化，应停止并重新核对，不能扩大到重建主站或修改 CRM。

## 4. 已批准的执行顺序与进度

第 1–5 步已完成远端准备和 loopback 候选验证；第 6–8 步尚未完成。原公网容器保留运行。

1. **已完成准备：保存并复核恢复基线。** 重新读取 helper status，要求无 pending。记录当前容器 ID、镜像 ID、启动参数、端口、restart policy、两项挂载、`bridge` 与 `meihua-feedback-net` 的连接。保存完整运行配置、所需静态文件清单与哈希；敏感配置仅留在权限受限的服务器备份目录，不进入 Git 或聊天。保存证书路径与公开指纹，不复制私钥到仓库。记录上述三站当前 HTTPS 行为与梅花反馈链路，避免用根页 302 代替反馈链路验收。

2. **已完成准备：保留现有容器作为第一回滚对象。** 不先删除它，不清理现有镜像和版本目录。恢复清单必须足以在不依赖新配置的情况下重新启动原容器并恢复两个已有网络。单有当前镜像 ID 不够，因为配置存在容器可写层变更。

3. **已完成准备：准备独立候选配置与 artifact。** 从当前容器导出完整有效配置，原样保留 `default.conf`、`meihua.conf` 及其依赖；新增独立的 Stephen、主站、CRM 配置文件。Stephen 使用仓库中的已审核模板，指向现有 `/srv/stephen/current`。候选配置已放在本次版本化宿主机目录并整体只读挂载；后续修改沿用统一来源，本次未重构其他站点规则。

4. **已完成准备：核对主站备份与 CRM 路由。** 从第 0 节所列宿主机备份恢复主站 4 个文件，逐项比对完整 manifest；不从旧镜像提取，也不从 CRM 的 `app/dist` 猜测主站。CRM 配置与既有路由核对，验证 `/` 和 `/api/` 的目的地；只为边缘候选连接现存 `jianghu_default` 网络，未重建 web、server 或 db，也未调整其端口或配置。

5. **已完成准备：在不占用公网端口的候选容器中验证。** 基于第 0 节的恢复快照镜像，使用复制后的完整配置，保留原有证书与 ACME 挂载、两个网络和必要启动选项，增加 `/srv/jianghu/stephen:/srv/stephen:ro`、经核对的主站静态目录以及 CRM 所需网络。候选端口只绑定 loopback 的空闲端口。运行 `nginx -t`，验证严格 TLS、站点身份、Stephen 旧 SHA、主站内容和现有 CRM 健康端点；候选测试必须能够区分连接的是候选端口而非当前公网容器。

6. **待执行：受控替换共享边缘容器。** 仅在上述验证全部通过后，安排短维护窗口，让候选接管既有 80/443，保留原容器用于快速恢复。切换不是已证明的无中断操作，不承诺零停机。不得使用只取原镜像标签、忽略当前配置和网络的简化重建命令。

7. **待执行：完成两层验收。** 先在服务器 loopback 按每个域名严格校验，再从外部经过正常 TLS 校验访问。验证 Stephen、主站、CRM、`zizai.tech`、`www.zizai.tech`、BJJ、梅花及已有反馈路径；确认重定向、静态资源、连接方式和关键页面行为保留。Stephen `/release-id.json` 应仍为 `ff6705c66cfde95577be21a7b4b48158d1d3d648`；`/healthz-stephen` 成功、`/api/` 隔离，helper 无 pending。任何一个原有服务退化都视为失败。

8. **待执行：恢复后再做内容发布。** 把已核实运行拓扑同步到私有注册表/运维记录，然后使用桥接后的既有发布器重新做完整预检。基础设施恢复不替代当前精确内容 SHA 的发布检查、浏览器验收或 finalize；不得在修复入口时顺便切换新内容。

## 5. 回滚与停止条件

- 候选检查失败：删除或停止候选须按该次批准范围处理，当前公网容器保持运行，不切流。
- 切换后任何原有服务失败：停止候选并恢复保留的原容器及其原端口、网络和配置。回滚目标是本次修复前的真实现状：`zizai.tech`、BJJ、梅花继续服务，Stephen/主站/CRM 的原缺陷仍可能存在。不要把回滚表述为所有站点恢复正常。
- 原容器和备份未经完整恢复验证不得清理。证书目录、CRM 数据卷和 Stephen 版本目录不在回滚修改范围内。
- 当前尚未启动新内容发布事务，不能使用 Stephen helper 的 lease 回滚来代替共享入口回滚。若另一个任务出现新的 pending 或更改了共享配置，先停止并协调，再重新取基线。
- 证书、原主站 artifact 或 CRM 路由核对失败时停止，不申请新证书、不改 DNS、不扩大应用范围。
- 所有工具保持正常 CA/SAN 校验与已有 SSH 主机信任；不以 `curl -k`、`StrictHostKeyChecking=no` 或删除其他站点冒烟条件绕过失败。

## 6. 批准边界与后续交付

最初的网站发布授权排除了 Nginx 和容器修改，因此只读诊断后先形成了本恢复方案。项目所有者随后明确“授权批准”共享入口恢复、失败回退和兼容依赖补丁；这是新的授权，不能把前述历史阶段改写成当时已经获批。

本次恢复批准包括一次共享边缘维护窗口、候选容器与配置准备、补齐缺失挂载和三组域名入口、连接现有 CRM 上游、经核对的主站备份恢复，以及失败时恢复原容器。CRM 应用、数据库、DNS、证书、helper 和自动发布开关继续排除。日常 Stephen 发布器仍只操作静态内容事务，不负责基础设施恢复。

已完成的依赖补丁、测试日期修复及本地验证见 [桥接记录](stephen-public-release-bridge.md)。新增 14 项无网络共享站点检查后，已运行正确的 Stephen 工作区命令 `npx vitest run --root stephen`；当前 11 个文件、221 项测试全部通过，用时 82.32 秒。

后续先完成最终提交的 CI 和公网恢复验收，再继续公开网站内容发布。只有新内容完成正式 finalize、版本回读和浏览器检查，才记录网站部署完成；只有既有入口在切换后通过两层校验，才记录共享入口恢复完成。
