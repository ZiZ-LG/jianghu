# 敏感资源 Creator/Share ACL 迁移与回滚说明（CORE-204）

- **任务：** CORE-204
- **状态：** 实现与验证完成，未部署生产
- **基线：** `40b199006dedb455c02c17bf7f9c741f6d519612`
- **启动治理提交：** `6f21558cd1fcf0f69bba686f2b8e007f684ab094`
- **业务提交：** `4bf28579a0ad265faf05e5a2bdb1bbd32eb27b29`
- **测试稳定化提交：** `e67c3373f1a1b2e5dd28dd83235ff806902a3dec`
- **远端证据：** [GitHub Actions 32856055702](https://github.com/ZiZ-LG/jianghu/actions/runs/32856055702)，对应精确 SHA `e67c3373f1a1b2e5dd28dd83235ff806902a3dec`，12/12 jobs 成功

## 1. 权威访问模型

CORE-204 将 `SourceArtifact`、`Transcript`、私密 `Note` 和 `Candidate` 统一纳入以下实时交集：

```text
tenantId
∩ 当前数据库角色与产品 capability
∩ EffectiveResourceScope / 当前父级闭包
∩ creator/share ACL
```

必须同时满足：

- 新建敏感资源默认 `private`，且写入稳定 `createdByUserId` 与 `aclVersion >= 1`；系统无法可靠确认创建者时进入 `owner_admin_only` 隔离，不得自动共享；
- 创建者读写仍受当前 Customer/Matter/Person 父级 scope 约束；viewer 只读且不得管理或审核；
- `matter_shared` 必须有当前有效 Matter 父级，非创建者读取还必须同时拥有 `source.read_shared`，共享不得扩大 Customer/Matter scope；
- Candidate 的非创建者审核只能由非 viewer、具备 `candidate.review_shared`、当前正式写 scope 且持有有效 `reviewer` grant 的用户执行；审核事务内重新加载角色、policy、scope、ACL version 与 grant；
- `owner_admin_only` 只允许当前租户 owner/admin 处理无法确认创建者的隔离行，不允许普通分享命令把已知私有正文升级为管理员可见；
- 缺失或非法 actor、tenant、parent、visibility、grant kind、ACL version，跨租户 grant、已撤销 grant、Matter 转移或角色降级均在下一次请求失败关闭；
- visibility、reviewer grant 与撤销使用 `aclVersion` CAS，并在同一事务写不含正文的 `AuditEvent`；
- Candidate 是五类候选的唯一审核权威，不再回退兼容五表判断审核权限。AI/机器结果仍必须先成为带来源、证据和置信度的 Candidate，经人审后才改变正式业务态。

统一决策与变更入口位于 `server/src/sensitiveAccess.ts` 和 `server/src/sensitiveAcl/service.ts`。Transcript、Note、Candidate 的创建、查询、重挂载、提取、脱敏、删除、修复、人物合并、Inbox 与批量审核均复用该边界；聚合/共享摘要不读取私密正文。

## 2. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| CORE-204 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260825_pre_core204.prisma` |
| PostgreSQL expand migration | `20260825000000_expand_sensitive_resource_acl` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260825000000_expand_sensitive_resource_acl/migration.sql` |
| ACL 数据 marker | `CORE-204-sensitive-acl-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:sensitive-acl-report
npm run migrate:sensitive-acl-apply
npm run migrate:sensitive-acl-verify
```

- `report` 是只读预演：检查 schema、父级闭包、creator 映射和已存在 ACL 语义，不写资源或 marker；
- `apply` 在可重试事务内完成映射和完整性校验，所有行闭合后最后写 marker；
- `verify` 要求 marker receipt 的版本、结构与 checksum 有效，并重新验证双向语义，不修改数据；
- 输出仅允许 ID、计数、原因码和非敏感 checksum，不输出 Note、Transcript、Candidate payload/evidence、凭据或密钥正文；
- 生产 PostgreSQL 只允许版本化 migration、`prisma migrate deploy` 和上述受控数据步骤，禁止 `prisma db push`。

## 3. 数据映射与 fail-closed 契约

1. 同租户、可稳定解析到当前 User 的 legacy `createdBy` 映射为 `createdByUserId + private`；空值、未知用户或跨租户创建者映射为 `owner_admin_only` 隔离。
2. Transcript 与 Note 必须验证 tenant、Customer/Matter/Person 父级闭包；Candidate 还必须验证其 target、creator 和 CORE-203 权威语义。任何悬空或跨租户父级立即停止。
3. SourceArtifact 在 CORE-204 只建立 ACL-ready 空基座；不回填投影、不新增公共产品 API，也不建立第二 Transcript 主表。
4. Candidate 和 Transcript 的在线幂等使用不可变的 creator domain，避免一个创建者通过 tenant-wide 唯一冲突探测另一创建者的私有资源；现有 legacy semantic key 保留在受控映射内。
5. apply 可接管“数据已提交但 marker 未写”的精确中断态；重复运行必须幂等。部分 schema、未知索引/字段、marker checksum 漂移、语义冲突或无法证明的迁移状态全部非零退出。
6. marker 是完整迁移收据，不是跳过实时 ACL 的开关。应用每次请求仍重新校验当前角色、policy、scope、visibility、ACL version 和 grant。
7. 在线迁移规模门只在写前 report 阶段阻止超出受控窗口的新部署；marker 已完成的数据库继续执行 verify，不因后续业务自然增长而被错误阻断。

## 4. SQLite 升级与恢复

SQLite 升级入口在任何 schema 或数据写入前使用 `VACUUM INTO` 创建一致性备份，然后：

1. 判定 schema 为已知 pre-CORE-204、expanded 或 partial/drift；
2. 对已知旧态执行 expand，对 expanded 精确校验，partial/drift 立即停止；
3. 执行 report、apply、verify；
4. 只有 marker 与全部语义校验成功后才完成升级。

失败时必须停止 Node 进程，保留失败数据库与日志，从升级输出的明确备份路径恢复，再验证租户、旧功能和 ACL 状态。不得使用通配符、未解析变量、手工补列或 `db push` 修复生产数据。

## 5. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 负责：

1. 等待数据库并识别已知 pre/expanded/partial 状态；
2. 对事务中断、已提交但 Prisma 未登记和精确 expanded 状态进行受控识别；
3. 仅在可证明状态下运行或接管 `20260825000000_expand_sensitive_resource_acl`；
4. 通过 `prisma migrate deploy` 完成版本化 DDL；
5. 顺序执行 ACL report、apply、verify；
6. 任一 schema、marker、checksum、父级或 ACL 语义检查失败即停止应用发布。

未知 drift 或部分 schema 不得自动补列、删表、删 marker 或强制 resolve。先用认证加密备份在隔离数据库恢复并验证；替换目标数据库、执行生产恢复或修改阿里云状态仍须项目所有者单独批准。

## 6. 应用回滚边界

CORE-204 是 expand-only 迁移。未来若部署后应用行为异常，优先前向修复；确需应用回退时：

1. 停止继续发布并保存故障日志、当前数据库与迁移状态；
2. 通过正常版本发布流程回退 CORE-204 应用行为；测试稳定化提交可独立回退，但不改变业务数据；
3. 保留 SourceArtifact 基座、Transcript/Note/Candidate ACL 字段、`SensitiveResourceGrant`、`DataMigrationState` marker、AuditEvent 和 `_prisma_migrations` 历史；
4. 不删除表/列/grant/marker，不把 migration 标记为 rolled back，不把已隔离内容自动改为共享，也不恢复 Candidate 兼容表审核 fallback；
5. 重新启用 CORE-204 应用前必须重跑 report/apply/verify；冲突只能以前向修复解决；
6. 回退后验证 tenant/viewer、Customer/Matter scope、私密 Note/Transcript、Candidate 人审与正式态零越权；
7. 数据库文件恢复、目标库替换、阿里云发布或生产回滚均是独立生产变更，不因本说明自动获批。

## 7. 已完成验证

- Server：74 files / 601 tests、typecheck、Prisma generate 与 PostgreSQL rendered schema check 全绿；
- SQLite 累积升级：12 tests 全绿；新增 migration 后将该累计子进程门的测试预算从 30 秒调整为 60 秒，未改变产品或迁移语义；
- Domain contracts：8 files / 87 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests；App：42 files / 326 tests，全部 typecheck/tests 全绿；
- 本地未运行会写入共享 `app/dist/**` 的 App production build；精确 SHA CI 在隔离环境完成该 gate；
- PostgreSQL 真实演练输出 `INTERRUPTED_SENSITIVE_ACL_AFTER_COMMIT_ADOPTION_OK=1`、`SENSITIVE_ACL_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`SENSITIVE_ACL_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_SENSITIVE_ACL_SCHEMA_FAIL_CLOSED_OK=1`、`SENSITIVE_ACL_RESTORE_ROLLBACK_OK=1`、`CORE_204_SENSITIVE_ACL_CUTOVER_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；
- `git diff --check`、脚本语法、旧路径/聚合正文访问清单、共享与自我修养保护路径检查、高置信密钥扫描均通过；SourceArtifact 无公共 API 或投影回填；
- 精确 SHA `e67c3373f1a1b2e5dd28dd83235ff806902a3dec` 的 [Actions 32856055702](https://github.com/ZiZ-LG/jianghu/actions/runs/32856055702) 12/12 jobs 成功；
- 公共 CI 对 Node 20 的既有弃用提示未在本任务修改；公共 workflow 属于共享文件，若要升级需另行批准。

CORE-204 未修改 Action/domain-contract/App、共享高冲突文件或“自我修养”专属路径，未部署生产、未合并 main。
