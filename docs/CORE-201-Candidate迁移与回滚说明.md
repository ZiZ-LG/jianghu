# CORE-201 Candidate 迁移与回滚说明

- **任务：** CORE-201
- **状态：** 已完成实现与精确 SHA CI；未部署生产
- **基线：** `558d22a5971626eedd1cae42cddd45bccc10cb14`
- **业务提交：** `a2e579ba80b9e8939bc23099f507d58995730fd9`
- **最终验证提交：** `05ae8b3bc99a15740aa67064e3d0a7454d2c1876`
- **远端证据：** [GitHub Actions 32803198527](https://github.com/ZiZ-LG/jianghu/actions/runs/32803198527)，精确 SHA 12/12 jobs 成功

## 1. 权威与范围

CORE-201 只增加统一 `Candidate` 的 expand-only 物理基座和只读迁移预演，不做数据切换：

- `PersonSuggestion`、`RelSuggestion`、`ChangeProposal`、`Reminder` 与 `pending_review EvidenceEvent` 仍是在线权威；
- migration 不向 Candidate 回填任何行，也不修改五个来源表或正式 Person、Relation、Evidence、Commitment；
- 没有 Candidate producer、consumer、双写、fallback 双读、Inbox 切换或人审采纳事务；
- dry-run 只输出数量、来源类型、行 ID、原因码与非敏感 checksum，不输出 evidence、rawContent 或 payload 正文；
- CORE-202/203/205 分别负责后续 producer/兼容投影、Inbox/批审与采纳事务，CORE-201 不提前实现。

## 2. Schema 与迁移映射

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| CORE-201 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260824_pre_core201.prisma` |
| PostgreSQL migration ID | `20260824000000_expand_candidate_foundation` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260824000000_expand_candidate_foundation/migration.sql` |
| SQLite 升级入口 | `cd server && npm run db:push` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` 调用 `prisma migrate deploy` |

生产只允许版本化 migration 与 `migrate deploy`。禁止对 PostgreSQL 生产运行 `prisma db push`；测试脚本中的 `db push` 仅用于临时数据库和 SQLite 开发升级。

PostgreSQL DDL 在单一事务内建立 26 列 Candidate 表、tenant FK、两个 tenant-scoped 唯一键和 tenant-first 索引，并设置 30 秒锁等待与 15 分钟语句上限。DDL 不包含来源表或 Candidate 的业务行 INSERT、UPDATE、DELETE。

## 3. 部署前只读预演

在已配置目标数据库连接、且没有输出或复制密钥的前提下运行：

```bash
cd server
npm run migrate:candidate-report
npm run migrate:candidate-verify
```

预期条件：

- 输出 `writes: 0`、`authority: legacy_candidate_tables`；
- `sourceRows = projectedRows` 且 `invalidRows` 为空时，verify 返回 0；
- 五来源逐 Tenant 扫描，父 Customer/Matter/Person、状态和创建者归属均校验；
- 无法确认的创建者映射为 `createdByUserId = null`、`visibility = owner_admin_only`，不得猜测用户；
- 任一跨租户、悬空父级、未知状态或计数不一致使 verify 非零退出，先修复旧权威数据再重试；
- CLI 不提供 `--apply`，传入该参数必须失败。

## 4. 状态判定与 fail-closed 行为

| 状态 | 含义 | 处理 |
|---|---|---|
| `uninitialized` | 空数据库，Tenant 与 Candidate 均不存在 | 不接管；由完整版本化迁移链初始化 |
| `legacy` | Tenant 存在、Candidate 不存在 | 先报告/校验，再执行 expand migration |
| `expanded` | Candidate 列、索引、主键和 tenant FK 与权威 schema 精确一致 | 若 migration 未登记，校验 schema 后登记为 applied；不得重放 DDL |
| `partial` | 表、列、索引或 FK 只完成一部分或发生漂移 | 立即停止；不得自动补列、删表或 `db push` |

PostgreSQL 事务在提交前中断时会回滚到 `legacy`，部署脚本可把未完成记录登记为 rolled back 后安全重放。事务已提交但 migration journal 未完成时，只允许在 `expanded` 且 schema diff 为零、只读 verify 通过后接管。其他形态一律失败关闭。

SQLite 升级在已有数据库发生任何 schema/backfill 变化前通过 `VACUUM INTO` 创建一致性备份；部分 Candidate shape 在 DDL 前被拒绝。升级后必须重新判定为 `expanded` 并执行只读 verify。

## 5. 回滚边界

CORE-201 是 expand-only 且没有在线切换，首选回滚是应用前向修复或回到上一应用版本，同时保留数据库扩展：

1. 停止继续发布，不启动 CORE-202 producer cutover；
2. 应用可回退到 CORE-201 前行为，旧五表继续服务；
3. 不删除 Candidate 表/行、旧五表、审计数据或 `_prisma_migrations` 记录；
4. 不把已应用 migration 标记为 rolled back，不强制重放相同 DDL；
5. 若 SQLite 需要文件级恢复，先完全停止 Node 进程，保留当前文件，再使用升级日志打印的写前备份恢复并重新验证旧五表；
6. 若 PostgreSQL 出现 `partial`/drift，先用 `scripts/restore-postgres.sh` 将认证加密备份恢复到隔离数据库并完成校验；替换目标数据库属于单独生产变更，必须另获批准；
7. 恢复后再次运行五来源只读报告，并确认 Candidate 不成为权威、来源表行数/状态未变化。

生产部署、数据库替换、main 合并均不在本任务授权内。本次没有连接或修改阿里云生产。

## 6. 已完成验证

- Domain contracts：8 files / 87 tests；
- G64111：2 files / 32 tests；
- PDE kernel：3 files / 25 tests；
- App：42 files / 326 tests；
- Server：66 files / 508 tests；
- SQLite：fresh、legacy upgrade、重复执行、partial 拒绝、写前备份与恢复；
- PostgreSQL：事务提交前重试、提交后未登记接管、partial 拒绝、认证恢复、fresh install 与第二次更新；
- 关键标记：`LEGACY_CANDIDATE_REPORT_OK=1`、`CANDIDATE_SOURCE_ROWS_UNCHANGED_OK=1`、`CORE_201_CANDIDATE_MIGRATION_OK=1`、`POSTGRES_OPS_INTEGRATION_OK=1`；
- 最终精确 SHA CI：`05ae8b3bc99a15740aa67064e3d0a7454d2c1876`，12/12 jobs 成功。

本任务未修改共享高冲突文件或“自我修养”专属路径，未创建生产构建产物，未部署。

## 7. CORE-202 人物/关系候选写入切换

CORE-202 已完成应用层 write-cutover，但仍未部署生产：

- 对 CORE-202 之后新建或首次触碰的 `person_create` / `relation_create`，统一 `Candidate` 是写入权威；
- `PersonSuggestion` 与 `RelSuggestion` 只由 `server/src/candidates/personRelation.ts` 在同一事务内维护为兼容物化投影，供尚未切换的旧 API 与 Inbox 读取；
- voice、enrich、graph suggest、MCP sync/direct producer，以及人物/关系采纳、拒绝和人物合并引用改写，不得绕过该 helper；
- 存量 legacy-only 行在第一次变更时通过稳定 legacy identity 惰性纳入 Candidate；CORE-202 不执行五类存量全量回填；
- 人审前正式 Person、Edge、阶段、预测或关键人状态保持零变化；AI 候选继续要求来源、证据与置信度。

CORE-202 的应用回滚边界如下：

1. 回退 `6ada51060286aec6285e9d4d6a45d8b2e226521e` 的应用代码即可恢复旧 producer/consumer 行为；
2. 不删除、回退或逆写已创建的 Candidate、旧兼容投影、审计记录或 migration history；
3. 由于 Candidate 与旧投影在同一事务提交，回退后的旧应用仍可读取兼容投影；若发现两者不一致，应停止切换并以前向修复恢复一致性，不得择一覆盖；
4. 回滚后重新验证租户边界、旧 Inbox、人物/关系采纳与拒绝，以及正式 Person/Edge 在未采纳候选下保持不变；
5. 生产部署、数据库替换、main 合并仍需单独批准，本次没有连接或修改阿里云生产。

CORE-203 的强制交接顺序：

1. 先对 PersonSuggestion、RelSuggestion、ChangeProposal、Reminder、pending-review EvidenceEvent 五类来源执行逐租户校验与可重入回填；
2. 确认 source/count/checksum 与 Candidate 投影闭合后，才可把 Inbox 切换为 Candidate 单表读取；
3. 切换后将旧五表冻结为只读兼容数据，不再接受独立写入；
4. CORE-203 cutover 不得删除旧表、旧行、Candidate、审计或 migration 记录，任何收缩删除必须等待后续独立阶段门。

CORE-202 业务提交为 `6ada51060286aec6285e9d4d6a45d8b2e226521e`；[GitHub Actions 32810333868](https://github.com/ZiZ-LG/jianghu/actions/runs/32810333868) 对应精确 SHA 12/12 jobs 成功。
