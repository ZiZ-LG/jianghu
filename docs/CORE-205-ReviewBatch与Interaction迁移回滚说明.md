# ReviewBatch 与 Interaction 迁移回滚说明（CORE-205）

- **任务：** CORE-205
- **状态：** 实现与验证完成，未部署生产
- **基线：** `60ee5384121864ac271e5df49be8120e5a913cab`
- **启动治理提交：** `2c13e8fead393631613e6d2531c6327d0db6566d`
- **业务提交：** `ea9dd7c1bd75335f3fc586b2875f2fb3fe4e3634`
- **远端证据：** [GitHub Actions 32900762234](https://github.com/ZiZ-LG/jianghu/actions/runs/32900762234)，对应精确 SHA `ea9dd7c1bd75335f3fc586b2875f2fb3fe4e3634`，attempt 2 的 12/12 jobs 成功

## 1. 唯一权威与正文边界

CORE-205 没有建立第二张 ReviewCandidate 表：

- `Candidate` 继续是人物、关系、字段、证据和 Commitment 候选的唯一物理权威；
- `ReviewBatch` 只是 tenant-scoped 审核信封，锚定一个已挂载的 `SourceArtifact`，保存活动分类、时间、Customer/Matter、creator/visibility/ACL、版本和不含正文的回执；
- `Interaction` 只保存人工确认的活动元数据和 SourceArtifact 指针，不保存 Note 正文、Transcript 密文/明文、摘录、Candidate evidence 或文件 blob；
- `SourceArtifact` 继续是 body-free 来源投影，正文仍只在原 Note/Transcript 权威中；
- 批次创建、列表、详情、待审和全驳回都不创建 Interaction 或正式 CRM 数据。

AI、连接器和 Job 不能调用正式采纳权威；只有通过当前角色、EffectiveResourceScope、父级闭包与 creator/share ACL 复核的非 viewer 人类写用户才能采纳。

## 2. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| CORE-205 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260825_pre_core205.prisma` |
| PostgreSQL expand migration | `20260825020000_expand_review_batch_interaction` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260825020000_expand_review_batch_interaction/migration.sql` |
| 数据 marker | `CORE-205-review-batch-interaction-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:review-batch-report
npm run migrate:review-batch-apply
npm run migrate:review-batch-verify
```

- `report` 只读检查 ReviewBatch/Interaction schema、SourceArtifact 锚点、Candidate 附着、父级闭包、ACL 世代、状态与回执；
- `apply` 只在可证明的 expanded 形态下写入 marker-last 迁移收据，不自动建批次、不修改 Candidate 业务状态、不创建正式对象；
- `verify` 要求 marker version、contract checksum、integrity checksum 和所有双向语义一致；
- 输出只允许 ID、计数、原因码和非正文 checksum，不记录正文、候选 evidence、凭据或密钥；
- 生产 PostgreSQL 只允许版本化 migration 和 `migrate deploy`，禁止 `db push`。

## 3. 整批人审与幂等事务

1. 批次创建必须在 Serializable 事务内重新加载 actor、SourceArtifact、当前 scope/ACL 和全部 Candidate；任意跨租户、跨来源、父级不闭合、creator/visibility/ACL 不同、已终态或已附着行均整批失败。
2. 采纳以 `reviewBatchId + acceptanceVersion` 作为业务幂等身份，交通层 `Idempotency-Key` 是额外保护；同一 canonical request 重放返回原回执，改参、过期版本或并发败者失败关闭。
3. 所有选中项在任何正式写入前完成预检。任一冲突返回确定性逐项结果，Person、Edge、EvidenceEvent、PlanAction、Interaction、Candidate 和审计都不发生静默部分写入。
4. 人物、关系、字段、证据和 Commitment 分别复用现有正式权威、CAS、审计和 tenant 边界；字段继续使用 `Customer.categoryKey` 等现有单一权威，不引入平行分类。
5. 只有至少一项成功采纳时才确定性创建或校验一个 body-free Interaction；全驳回批次关闭且 `interactionId` 为空。
6. 回放也必须重新授权：角色降级、Matter 转移、scope 撤销、ACL/grant 世代变化或 SourceArtifact tombstone 会立即阻断新写入。

## 4. SQLite 升级与恢复

SQLite 累计升级入口的顺序是：

1. 识别精确 legacy、expanded 或 partial/drift 形态；
2. legacy 形态在任何 Prisma DDL 前先运行 `migrate:review-batch-report`，既有 Candidate 如果带有未登记批次附着会在重建表前失败关闭；
3. 需要改变 schema/data 时先用 `VACUUM INTO` 创建明确一致性备份，再执行 SQLite expand；
4. DDL 后精确校验表/列/索引，然后 report/apply/verify；
5. marker 和所有语义通过后才结束。

失败时停止 Node 进程，保留失败库、日志与明确备份路径，从该写前备份恢复后重新验证。禁止手工补表/列、删 marker 或在生产使用 `db push`。

## 5. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 按 CORE-203 Candidate、CORE-204 ACL、SAAS-201 SourceArtifact、CORE-205 ReviewBatch/Interaction 的依赖顺序：

1. 只接受精确 pre-CORE-205、expanded、可证明的事务中断或 DDL 已提交未登记状态；
2. expand migration 在建表前锁定并验证 `Candidate` 与 `SourceArtifact` 附着语义，不 UPDATE/DELETE Candidate、SourceArtifact 或任何正式表；
3. 通过 `prisma migrate deploy` 执行 expand-only DDL，再顺序执行 report/apply/verify；
4. partial schema、未知 drift、附着冲突、marker checksum 或回执身份漂移均非零退出并阻止应用启动；
5. 失败恢复必须先用认证加密备份在隔离数据库验证。替换目标库、运行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准。

## 6. 应用与数据回滚边界

CORE-205 是 expand-only schema 迁移。未来若获批部署后发生异常：

1. 优先前向修复；确需应用回退时，通过正常版本发布流程回退 CORE-205 应用代码，但保留 ReviewBatch/Interaction 表、Candidate 附着、marker、AuditEvent、CommandRun 和 `_prisma_migrations` 历史；
2. 不删表/列/索引，不把 migration 标记为 rolled back，不删 marker，不重置 acceptanceVersion 或把已处理 Candidate 改回待审；
3. 已人审采纳的 Person/Edge/Evidence/Commitment/Interaction 是带审计的正式业务事实，不得因应用回退而删除或逆写；业务纠错必须走新的人工命令和审计链；
4. 重新启用前重跑 report/apply/verify，并验证 tenant/viewer、Customer/Matter scope、creator/share ACL、SourceArtifact tombstone、全驳回零 Interaction 和幂等重放；
5. 数据库替换、阿里云发布/回滚和生产 migration 都是独立生产变更，本说明不构成部署授权。

## 7. 已完成验证

- Server：Prisma generate、PostgreSQL rendered schema check、typecheck、80 files / 650 tests 全绿；聚焦 ReviewBatch/Candidate/SourceArtifact/migration 组合 11 files / 137 tests 全绿；
- Domain contracts：8 files / 87 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests；App：42 files / 326 tests，全部 typecheck/tests 全绿；
- 本地未运行会写共享 `app/dist/**` 的 App production build；精确 SHA CI 在隔离环境完成 App build 和 production-images gate；
- SQLite 累计升级覆盖 legacy pre-DDL attachment drift 失败关闭，PostgreSQL 真实演练输出 `INTERRUPTED_REVIEW_BATCH_AFTER_COMMIT_ADOPTION_OK=1`、`REVIEW_BATCH_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`REVIEW_BATCH_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`REVIEW_BATCH_ATTACHMENT_DRIFT_FAIL_CLOSED_OK=1`、`PARTIAL_REVIEW_BATCH_SCHEMA_FAIL_CLOSED_OK=1`、`REVIEW_BATCH_RESTORE_ROLLBACK_OK=1`、`CORE_205_REVIEW_BATCH_MIGRATION_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- 路由/生产者清单、body-free schema/返回/审计、无第二 Candidate 表、预审正式态零写、`git diff --check`、Shell 语法、共享/自我修养保护路径和高置信密钥扫描全部通过；
- 精确 SHA `ea9dd7c1bd75335f3fc586b2875f2fb3fe4e3634` 的 [Actions 32900762234](https://github.com/ZiZ-LG/jianghu/actions/runs/32900762234) 首次 PostgreSQL job 在首段无诊断异常短退；同 SHA 开启 debug 后的 failed-job 重跑完成整套故障注入、认证恢复、fresh install/update，attempt 2 最终 12/12 jobs 成功并以 `POSTGRES_OPS_INTEGRATION_OK=1` 结束；
- 公共 CI 的既有 Node 20 弃用提示未在本任务修改；公共 workflow 属于共享文件，后续升级仍须单独批准。

CORE-205 未修改 Action/domain-contract/App、共享高冲突文件或“自我修养”专属路径，未部署生产、未合并 main。
