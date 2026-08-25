# Unified Candidate 迁移与回滚说明（CORE-201～CORE-203）

- **任务：** CORE-201、CORE-202、CORE-203
- **状态：** Candidate 已完成五类来源回填、写入收敛与 Inbox 切换；未部署生产
- **基线：** `558d22a5971626eedd1cae42cddd45bccc10cb14`
- **CORE-201 业务/稳定性提交：** `a2e579ba80b9e8939bc23099f507d58995730fd9`、`05ae8b3bc99a15740aa67064e3d0a7454d2c1876`
- **CORE-202 业务提交：** `6ada51060286aec6285e9d4d6a45d8b2e226521e`
- **CORE-203 业务提交：** `b5b6c30e898e06e410921538b06ee978b3efd0e7`
- **远端证据：** [CORE-201 Actions 32803198527](https://github.com/ZiZ-LG/jianghu/actions/runs/32803198527)、[CORE-202 Actions 32810333868](https://github.com/ZiZ-LG/jianghu/actions/runs/32810333868)、[CORE-203 Actions 32820222548](https://github.com/ZiZ-LG/jianghu/actions/runs/32820222548)，均为对应精确 SHA 12/12 jobs 成功

## 1. 当前权威与兼容边界

从 CORE-203 起，统一 `Candidate` 是以下五类候选的唯一在线权威：

| Candidate kind | 兼容投影 |
|---|---|
| `person_create` | `PersonSuggestion` |
| `relation_create` | `RelSuggestion` |
| `field_change` | `ChangeProposal` |
| `reminder` | `Reminder` |
| `evidence` | machine `pending_review EvidenceEvent` |

必须同时满足：

- producer、审核、拒绝、merge 与引用改写只能调用 `server/src/candidates/personRelation.ts` 或 `server/src/candidates/reviewItems.ts`；
- 旧五表只由 Candidate helper 在同一事务内维护，作为旧专用 API 与应用回滚所需的兼容投影；不得独立写入，也不得删除；
- `/api/inbox` 只查询 pending Candidate，不读取或回退到旧五表；缺少有效回填 marker 时失败关闭；
- Candidate payload、状态、版本、来源、证据、置信度与创建者是审核权威；兼容投影不反向覆盖 Candidate；
- viewer 继续拒写；所有查询、写入、父实体校验与审核均按 `tenantId` 和 EffectiveResourceScope 收敛；
- 机器 Evidence 只能先形成候选；可信人工 Evidence 可直接创建正式 `approved EvidenceEvent`。Candidate 审核前不得改变正式 Person、Relation、字段、Commitment、PDE 状态或关键人状态。

## 2. Schema、marker 与命令映射

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| CORE-201 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260824_pre_core201.prisma` |
| PostgreSQL expand migration | `20260824000000_expand_candidate_foundation` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260824000000_expand_candidate_foundation/migration.sql` |
| 五来源回填 marker | `CORE-203-candidate-backfill-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

Candidate 数据步骤有三个明确命令：

```bash
cd server
npm run migrate:candidate-report
npm run migrate:candidate-apply
npm run migrate:candidate-verify
```

- `migrate:candidate-report`：只读预演，用于 expand 前、恢复诊断或人工核对；不写 Candidate、来源表或 marker。
- `migrate:candidate-apply`：在一个可重试事务内校验五来源、补齐缺失 Candidate、核对已存在 Candidate 的完整语义，并在所有 parity 成功后最后写 marker。
- `migrate:candidate-verify`：要求 marker 存在且 receipt 结构、版本和 checksum 有效，再执行五来源与 Candidate 的双向数量/语义 parity；不修改数据。

输出只包含计数、类型、ID、原因码和非敏感 checksum，不输出 Evidence、rawContent、Transcript 或 Candidate payload 正文。

生产 PostgreSQL 只允许版本化 migration 与 `prisma migrate deploy`。禁止对生产运行 `prisma db push`；仓库测试里的 `db push` 只用于临时数据库或 SQLite 开发升级。

## 3. Marker 与 fail-closed 契约

`CORE-203-candidate-backfill-v1` 是一次完整、可验证的回填收据，不是绕过实时一致性检查的开关：

1. apply 先验证所有租户、父 Customer/Matter/Person/Commitment、状态、创建者和来源语义；
2. 只创建稳定 legacy identity 尚未关联的 Candidate；已关联行必须完整一致，不能“最后写入覆盖”；
3. 五来源与 Candidate 双向计数、payload、状态、来源、证据、置信度和时间语义闭合后才写 marker；
4. receipt 的版本、结构与 contract checksum 固定；缺失、损坏、未知版本或 checksum 漂移一律失败关闭；
5. apply 可从“Candidate 已写但 marker 未写”的中断状态恢复；重复运行必须幂等；
6. 相同 sourceRef 但 Evidence payload 变化、Reminder 被移动到另一父对象、跨租户/悬空父级、未知 kind/payload 或终态冲突均停止迁移，禁止猜测合并；
7. marker 存在后仍必须运行 verify；任何后续 legacy 应用写入造成的 parity 漂移会使重新切换失败，必须先以前向修复恢复一致性。

## 4. SQLite 升级流程

SQLite 升级入口会在任何 schema 或数据变化前通过 `VACUUM INTO` 创建一致性写前备份，然后：

1. 判定 Candidate schema 为 `uninitialized | legacy | expanded | partial`；
2. 对 `legacy` 执行 expand，对 `expanded` 校验精确 shape；`partial`/drift 立即停止；
3. 运行只读 report；
4. 运行 apply，写入五来源 Candidate 与 marker；
5. 运行 verify，确认双向 parity 后才完成升级。

升级失败时不得继续启动新应用。文件级恢复必须先完全停止 Node 进程，保留失败数据库和日志，再从升级日志打印的明确备份路径恢复；恢复后重新验证旧五表、租户边界和 Candidate 状态。不得用未解析变量、通配符或 `db push` 对生产文件做修复。

## 5. PostgreSQL migrate deploy 流程

`server/scripts/deploy-postgres-migrations.sh` 负责：

1. 等待数据库就绪并判定已知 schema 状态；
2. 对事务中断、已提交但未登记、部分 schema 或 drift 分别处理；只有精确匹配的 expanded shape 可被认证接管；
3. 调用 `prisma migrate deploy` 执行版本化 expand migration；
4. 运行 Candidate report、apply 和 verify；
5. 任一 schema、marker 或双向 parity 检查失败即非零退出，不启动依赖 Candidate-only Inbox 的应用。

`partial` 或未知 drift 不得自动补列、删表或强制 resolve。必须先用 `scripts/restore-postgres.sh` 把认证加密备份恢复到隔离数据库并完成校验；替换目标数据库、修改生产或执行回滚仍须项目所有者单独批准。

## 6. 应用回滚

CORE-203 未执行破坏性 contract migration。若未来部署后应用行为异常，首选前向修复；确需回滚时：

1. 停止继续发布，保留故障日志和当前数据库；
2. 通过正常版本发布流程回退 `b5b6c30e898e06e410921538b06ee978b3efd0e7` 的应用行为，恢复 CORE-203 前的旧 Inbox/producer consumer；
3. 保留 Candidate 表、所有 Candidate 行、旧五表兼容投影、`DataMigrationState` marker、AuditEvent、PDE snapshot 与 `_prisma_migrations` 历史；
4. 不删除 marker，不把已应用 migration 标记为 rolled back，不逆写 Candidate 或正式业务数据；
5. 旧应用回滚期间若再次独立写旧五表，现有 marker 不再代表实时 parity。重新启用 Candidate-only Inbox 前必须重跑 apply/verify；冲突必须以前向修复解决；
6. 回滚后验证旧 Inbox、人物/关系/字段/Evidence 审核、Reminder、租户/父树/viewer 边界，以及未采纳候选不改变正式态；
7. 数据库文件恢复或目标库替换是独立生产变更，不因应用回滚自动获批。

旧五表是必要的回滚能力，不是新的在线权威。任何删除旧表、旧行、Candidate、marker 或兼容 API 的 contract 动作，必须等待消费者清单为零、恢复演练成功及后续独立阶段门。

## 7. 已完成验证

- 聚焦 Candidate/Inbox/producer/batch/merge/tenant：11 files / 126 tests；
- Server：70 files / 539 tests，typecheck 与 Prisma generate 成功；
- Domain contracts：8 files / 87 tests；
- G64111：2 files / 32 tests；
- PDE kernel：3 files / 25 tests；
- App：42 files / 326 tests，typecheck 成功；本地未写共享 `app/dist/**`，精确 SHA CI 的隔离 production build 成功；
- PostgreSQL 真实演练：marker 缺失恢复、checksum 漂移、语义冲突、部分 schema、认证备份/恢复、fresh install 与重复升级均通过；
- 关键标记：`CANDIDATE_BACKFILL_APPLY_OK=1`、`CANDIDATE_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`CANDIDATE_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`CORE_203_CANDIDATE_CUTOVER_OK=1`、`POSTGRES_OPS_INTEGRATION_OK=1`；
- CORE-203 精确 SHA CI：`b5b6c30e898e06e410921538b06ee978b3efd0e7`，[Actions 32820222548](https://github.com/ZiZ-LG/jianghu/actions/runs/32820222548)，12/12 jobs 成功；
- `git diff --check`、旧表旁路写入清单、密钥模式扫描、共享/自我修养保护路径检查均通过。

CORE-201～203 均未部署生产、未合并 main；CORE-203 未修改 Prisma schema、migration、Action、App、共享高冲突文件或“自我修养”专属路径。
