# SAAS-211｜G4 复杂销售个人闭环阶段门验收记录

- **日期：** 2026-09-04
- **任务：** SAAS-211
- **分支：** `codex/saas-211-g4-acceptance`
- **工作树：** `.worktrees/saas-211-g4-acceptance`
- **基线：** `origin/main@9cccff76c7f22fbf2449a7507ef6ad5be789ec10`
- **执行计划：** `docs/superpowers/plans/2026-09-04-saas-211-g4-stage-gate.md`

## 1. 阶段门结论

SAAS-211 的本地候选验收通过：曹经理个人复杂销售闭环、三类受控 Job、人审零自动正式写、干预解释、敏感 ACL、双库 schema、版本化 PostgreSQL migration 与备份恢复均获得可重复证据。候选只增加验收测试和治理文档，没有修改生产运行时代码、schema、migration、共享高冲突文件或“自我修养”专属路径。

本记录在 push 前形成，不预写远端结果。只有最终 branch-tip 精确 SHA 的权威 GitHub Actions 达到 **12/12 jobs success** 后，`SAAS-211 = DONE` 与 `G4 = PASS` 才对外生效；在此之前不得创建后续研发候选、启动 SAAS-301 或复用中间 SHA。SAAS-301 仅进入 `READY`，启动仍需新的明确授权。

## 2. 曹经理端到端证据

| 阶段 | 验收证据 |
|---|---|
| 商业运行时 | `/api/me` 明确返回 `commercial`、`crm.core + sales.workspace`，团队共享权限为空；测试没有落回 internal 默认配置。 |
| 文件导入 | 合成 `.txt` 经真实 multipart API 导入；同一幂等键 replay 返回同一 SourceArtifact/fingerprint，SourceArtifact 与 Transcript 各仅一行；响应不含正文，正文只以既有加密存储形态存在。 |
| 三类 Job | 精确运行 `pre_meeting_brief@core-206.v1/read_only`、`post_meeting_extract@core-206.v1/candidate`、`relationship_radar@saas-212.v1/draft`；三者均先由 owner 显式启用。 |
| 机器输出边界 | pre-meeting 只生成带来源、时间与未知项的简报；post-meeting 只生成带 quote/confidence/source 的候选；radar 只生成不可变 snapshot 与 `uncommitted` draft。各机器阶段前后正式业务表快照保持不变。 |
| 人审写入 | owner 明确采纳后才原子建立 Interaction、Person、Relation、Evidence 与 Commitment；相同请求幂等 replay，修改 payload 发生冲突并整批失败关闭。 |
| 情报与假设 | IntelligenceItem、StakeholderFocus、SalesHypothesis、Evidence link 和最终状态均由明确命令产生；反对证据只给出 `contradicted` 建议，不自动改正式状态。 |
| 关系干预 | radar 返回六个独立 signal，无总分；每个干预项包含 reason/source/time/ruleVersion/action，来源下钻受当前 revision 与 ACL 约束。 |
| 组合视图 | 5 个非归档 Matter 全部进入管理投影，不被硬截断；注意力排序和来源可解释，读路径无正式写副作用；未启用 G64111 的 fixture 完成同一闭环。 |
| 运行历史 | current ReviewBatch output version 下 AgentRun detail 可见；人审推进 batch version 后旧 run 通过 API 同形隐藏，但三条不可变 AgentRun 审计记录仍保留。 |

## 3. 多租户、RBAC 与敏感 ACL

- 所有 fixture 和查询按 `tenantId` 隔离；外部租户 owner 对 SourceArtifact、ReviewBatch 与来源下钻均获得与不存在资源同形的失败，不暴露存在性。
- viewer 即使被设为 Customer/Matter owner，仍不能读取敏感 SourceArtifact；Job control/run、review 和 source mutation 均返回 `viewer_write_denied`，且正式业务与 AuditEvent 零新增。
- manager-shaped member、普通 member 和非创建者 admin 不因角色名、Matter share 或单独 resource grant 自动取得敏感正文。
- G4 商业 `sales.workspace` 当前不分配 `source.read_shared` 或 `candidate.review_shared`。因此本阶段的曹经理旅程由 owner 完成人审；没有伪造 G5 的 manager/team scope。资源 grant 单独存在时仍按产品权限 fail closed。
- 权限启用场景下的 creator/share/current-version reviewer、role downgrade、revoke 与下一请求即时生效，继续由既有 CORE-204/CORE-205 ACL 套件覆盖。本任务同时复跑这些套件。商业团队权限分配属于 SAAS-301。
- 未授权 manager review 不产生正式写或 AuditEvent，只留下一个不含敏感 result 的失败 CommandRun；降权和撤销后的 replay 不产生重复副作用。
- 测试逐项扫描响应、AgentRun、CommandRun、AuditEvent、会前输出与会议文本行；文件正文、伪 API key、quote 和密文均未泄露到禁止位置。

## 4. 本地验证证据

### 定向与 G4 回归

- 新增曹经理完整旅程：1 file / 1 test，通过。
- 曹经理旅程 + 敏感 ACL routes：4 files / 45 tests，通过。
- G4 migration/marker 定向矩阵：11 files / 63 tests，通过。
- G4 功能回归矩阵：18 files / 136 tests，通过。

### 唯一一次完整本地验收

| 工作区 | 结果 |
|---|---|
| `packages/domain-contracts` | typecheck；17 files / 161 tests，通过 |
| `packages/g64111` | typecheck；2 files / 32 tests，通过 |
| `packages/pde-kernel` | typecheck；3 files / 25 tests，通过 |
| `app` | typecheck；60 files / 413 tests；production build 144 modules，通过 |
| `server` | Prisma generate；typecheck；123 files / 976 tests，通过 |
| SQLite / PostgreSQL | 两份 Prisma schema validate；`schema:postgres:check`，通过 |
| PostgreSQL 运维链路 | `scripts/test-postgres-ops-integration.sh` 完整通过，终态 `POSTGRES_OPS_INTEGRATION_OK=1` |

App production build 只写入 `/tmp` 临时目录，没有覆盖 `app/dist`。PostgreSQL 集成首次在 Docker `npm ci --install-links` 遇到镜像网络 `ECONNRESET`，当时 migration 尚未开始；以同一 Dockerfile、源码和 lockfile 预热精确依赖层后，从头重跑完整脚本并通过。该过程只使用本机 Docker 测试环境，不是 Mac mini 或生产部署。

### 依赖审计

- `packages/g64111`、`packages/pde-kernel`、`server` 的 full 与 production audit 均为 0 vulnerabilities。
- `packages/domain-contracts` full audit 为 0 vulnerabilities；production audit 的 GitHub/npm 官方端点返回 503，日志没有漏洞发现。
- `app` production audit 为 0 vulnerabilities；full audit 的官方端点返回 503，日志没有漏洞发现。
- 未修改依赖或 workflow，也未降低阈值。最终精确 SHA CI 必须重新执行全部五个 dependency-audit matrix job；如只有 400/500/503 且日志明确无漏洞发现，只重跑对应失败 job。

## 5. 独立审查

仓库 `/review` 方法对基线后的全部变更完成独立检查。审查发现并关闭两项会造成假绿的关键问题：测试错误使用 internal product access；商业 G4 被误当作已拥有 G5 team permissions。另关闭时间漂移、上传 replay 和 AgentRun current-version 可见性三项可靠性缺口。

修复后测试明确锁定 commercial runtime、空团队权限、owner 人审、失败关闭 ACL、固定时间、上传幂等、AgentRun 版本失效与越权失败 CommandRun 安全形状。复核无剩余阻断项；没有因此修改生产代码。

## 6. 变更、回滚与边界

本候选截至治理收口前包含：

- `9985f459b4e97397d8804e158813a935160388ab`：SAAS-211 启动计划与清单状态。
- `ea5968ba16be05dac1d479fc34d425c5057bbaaf`：曹经理 G4 端到端验收测试。
- `6bfd0973392a31f072e4064465c6605bd135bb34`：独立审查后的验收加固。
- 本验收记录、计划勾选与商业清单收口将形成独立 docs commit；其 SHA 以最终 branch tip 为准。

精确变更范围只允许：

- `server/tests/g4-commercial-journey.test.ts`
- `docs/superpowers/plans/2026-09-04-saas-211-g4-stage-gate.md`
- `docs/SAAS-211-G4阶段门验收记录.md`
- `docs/商业版开发待办清单v1.md`

回滚时可按逆序 revert 治理收口、测试加固、验收测试和启动计划 commit。没有 schema、migration 或运行时行为需要回滚；不得删除或重写任何既有 G4 数据、审计、AgentRun 或 migration history。

## 7. 远端与发布门

1. 四个本地 commit 共同组成唯一 SAAS-211 候选，一次性 push；只认可最终 branch-tip SHA。
2. 该 SHA 的权威 push CI 必须达到 12/12。真实测试、类型、迁移、安全或构建失败时修复并形成新 SHA；仅 audit endpoint 400/500/503 且无漏洞发现时只重跑失败 job。
3. 12/12 后再核对 clean、远端 SHA、main drift、自我修养零变化和 branch protection；创建 PR 仍须单独批准。
4. 不合并 main，不启动 SAAS-301，不部署生产、阿里云或 Mac mini。
