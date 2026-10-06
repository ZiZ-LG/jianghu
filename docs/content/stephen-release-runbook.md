# 自我修养静态站｜SAAS-607 发布运行手册 v3

日常发布从公开网站仓库构建，由私有江湖仓库中的发布器执行。只有版本、CI、构建、线上检查和真实浏览器验收全部通过，才能报告部署完成。

本手册是发布操作的统一入口。[本次桥接记录](stephen-public-release-bridge.md) 保存批准范围与执行结果。源码与安全机制以 `deploy/stephen-local-release.sh`、`deploy/stephen-remote-release.sh` 和 `deploy/public-site-targets.json` 为准。

## 1. 范围与固定身份

| 对象 | 权威 |
|---|---|
| 网站源码 | `ZiZ-LG/stephen-knowledge-hub` 的干净、精确当前 `main`，构建目录 `dist` |
| 发布器 | `ZiZ-LG/jianghu` 的干净、精确当前 `main`，入口 `deploy/stephen-local-release.sh` |
| 公开源码 CI | `checks.yml`，指定 SHA 最新的 `push/main` 运行成功 |
| 私有发布器 CI | `ci.yml` 与 `stephen-checks.yml`，指定 SHA 最新的 `push/main` 运行成功 |
| 目标站点 | `https://stephen.lake2ocean.top/` |
| 服务器事务 | `/usr/local/sbin/stephen-release-helper`，固定目标来自私有 registry |

部署批准只覆盖用户已审核的网站版本。自动内容审批、修改共享服务配置、启用 `STEPHEN_RELEASE_ENABLED`、CRM 和数据库都不在日常发布范围内。

GitHub 自动发布仍停用。未来如单独批准启用，必须在设置 `STEPHEN_RELEASE_ENABLED=1` 之前，使用 GitHub API 核对生产 Environment 的 `required_reviewers` 和部署分支规则 `deployment_branch_policy`（包括 `protected_branches` 及仅允许 main 的实际分支政策）。审批人、保护规则或 API 结果缺失时不得开启；workflow 中声明 Environment 名称不能证明人工审批保护已经配置。

registry 保存预期运行契约，不证明当前生产健康。旧分支记录的运行状态只可用于定位；每次操作必须重新读取 helper status、HTTPS 身份和共享站点。

## 2. 准备

保留用户主工作目录与未提交资料。分别准备两个干净的独立工作目录，固定公开源码 SHA 和私有发布器 SHA。不能把公开仓库的 SHA 当作私有发布器版本。

在仓库外创建操作者自有、权限 `0700` 的操作目录。预检包、激活包和事务状态分别保存；激活包目录必须为空，状态文件必须不存在。状态文件创建为 `0600`。记录绝对路径，便于中断后回读。

本地使用已有 SSH 身份和已信任的 known-hosts。不得输出私钥、令牌或整份环境变量。代理只改变网络连接路径，不能关闭证书、主机名或 SSH 主机密钥校验。

## 3. 预检

从私有发布器工作目录执行，参数中的占位符须替换成已经核对的绝对路径与完整 SHA：

```bash
bash deploy/stephen-local-release.sh plan \
  --source-dir /absolute/public-source-worktree \
  --source-sha <public-main-sha> \
  --operator-sha <private-main-sha> \
  --bundle-dir /absolute/operation/preflight-bundle
```

预检只允许本地构建、测试和打包，以及远端只读检查。不得上传、stage、activate 或 finalize。成功结果必须含正确的两个仓库与 SHA、CI 链接、校验值，并同时满足 `releaseState=PLAN_ONLY`、`productionTouched=false`。

任一条件不满足即停止。证书错误、站点身份错误、已有 pending 事务或 CI 失败都不是可忽略警告。不得通过跳过 TLS 校验、替换域名或直接复制文件绕过。

## 4. 激活与浏览器验收

当前版本已获发布批准且预检成功后，使用新的空 bundle 目录：

```bash
STEPHEN_PRODUCTION_RELEASE_APPROVAL=release:<public-main-sha> \
  bash deploy/stephen-local-release.sh activate \
  --source-dir /absolute/public-source-worktree \
  --source-sha <public-main-sha> \
  --operator-sha <private-main-sha> \
  --bundle-dir /absolute/operation/activation-bundle \
  --state-file /absolute/operation/release-state.json
```

激活先检查当前线上服务，再上传并进入有时限的 pending 事务。状态必须记录公开源码、私有执行版本、构建校验值、前一版本与 lease。收到 `ALREADY_ACTIVE` 时只运行 verify，确认这是已上线同一版本的无写入操作。

收到 `PENDING_BROWSER_VERIFICATION` 后，先使用真实浏览器完成以下检查，再 finalize：

- 桌面与手机宽度下，页面能显示、导航能点击，无影响阅读的溢出。
- 首页、简报、至少一个已发布主题、政策页均正常。
- `/learn/` 和本版 8 个学习主题均可打开；练习与工具入口可用。
- `/fieldbook/` 引导正常；`/library/#legacy-learning` 能说明旧记录并保留只读导出。
- 鼠标滚轮与触控方式的纵向滚动有效，页面动态标题正确。
- 浏览器控制台无本次版本导致的错误。
- `/release-id.json` 的公开仓库、SHA 和内容校验值与本次事务一致。

不要在生产浏览器里导入真实客户数据或伪造用户学习进度。线上只读检查不能替代用户对内容体验的评价。

## 5. 完成与回读

全部浏览器检查通过后，仅为这一条调用设置验证值：

```bash
STEPHEN_BROWSER_VERIFICATION=verified:<public-main-sha>:<lease> \
  bash deploy/stephen-local-release.sh finalize \
  --source-dir /absolute/public-source-worktree \
  --state-file /absolute/operation/release-state.json

bash deploy/stephen-local-release.sh verify \
  --state-file /absolute/operation/release-state.json
```

只有 stored/observed 状态为 `FINALIZED`、current 为预期公开 SHA、pending 已清空，且最终线上检查通过，才记录部署完成。不能用命令退出码或 GitHub 合并代替这些证据。

## 6. 失败与中断

结果不明时保留原状态文件，先 verify；不得直接再发起一次激活。verify 不修改状态文件。它区分本地最后记录与远端观察结果，处理上传、stage、切换或 finalize 响应中断。

自动检查发现 pending 激活失败时，发布器沿用既有失败回退。服务器保留 30 分钟过期恢复和重启恢复机制。浏览器未通过时不得 finalize；手工回退须有当前授权，并绑定精确 SHA 和 lease：

```bash
STEPHEN_PRODUCTION_ROLLBACK_APPROVAL=rollback:<public-main-sha>:<lease> \
  bash deploy/stephen-local-release.sh rollback \
  --state-file /absolute/operation/release-state.json
```

已 finalize 的版本不属于此 pending 回退接口。禁止删除数据卷、重建共享容器、重装 helper 或修改 Nginx 来绕过失败。

## 7. 保留的服务器边界

本次不改变服务器 helper。它仍检查归档 checksum、普通文件类型、路径边界、文件数量与大小；拒绝符号链接、硬链接、设备、绝对路径和路径穿越。每个 SHA 的已暂存版本不可覆盖。

既有限制为：压缩包 50 MiB，最多 1,000 个内容文件，单文件 8 MiB、总内容 16 MiB、metadata 1 MiB、路径 16 层。版本目录总量 512 MiB，操作后至少保留 512 MiB 可用空间。超过限制时停止，不能自动清理可能仍用于回退的历史版本。

helper 使用互斥锁及同文件系统原子指针，pending 事务保存精确前序版本。版本切换不修改网站源代码、CRM、数据库或共享运行配置。

## 8. 交接

记录两个仓库与 SHA、CI 链接、内容/归档 checksum、操作目录、原状态文件、前后 current 与 pending、浏览器验证结果、是否触及生产。失败时写清已完成事项、阻断证据和具体下一步；不得将未验证的部署写成已上线。
