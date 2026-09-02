# IntelligenceItem 与 StakeholderFocus 迁移回滚说明（SAAS-206）

- **任务：** SAAS-206
- **状态：** 实现与验证完成，未部署生产
- **基线：** `a702b229f28e117e2eeccc0513692cc60ca2b353`
- **启动治理提交：** `6bdd055b49da550db82a656706f0e24a96852c83`
- **业务提交：** `5f2d0568a6f15216d98a8b0f9013ed1c0dfa2aa3`
- **远端证据：** [GitHub Actions 33172038063](https://github.com/ZiZ-LG/jianghu/actions/runs/33172038063)，attempt 1 对应精确业务 SHA，12/12 jobs 成功

## 1. 权威与正式数据边界

`IntelligenceItem` 与 `StakeholderFocus` 是复杂销售能力包中的方法论中立正式对象，不建立第二套 Customer、Matter、Person、Relation 或 Evidence 权威：

- `IntelligenceItem.assertionType` 固定为 `observed | reported | inferred`，默认 `reported`；转述和推断不得通过改标签伪装成 `EvidenceEvent`；
- 情报保存 statement、来源种类与描述、发生／获知时间、置信度和严格作用对象；Interaction 与 Evidence 只作为精确版本来源引用，不复制或改写其正式内容；
- `StakeholderFocus` 是 `stakeholder.focus` 唯一权威。每个 Matter 仅允许一个当前焦点，目标 Person 必须是当前 MatterParticipant；目标变化、理由、依据或证据缺口和有效期由用户明确确认；
- 焦点不读取、不写入、不回填也不降级到 `Opportunity.primaryDPersonId`、G64111 分数、方法论角色或值；
- SAAS-206 不新增 App UI、不修改 legacy Action/store。关系图展示、假设和滚动验证分别留给 SAAS-208、SAAS-207 及其后续任务。

## 2. 来源、状态与并发语义

1. 手工来源不得伪造引用；Interaction 来源要求精确 Interaction 版本，并继续检查底层 SourceArtifact 当前 creator/share ACL、retention 和 Customer/Matter 归属；Evidence 来源只接受同 tenant、Customer、Matter 下 `approved` 的版本 0。
2. 作用对象最多 12 个且不得重复；customer/matter 必须等于父锚，person 必须是当前 MatterParticipant，relation 必须属于同一 tenant/Customer/Matter。
3. 情报更新、归档和恢复使用 `version` CAS；归档默认从列表排除，但历史对象和审计保留。读取时重新解析 canonical JSON，损坏、未知或悬空存储失败关闭。
4. 焦点依据最多 8 个，允许精确 IntelligenceItem、Interaction 或 Evidence 引用；依据为空时必须明确填写 evidence gap。
5. 焦点以 `activeMatterKey=matterId` 和数据库唯一约束保证每个 tenant/Matter 一个当前对象。替换或退役在 Serializable 事务中验证 expected current ID/version；确认人、确认时间和退役人由服务端生成。
6. 到达 `validUntil` 只在读取投影中返回 `expired`，不反写历史行、不自动选择另一人物，也不从 primary D 或方法论角色补位。

## 3. 租户、viewer、幂等与审计

- 所有命令、幂等回放、列表和按 ID 直查均先按 `tenantId` 过滤，再重载当前数据库角色、`sales.workspace`、EffectiveResourceScope、Customer/Matter 父级闭包及引用资源权限；
- viewer 在创建 CommandRun 或 AuditEvent 前即被拒绝写入；读取仍执行 Customer 归属隔离。隐藏资源与不存在资源使用同形 404；
- 正式写入在统一 CommandRunner 事务内再次授权，并按 Idempotency-Key 与规范化 payload 绑定；同 key 改参失败，回放时权限撤销立即生效；
- AuditEvent 和命令回执只保存对象 ID、类型／状态、来源种类、引用版本、置信度、时间、作用对象、变更字段及版本，不保存 statement、source description、desired change、rationale 或 evidence gap 正文；
- Candidate、Agent、AI 或评分代码没有导入正式 writer 的路径。机器建议必须先进入 Candidate；用户确认后才可调用专用命令。

## 4. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| SAAS-206 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260827_pre_saas206.prisma` |
| PostgreSQL expand migration | `20260827000000_expand_intelligence_focus` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260827000000_expand_intelligence_focus/migration.sql` |
| 数据 marker | `SAAS-206-intelligence-focus-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:intelligence-focus-report
npm run migrate:intelligence-focus-apply
npm run migrate:intelligence-focus-verify
```

- `report` 只读检查精确 schema、marker、父级闭包、来源／作用对象、焦点当前唯一性、参与人、依据、时间和用户引用；只输出计数、ID、原因码及非正文 checksum；
- `apply` 只接受精确 predecessor 或 successor 形态，在 schema 完整后以 marker-last 登记零回填收据；不创建情报或焦点，不改 Evidence、primary D、Candidate、ResearchBrief 或方法论数据；
- `verify` 复核 marker version、contract/integrity checksum、canonical JSON、状态、版本和引用闭包；
- 完成 marker 后缺表、未知列／索引、部分 schema、非法既有行或 checksum 漂移均失败关闭；
- 生产 PostgreSQL 只允许版本化 migration 与 `migrate deploy`，禁止 `db push`。

## 5. SQLite 升级与恢复

SQLite 累计升级入口先识别精确 SAAS-204 predecessor、SAAS-206 expanded 或 partial/drift 形态。任何 schema/data 写入前先通过 `VACUUM INTO` 创建明确一致性备份，然后才允许 Prisma expand、精确列／索引检查和 Intelligence/Focus report/apply/verify。

部分表、未知 drift、非法既有行、marker 冲突或引用闭包错误立即停止，并保留失败库、日志和写前备份路径。恢复只能从该明确备份开始并重新验证；禁止手工补表／列、删 marker 或使用生产 `db push` 绕过。

## 6. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 在 SAAS-204 之后处理 SAAS-206：

1. 只接受精确 pre-SAAS-206、expanded、可证明事务回滚，或完整 DDL 已提交但 Prisma 未登记的状态；
2. 已提交完整 DDL 的中断场景先只读 report 和 schema diff，再安全 `migrate resolve --applied`；部分 schema 一律拒绝接管；
3. `prisma migrate deploy` 只执行 expand-only DDL，随后顺序执行 report/apply/verify；marker 最后写入；
4. 根级运维演练覆盖 committed-DDL adoption、语义冲突、marker checksum、partial schema、认证加密备份／隔离恢复、fresh install 和二次更新；
5. 替换生产数据库、执行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准，本说明不构成部署授权。

## 7. 应用与数据回滚边界

SAAS-206 是 expand-only 迁移。未来若获批部署后出现异常：

1. 先停止新的 IntelligenceItem／StakeholderFocus 写入口，再通过正常版本发布回退 SAAS-206 路由、服务和契约消费者；
2. 必须保留 `IntelligenceItem`、`StakeholderFocus` 表与全部行、`DataMigrationState` marker、AuditEvent、CommandRun 和 `_prisma_migrations` 历史；不得删表／列／索引、删 marker 或执行 destructive down migration；
3. 不得把 IntelligenceItem 转写为 Evidence，不得把 StakeholderFocus 复制到 `primaryDPersonId`，也不得从 primary D、G64111 角色／分数或方法论值重建焦点；
4. 已退役、已到期、来源撤权或父级失效的对象继续按当前权限失败关闭；回退不得恢复已撤销可见性；
5. 重新启用前重跑 report/apply/verify，并复核 tenant/viewer、Customer/Matter scope、SourceArtifact ACL、MatterParticipant、CAS、幂等与正式 Evidence/primary-D 零变化；
6. SQLite 只从明确写前备份恢复；PostgreSQL 只经认证备份的隔离恢复验证并另获生产批准。

## 8. 已完成验证

- Domain Contracts：13 files / 126 tests；App：49 files / 362 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests，全部 typecheck/tests 通过；
- Server 当前树完成 Prisma generate、PostgreSQL rendered schema check、typecheck 与 103 files / 866 tests；迁移聚焦 4 files / 74 tests，租户／路由／静态安全矩阵 9 files / 33 tests；
- 本地与远端真实 PostgreSQL 演练均输出 `INTERRUPTED_INTELLIGENCE_FOCUS_AFTER_COMMIT_ADOPTION_OK=1`、`INTELLIGENCE_FOCUS_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`INTELLIGENCE_FOCUS_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_INTELLIGENCE_FOCUS_SCHEMA_FAIL_CLOSED_OK=1`、`INTELLIGENCE_FOCUS_RESTORE_ROLLBACK_OK=1`、`SAAS_206_INTELLIGENCE_FOCUS_MIGRATION_OK=1`、`FRESH_INSTALL_FIRST_RUN_OK=1`、`FRESH_INSTALL_SECOND_UPDATE_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- 精确业务 SHA `5f2d0568a6f15216d98a8b0f9013ed1c0dfa2aa3` 的 [GitHub Actions 33172038063](https://github.com/ZiZ-LG/jianghu/actions/runs/33172038063) attempt 1 完成 12/12 jobs；App build、production images 与全部 dependency audit 同时成功；
- `git diff --check`、唯一 `IN_PROGRESS`、tenant scope、viewer 预检、幂等回放重授权、Evidence/primary-D/方法论零写、机器 writer import 边界、保护路径和高置信密钥扫描均通过。

本任务仅修改了项目所有者为 SAAS-206 明确批准的根级共享运维脚本；未修改 App package/lock/Vite/dist、公共 workflow、主站导航、Nginx、Compose 或“自我修养”专属路径，未部署生产或 Mac mini，未合并 `main`。
