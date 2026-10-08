# SAAS-607｜独立网站仓库发布接线

**当前状态（2026-10-06）：已获追加授权，兼容依赖补丁与共享入口候选验证已完成；公网尚未切换，新 Stephen 内容尚未上传或激活。**

本次维护将独立网站仓库接入私有发布器。网站内容仍由公开仓库维护，服务器地址、部署身份与发布事务留在私有仓库。远端已保存恢复快照、配置和主站 artifact，并启动仅监听 loopback 的候选容器；这些准备写入不等于公网恢复或内容部署完成。

## 批准范围

2026-10-06，项目所有者先批准“推送 GitHub 并部署”，随后确认补齐独立网站仓库与既有发布器的接线。批准范围包括版本与校验值核对、沿用既有回退机制，以及部署已经审核的网站内容。

最初的内容发布批准排除共享基础设施变更。发现入口故障后，项目所有者明确回复“授权批准”，追加批准两项：一次共享入口恢复及失败回退；五份私有锁文件的兼容安全补丁。共享恢复仅补齐 Stephen、主站和 CRM 的既有入口、挂载及所需边缘网络，详见 [恢复记录](stephen-production-entry-repair-review.md)。

CRM 应用、数据库、DNS、证书、服务器 helper 和自动发布开关仍在排除范围内，不部署 CRM。日常 Stephen 发布仍不允许修改 Nginx、容器或共享基础设施；此次恢复是单独批准的一次性维护。

本次是 SAAS-607 发布维护，不启动新的 CRM 建设任务。执行分支为 `codex/stephen-public-release-bridge`，起点为私有 `origin/main@9cccff76c7f22fbf2449a7507ef6ad5be789ec10`。用户主工作目录及旧工作树的未提交资料保持原状。

## 已审核的网站版本

- 源码仓库：`ZiZ-LG/stephen-knowledge-hub`。
- 已合并 PR：[#20](https://github.com/ZiZ-LG/stephen-knowledge-hub/pull/20)。
- 公开 main：`e4455640a9393e4d05102eb5beb905ddae654084`。
- 精确 SHA 的检查：[Actions 37427858271](https://github.com/ZiZ-LG/stephen-knowledge-hub/actions/runs/37427858271)。执行发布时仍需重新读取最新结果。
- 旧手册已整合成 8 个学习主题及练习；旧入口与本地记录的只读导出保留。

## 设计与验收

发布器分别检查私有执行代码和公开网站源码。预检、激活和 finalize 要求两者来自固定仓库、干净工作目录及当前 `main`，并通过精确 SHA 的指定工作流。状态记录同时保存两个仓库身份、两个提交版本及构建校验值，禁止把公开提交伪装成私有提交。verify 和 pending 回退校验状态记录中的私有发布器版本，不因主分支前移或公开源码目录不可用而阻断恢复。

沿用服务器 helper 的 stage、pending、finalize 和过期回退事务，不重新安装 helper。上传前验证当前网站及共享站点；切换后先验证 HTTPS 和版本，再检查真实浏览器。浏览器需覆盖首页、简报、已发布主题、8 个学习主题、旧手册入口、工具/资料库和政策页。

实现验证需覆盖正常发布、重复操作、状态损坏、版本漂移、错仓库、校验失败、中断恢复和回退。测试使用临时目录与模拟控制输入，不能连接生产。线上完成只以正式 `FINALIZED` 状态和回读验证为准。

## 执行记录

以下按发生顺序记录当时状态；最新状态见表格末行及文首。

| 日期 | 状态 | 证据及边界 |
|---|---|---|
| 2026-10-06 | 实施中 | 公开代码已合并；私有桥接正在独立工作树实现。未上传、未激活生产。经当前网络访问 Stephen 时出现证书主机名不匹配，服务器直连超时；尚不能确定服务器配置原因。 |
| 2026-10-06 | 本地实现与验证完成，生产受阻 | 新增双仓库发布器和 60 项测试；Stephen 两套类型检查通过。全量 206 项首次运行 205 项通过，唯一运行手册保护条款断言补回后单独通过；随后新增的确定性归档用例通过，现 207 项均有通过证据，未再重复整套运行。独立发布器审查无新增阻断，shell 语法与 diff 检查通过。公共 dist 副本经两仓库验证器独立重算一致，9 文件、内容 checksum `f80529f2c6b6b0f0fe1b639a31c2aee0b3736912f19d4440f9df921186ebe464`；此结果不替代生产预检。已通过可信 SSH 确认线上缺少域名入口及挂载；仍无上传或激活。 |
| 2026-10-06 | 桥接已推送，草稿 PR 待解除阻断 | [PR #49](https://github.com/ZiZ-LG/jianghu/pull/49)，实现提交 `98d54979a8e22d9eb535de0761d9e7098c26c994`。[push Stephen checks 37430614265](https://github.com/ZiZ-LG/jianghu/actions/runs/37430614265) 与 [PR Stephen checks 37430683986](https://github.com/ZiZ-LG/jianghu/actions/runs/37430683986) 均成功；[完整 CI 37430614291](https://github.com/ZiZ-LG/jianghu/actions/runs/37430614291) 的五个依赖审计任务均因既有 high 告警失败。未合并私有 main，未部署。 |
| 2026-10-06 | 追加批准后，补丁与候选验证完成 | 五份锁文件仅更新指定 8 个包节点；刷新 `file:` 副本后，类型检查、构建及高危审计通过。服务端唯一失败由旧日期测试引起，旧锁独立复现后只修测试日期，相关文件 8 项通过。发布器另新增 14 项无网络共享站点检查，并完成当前 221 项全量测试。远端恢复快照和候选已准备，34 个严格 TLS 请求通过，8 个既有入口与基线一致。公网仍由原容器提供，Stephen 仍为 `ff6705c66cfde95577be21a7b4b48158d1d3d648` 且无 pending；未上传或激活新内容。 |

具体操作及失败处理以 [发布运行手册](stephen-release-runbook.md) 为准。操作产生的 bundle、日志、状态文件与访问凭据保留在仓库外，不提交到公开仓库。

## 已批准的修复及验证结果

追加授权前的只读诊断发现共享入口缺失，以及五个依赖审计任务因既有 high 告警失败。上述执行记录保留当时的授权和阻断状态，不表示当时已经批准或执行修复。项目所有者随后批准 [共享入口恢复方案](stephen-production-entry-repair-review.md) 和以下兼容补丁。

五份锁文件为 `app/package-lock.json`、`server/package-lock.json`、`packages/domain-contracts/package-lock.json`、`packages/g64111/package-lock.json` 和 `packages/pde-kernel/package-lock.json`。按 npm 官方元数据更新 8 个节点的版本、下载地址和 integrity；无额外传递升级，也未修改 package.json、业务代码、评分算法、契约或 schema。

| 依赖 | 补丁前锁定 | 已安装并验证 | 范围与依据 |
|---|---|---|---|
| `source-map-js` | 前后端及三个共享包均为 `1.2.1` | `1.2.2` | 开发依赖；[公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| `fastify` | 后端 `5.12.1` | `5.12.5` | 后端运行依赖；[修复版本公告](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc) |
| `undici` | 后端 `7.29.0` | `7.29.1` | 后端运行依赖；[公告](https://github.com/advisories/GHSA-w293-vg96-wgc3) |
| `@fastify/busboy` | 后端 `3.2.0` | `3.2.2` | 后端传递依赖；[公告](https://github.com/advisories/GHSA-gxm5-99cw-xjw9) |

本地检查使用 Node `26.5.0`。五个工作区均重新执行 `npm ci --install-links`，刷新前后端的本地包副本。

| 检查 | 已取得的证据 |
|---|---|
| 三个共享包 | 类型检查通过；domain-contracts 161 项、g64111 32 项、pde-kernel 25 项测试通过。 |
| App | 类型检查、413 项测试和构建通过。 |
| Stephen | 两套类型检查、构建及私有 artifact 校验通过。新增 14 项无网络共享站点检查后，执行 `npx vitest run --root stephen`，当前 11 个文件、221 项测试全部通过，用时 82.32 秒。 |
| Server | SQLite 客户端生成、PostgreSQL schema 检查及类型检查通过；全量 975 项中 974 项通过、1 项旧日期测试失败。以 `7fca1bb` 的旧锁在独立目录重现同一 409 `sales_hypothesis_review_time_conflict` 后，经批准仅把该 API 用例的日期改为当前时间后 14 天，原断言不变；相关文件 8 项重跑通过，未重复全部 975 项。 |
| PostgreSQL 生成兼容性 | 仅生成 PostgreSQL 客户端并通过类型检查，未连接 PostgreSQL；随后已恢复 SQLite 客户端。 |
| 依赖审计 | 五个工作区的完整及 `--omit=dev` 审计共 10 项均通过 `--audit-level=high`，high/critical 均为 0。 |

审计仍报告既有中危项：App 和三个共享包各 2 项（Vitest 及其 mocker）；Server 完整审计 6 项、生产依赖审计 4 项，涉及 `fast-uri` 及 `mammoth → argparse → sprintf-js`。计数不是独立漏洞数量；本批未扩大升级范围，也不把通过高危门槛写成“无漏洞”。

## 仍需完成

私有修复需通过最终提交对应的完整 CI。共享入口候选通过后，还须按已批准恢复方案切换公网并从服务器和外部回读验证。随后才能用公开源码的精确版本重新预检、上传和激活，再完成浏览器验收与 finalize。任何一步失败均沿用对应的回退边界，不绕过检查。

本次远端候选只验证旧 Stephen 版本的访问恢复，不证明新内容已上线。操作证据位于仓库外的 `stephen-approved-release-20261006-hvhj0cbv` 目录；恢复记录列出完整位置、快照、候选和主站文件来源。
