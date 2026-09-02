# SalesHypothesis 迁移回滚说明（SAAS-207）

- **任务：** SAAS-207
- **状态：** 实现与验证完成，未部署生产
- **基线：** `bd2f9eec5265853e90e831247733b5e293ed3f4b`
- **启动治理提交：** `805d03c632f41779aef1fe8a22fe736067f39c7c`
- **业务提交：** `2c4f93051c979af02fb2ff8012deb6849605e81b`
- **远端证据：** [GitHub Actions 33360484623](https://github.com/ZiZ-LG/jianghu/actions/runs/33360484623)，对应精确业务 SHA，12/12 jobs 成功

## 1. 权威与正式数据边界

`SalesHypothesis`、`SalesHypothesisRevision` 与 `HypothesisEvidenceLink` 是复杂销售能力包中的方法论中立正式对象，不建立第二套 Customer、Matter、Person、Evidence、关系、阶段或预测权威：

- `SalesHypothesis` 是 `sales.hypothesis` 唯一在线身份、当前 Revision 指针和正式状态权威；
- `SalesHypothesisRevision` 是追加式不可变判断历史，保存 claim、reason、预期信号、反证条件、修订人和修订时间；
- `HypothesisEvidenceLink` 是追加式不可变验证记录，只引用同一当前 Revision 下已审核 Evidence version 0，并明确 supporting 或 contradicting；
- 状态建议是确定性只读投影，不是正式状态，不写库；正式 `untested | testing | supported | contradicted | retired` 只能由用户确认命令修改；
- SAAS-207 不新增 App UI、不修改 legacy Action/store。关系图叠加、验证 Commitment 与滚动复盘留给 SAAS-208；Relationship Radar 留给 SAAS-212。

## 2. Revision、Evidence 与状态语义

1. 用户创建或修订必须提供非空 claim、reason、至少一个预期信号和至少一个反证条件。修订通过 expected version/current Revision 做 CAS，只推进当前指针并把当前判断重置为 `untested`；旧 Revision、链接和审计保持不变。
2. 迁移生成的 `legacy_assumption` Revision 可以显式保留空预期信号、空反证条件和旧 mitigation 缺口；第一次用户修订必须补齐完整内容，运行时不得为旧数据臆造条件。
3. EvidenceLink 只允许追加到命令执行时的当前 Revision；Evidence 必须是同 tenant、Customer、Matter 下 `approved` 的精确 version 0。方向、父级、版本、重复链接或存储损坏均失败关闭。
4. 已被 HypothesisEvidenceLink 引用的 Evidence 不得删除。链接回执、命令结果和 AuditEvent 只保存 ID、版本、方向、状态和时间等无正文元数据。
5. 状态建议规则固定为 `hypothesis-evidence-balance.v1`：只有 supporting 链接建议 `supported`，只有 contradicting 链接建议 `contradicted`，混合或无链接不提出正式状态建议。读取建议不得创建 AuditEvent，也不得修改任何正式对象。
6. owner、Person、next review、review note、状态或 Revision 的任何正式变化都需要用户命令；AI、Agent、Candidate、评分或方法论模块没有导入正式 writer 的路径。

## 3. 租户、viewer、幂等与审计

- 所有创建、修订、复盘元数据、状态、Evidence 链接、幂等回放、列表、按 ID 直查和状态建议均先按 `tenantId` 过滤，再重载当前数据库角色、`sales.workspace`、EffectiveResourceScope、Customer/Matter 父级闭包及可选 MatterParticipant/Evidence 权限；
- viewer 在创建 CommandRun 或 AuditEvent 前即被拒绝写入；读取仍执行 Customer primary owner 隔离。隐藏资源与不存在资源使用同形 404；
- 正式写入在 serializable CommandRunner 事务内再次授权，并把 Idempotency-Key 绑定到规范化 payload。相同 key 改参失败；回放时权限、角色或父级闭包已撤销则立即失败；
- 跨 tenant、跨 Customer、跨 Matter、非参与 Person、未审核／错误版本 Evidence、过期 CAS 或损坏 canonical JSON 均失败关闭；
- 每次操作前后的 Relation、Stage、Forecast、StakeholderFocus、G64111、Methodology 等正式状态均保持零变化；状态建议同样保持 CommandRun、AuditEvent、Candidate、Evidence 和正式 CRM 零写。

## 4. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| SAAS-207 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260830_pre_saas207.prisma` |
| PostgreSQL expand migration | `20260830000000_expand_sales_hypothesis` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260830000000_expand_sales_hypothesis/migration.sql` |
| 数据 marker | `SAAS-207-sales-hypothesis-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:sales-hypothesis-report
npm run migrate:sales-hypothesis-apply
npm run migrate:sales-hypothesis-verify
```

- `report` 只读检查精确 schema、marker、旧 assumption 来源、父级闭包、manual origin、状态映射、稳定 ID/checksum、现有 successor 与不可变 Revision/Link 一致性；只输出计数、ID、原因码和无正文 checksum；
- `apply` 只接受精确 predecessor、完整 successor 或可证明的已提交 DDL 中断态。它先保守回填旧 manual assumption，再以 marker-last 记录结果；不删除、覆盖或改写旧 StrategyRisk；
- `verify` 复核 marker version、contract/integrity checksum、每条 predecessor/successor 映射、Revision 序号／当前指针、canonical arrays、链接语义、状态和父级闭包；
- marker 存在后缺表、未知列／索引、部分 schema、非法行、未知状态／origin、duplicate/orphan、checksum 漂移或不完整 successor 均失败关闭；
- PostgreSQL 标识符长度由 schema-render 回归锁定在 63 bytes 内，migration SQL 与 Prisma 期望索引名必须一致；
- 生产 PostgreSQL 只允许版本化 migration 与 `migrate deploy`，禁止 `db push`。

## 5. 旧 StrategyRisk assumption 回填与冻结

1. 仅迁移 `origin=manual` 且 `kind=assumption` 的有效旧行；非人工来源、空 claim、未知值、重复 ID、悬空／跨父级数据或冲突 successor 一律阻断。
2. 状态映射只允许 `open → untested`、`resolved | dismissed → retired`。迁移绝不推断 `supported` 或 `contradicted`，也不臆造 owner、Person、next review、review note、预期信号、反证条件或 creator identity。
3. successor ID、首个 Revision ID、Revision 编号、legacyStrategyRiskId 和 checksum 采用确定性映射；重跑必须得到完全相同结果，否则失败关闭。
4. marker 验证完成后，旧 assumption 的新增、更新、删除以及 risk↔assumption 转换在 action scope 和 mutate 双层失败关闭。`StrategyRisk(kind=risk)` 的新增、更新、删除和转换外行为保持原样。
5. 旧 assumption 行保留用于审计与非破坏性应用回滚，但不得作为在线读取 fallback、第二权威或长期双写目标；不得根据后来被编辑的旧行重建正式假设。

## 6. SQLite 升级与恢复

SQLite 累计升级入口先识别精确 pre-SAAS-207、完整 expanded 或 partial/drift 形态。任何 schema/data 写入前先通过 `VACUUM INTO` 创建明确一致性备份，然后才允许 Prisma expand、精确列／索引检查和 SalesHypothesis report/apply/verify。

部分表、未知 drift、非法旧行、marker 冲突、父级闭包错误或 successor 不一致立即停止，并保留失败库、日志和写前备份路径。恢复只能从该明确写前备份开始并重新执行 report/apply/verify；禁止手工补表／列、删 marker、改写 Revision/Link 或用生产 `db push` 绕过。

## 7. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 在 SAAS-206 之后处理 SAAS-207：

1. 只接受精确 pre-SAAS-207、完整 expanded、可证明事务回滚，或完整 DDL 已提交但 Prisma 尚未登记的状态；
2. 已提交完整 DDL 的中断场景先只读 report 和 schema diff，再安全 `migrate resolve --applied`；部分 schema 一律拒绝接管；
3. `prisma migrate deploy` 只执行 expand-only DDL，随后顺序执行 report/apply/verify；数据 marker 最后写入；
4. 根级运维演练覆盖 committed-DDL adoption、语义冲突、marker checksum、partial schema、认证加密备份／隔离恢复、fresh install 和二次更新；
5. 替换生产数据库、执行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准，本说明不构成部署授权。

## 8. 应用与数据回滚边界

SAAS-207 是 expand-only 迁移。未来若获批部署后出现异常：

1. 先停止新的 SalesHypothesis 写入口，再通过正常版本发布回退 SAAS-207 路由、服务和契约消费者；
2. 必须保留 `SalesHypothesis`、`SalesHypothesisRevision`、`HypothesisEvidenceLink` 全部表／行、被链接 Evidence、旧 StrategyRisk 前任行、`DataMigrationState` marker、AuditEvent、CommandRun 和 `_prisma_migrations` 历史；不得删表／列／索引、删 marker 或执行 destructive down migration；
3. 不得重写／删除不可变 Revision 或 EvidenceLink，不得恢复 assumption 写入，不得启用 predecessor fallback／长期双写，也不得把确定性建议自动写成正式状态；
4. 角色降级、父级失效、Person 不再参与、Evidence 撤销或 scope 撤权后继续按当前权限失败关闭；回退不得恢复已撤销可见性；
5. 重新启用前重跑 report/apply/verify，并复核 tenant/viewer、Customer/Matter/Person/Evidence 闭包、CAS、幂等回放重授权、Evidence 禁删和 Relation/Stage/Forecast/Focus/G64111/Methodology 零变化；
6. SQLite 只从明确写前备份恢复；PostgreSQL 只经认证备份的隔离恢复验证并另获生产批准。

## 9. 已完成验证

- Domain Contracts：14 files / 134 tests；App：49 files / 362 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests，全部 typecheck/tests 通过；
- Server 当前树完成 Prisma generate、PostgreSQL rendered schema check、typecheck 与 110 files / 895 tests；严格路由、tenant/viewer、幂等、静态 writer 边界、双库迁移和索引长度回归均通过；
- 本地与远端真实 PostgreSQL 演练均输出 `INTERRUPTED_SALES_HYPOTHESIS_AFTER_COMMIT_ADOPTION_OK=1`、`SALES_HYPOTHESIS_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`SALES_HYPOTHESIS_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_SALES_HYPOTHESIS_SCHEMA_FAIL_CLOSED_OK=1`、`SALES_HYPOTHESIS_RESTORE_ROLLBACK_OK=1`、`SAAS_207_SALES_HYPOTHESIS_MIGRATION_OK=1`、`FRESH_INSTALL_FIRST_RUN_OK=1`、`FRESH_INSTALL_SECOND_UPDATE_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- 精确业务 SHA `2c4f93051c979af02fb2ff8012deb6849605e81b` 的 [GitHub Actions 33360484623](https://github.com/ZiZ-LG/jianghu/actions/runs/33360484623) 完成 12/12 jobs；App build、production images 与全部 dependency audit 同时成功；
- `git diff --check`、唯一 `IN_PROGRESS`、tenant scope、viewer 预检、幂等回放重授权、正式数据零写、机器 writer import 边界、保护路径和高置信密钥扫描均通过。

本任务仅修改了项目所有者为 SAAS-207 明确批准的根级共享运维脚本；未修改 App source/Action/package/lock/Vite/dist、公共 workflow、主站导航、Nginx、Compose 或“自我修养”专属路径，未部署生产或 Mac mini，未合并 `main`。
