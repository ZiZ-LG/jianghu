# 自我修养静态站｜SAAS-607 发布流水线运行手册 v1

> 状态：`IMPLEMENTED-NOT-MERGED / PRODUCTION DISABLED`
>
> 本手册不是生产启用指令。`STEPHEN_RELEASE_ENABLED` 必须保持未设置或非 `1`；不得创建或切换生产 `current`，不得修改运行中 Nginx、容器挂载或流量。只有项目所有者明确回复“批准首次生产启用”后，才进入首次生产迁移阶段门。

## 1. 已核验的生产现状（2026-08-25）

- 服务器：`47.95.13.214`，当前运维用户 `admin`；
- 运行中边缘容器：`zizai-site`；镜像：`zizai-site:public-security-filing-corrected-81da993`；
- Stephen 当前容器内目录：`/usr/share/nginx/jianghu/stephen`；
- 宿主机同名目录不存在，容器静态文件来自镜像层；
- 容器当前仅挂载证书和 ACME 目录，没有 Stephen 静态目录挂载；
- 已有历史版本根：`/home/admin/jianghu/deployments`；但 `/home/admin` 权限为 `0700`，不适合作为独立 deploy 用户的长期运行根；
- 服务器具备 `python3`、`flock`、`sha256sum`、GNU tar、curl、jq；容器 Nginx 为 `1.31.3`；
- 当前 `stephen.lake2ocean.top` 根页、`/healthz-stephen`、`/api/` 隔离，主站、CRM、CRM health、`zizai.tech` 和同容器的 `bjj.zizai.tech` 均已完成只读在线基线检查。

因此，SAAS-607 选择新的固定宿主机根 `/srv/jianghu/stephen`，并要求未来把**父目录**挂载到容器内 `/srv/stephen:ro`。只挂载 `current` 的解析结果不能满足后续软链接切换，禁止这样配置。

## 2. 发布链路与失败关闭

`.github/workflows/stephen-release.yml` 只监听 `CI` 的 `workflow_run`，并依次确认：

1. 触发 run 来自当前仓库、`push`、`main`，且结论成功；
2. checkout、事件 SHA 和最新 `origin/main` 完全一致，过期 SHA 失败关闭；
3. 记录 first-parent diff 中的 Stephen 公开构建、发布与候选稿变化，但不用该 diff 阻断发布；开关启用后，每个精确、当前且全绿的 `main` SHA 都安全重建并发布，以合并被后续无关提交超越的 Stephen 变化；
4. 同一 SHA 的 `Stephen checks` 已成功；
5. 仓库变量 `STEPHEN_RELEASE_ENABLED` 精确等于 `1`；
6. 独立的无密钥 `build` job 重新安装、类型检查、测试并构建 Stephen，产物通过备案标识、详情旅程、候选状态泄漏、文件类型和 checksum 校验；
7. `build` job 将精确 SHA、归档 checksum 和内容 checksum 写入清单，并通过 GitHub Actions 私有 artifact 传递；artifact 只保留 1 天，后续 job 以官方返回的精确 artifact ID 下载；
8. 全新的 `deploy` runner 在读取任何生产 Secret 前，先核对 artifact 顶层文件白名单、双 checksum、清单字段、内嵌发布身份和来源 SHA；该 runner 不 checkout、不运行 npm/Node/git 或仓库脚本；
9. `production-stephen` Environment 允许后续步骤读取专属控制 token 与 SSH Secrets；审批等待结束后，再次读取仓库开关并确认 `origin/main` 仍是该 SHA；
10. 通过 forced-command SSH key 上传并 stage `releases/<exact-sha>`；上传 key 不能执行任意 shell；
11. 在切换前第三次确认仓库开关和 `origin/main`，再用唯一 lease 执行 `activate`；服务器先启动 30 分钟自动回滚计时器，再持久化 pending 事务并原子切换；
12. 检查 Stephen 核心页、全部 sitemap 详情、公安图标、`/api/` 404，以及主站、CRM 和 `zizai.tech` 的稳定站点身份，并通过 `/release-id.json` 精确核对 `sourceSha` 和内容 checksum；
13. 冒烟通过后、`finalize` 前再次确认开关与 `origin/main`；只有 finalize 成功才撤销自动回滚计时器；
14. 任一检查失败都会调用带同一 SHA 和 lease 的 `rollback`，恢复 pending 事务记录的精确旧版本后再次检查核心站点；runner 失联时则由服务器计时器回滚，服务器重启时由 recovery service 收口未完成事务。

发布工作流的 `eligibility`、`build`、`deploy` runner 均固定 `ubuntu-latest`；内置 `GITHUB_TOKEN` 权限只有 `actions: read` 和 `contents: read`，只用于读取 main ref、精确 SHA 的检查结果和同一 workflow run 的私有 artifact。GitHub 远程实测表明，内置 token 调用仓库 Variables API 会返回 `403 Resource not accessible by integration`；该端点要求独立的 repository `Variables: read` 权限。因此运行中的开关复核使用仅存在于 `production-stephen` Environment 的细粒度控制 token，普通 `Stephen checks` 与无密钥 `build` job 不读取生产 Secret，也不申请无效的 `actions: read`。不使用第三方 SSH Action、`pull_request_target` 或 `StrictHostKeyChecking=no`；生产 deploy job 仅消费由官方 artifact action 传递且经 SHA/checksum 绑定的私有短期产物。

## 3. GitHub 配置清单（只列名称，不记录值）

创建并保护 Environment：

- `production-stephen`；
- 必须配置至少一位真实人工审批人，API 返回的 `protection_rules` 必须包含 `required_reviewers` 且 reviewer 数量大于等于 1；
- 必须限定只允许 `main` 部署：`deployment_branch_policy` 使用 `protected_branches: false` 和自定义分支政策，分支白名单只包含 `main`；
- 在设置 `STEPHEN_RELEASE_ENABLED=1` 之前，必须用 GitHub API 分别读回 Environment 和 deployment branch policies，确认 `required_reviewers` 存在且唯一分支为 `main`；不能仅以 Environment 名称存在作为通过证据。

启用前只读验证（输出不得含 Secret 值）：

```bash
gh api repos/ZiZ-LG/jianghu/environments/production-stephen \
  --jq '{protection_rules, deployment_branch_policy}'
gh api repos/ZiZ-LG/jianghu/environments/production-stephen/deployment-branch-policies \
  --jq '.branch_policies | map({name, type})'
```

如当前 GitHub 套餐或仓库可见性不支持 `required_reviewers`，必须暂停首次生产启用，改用等价的仓库外人工审批边界并另行审批，不得降级为无保护 Environment。

2026-08-26 启用前只读核查显示：当前仓库为个人账号下的 private 仓库，且尚无 Environment。GitHub 官方当前说明指出，Free、Pro 和 Team 套餐的 required reviewers 仅对 public 仓库可用。因此，在 [GitHub 官方环境能力说明](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) 与实际 API 均未证明当前仓库可配置人工审批前，不得创建生产 Secrets或开启发布变量。

Environment Secrets：

- `STEPHEN_RELEASE_CONTROL_TOKEN`：细粒度 token，仅授权当前 `ZiZ-LG/jianghu` 仓库的 `Variables: read`；用于 Environment 等待后、切换前及 finalize 前重新读取停止开关，不得授予内容或变量写权限；当前 main 仍由内置 `GITHUB_TOKEN` 的 `Contents: read` 独立核对；
- `STEPHEN_SSH_HOST`：正式服务器地址；
- `STEPHEN_SSH_PORT`：SSH 端口；
- `STEPHEN_SSH_USER`：专用部署用户，建议 `stephen-deploy`；
- `STEPHEN_SSH_PRIVATE_KEY`：只属于 GitHub Actions 的新 ed25519 私钥；
- `STEPHEN_SSH_KNOWN_HOSTS`：经可信控制台核对指纹后的 known_hosts 完整行。

Repository Variable：

- `STEPHEN_RELEASE_ENABLED`：首次启用前不创建或保持非 `1`；收到项目所有者批准后才设为字符串 `1`。

控制 token 采用短有效期并在到期前轮换；权限或 Secret 缺失时工作流会在上传、切换之前失败关闭。不得复用 Mac 上的 `lake2ocean_aliyun_ed25519` 私钥，不得把任何 token、私钥、口令或 Secret 值写入聊天、仓库、PR、日志或 artifact。

## 4. 专用 SSH 身份与服务器最小权限（首次启用时人工执行）

在用户控制的安全位置生成一把全新 key；私钥进入 GitHub Environment Secret，服务器只安装公钥。先从阿里云控制台读取服务器主机公钥指纹，再核对 `ssh-keyscan` 结果，不能把未核对的扫描结果直接当作信任根。

服务器目标权限模型：

- `stephen-deploy` 只写 `/srv/jianghu/stephen/incoming`；
- `/srv/jianghu/stephen`、`releases`、`current`、`previous` 均为 root 控制；
- repo 中的 `deploy/stephen-remote-release.sh` 以 `root:root 0755` 安装为 `/usr/local/sbin/stephen-release-helper`；
- repo 中的 `deploy/stephen-ssh-dispatcher.sh` 以 `root:root 0755` 安装为 `/usr/local/sbin/stephen-ssh-dispatcher`；
- repo 中的 `deploy/stephen-release-recover.service` 以 `root:root 0644` 安装到 `/etc/systemd/system/`，执行 `daemon-reload` 后启用；它只在开机时恢复未 finalize 的 pending 激活，容器尚未就绪时每 15 秒重试并受 systemd 启动频率上限约束；
- helper 文件不得 group/world writable；
- sudoers 使用 `env_reset`、固定 `secure_path` 和 `NOSETENV`，只允许无额外环境的 `/usr/local/sbin/stephen-release-helper *`；命令面仍由 forced dispatcher 和 helper 的参数校验共同收窄；
- Actions 公钥的 `authorized_keys` 必须使用精确前缀 `restrict,no-user-rc,command="/usr/local/sbin/stephen-ssh-dispatcher"`；dispatcher 只接受固定格式的 `stephen-upload`、`stage`、`activate`、`finalize`、`rollback`、`status`，拒绝交互 shell、管道、重定向和额外参数；
- Actions 客户端必须同时使用 `-F /dev/null`、`GlobalKnownHostsFile=/dev/null`、`StrictHostKeyChecking=yes` 和 Environment Secret 写入的专属 `UserKnownHostsFile`，确保系统级 SSH 配置与全局 known-hosts 不能成为额外信任锚；
- 不把 deploy 用户加入 `docker` 组，不授予通用 root shell、任意 `docker` 或任意文件复制权限。

建议目录形态：

```text
/srv/jianghu/stephen/
├── incoming/                   # stephen-deploy 可写
├── releases/                  # root 写，<40-char-sha>/
├── .activation-pending.json   # root 写，未 finalize 的激活事务
├── current -> releases/<sha>  # root 原子替换
└── previous -> releases/<sha> # root 原子替换
```

`incoming` 的实际峰值由 dispatcher 限制为 100 MiB，单包限制为 50 MiB；接收前先按已有占用缩小可读上限。stage 成功或幂等复用后删除相应上传包；超过 24 小时的失败归档和超过 1 小时的残留上传临时文件会在下一次上传时清理。安装 helper、dispatcher、recovery service、用户、公钥、sudoers 和目录权限都属于首次生产启用，不在 SAAS-607 当前授权内。

## 5. 运行时迁移前置门

当前容器并不读取 `current`。首次生产启用必须在独立变更窗口完成：

1. 保留当前镜像 ID、容器参数、证书挂载、网络和端口作为 legacy 回滚证据；
2. 准备一个经验证的 bootstrap release 和一个候选 release；
3. 将宿主机父目录 `/srv/jianghu/stephen` 只读挂载为容器内 `/srv/stephen`；
4. 使用 repo 中的候选 Nginx 配置，使 Stephen HTTPS server 的 root 为 `/srv/stephen/current`；
5. 在切流前运行真实 `nginx -t`，并验证主站、CRM、Stephen、`zizai.tech` 和 BJJ Host；
6. 记录恢复旧容器镜像和旧启动参数的首次迁移回滚命令；
7. 候选 Nginx 配置必须把 `/release-id.json` 映射到当前版本的 `.stephen-release.json`，同时继续隐藏其他 dotfile；
8. 只有这些证据齐全，helper 的 `activate` 才会通过 runtime-ready 检查。

这一步会修改共享边缘容器和 Nginx，必须另行批准；SAAS-607 当前只提交候选配置，不应用到服务器。

## 6. 版本包与服务器 helper 契约

版本包必须：

- 绑定 40 位小写 commit SHA；
- 包含 `.stephen-release.json`；
- 外层 tar.gz 生成 SHA-256；
- 只含普通文件和目录，不含符号链接、硬链接、设备、绝对路径或 `..`；
- 压缩包不超过 50 MiB；流式 tar 预检最多接受 1,000 个 artifact 文件及 1 个 metadata 文件，单个 artifact 文件不超过 8 MiB、artifact 总内容不超过 16 MiB、metadata 不超过 1 MiB、路径最多 16 层；
- 解压在 `0700` 临时目录，随后统一为目录 `0755`、文件 `0644`，避免归档权限形成 setuid/可执行文件；
- 上传区文件先在 root 保护的 `releases` 目录内复制为 `0600 root:root` 临时归档，checksum、成员校验和解压只读取该不可变副本；
- 已存在同 SHA 版本时只有 checksum 完全一致才允许幂等复用，禁止覆盖。

artifact 的同一组限制也在打包前执行。服务器以 streaming tar 模式在读取成员正文前逐项验证类型、数量和声明大小，并先用 `O_NOFOLLOW` 把 deploy 用户可写上传文件有界复制成 root-only 不可变归档，避免校验和解压之间被替换。所有 root helper Python 调用使用 isolated mode，不能从 deploy 用户的 cwd、user site 或 `PYTHONPATH` 加载代码。

`releases` 的逻辑内容总量硬限制为 512 MiB，并要求变更后仍保留至少 512 MiB 文件系统可用空间；达到任一边界时新 stage 失败关闭，不继续占满磁盘。历史清理由运维在核对 `current`、`previous` 和 pending restore 引用后执行，不在发布 key 的权限内。

helper 在切换前后都执行 Nginx 校验。`activate <sha> <lease>` 只是进入 pending：先注册 30 分钟 expiry timer，再持久化旧 `current`/`previous`，随后切链接和 reload。外部 HTTPS 冒烟与精确 release identity 全部通过后，`finalize <sha> <lease>` 才提交事务；失败时 `rollback <sha> <lease>` 不依赖失败版本内容完整性，只校验并恢复事务中记录的精确旧链接。每次原子链接替换和 pending marker 删除都对发布根目录执行 `fsync`；回滚必须在删除 marker 和撤销 timer 前，通过 runtime 与外部 `/release-id.json` 双重确认实际服务的正是恢复 SHA。未收到 runner 后续消息时 timer 回滚；机器重启时 recovery service 处理残留 pending。所有 Docker/Nginx/systemd 子命令受 20 秒外层 timeout 约束，release lock 最多等待 120 秒，expiry service 遇到锁竞争或瞬时容器故障会每 15 秒重试。所有链接变更发生在同一文件系统并由 `flock` 串行化。

## 7. 当前内容批准缺口

SAAS-606 的 `review-manifest.json` 明确保留：

- `pending_owner_review`；
- `not_published`；
- 单一官方发现记录和 AI/确定性候选文案。

它还不是当前公开集合要求的完整批准对象：至少缺少正式批准审计和“每条结论两项可追溯事实”的公开内容载荷。因此 SAAS-607：

- 不把 pending manifest 自动导入 `publicItems.ts`；
- candidate-only merge 会触发精确当前 `main` 的安全重发，但只会重新发布 `publicItems` 白名单内已批准内容，不会导入候选稿；
- 产物中出现 pending/not-published 字符串会失败关闭；
- 不以降低内容标准来伪造“Merge 即公开”。

首次自动内容上线前，需要一个单独批准的最小内容提升任务：把项目所有者保留的条目转换为完整、可验证、已批准的公开内容对象，并让 PR 明确展示最终将公开的载荷。这不是共享架构重选，但属于 SAAS-606 审核载荷的补全。

## 8. SAAS-607 验收方式

当前阶段允许：

- 本地构建、测试、checksum；
- 上传到唯一的非 `current` dry-run 目录；
- 在服务器端重新核对 checksum、metadata 和文件；
- 对当前线上执行只读冒烟。

当前阶段禁止：

- 创建、覆盖或切换 `/srv/jianghu/stephen/current` / `previous`；
- 安装 helper、创建 deploy 用户或写 sudoers；
- 修改运行中容器、挂载、Nginx、DNS 或流量；
- 设置 `STEPHEN_RELEASE_ENABLED=1`；
- 宣称已发生生产发布。

验收输出必须记录精确分支、commit、产物 SHA-256、dry-run 目录、线上只读结果、远程 CI 和下一阶段门。
