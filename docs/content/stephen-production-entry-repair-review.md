# Stephen 生产入口恢复审核方案

状态：**待项目所有者批准，未执行修复**。核查日期：2026-10-06（下列服务器时间为 UTC）。

当前不能部署新 Stephen 内容。服务器共享边缘容器已缺少 Stephen、主站和 CRM 的域名入口，且没有挂载 Stephen 版本目录。只切换网站版本指针不能恢复访问。建议另行批准一次共享入口恢复，再继续既有发布器的预检、发布与浏览器验收。

本轮只执行了读取、TLS 握手、HTTP GET/HEAD 和 helper status。没有改 Nginx、容器、证书、DNS、CRM、数据库或网站版本指针；没有申请新证书、上传产物或执行发布。没有读取私钥内容，也没有关闭 TLS 或 SSH 主机校验。

## 1. 已确认的事实

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

## 2. 配置从哪里来，为什么不能只 reload

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

## 3. 最小范围选择

| 选择 | 能恢复什么 | 对此次内容发布的影响 |
| --- | --- | --- |
| 仅恢复 Stephen server block 与只读挂载 | 可恢复 Stephen 的旧版本入口；仍需重建共享容器并保留其他配置 | 主站与 CRM 仍失败，既有发布器的共享站点检查仍会阻断。不得删除检查来强行发布。 |
| 恢复缺失的三组入口：Stephen、主站（含 www）、CRM | 修复同一共享边缘的已确认缺口 | 推荐作为独立基础设施批次；所有恢复证据通过后，才继续内容发布。 |

推荐授权应精确限定为：恢复 `zizai-site` 的上述域名路由、Stephen 只读挂载、主站已核对静态 artifact，以及连接现有 CRM 上游所需的边缘网络；保留现有 `zizai.tech`、BJJ、梅花及反馈服务的内容、配置和网络。不得修改 CRM 应用、数据库、证书、DNS、helper 或内容发布指针。

主站 artifact 尚待核对，CRM 反向代理也需先核实既有历史路由。如果任一恢复材料无法确认，不扩大到重建主站或修改 CRM；该批次停止并报告缺口。用户若只批准 Stephen，则只完成该范围并明确保留内容发布阻断。

## 4. 待批准后的具体执行顺序

以下是审核方案，尚未执行任何步骤中的生产写入。

1. **冻结共享入口变更并保存恢复基线。** 重新读取 helper status，要求无 pending。记录当前容器 ID、镜像 ID、启动参数、端口、restart policy、两项挂载、`bridge` 与 `meihua-feedback-net` 的连接。保存完整运行配置、所需静态文件清单与哈希；敏感配置仅留在权限受限的服务器备份目录，不进入 Git 或聊天。保存证书路径与公开指纹，不复制私钥到仓库。记录上述三站当前 HTTPS 行为与梅花反馈链路，避免用根页 302 代替反馈链路验收。

2. **保留现有容器作为第一回滚对象。** 不先删除它，不清理现有镜像和版本目录。恢复清单必须足以在不依赖新配置的情况下重新启动原容器并恢复两个已有网络。单有当前镜像 ID 不够，因为配置存在容器可写层变更。

3. **准备独立候选配置与 artifact。** 从当前容器导出完整有效配置，原样保留 `default.conf`、`meihua.conf` 及其依赖；新增独立的 Stephen、主站、CRM 配置文件。Stephen 使用仓库中的已审核模板，指向现有 `/srv/stephen/current`。候选配置建议放在版本化的宿主机目录并整体只读挂载，后续修改要进入统一来源；本次不同时重构其他站点规则。

4. **补足两个待验证材料。** 从保留的旧主站镜像中提取候选静态 artifact 到独立准备区，核对标题、导航顺序、CRM 链接和备案标记，确认其恢复范围后再使用；不从 CRM 的 `app/dist` 猜测主站。CRM 配置须与原路由核对，验证 `/` 和 `/api/` 的既有目的地，只在边缘容器加入现存 `jianghu_default` 网络，不重建 web、server 或 db，不调整它们的端口或配置。

5. **在不占用公网端口的候选容器中验证。** 基于当前精确镜像，使用复制后的完整配置，保留原有证书与 ACME 挂载、两个网络和必要启动选项，增加 `/srv/jianghu/stephen:/srv/stephen:ro`、经核对的主站静态目录以及 CRM 所需网络。候选端口只绑定 loopback 的空闲端口。运行 `nginx -t`，验证严格 TLS、站点身份、Stephen 旧 SHA、主站内容和现有 CRM 健康端点；候选测试必须能够区分连接的是候选端口而非当前公网容器。

6. **受控替换共享边缘容器。** 仅在上述验证全部通过后，安排短维护窗口，让候选接管既有 80/443，保留原容器用于快速恢复。切换不是已证明的无中断操作，不承诺零停机。不得使用只取原镜像标签、忽略当前配置和网络的简化重建命令。

7. **完成两层验收。** 先在服务器 loopback 按每个域名严格校验，再从外部经过正常 TLS 校验访问。验证 Stephen、主站、CRM、`zizai.tech`、`www.zizai.tech`、BJJ、梅花及已有反馈路径；确认重定向、静态资源、连接方式和关键页面行为保留。Stephen `/release-id.json` 应仍为 `ff6705c66cfde95577be21a7b4b48158d1d3d648`；`/healthz-stephen` 成功、`/api/` 隔离，helper 无 pending。任何一个原有服务退化都视为失败。

8. **恢复后再做内容发布。** 把已核实运行拓扑同步到私有注册表/运维记录，然后使用桥接后的既有发布器重新做完整预检。基础设施恢复不替代当前精确内容 SHA 的发布检查、浏览器验收或 finalize；不得在修复入口时顺便切换新内容。

## 5. 回滚与停止条件

- 候选检查失败：删除或停止候选须按该次批准范围处理，当前公网容器保持运行，不切流。
- 切换后任何原有服务失败：停止候选并恢复保留的原容器及其原端口、网络和配置。回滚目标是本次修复前的真实现状：`zizai.tech`、BJJ、梅花继续服务，Stephen/主站/CRM 的原缺陷仍可能存在。不要把回滚表述为所有站点恢复正常。
- 原容器和备份未经完整恢复验证不得清理。证书目录、CRM 数据卷和 Stephen 版本目录不在回滚修改范围内。
- 当前方案尚未启动内容发布事务，不能使用 Stephen helper 的 lease 回滚来代替共享入口回滚。若另一个任务出现新的 pending 或更改了共享配置，先停止并协调，再重新取基线。
- 证书、原主站 artifact 或 CRM 路由核对失败时停止，不申请新证书、不改 DNS、不扩大应用范围。
- 所有工具保持正常 CA/SAN 校验与已有 SSH 主机信任；不以 `curl -k`、`StrictHostKeyChecking=no` 或删除其他站点冒烟条件绕过失败。

## 6. 批准边界与本轮交付

本轮网站发布授权明确排除 Nginx 和容器修改。因此上述共享入口恢复需要新的明确授权；原因来自用户当前范围以及 [发布运行手册](stephen-release-runbook.md) 的运行时边界，不是把只读诊断当作额外审批项。

待批准的具体事项为：一次共享边缘维护窗口、候选容器与配置准备、补齐缺失挂载和三组域名入口、连接现有 CRM 上游、经核对的旧主站 artifact 恢复，以及失败时恢复原容器。若主站恢复材料仍不能确认，应先报告具体差异再决定，不能用猜测补齐。

私有桥接代码、测试与 PR 准备可以独立继续。生产发布仍以共享 HTTPS 与版本身份门通过为前提。
