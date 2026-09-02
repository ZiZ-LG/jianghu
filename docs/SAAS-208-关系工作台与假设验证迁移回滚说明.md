# 关系工作台与假设验证迁移回滚说明（SAAS-208）

- **任务：** SAAS-208
- **状态：** 实现与验证完成，未部署生产
- **基线：** `1d7f06950a7d1a2f4444f35c85bb5fcda37a9160`
- **启动治理提交：** `7dd49eb8d0dfa0c89409fc8de404a83c3abaeedb`
- **业务提交：** `e5503e37f8d1ec0ad5fee1f263efc586f0b96b44`
- **远端证据：** [GitHub Actions 33429254792](https://github.com/ZiZ-LG/jianghu/actions/runs/33429254792)，对应精确业务 SHA，12/12 jobs 成功

## 1. 权威与正式数据边界

SAAS-208 只把既有正式权威装配进一个轻量关系工作台，并在同一 `PlanAction` 上闭合假设验证；它不建立第二套 Customer、Matter、Person、Relation、Intelligence、Focus、Hypothesis、Evidence 或 Commitment 权威：

- 正式 `Relation` 始终以实线显示；当前有权且仍为 pending 的关系 Candidate 只以灰色虚线 `?` 投影，查看不会采纳或写正式关系；
- `IntelligenceItem` 保留 `observed | reported | inferred`、来源、发生／获知时间与置信度，时效只按时间确定性展示，不生成风险分数；
- 当前关键人高亮只读取 `StakeholderFocus`，不读取、写入或回退 `primaryDPersonId`、ADURC、G64111 分数或方法论角色；
- `SalesHypothesis` 与不可变 Revision 继续是正式假设权威；显式 Person 假设以点线注释，Matter 级假设只在列表中展示，不臆造 Person 或 Relation；
- 验证 Commitment 仍使用现有 `PlanAction` 行，只增加精确 hypothesis/current Revision 指针、人工完成结果和一次性复盘处置；不存在第二张任务表、fallback 或长期双写；
- AI、Agent、Candidate、情报或 Evidence 均不能自动改变正式关系、假设状态、阶段、预测、Focus 或关键人状态。正式 keep/revise/retire 只能由用户命令触发。

## 2. 验证 Commitment 与滚动复盘语义

1. `CREATE_COMMITMENT` 可选携带完整 `hypothesisRef`，两条指针必须同时存在并固定命令执行时的当前 Revision；旧 Commitment、Quick Capture 和 Today 路径继续使用空指针。
2. 只有已完成、仍链接当前验证周期且尚未复盘的 Commitment 才能执行 `RECORD_COMMITMENT_RESULT`；结果为 1–2,000 字符的人写内容，复盘后冻结。
3. `LINK_HYPOTHESIS_EVIDENCE` 可选引用精确 verification Commitment。引用时 Evidence 必须为同 tenant、Customer、Matter、Hypothesis、当前 Revision 下已审核的 version 0，且 Commitment 已完成；链接保持追加式不可变并继续阻止 Evidence 删除。
4. `REVIEW_HYPOTHESIS_VERIFICATION` 必须先证明存在人工结果或该验证周期的已审核 Evidence，再一次性执行：
   - `keep`：保留 claim/status，设置未来复盘时间；
   - `revise`：追加完整不可变 Revision，并按 SAAS-207 规则重置正式状态；
   - `retire`：通过既有人工状态规则将假设置为 `retired`。
5. 完成 Commitment、出现 supporting/contradicting Evidence 或生成只读建议均不会自动复盘。回执、`CommandRun.result` 与 AuditEvent 只记录 ID、版本、处置和时间等无正文元数据。
6. 复盘 readiness 只读确定性投影为 `planned | awaiting_result_or_evidence | ready_for_review | reviewed | superseded_revision`；不创建黑盒分数、RelationshipSignal 或 InterventionItem。

## 3. 租户、viewer、ACL、幂等与审计

- 工作台读取、Commitment 创建／结果、Evidence 链接、复盘命令及幂等回放均先按 `tenantId` 过滤，并重载当前数据库角色、`sales.workspace`、EffectiveResourceScope 和 Customer/Matter/Person/Relation/Hypothesis/Revision/Commitment/Evidence 父级闭包；
- viewer 写入在创建 `CommandRun` 或 AuditEvent 前被拒绝；读取继续执行 Customer primary owner 行级隔离。隐藏资源与不存在资源使用同形响应；
- Candidate 的 locator、quote 和来源投影还要求当前 ReviewBatch/Candidate/SourceArtifact ACL。权限撤销、来源不一致、payload 损坏或 endpoint 缺失时只省略该 Candidate，不扩大其他读取；
- 正式命令在 serializable 事务内再次授权，Idempotency-Key 绑定规范化 payload；同 key 改参失败，回放时角色、scope、ACL 或父级已撤销也失败；
- 跨 tenant／Customer／Matter、过期 Revision、非当前参与人、错误 Evidence 版本、未完成／已复盘 Commitment、过期 CAS 或损坏存储均失败关闭；
- 只读工作台不创建 AuditEvent、CommandRun、Candidate、Relation、Evidence、Focus、假设变化、Commitment 变化、AgentRun 或方法论值。

## 4. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| SAAS-208 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260831_pre_saas208.prisma` |
| PostgreSQL expand migration | `20260831000000_expand_hypothesis_commitment_review` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql` |
| 数据 marker | `SAAS-208-hypothesis-commitment-review-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:hypothesis-commitment-review-report
npm run migrate:hypothesis-commitment-review-apply
npm run migrate:hypothesis-commitment-review-verify
```

- migration 只为 `PlanAction` 增加 nullable/defaulted 假设指针、人工结果与复盘元数据，并为 `HypothesisEvidenceLink` 增加 nullable verification Commitment 指针；不回填、不删除、不重写现有业务行；
- report/apply/verify 只接受精确 predecessor、完整 successor 或可证明的事务／登记中断态；partial schema、未知列／索引、marker checksum、非法配对元数据、父级或 Revision 语义漂移均失败关闭；
- marker 最后写入；已存在 marker 时必须同时证明完整 schema、contract checksum 和 integrity checksum；
- PostgreSQL 生产只允许版本化 migration 与 `migrate deploy`，禁止 `db push`。

## 5. SQLite 升级与恢复

SQLite 累计升级入口先识别精确 pre-SAAS-208、完整 expanded 或 partial/drift 形态。任何 schema/data 写入前都必须先用 `VACUUM INTO` 创建明确一致性备份，再执行 Prisma expand、精确列／索引检查和 report/apply/verify。

部分列／索引、未知 drift、非法配对元数据、跨父级引用、marker 冲突或 successor 不一致立即停止，并保留失败库、日志和写前备份路径。恢复只能从该明确写前备份开始并重新执行 report/apply/verify；禁止手工补列、删 marker、改写结果／处置或用生产 `db push` 绕过。

## 6. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 在 SAAS-207 之后处理 SAAS-208：

1. 只接受精确 pre-SAAS-208、完整 expanded、可证明事务回滚，或完整 DDL 已提交但 Prisma 尚未登记的状态；
2. 已提交完整 DDL 的中断场景先做只读 schema/语义检查，再安全执行 `migrate resolve --applied`；partial schema 一律拒绝接管；
3. `prisma migrate deploy` 只执行 expand-only DDL，随后依次执行 report/apply/verify，数据 marker 最后写入；
4. 根级演练覆盖 committed-DDL adoption、语义冲突、marker checksum、partial schema、认证加密备份／隔离恢复、fresh install 和二次更新；
5. 替换生产数据库、执行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准，本说明不构成部署授权。

## 7. 应用与数据回滚边界

SAAS-208 是 expand-only 迁移。未来若获批部署后出现异常：

1. 先停止新的验证结果、Evidence 链接和复盘写入口，再通过正常版本发布隐藏关系工作台并回退 SAAS-208 路由、服务、前端和契约消费者；
2. 必须保留 `PlanAction` 新字段及其全部结果／处置、`HypothesisEvidenceLink.verificationCommitmentId`、链接 Evidence、SalesHypothesis/Revision、`DataMigrationState` marker、AuditEvent、CommandRun 和 `_prisma_migrations` 历史；
3. 不得删列／索引／marker，不得清空或重新解释已完成结果和一次性处置，不得把 Candidate 转正式 Relation，也不得从 legacy primary D、ADURC、G64111 或 StrategyRisk assumption 重建正式对象；
4. 角色降级、父级失效、来源撤权、Person 不再参与或 Evidence 撤销后继续按当前权限失败关闭；回退不得恢复已撤销可见性；
5. 重新启用前重跑 report/apply/verify，并复核 tenant/viewer、父级闭包、Candidate/Source ACL、CAS、幂等回放重授权、Evidence 禁删和正式 Relation/Stage/Forecast/Focus/G64111/Methodology 零自动变化；
6. SQLite 只从明确写前备份恢复；PostgreSQL 只经认证备份的隔离恢复验证并另获生产批准。

## 8. 已完成验证

- Domain Contracts：15 files / 142 tests；Server：114 files / 919 tests；App：53 files / 372 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests，全部 typecheck/tests 通过；
- Server 同时完成 Prisma generate、PostgreSQL rendered schema check、双库 migration、严格路由、tenant/viewer、当前角色、幂等、审计正文最小化、损坏数据和 authority 边界验证；App production build 成功，仅保留既有 chunk-size 提示；
- 本地 PostgreSQL 运维演练输出 `INTERRUPTED_HYPOTHESIS_COMMITMENT_REVIEW_AFTER_COMMIT_ADOPTION_OK=1`、`HYPOTHESIS_COMMITMENT_REVIEW_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`HYPOTHESIS_COMMITMENT_REVIEW_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_HYPOTHESIS_COMMITMENT_REVIEW_SCHEMA_FAIL_CLOSED_OK=1`、`HYPOTHESIS_COMMITMENT_REVIEW_RESTORE_ROLLBACK_OK=1`、`SAAS_208_HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_OK=1`、`FRESH_INSTALL_FIRST_RUN_OK=1`、`FRESH_INSTALL_SECOND_UPDATE_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- 精确业务 SHA `e5503e37f8d1ec0ad5fee1f263efc586f0b96b44` 的 [GitHub Actions 33429254792](https://github.com/ZiZ-LG/jianghu/actions/runs/33429254792) 完成 12/12 jobs；App build、production images、PostgreSQL operations 与全部 dependency audit 同时成功；
- `git diff --check`、提交级禁止路径扫描、唯一共享文件 allowlist 和工作树清洁检查通过。

本任务仅修改了项目所有者为 SAAS-208 明确批准的根级共享运维脚本 `scripts/test-postgres-ops-integration.sh`；未修改 App package/lock/Vite/dist、公共 workflow、主站导航、Nginx、Compose 或“自我修养”专属路径，未部署生产、阿里云或 Mac mini，未合并 `main`。
