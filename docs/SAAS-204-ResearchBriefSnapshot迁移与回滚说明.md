# ResearchBriefSnapshot 迁移与回滚说明（SAAS-204）

- **任务：** SAAS-204
- **状态：** 实现与验证完成，未部署生产
- **基线：** `e1850e7e289110890068f826a48d950206e71453`
- **启动治理提交：** `156ad44e4d8e5616b69fdc3c21f4c879ac820b57`
- **存储/迁移提交：** `9f8198808d855a9a8f62da0a964a394565784595`
- **业务提交：** `eeeb096c19644dd937f4969c45ae54c276e8e4ff`
- **运维稳定化提交：** `df0709376347d202f49a84908eb337ef335a6d04`
- **远端证据：** [GitHub Actions 33076757179](https://github.com/ZiZ-LG/jianghu/actions/runs/33076757179)，对应精确 SHA `df0709376347d202f49a84908eb337ef335a6d04`，12/12 jobs 成功

## 1. 快照权威与正式数据边界

`ResearchBriefSnapshot` 是一次拜访前研究结果的不可变、创建者私有读模型，不是第二套 Customer、Matter、CuratedSummary 或正式销售事实权威：

- 精确 CRM Customer 是必需主体锚；可选 Matter 必须属于同一 tenant 与 Customer，且两者当前均有效；
- 使用外部资料时必须有稳定外部主体锚。多候选或未匹配主体只允许保存候选、未知项和失败项，不允许形成结论段落；
- 正文 payload 以既有 AES-256-GCM 权威加密保存；明文列只保存 tenant、创建者、父级 ID、状态、计数、哈希、版本和时间；
- 快照提交及读取不写 Customer/Matter/Person/Relation/Evidence/Commitment/Interaction/Candidate/ReviewBatch/CuratedSummary、阶段、Forecast 或关键人状态；
- SAAS-204 只开放创建者私有的列表/详情读取，不注册 `pre_meeting_brief` handler、不新增生成/刷新 mutation、不创建 AgentRun、不调用 LLM、企查查或飞书。生成闭环和 UI 留给 SAAS-205。

## 2. 主体、来源、时效与降解语义

1. payload 最多包含 5 个主体候选、20 个来源、8 个段落、20 个未知项、20 个失败项，canonical UTF-8 序列化后不超过 50,000 字符；所有层级拒绝未知字段和 secret/token/prompt/raw-response 类字段。
2. 每个结论段落必须引用至少一个来源。来源保存稳定引用、版本、指纹、provider、主体锚、observed/retrieved/fresh-until 时间及 `fresh | stale | failed | unavailable` 状态。
3. CRM 正式字段使用当前 Customer/Matter 权威值；人工编辑的 CuratedSummary 只能作为带创建者与版本的可归因来源；旧 AI CuratedSummary 只能标记为 cache 输入，不能升级为事实权威。
4. 提交使用哈希 generation key、canonical payload fingerprint 与 source-set hash 幂等；同 key 同 payload 返回原快照，同 key 改参或已持久化密文/元数据损坏均失败关闭。
5. 列表不解密 payload。详情只有在当前 tenant、数据库角色、`sales.workspace`、EffectiveResourceScope、父级闭包和创建者权限全部通过后才解密。
6. 当前 CRM 或人工摘要版本漂移时保留历史段落并标记 stale；敏感 SourceArtifact 被隐藏、删除、降解、撤销 ACL 或指纹/版本漂移时，投影匿名化该来源并移除所有依赖内容，只返回有界通用 unknown/failure 标记，不泄露来源存在性或正文。
7. 到达快照或来源时效边界后动态返回 stale；历史密文保持不可变，不用读取时投影反写存储行。

## 3. 租户、viewer 与审计

- 提交、幂等回放、列表和详情都重新加载当前数据库角色与产品能力，不信任调用方缓存角色；
- 所有查询和写入都先按 `tenantId` 作用域过滤，再验证 Customer/Matter、EffectiveResourceScope 和敏感来源 ACL；隐藏与不存在使用同形 404；
- viewer 永远不能提交或刷新快照；viewer 降级后只有在仍为原创建者、仍拥有 Customer 行级归属并通过全部当前来源 ACL 时才能读取；
- 快照 insert 与 AuditEvent 在 Serializable 事务内完成。审计只含快照 ID、计数和哈希，不含段落、来源正文、URL、provider 错误、密文、凭据或模型响应；
- 数据模型不建立到 Account/Opportunity/User 的级联删除关系，避免父对象或用户删除破坏历史快照；父级有效性由 tenant-scoped 服务查询动态复核。

## 4. Schema、migration、marker 与命令

| 目标 | 权威文件或标识 |
|---|---|
| SQLite 源 schema | `server/prisma/schema.prisma` |
| PostgreSQL 确定性渲染 schema | `server/prisma/postgres/schema.prisma` |
| SAAS-204 前 PostgreSQL 精确快照 | `server/prisma/postgres/legacy/20260826_pre_saas204.prisma` |
| PostgreSQL expand migration | `20260826000000_expand_research_brief_snapshot` |
| PostgreSQL migration SQL | `server/prisma/postgres/migrations/20260826000000_expand_research_brief_snapshot/migration.sql` |
| 数据 marker | `SAAS-204-research-brief-snapshot-v1` |
| SQLite 升级入口 | `server/scripts/upgrade-sqlite-schema.ts` |
| PostgreSQL 生产入口 | `server/scripts/deploy-postgres-migrations.sh` |

迁移命令：

```bash
cd server
npm run migrate:research-brief-report
npm run migrate:research-brief-apply
npm run migrate:research-brief-verify
```

- `report` 只读检查精确 schema、marker 和既有快照语义，只输出 ID、计数、原因码及非正文 checksum；
- `apply` 只接受精确 predecessor/successor 形态，在单事务中 marker-last 登记零回填收据，不创建业务快照、不修改既有正式表；
- `verify` 复核 marker version/contract/integrity checksum、SHA-256 generation key、状态与计数关系、来源/段落/未知/失败关系及时间边界；
- marker 存在后的缺表、未知列/索引、语义冲突、密文元数据冲突或 checksum 漂移均失败关闭；
- 生产 PostgreSQL 只允许版本化 migration 与 `migrate deploy`，禁止 `db push`。

## 5. SQLite 升级与恢复

SQLite 累计升级入口先识别精确 CORE-206 predecessor、SAAS-204 expanded 或 partial/drift 形态。任何 schema/data 写入前先通过 `VACUUM INTO` 生成明确一致性备份；随后才允许执行 Prisma expand、精确列/索引检查和 ResearchBrief report/apply/verify。

部分表、未知 drift、非法既有行或 marker 冲突立即停止，保留失败库、日志和写前备份路径。恢复必须从该明确备份开始并重新验证；禁止手工补表/列、删 marker 或用生产 `db push` 绕过。

## 6. PostgreSQL migrate deploy 与恢复

`server/scripts/deploy-postgres-migrations.sh` 在 CORE-206/SAAS-203 既有链路之后处理 SAAS-204：

1. 只接受精确 pre-SAAS-204、expanded、可证明事务中断或完整 DDL 已提交但未登记状态；
2. `prisma migrate deploy` 执行 expand-only DDL，再顺序执行 report/apply/verify；
3. 中断接管、语义冲突、marker checksum、partial schema、认证备份隔离恢复、fresh install 和二次更新全部纳入根级真实运维演练；
4. 根演练在迁移服务健康检查成功后停止 runtime server，再执行确定性 legacy fixture 断言，避免 30 秒后 patrol worker 与测试回填并发修改 Candidate/Reminder；数据库容器继续运行，迁移和恢复覆盖不减少；
5. 替换生产数据库、执行生产恢复、修改阿里云或发布应用仍需项目所有者单独批准，本说明不构成部署授权。

## 7. 应用与数据回滚边界

SAAS-204 是 expand-only 迁移。未来若获批部署后出现异常：

1. 优先停用未来 SAAS-205 的 `pre_meeting_brief` handler，并通过正常版本发布回退 SAAS-204 读路由/提交 adapter；
2. 必须保留 `ResearchBriefSnapshot` 表与密文、marker、AuditEvent、DataMigrationState 和 `_prisma_migrations` 历史；不得删表/列/索引、删 marker、回写 CuratedSummary/Account 或把 migration 标记为 rolled back；
3. 已失效或失去 ACL 的来源继续按当前权限降解投影，不得通过回退恢复已撤销可见性；
4. 重新启用前重跑 report/apply/verify，并复核 tenant/viewer、Customer/Matter scope、创建者私有、SourceArtifact ACL/retention/fingerprint、密文幂等和正式 CRM 零变化；
5. SQLite 只从明确写前备份恢复；PostgreSQL 只经认证备份的隔离恢复验证并另获生产批准。

## 8. 已完成验证

- Domain contracts：12 files / 112 tests；App：46 files / 353 tests；G64111：2 files / 32 tests；PDE kernel：3 files / 25 tests，全部 typecheck/tests 通过；
- Server 当前树：Prisma generate、PostgreSQL rendered schema check、typecheck、93 files / 814 tests 全绿；ResearchBrief 边界聚焦回归 3 files / 21 tests 全绿；
- 本地真实 PostgreSQL 演练通过全部历史迁移、认证备份/恢复、fresh install 与二次更新，输出 `INTERRUPTED_RESEARCH_BRIEF_AFTER_COMMIT_ADOPTION_OK=1`、`RESEARCH_BRIEF_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1`、`RESEARCH_BRIEF_MARKER_CHECKSUM_FAIL_CLOSED_OK=1`、`PARTIAL_RESEARCH_BRIEF_SCHEMA_FAIL_CLOSED_OK=1`、`RESEARCH_BRIEF_RESTORE_ROLLBACK_OK=1`、`SAAS_204_RESEARCH_BRIEF_MIGRATION_OK=1`、`FRESH_INSTALL_FIRST_RUN_OK=1`、`FRESH_INSTALL_SECOND_UPDATE_OK=1` 与 `POSTGRES_OPS_INTEGRATION_OK=1`；临时容器、网络和卷清理为零残留；
- 首个业务候选 SHA `eeeb096c19644dd937f4969c45ae54c276e8e4ff` 的 [Actions 33073624599](https://github.com/ZiZ-LG/jianghu/actions/runs/33073624599) 有 11/12 jobs 成功，唯一失败暴露既有 patrol 与 legacy fixture 竞态；经项目所有者批准，在根运维脚本加入健康检查后停 runtime worker 的确定性隔离，并补回归测试；
- 最终精确 SHA `df0709376347d202f49a84908eb337ef335a6d04` 的 [Actions 33076757179](https://github.com/ZiZ-LG/jianghu/actions/runs/33076757179) 12/12 jobs 成功；App build、production-images 和 dependency audit 均由隔离 CI 完成；
- `git diff --check`、Shell 语法、仅一个 `IN_PROGRESS`、正式 writer/Agent handler/网络 provider 缺席、body-free 审计、保护路径和高置信密钥扫描均通过；公共 CI 的既有 Node 20 弃用提示未在本任务修改。

SAAS-204 仅修改了项目所有者明确批准的根级共享运维脚本；未修改 App package/lock/Vite/dist、公共 workflow、主站导航、Nginx 或“自我修养”专属路径，未部署生产、Mac mini，未合并 main。
