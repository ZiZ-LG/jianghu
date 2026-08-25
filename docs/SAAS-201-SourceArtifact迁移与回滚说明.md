# SourceArtifact 投影迁移与回滚说明（SAAS-201）

- **任务：** SAAS-201
- **状态：** 实现与验证完成，未部署生产
- **基线：** `a5ef723d7d7d7653b44c5d9cf8d8aa339e36e5e9`
- **启动治理提交：** `e452970d58e880f12385328d1b8987459f6ba49c`
- **业务提交：** `c454fbb751817f0480e7257ab1a2fd74a2e8cb09`
- **远端证据：** [GitHub Actions 32877939477](https://github.com/ZiZ-LG/jianghu/actions/runs/32877939477)，对应精确 SHA `c454fbb751817f0480e7257ab1a2fd74a2e8cb09`，12/12 jobs 成功

## 1. 单一投影与正文权威

`SourceArtifact` 是来源资料的唯一元数据投影，不是第二份正文仓库：

| 来源类型 | 正文/原件唯一权威 | SourceArtifact 保存内容 |
|---|---|---|
| Note | `Note.content` | tenant、父级、creator/visibility/ACL、来源、时间、指纹、留存状态 |
| Transcript | `Transcript.contentEnc` | 同上；不复制、解密或返回密文/明文 |
| 上传文件 | 解析文本加密后仍只在 `Transcript.contentEnc` | `artifactKind=uploaded_file` 与稳定 `upload:<raw-file-sha256>` 外部引用 |
| 外部引用 | 无本地正文 | creator-domain/source/externalRef、挂载、指纹与 `reference_only` 状态 |

正文边界不可放宽：SourceArtifact schema、接口、审计和命令回执都不得出现 Note 正文、Transcript 密文/明文、原文件 blob 或凭据。SAAS-201 不写 Candidate `sourceArtifactId`，不创建 ReviewBatch、Interaction、Evidence 或其他正式业务事实。

## 2. 身份、指纹与留存契约

1. 本地 Note/Transcript 使用 `(tenantId, backingKind, backingId)` 唯一身份；外部引用使用 `(tenantId, immutable creator idempotencyDomain, source, externalRef)`，不同 creator/tenant 之间不共享存在性。
2. 可用 Note 的 `content_sha256_v1` 直接对当前 `Note.content` 权威值计算；可用 Transcript/上传转写直接对持久化的 `Transcript.contentEnc` 密文权威值计算。计算过程不记录输入或 digest，也不为迁移解密 Transcript。
3. 外部引用与迁移前已经清空正文的 Transcript 使用 canonical reference metadata 生成 `reference_sha256_v1`。运行时从可用态降解时保留最后一个内容指纹，不以空正文重写。
4. `available` 表示当前 backing 与正文标志一致；`degraded` 表示 Transcript backing 仍在但原密文已清空；`reference_only` 表示仅有外部引用；`deleted` 保留元数据 tombstone 且本地 backing 必须不存在。
5. marker 存在后，缺失投影、正文指纹漂移、父级/creator/ACL 漂移、非法状态或 checksum 漂移均失败关闭，不自动修补或静默重写。
6. Transcript 的密钥可用性仍由实际解密/抽取路径验证；SAAS-201 迁移只校验持久化密文权威及状态一致性，避免迁移日志或回填引入解密面。

## 3. API 与实时权限

所有 `/api/source-artifacts*` 路由继续位于现有 `sales.workspace` capability 边界：

- list/detail 只选择元数据，按 tenant、当前数据库角色、EffectiveResourceScope、父级闭包和 creator/share ACL 过滤；隐藏与不存在使用相同 404；
- external register、mount、visibility、degrade、delete 均要求有效 `Idempotency-Key`，使用 Serializable transaction、预期 `aclVersion` 和不含正文的 AuditEvent；
- viewer 写入在副作用前拒绝；角色降级、Matter 转移、ACL 变化和重放都会重新验证当前可管理范围；
- re-mount 同时验证旧资源可管理性与新 Customer/Matter/Person 目标闭包；`matter_shared` 不得直接解除 Matter 挂载；
- 精确 creator-domain 外部引用可由匹配的 Transcript 导入原子接管，保留 artifact ID、挂载、visibility 与 ACL 世代；跨 creator、跨 tenant 或挂载冲突失败关闭；
- lifecycle 响应根据实时 backing existence、正文标志和 retention state 计算，不把投影标志当作正文仍存在的证明。

## 4. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| SAAS-201 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260825_pre_saas201.prisma` |
| PostgreSQL expand migration | `20260825010000_expand_source_artifact_projection` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260825010000_expand_source_artifact_projection/migration.sql` |
| 数据 marker | `SAAS-201-source-artifact-projection-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:source-artifact-report
npm run migrate:source-artifact-apply
npm run migrate:source-artifact-verify
```

- `report` 逐租户只读枚举 Note、Transcript、SourceArtifact、creator 与父级闭包，只输出计数、ID、原因码和非正文 checksum；
- `apply` 使用 Serializable 单事务补齐确定性投影、修正可证明的 pre-marker metadata，全部 parity 通过后最后写 marker；
- `verify` 要求 marker 版本/contract checksum/integrity checksum 有效，并重跑双向 backing、父级、ACL、指纹和留存校验；
- PostgreSQL 生产只允许版本化 migration 与 `migrate deploy`，禁止 `db push`；
- marker 已存在后的缺失或漂移不是普通回填条件。生产不得手工删 marker、强制 resolve 或直接改列来绕过失败。

## 5. SQLite 升级与恢复

SQLite 升级脚本在任何 schema/data 写入前通过 `VACUUM INTO` 创建明确的一致性备份，然后：

1. 同时识别 CORE-204 精确旧形态、SAAS-201 expanded 形态与 partial/drift；
2. 对旧形态执行 Prisma expand，对 expanded 形态做精确列/索引校验；partial/drift 立即停止；
3. 在 CORE-204 ACL verify 后执行 SourceArtifact report/apply/verify；
4. 只有 marker 与全部投影语义通过才完成升级。

失败时停止 Node 进程并保留失败库、输出和明确备份路径；从该写前备份恢复后重新验证。不得用通配符、未解析变量、手工补列或生产 `db push` 修复。

## 6. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 按依赖顺序执行 CORE-204 后的 SAAS-201：

1. 识别精确 pre-SAAS-201、expanded、事务中断或 partial/drift 状态；
2. PostgreSQL 已回滚的中断事务可登记为 rolled back 后安全重放；完整 DDL 已提交但 Prisma 未登记时，只有 schema 与只读 report 同时可证明才允许接管；
3. 运行 `prisma migrate deploy` 完成 expand-only DDL，再顺序执行 report/apply/verify；
4. 部分 schema、未知 drift、语义冲突、marker checksum 或投影指纹漂移均非零退出并阻止应用启动；
5. 失败恢复必须先使用认证加密备份在隔离数据库验证。替换目标数据库、执行生产恢复、修改阿里云或发布应用仍须项目所有者单独批准。

## 7. 应用与数据回滚边界

SAAS-201 是 expand-only schema 迁移。若未来获批部署后应用异常：

1. 优先关闭 SourceArtifact 新路由或按正常版本发布流程回退业务提交，保留所有 expand 字段、投影、tombstone、AuditEvent、DataMigrationState 与 `_prisma_migrations` 历史；
2. 不删除 SourceArtifact 行/列/索引，不把 migration 标为 rolled back，不把 marker 当修复开关，不逆写 Note/Transcript 正文；
3. 回退应用后，旧 Note/Transcript 路径仍是正文权威。重新启用 SAAS-201 前必须重跑 report/apply/verify，冲突只以前向修复或经批准的认证恢复处理；
4. degrade/delete 是用户触发的正文删除行为，tombstone 不能重建已清除内容。需要恢复正文只能依赖事先存在且获准使用的合法备份；不得从指纹反推内容；
5. 回退后重新验证 tenant/viewer、Customer/Matter scope、私密 Note/Transcript、Candidate 人审零变化和既有 CRM API；
6. 数据库替换、阿里云发布/回滚和生产 migration 均是独立生产变更，本说明不构成部署授权。

## 8. 已完成验证

- Server：Prisma generate、PostgreSQL rendered schema check、typecheck、77 files / 621 tests 全绿；
- Domain contracts：8 files / 87 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests；App：42 files / 326 tests，全部 typecheck/tests 全绿；
- 本地未运行会写入共享 `app/dist/**` 的 App production build；精确 SHA CI 在隔离环境完成 build 和 production-images gate；
- PostgreSQL 真实演练输出 `SOURCE_ARTIFACT_BACKFILL_APPLY_OK=1`、`SOURCE_ARTIFACT_CREATOR_QUARANTINE_OK=1`、`INTERRUPTED_SOURCE_ARTIFACT_AFTER_COMMIT_ADOPTION_OK=1`、`SOURCE_ARTIFACT_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`SOURCE_ARTIFACT_FINGERPRINT_DRIFT_FAIL_CLOSED_OK=1`、`SOURCE_ARTIFACT_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_SOURCE_ARTIFACT_SCHEMA_FAIL_CLOSED_OK=1`、`SOURCE_ARTIFACT_RESTORE_ROLLBACK_OK=1`、`SAAS_201_SOURCE_ARTIFACT_CUTOVER_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- producer/delete/rebind 清单、body-free schema、无 Candidate/ReviewBatch/正式态写入断言、`git diff --check`、Shell 语法、保护路径和新增行高置信密钥扫描全部通过；
- 精确 SHA `c454fbb751817f0480e7257ab1a2fd74a2e8cb09` 的 [Actions 32877939477](https://github.com/ZiZ-LG/jianghu/actions/runs/32877939477) 12/12 jobs 成功；
- 公共 CI 的既有 Node 20 弃用提示未在本任务修改；公共 workflow 属于共享文件，后续升级仍须单独批准。

SAAS-201 未修改 Action/domain-contract/App、共享高冲突文件或“自我修养”专属路径，未部署生产、未合并 main。
