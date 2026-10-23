# CRM API 发布与回滚（SAAS-108）

本入口只替换已另行验证、批准的 CRM API 镜像。保留现有页面、业务代码和正式环境变量，不构建镜像，不执行 SQL、迁移或 schema 更新。`aliyun-edge-release.sh` 继续排除 CRM。不得借此发布当前 main 的全部业务代码。

## 门槛与保护范围

- PR 精确 head 的最新 push、PR 完整 CI，以及合并后精确 main 的 CI 和 Stephen checks 均须 completed/success。跳过的自动发布不算验证成功。
- 镜像以完整 config digest 固定，linux/amd64，Entrypoint/Cmd 必须为 `npm run start`，绕过旧迁移入口；默认环境必须与旧镜像一致。
- 旧 API 必须正在运行、无挂载、无公开端口，只连接计划列明的两个私有业务网络。正式 DSN 仅在主机内比较，不输出。所有事务须由同一 Docker 操作者运行，共用该用户主目录下的 `.crm-api-release.lock`，防止不同 state 并发激活。若旧 API 带本发布器事务标签，准备和激活还须确认其原事务已 FINALIZED、pending=false；原租约未收尾或原 state 缺失时禁止嵌套发布。
- 同正式 DSN 的运行容器必须只有一个。先禁用旧 API 自动重启并停止，再换网络别名、启动新 API。新 API 无迁移入口；不连接合成库候选。
- 外部计划逐一固定数据库、CRM Web、Stephen、官网、历史首页、BJJ、旧版保留容器等保护对象 ID，以及 nginx、证书、helper、Stephen pointer 等文件。保护对象摘要会核对配置、镜像、状态、挂载及网络；仅忽略挂载列表顺序。
- 入口保留原容器、镜像和事务。不得删除旧归档、旧事务或失败记录。网络恢复只使用原 aliases，由 Docker 自动分配 IP；不复制 IPAMConfig、MAC、缓存 IP，不使用 `--ip`。

## 外部计划与事务

Python 3.6+，Docker 本机 Unix socket，Docker Engine 26+。计划及事务放在仓库外，目录只允许操作者访问。先重新核对生产身份、CI、TLS、镜像告警和原保护对象；不得输出 inspect 全文、环境变量或密钥。

计划 JSON 字段：

| 字段 | 内容 |
| --- | --- |
| oldContainer | 当前 API 的完整容器 ID，作为本次回滚目标 |
| oldImage / newImage | 已核对的完整 `sha256:` config digest |
| newName | 本次唯一候选容器名 |
| networks | 现有后端和 CRM 前端私有网络名，依次列出 |
| healthURL | 严格 HTTPS 的正式 `/api/health/ready`；仅隔离测试允许 127.0.0.1 HTTP |
| leaseSeconds | 15–900 秒，生产建议 600 秒；必须在同次执行完成验收或回滚 |
| protectedContainers | 对象名到完整容器 ID 的映射，不包含当前 API |
| protectedPaths | 需要保留的主机文件/目录绝对路径 |
| protectedContainerFiles | 保护容器 ID 到容器内只读文件路径的映射 |

以下命令须使用已合并、CI 通过且字节固定的发布器；`STATE` 是全新私有事务目录，已有目录不得重建。准备只创建停止的新容器。基线完整配置含正式连接，仅以 0600 保存在主机事务内。

```sh
python3 deploy/crm-api-release.py --root "$STATE" prepare --plan "$PLAN"
python3 deploy/crm-api-release.py --root "$STATE" status
python3 deploy/crm-api-release.py --root "$STATE" activate
```

激活返回 `AWAITING_ACCEPTANCE`、`pending=true` 与精确 lease。独立 watchdog 在首次停服前确认启动；激活和最终验收的命令、等待均受剩余租约约束。墙钟回拨不会延长单调时钟期限。若 Docker stop 超时且结果不明，恢复会等待原停止请求结束，不能把仍将停止的旧容器误报为已恢复。

## 验收、确认与失败恢复

同一轮完成：严格 TLS/正常 DNS 请求，CRM 页面与未认证 API 行为、静态页面字节/资源、官网、历史首页、BJJ、Stephen 公网检查；真实浏览器操作与截图检查；原保护对象、正式环境等值和恰好一个 worker 回读。没有凭据时不新增生产账户或写业务数据。移动视口只证明响应式布局；触控模拟需另有真实执行证据。

只有所有验收通过，才在仓库外创建回执。回执须复制本事务的 `apiId`、`lease`、`planDigest`、`publisherDigest`，并填写本次实际检查时间 `checkedAtEpoch` 及四个布尔结果 `publicPassed`、`browserPassed`、`protectedPassed`、`screenshotsInspected`。不得把合成 CLI 测试回执当成生产验收。

```sh
python3 deploy/crm-api-release.py --root "$STATE" finalize --lease "$LEASE" --receipt "$RECEIPT"
python3 deploy/crm-api-release.py --root "$STATE" status
```

完成标准：stored phase 为 `FINALIZED`、pending=false；observed 新 API 运行且镜像精确，旧 API 停止，同正式 DSN 仅一个 worker；全部外部检查通过。回执错绑或不完整不会确认；实际验收失败立即恢复旧 API。超时 watchdog 使用同一事务和精确 lease 恢复。

任何外部验收失败，立即执行并回读：

```sh
python3 deploy/crm-api-release.py --root "$STATE" rollback --lease "$LEASE"
python3 deploy/crm-api-release.py --root "$STATE" status
```

恢复先停新 API，再接回旧 aliases、原重启策略和旧容器。`ROLLED_BACK` 必须伴随 pending=false、旧版 readiness/公网就绪、保护对象一致和单 worker。出现第三方同 DSN worker 时只停本事务的新 worker，不操作第三方、不再启动旧版，并保留 `ROLLBACK_FAILED/pending=true` 供现场处理。恢复失败不得标记完成；watchdog 有界重试三次，仍失败需保留具体状态并告知操作者。结果不明先回读，禁止盲目再次 activate 或重建 state。

## 自动验证

```sh
python3 deploy/crm-api-release.test.py
python3 -O deploy/crm-api-release.test.py
python3 deploy/crm-api-release-integration.py
```

单元测试覆盖 IPAM/别名、单 worker、恢复失败、旧停止请求不明、验收失败、过期/错绑租约、环境保护和文件权限。CI 的独立 `crm-release` job 在 Linux/Python 3.12 运行单测和真实 Docker 集成，另用无网络 Python 3.6 容器验证兼容单测。集成只创建带唯一标记的临时容器/内部网络与 loopback 代理，不使用数据库、生产 DSN 或 SSH；强制新旧地址不同，验证动态 DNS 切换和回退，并覆盖网络失败、不健康、激活中到期、验收中到期和返回后的 watchdog 到期。清理仅处理本次 fixture。

源码修复、CI 成功和生产替换各自记录证据；本文件定义流程，不代表任何一轮已发布。实际 SHA、镜像、租约、CI 与验收证据保存在该轮交付记录。
