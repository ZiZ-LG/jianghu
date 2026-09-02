# AgentJobDefinition 与 AgentRun 迁移回滚说明（CORE-206）

- **任务：** CORE-206
- **状态：** 实现与验证完成，未部署生产
- **基线：** `a02b91a4bddf339ad94ca14d757181feb9db8b91`
- **启动治理提交：** `a72bde7b6464bd9f80b24c9ae55411181f5b3a29`
- **业务提交：** `2a1901c92b3b31ef6e4aaee3fff0dd8b0270b90f`
- **测试稳定化提交：** `d70a6b3e0a683159e457d5d96d0d84ebde84840c`
- **远端证据：** [GitHub Actions 32921909448](https://github.com/ZiZ-LG/jianghu/actions/runs/32921909448)，对应精确 SHA `d70a6b3e0a683159e457d5d96d0d84ebde84840c`，12/12 jobs 成功

## 1. Job 权威、默认停用与正文边界

CORE-206 只建立受控 Agent 运行基座，不实现三个业务 Job：

- 代码 registry 是唯一 Job Card 权威，且只登记 `pre_meeting_brief`、`post_meeting_extract`、`relationship_radar` 三个固定 key；
- tenant 的 `AgentJobDefinition` 只是某一精确 registry 版本的控制／审计快照，只能停用或收紧，不能扩大 trigger、scope、actionMode、来源、输出、预算、超时或重试权限；
- 缺失 tenant 行、新 registry 版本、无生产 handler 的 Job 均默认停用；CORE-206 的生产 handler registry 为空；
- 既有 `EnrichJob` 保持冻结兼容，不迁表、不改名，也不成为新 Agent 权威；
- `AgentRun` 只存 body-free 输入／证据／输出引用、安全计数、稳定失败码、授权指纹和运行审计；不存 prompt、模型响应、Note/Transcript 正文、Candidate evidence、来源摘录、文件 blob、凭据、token 或原始错误栈；
- Agent 不获得 Prisma 或正式业务 mutation 能力，不得写 Customer、Matter、Person、Relation、Commitment、Interaction、Evidence、阶段、Forecast、关键人状态或外部消息。

## 2. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| CORE-206 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260825_pre_core206.prisma` |
| PostgreSQL expand migration | `20260825030000_expand_agent_job_run` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260825030000_expand_agent_job_run/migration.sql` |
| 数据 marker | `CORE-206-agent-job-run-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:agent-job-report
npm run migrate:agent-job-apply
npm run migrate:agent-job-verify
```

- `report` 只读检查 AgentJobDefinition/AgentRun schema、registry 快照、tenant/resource 锚点、body-free 引用和迁移状态；
- `apply` 只在可证明的 expanded 形态下写入 marker-last 迁移收据，不创建 tenant Job 控制行，不启用 Job，也不创建 AgentRun 或正式 CRM 数据；
- `verify` 要求 marker version、contract checksum、integrity checksum 与双向语义完全一致；
- schema 不使用原生 enum、JSON 或数组，SQLite 与 PostgreSQL 保持同一可移植模型；
- 生产 PostgreSQL 只允许版本化 migration 与 `migrate deploy`，禁止 `db push`。

## 3. 运行授权、幂等与人审边界

1. 读取 Job Card 不落 tenant 行；只有当前 owner/admin 可通过 expected-version CAS、`Idempotency-Key` 和 body-free AuditEvent 启停已注册且有生产 handler 的精确版本，viewer 写入在任何 CommandRun/AgentRun/AuditEvent 副作用前拒绝。
2. 每次请求、幂等回放、租约接管、每次 attempt 与输出提交前，都重新验证当前 tenant、数据库角色、`sales.workspace` capability、EffectiveResourceScope、Customer/Matter 父级闭包与敏感 SourceArtifact ACL；角色降级、Matter 转移、ACL/grant 撤销、tombstone 或 Job 停用立即生效。
3. 运行以 tenant/actor/哈希幂等键和 canonical request hash 唯一化；同参回放先重新授权再返回既有回执，改参冲突；活动租约不重复执行，过期租约只能在完整重授权后接管。
4. runner 只把有界上下文与 AbortSignal 交给注入的 prepare handler；超时、预算耗尽、不可重试错误或达到最大 attempts 都以稳定安全原因码结束，不保存 provider 原始错误。
5. `read_only` 只允许已登记的派生只读引用，`draft` 只允许草稿／派生引用；`candidate` 只允许一个 `review_batch` 输出，并要求输入精确锚定单一 SourceArtifact，输出批次及其 Candidate 继续匹配同一 tenant、Customer、Matter、来源和当前审核权限。
6. Agent 只能生成带来源、证据和置信度的候选并交给既有 ReviewBatch 人审；只有人类写用户经过 CORE-205 权威事务采纳后，候选才可进入正式 CRM 数据。

## 4. SQLite 升级与恢复

SQLite 累计升级入口按以下顺序执行：

1. 识别精确 legacy、expanded 或 partial/drift 形态；
2. 在任何 Prisma DDL 前运行只读 report，未知表／列／索引、非法 registry 快照或 AgentRun 语义均失败关闭；
3. 需要改变 schema/data 时先用 `VACUUM INTO` 创建明确一致性备份，再执行 portable expand；
4. DDL 后精确校验表、列、唯一性和索引列序，再按 report/apply/verify 写 marker-last 收据；
5. marker、checksum 与全部语义验证通过后才结束。

失败时停止 Node 进程，保留失败库、日志与明确备份路径，从该写前备份恢复后重新验证。禁止手工补表／列、删除 marker 或在生产使用 `db push`。累计 legacy fixture 会清理重建表遗留的命名索引，并再次校验唯一标志与精确列序，避免 SQLite CI 因索引 namespace 残留产生假红或用 `IF NOT EXISTS` 掩盖错误索引。

## 5. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 在 CORE-203 Candidate、CORE-204 ACL、SAAS-201 SourceArtifact、CORE-205 ReviewBatch/Interaction 之后执行 CORE-206：

1. 只接受精确 pre-CORE-206、expanded、可证明的事务中断或 DDL 已提交未登记状态；
2. expand migration 只新增 AgentJobDefinition/AgentRun 表与 tenant-first 索引，不 UPDATE/DELETE EnrichJob、Candidate、ReviewBatch、SourceArtifact、CommandRun、AuditEvent 或正式业务表；
3. 通过 `prisma migrate deploy` 执行 expand-only DDL，再顺序执行 report/apply/verify；
4. partial schema、registry/语义冲突、marker checksum 漂移或未知状态均非零退出并阻止应用启动；
5. 失败恢复必须先用认证加密备份在隔离数据库验证。替换目标库、运行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准。

## 6. 应用与数据回滚边界

CORE-206 是 expand-only schema 迁移，且默认停用是运行回滚底线。未来若获批部署后发生异常：

1. 先停用对应 Job；若确需应用回退，通过正常版本发布流程回退 CORE-206 应用代码，但保留 AgentJobDefinition/AgentRun 表、运行审计、marker、AuditEvent、CommandRun 与 `_prisma_migrations` 历史；
2. 不删表／列／索引，不把 migration 标记为 rolled back，不删除 marker，不重置运行状态或篡改历史回执；
3. 不把既有 EnrichJob 重新包装为 fallback，不开放任意 handler、网络、脚本、自动外发或正式 CRM writer；
4. 重新启用前重跑 report/apply/verify，并验证当前 tenant/role/capability/scope/ACL、幂等回放、租约接管、预算／超时／重试、Job 停用与 candidate ReviewBatch 锚点；
5. 数据库替换、阿里云发布／回滚和生产 migration 都是独立生产变更，本说明不构成部署授权。

## 7. 已完成验证

- Domain contracts：9 files / 91 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests；App：42 files / 326 tests；全部 typecheck/tests 全绿；
- Server：Prisma generate、PostgreSQL rendered schema check、typecheck、83 files / 683 tests 全绿；聚焦 Agent/schema/ops 5 files / 76 tests、SQLite 累计升级 16/16 全绿；
- 本地未运行会写共享 `app/dist/**` 的 App production build；精确 SHA CI 在隔离环境完成 App build 与 production-images gate；
- PostgreSQL 真实演练与远端日志均输出 `INTERRUPTED_AGENT_JOB_AFTER_COMMIT_ADOPTION_OK=1`、`AGENT_JOB_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`AGENT_JOB_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_AGENT_JOB_SCHEMA_FAIL_CLOSED_OK=1`、`AGENT_JOB_RESTORE_ROLLBACK_OK=1`、`CORE_206_AGENT_JOB_MIGRATION_OK=1`、`FRESH_INSTALL_SECOND_UPDATE_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- registry/route/legacy queue/formal writer/body-column inventory、candidate 单一来源与错误 ReviewBatch 锚点负向测试、history tenant/scope/ACL batching、`git diff --check`、Shell 语法、共享／自我修养保护路径和高置信密钥扫描全部通过；
- 精确 SHA `d70a6b3e0a683159e457d5d96d0d84ebde84840c` 的 [Actions 32921909448](https://github.com/ZiZ-LG/jianghu/actions/runs/32921909448) 12/12 jobs 成功；
- 公共 CI 的既有 Node 20 弃用提示未在本任务修改；公共 workflow 属于共享文件，后续升级仍须单独批准。

CORE-206 未修改 Action、App、产品权限分配、共享高冲突文件或“自我修养”专属路径，未部署生产、未合并 main。
