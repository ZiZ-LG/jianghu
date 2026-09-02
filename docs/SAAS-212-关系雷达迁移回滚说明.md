# 关系雷达迁移回滚说明（SAAS-212）

- **任务：** SAAS-212
- **状态：** 实现、主线协调与验证完成，未合并 `main`，未部署生产
- **基线：** `a4308a39b698b5314900bcac7b4155de0778f46b`
- **启动治理提交：** `9963c76ddc3932cf9a0120b61260dc6ccc0ea61d`
- **业务提交：** `648ed5b6f88419013d024c0e903284d368917b8a`
- **主线协调提交：** `f0d30946729c7356b8461bd56090e9b83cc996a3`，父提交为 `origin/main@ff6705c66cfde95577be21a7b4b48158d1d3d648` 与完整 G4 业务提交
- **远端证据：** [GitHub Actions 33495636070](https://github.com/ZiZ-LG/jianghu/actions/runs/33495636070) 对应精确业务 SHA，[GitHub Actions 33575643353](https://github.com/ZiZ-LG/jianghu/actions/runs/33575643353) 对应精确主线协调 SHA；两次均为 12/12 jobs 成功

## 1. 权威与正式数据边界

SAAS-212 新增的是方法论中立、可过期的关系健康派生快照，不建立第二套正式 CRM 权威：

- `RelationshipRadarSnapshot` 只保存严格验证后的通用解释、无正文精确来源引用、六维信号、干预项和未提交行动草稿；不保存来源正文、客户／人员名称、prompt、模型输出、provider 错误或密钥；
- 固定六维为互动新鲜度、单线联系、角色覆盖、可见暖路径、证据新鲜度和下一步完整性；每维独立展示，不生成总分、加权分、排名或方法论值；
- `relationship_radar@saas-212.v1` 是默认停用的 deterministic draft Job，只有 owner/admin 可启停，owner/admin/member 可显式运行，viewer 禁止运行；旧 `core-206.v1` 控制不会自动迁移或启用新版本；
- Agent runner 只暴露一个窄的关系雷达提交端口，在同一 serializable 事务中写一份不可变快照并完成 `AgentRun`；handler 准备阶段零写入、零模型调用；
- RelationshipSignal、InterventionItem 和行动草稿都只是 24 小时派生投影。草稿只有在用户明确点击后才能预填既有 Commitment 编辑器，永不自动提交；
- 任何雷达运行、读取、Today 投影或来源下钻都不能自动创建、采纳、修改或推断正式 Person、Relation、Evidence、Interaction、IntelligenceItem、StakeholderFocus、SalesHypothesis、Commitment、stage、forecast 或关键人状态。

## 2. 六维规则、来源与降级语义

1. 快照始终按固定顺序返回六个 RelationshipSignal，每个信号包含状态、严重度、reason code、通用可见解释、精确来源引用、观察时间、规则版本、过期时间和建议动作。
2. V1 只读取当前可见的正式 Interaction、MatterParticipant、Relation、已审核 Evidence、有效 IntelligenceItem、当前 StakeholderFocus 与 Commitment 元数据；Candidate、Hypothesis overlay、`primaryDPersonId`、ADURC、G64111、pipeline legacy 和方法论角色都不能作为正式事实。
3. V1 不产生 `high` 信号。任何 medium 信号和 InterventionItem 都必须带当前可解析的来源与目标；来源缺失、撤权、归档、父级漂移或版本漂移时，信号降为 `unknown/low`，依赖该来源的干预项被省略，来源不可用绝不能提高严重度。
4. 快照生成时按 canonical payload 和 source set 计算 SHA-256 指纹；同一用户、同一 generation key 幂等绑定一份快照，一个成功 `AgentRun` 只对应一份快照。
5. Today 只消费当前未过期且重新授权后的雷达干预项，仍保持“待确认／待跟进／已完成”三个首层分组；无下一步提示与既有 `matter_without_next_commitment` 去重。
6. 来源下钻只返回当前有权的有界元数据。撤权、版本漂移或父级失效后返回 404／降级投影，不泄露正文、历史可见性或敏感 ACL 信息。

## 3. 租户、viewer、ACL、幂等与审计

- 所有运行、提交、回放、最新快照、Today 投影和来源下钻先按 `tenantId` 过滤，并重载当前数据库角色、`sales.workspace`、EffectiveResourceScope 与 Customer/Matter/source 父级闭包；
- viewer 写入在创建 `AgentRun` 或 AuditEvent 前被拒绝；读取继续执行 Customer primary owner 行级隔离。角色、归属、capability 或父级在回放前撤销时失败关闭；
- 运行提交在 serializable 事务内再次授权并验证精确来源 revision、输出引用与快照一致性；缺失、重复、跨租户、跨 Customer/Matter、handler 自造或过预算引用全部回滚；
- AgentRun 与 AuditEvent 只保存 ID、版本、计数、指纹和状态等无正文元数据，不保存来源正文、解释全文、prompt、模型文本或密钥；
- 雷达读取、Today 投影和来源下钻不创建 AgentRun、CommandRun、AuditEvent 或任何正式 CRM 写入。

## 4. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| SAAS-212 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260831_pre_saas212.prisma` |
| PostgreSQL expand migration | `20260831235900_expand_relationship_radar` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260831235900_expand_relationship_radar/migration.sql` |
| 数据 marker | `SAAS-212-relationship-radar-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:relationship-radar-report
npm run migrate:relationship-radar-apply
npm run migrate:relationship-radar-verify
```

- migration 只新增 portable scalar/text 的 `RelationshipRadarSnapshot` 表、唯一约束与索引；不回填、不删除、不重写现有 CRM、Agent 或审计行；
- report/apply/verify 只接受精确 predecessor、完整 successor 或可证明的事务／登记中断态；未知列／索引、非空预存表、partial schema、语义漂移和 marker checksum 冲突均失败关闭；
- marker 最后写入；marker 已存在时仍必须证明完整 schema、contract checksum 和 integrity checksum；
- PostgreSQL 生产只允许版本化 migration 与 `migrate deploy`，禁止 `db push`。

## 5. SQLite 升级与恢复

SQLite 累计升级入口先识别精确 pre-SAAS-212、完整 expanded 或 partial/drift 形态。任何 schema/data 写入前必须先通过 `VACUUM INTO` 创建明确一致性备份，再执行 Prisma expand、精确表／索引检查及 report/apply/verify。

非空预存表、部分表／索引、未知 drift、marker 冲突或 successor 不一致立即停止，并保留失败库、日志和写前备份路径。恢复只能从该明确写前备份开始并重新执行 report/apply/verify；禁止手工补表、删 marker、改写快照或用生产 `db push` 绕过。

## 6. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 在 SAAS-208 之后处理 SAAS-212：

1. 只接受精确 pre-SAAS-212、完整 expanded、可证明事务回滚，或完整 DDL 已提交但 Prisma 尚未登记的状态；
2. 完整 DDL 中断场景先只读验证 schema 与语义，再安全执行 `migrate resolve --applied`；partial schema 或非空未知表拒绝接管；
3. `prisma migrate deploy` 只执行 expand-only DDL，随后依次执行 report/apply/verify，数据 marker 最后写入；
4. 根级演练覆盖 committed-DDL adoption、语义冲突、marker checksum、partial schema、认证加密备份／隔离恢复、fresh install 和二次更新；
5. 替换生产数据库、执行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准，本说明不构成部署授权。

## 7. 应用与数据回滚边界

SAAS-212 是 expand-only 迁移。未来若另获批准部署后出现异常：

1. 先由 owner/admin 停用 `relationship_radar@saas-212.v1`，再通过正常版本发布隐藏关系雷达、Today 雷达投影、来源下钻和运行控件；
2. 可回退 SAAS-212 应用、契约和路由消费者，但必须保留 `RelationshipRadarSnapshot` 全部历史、`AgentRun`、AuditEvent、`DataMigrationState` marker 与 `_prisma_migrations` 历史；
3. 不得删表／索引／marker，不得清空、重写或重新解释不可变快照，不得把派生信号写回正式 CRM，也不得从 legacy 或方法论字段重建；
4. 角色降级、父级失效、来源撤权或 revision 漂移后继续按当前权限失败关闭；回退不得恢复已撤销可见性；
5. 重新启用前重跑 report/apply/verify，并复核 tenant/viewer、当前角色、capability、父级闭包、精确来源 revision、幂等、快照指纹、Today 去重和正式 CRM 零自动变化；
6. SQLite 只从明确写前备份恢复；PostgreSQL 只经认证备份的隔离恢复验证并另获生产批准。

## 8. 已完成验证

- Domain Contracts：16 files / 147 tests；Server：119 files / 946 tests；App：55 files / 380 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests，全部 typecheck/tests 通过；
- Server 同时完成 Prisma generate、PostgreSQL rendered schema check、双库 migration、tenant/viewer、当前角色、capability、来源 revision、幂等、审计正文最小化、损坏数据和 authority 边界验证；App production build 成功，仅保留既有 chunk-size 提示；
- 本地 PostgreSQL 运维演练输出 `INTERRUPTED_RELATIONSHIP_RADAR_AFTER_COMMIT_ADOPTION_OK=1`、`RELATIONSHIP_RADAR_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`RELATIONSHIP_RADAR_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_RELATIONSHIP_RADAR_SCHEMA_FAIL_CLOSED_OK=1`、`RELATIONSHIP_RADAR_RESTORE_ROLLBACK_OK=1`、`SAAS_212_RELATIONSHIP_RADAR_MIGRATION_OK=1`、`FRESH_INSTALL_FIRST_RUN_OK=1`、`FRESH_INSTALL_SECOND_UPDATE_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- App、Server、Domain Contracts、G64111 与 PDE 的完整及 production-only dependency audit 均为 0 vulnerabilities；production `server`/`web` 镜像构建成功但未启动或部署；
- 主页产物保护单测 12/12 与阿里云 edge release guard 本地演练通过；这不是生产部署或线上变更；
- 精确业务 SHA `648ed5b6f88419013d024c0e903284d368917b8a` 的 [GitHub Actions 33495636070](https://github.com/ZiZ-LG/jianghu/actions/runs/33495636070) 和精确主线协调 SHA `f0d30946729c7356b8461bd56090e9b83cc996a3` 的 [GitHub Actions 33575643353](https://github.com/ZiZ-LG/jianghu/actions/runs/33575643353) 均完成 12/12 jobs；
- `git diff --check`、提交级禁止路径扫描、批准共享文件清单和工作树清洁检查通过；主线协调相对 `origin/main` 的自我修养专属路径为零变化。

SAAS-212 业务提交只修改了项目所有者明确批准的共享根运维脚本 `scripts/test-postgres-ops-integration.sh`；主线协调另纳入项目所有者明确批准的 `app/src/App.tsx` 与 `docker-compose.yml` 既有 G4 差异。未修改“自我修养”专属路径，未合并 `main`，未部署生产、阿里云或 Mac mini。
