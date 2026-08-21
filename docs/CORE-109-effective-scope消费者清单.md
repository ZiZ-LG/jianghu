# CORE-109 Effective Scope 消费者清单

- **状态：** DONE（在线读取消费者 0 PENDING）
- **日期：** 2026-08-21
- **机器权威：** `packages/domain-contracts/src/authority.ts` → `tenant.data_scope`
- **运行时权威：** `server/src/resourceScope.ts` → `resolveEffectiveResourceScope()`
- **范围：** Customer/Matter 资源可见性；不包含 CORE-204 敏感正文 ACL、CORE-206 Agent scope、SAAS-301 Team/Grant

## 1. 唯一授权集合

每次请求都从数据库重读当前 `Tenant.dataScopePolicy` 与当前 `User.role`，不信任 JWT/MCP 上的旧角色。解析器只返回三组 ID：

| 集合 | 含义 | 可返回的数据 |
|---|---|---|
| `accountIds` | 可见 Customer 容器 | `id / name / customerType` |
| `fullAccountIds` | 可读完整 Customer | Customer profile、客户级 Person/Relation/Note/Commitment、客户级候选与全部子 Matter |
| `matterIds` | 可读 Matter | Matter 本身及该 Matter 明确挂载的角色、参与人、关系、BI/UCV、Note/Commitment、候选与运行记录 |

策略矩阵：

| Policy / 当前角色 | `fullAccountIds` | `matterIds` |
|---|---|---|
| `legacy_tenant_shared` owner/admin/member | 本租户全部未归档 Customer | 本租户全部未归档 Matter |
| `scoped` owner/admin | 本租户全部未归档 Customer | 本租户全部未归档 Matter |
| `scoped` member | `Customer.primaryOwnerUserId === 当前 User.id` | 完整 Customer 下 Matter ∪ `Matter.primaryOwnerUserId === 当前 User.id` |
| 任意 policy viewer | 本人稳定 User.id 归属 Customer | 上述 Customer 下 Matter；不得因直接 Matter owner 扩权 |
| 未知 policy、非法 role、actor 已删除/跨租户 | 空集 | 空集；失败关闭 |

`scoped` member 只拥有某个 Matter 时，其父 Customer 仅进入 `accountIds`。不得返回客户 profile、外部编号、人物总数、兄弟 Matter 数量或任何客户级正文。

## 2. 在线消费者清单

| 消费者 | 查询前约束 | 关键输出约束 | 回归证据 | 状态 |
|---|---|---|---|---|
| 唯一解析器 `server/src/resourceScope.ts` | tenant、policy、当前 DB role、稳定 User.id、未归档父树 | 产出三组 ID；未知状态空集 | `resource-scope.test.ts` | DONE |
| 旧 helper adapter `server/src/scope.ts` | 每次调用唯一解析器 | Account detail 用 `fullAccountIds`；Matter 用 `matterIds`；拒绝统一 404 | `resource-scope.test.ts`、`access-token-scope.test.ts` | DONE |
| State `server/src/state.ts` | 先解析，再以 ID 集合查询 | partial Customer 仅容器；客户级行只认 full Customer；Matter 行只认 visible Matter | `effective-scope-state.test.ts`、`tenant-parentage.test.ts` | DONE |
| MCP `server/src/mcpServer.ts` | list/detail/score/pending 均先解析 | list 可含 partial 容器但不含客户详情；detail 必须 full；score 必须 Matter；pending 人物只认 full Customer、关系只认 Matter | `effective-scope-routes.test.ts`、`mcpBoundary.test.ts`、`access-token-scope.test.ts` | DONE |
| AI / Strategy `server/src/ai.ts`、`server/src/strategy.ts` | graph 查询前要求 `matterIds`；重验当前角色；四个 strategy 入口复用同一 server context | partial Customer 只取当前 Matter 引用人物，不取客户级 Edge；外部模型永不接收 private BI/self log；当前 viewer 不可绕过旧 JWT 发起推演 | `effective-scope-routes.test.ts`、`visibility-acl.test.ts` | DONE |
| Advisor history `server/src/advisor.ts` | 读、追加、清空前均要求 `matterIds`，再校验 Person 属于该 Matter 的 Customer | 隐藏 Matter 的对话正文统一 404；当前 viewer 即时 403 | `effective-scope-routes.test.ts`、`internal-release-journeys.test.ts` | DONE |
| PDE `server/src/pde/routes.ts`、`server/src/pde/assemble.ts` | seed/graph 查询前要求 `matterIds`；assembler 再防御校验 | partial Customer 只取当前 Matter 的 Role/BI 人物；当前 viewer 不读 private BI/历史 EV snapshot | `effective-scope-routes.test.ts`、PDE 全量回归 | DONE |
| Suggestions / Inbox `server/src/suggest.ts` | PersonSuggestion=`fullAccountIds`；Relation/Evidence=`matterIds`；Proposal/Reminder=`fullAccountIds OR matterIds` | 只为已过滤行加载 Customer/Matter/Person 名称；当前 viewer 失败关闭 | `effective-scope-routes.test.ts`、`tenant-parentage.test.ts` | DONE |
| Curated `server/src/curated.ts` | Customer 要求 full；Matter 要求 Matter | viewer 仅返回 `restricted`，不触发 AI、不读历史共享摘要 | `effective-scope-routes.test.ts`、`visibility-acl.test.ts` | DONE |
| Transcript `server/src/recording.ts` | 列表查询使用 `fullAccountIds OR matterIds` | 只返回元数据；无正文旁路；当前 viewer 失败关闭 | `effective-scope-routes.test.ts`、录音全量回归 | DONE |
| Enrich jobs `server/src/jobs.ts` | 列表查询使用 `fullAccountIds OR matterIds` | partial Customer 的客户级任务不可见；当前 viewer 失败关闭 | `effective-scope-routes.test.ts`、jobs 全量回归 | DONE |
| Repair context `server/src/repair.ts` | 读取 sourceRef/audit 前：Customer 要求 full，Matter 要求 Matter，Note/Visit 按挂载父级判断 | 隐藏资源统一 404；当前 viewer 不可进入 writer context | `effective-scope-routes.test.ts`、`repair.test.ts` | DONE |
| Person merge preview/command `server/src/personMerge.ts` | 先解析当前角色并只取 Person 的 tenant/Customer 父键；必须属于同一 `fullAccountIds` 后才读姓名、角色冲突或执行合并 | partial Customer 不可预览或合并；事务内再次重验 scope | `effective-scope-routes.test.ts`、`person-merge.test.ts` | DONE |
| 专用 export/search | 路由与 MCP 工具清点无 `/api/export`、`/api/search` 或对应工具 | 后续新增必须先登记本清单并复用解析器 | `rg` 静态清点 | ABSENT（非 PENDING） |

## 3. Query-time 硬规则

1. 所有业务查询先带 `tenantId`，再带解析器 ID 集合；不得先加载全租户图再在响应层过滤。
2. 同时可能挂 Customer/Matter 的行统一使用：

```ts
OR: [
  { accountId: { in: [...scope.fullAccountIds] } },
  { opportunityId: { in: [...scope.matterIds] } },
]
```

3. partial Customer 只允许 `id / name / customerType`；MCP 派生标签可以由 `customerType` 计算，不得返回 `externalRef / unifiedCreditCode / profile / personCount / siblingMatterCount`。
4. 按 ID 隐藏资源统一表现为 404 或 MCP tool error，不区分“不存在”和“无权”。
5. `OpportunityMember`、展示姓名、地区、旧 `primaryOwner` 文本不得参与授权。
6. CORE-204 以后增加的正文 ACL、CORE-206 Agent scope、SAAS-301 Team/Grant 只能与本集合取交集，不能绕过或扩大本集合。

## 4. Migration 与启用边界

- PostgreSQL migration：`20260821040000_add_tenant_data_scope_policy` 仅新增非空文本列，默认 `legacy_tenant_shared`。
- SQLite 由受控 `npm run db:push` wrapper 备份后扩列；存量行与新租户默认均为 `legacy_tenant_shared`。
- CORE-109 **没有** UI、API、脚本或自动任务把租户切成 `scoped`。启用属于单独的生产变更：先 dry-run、确认稳定 Customer/Matter owner、备份、指定 tenant、人工批准，再做 canary。
- 未知开放字符串绝不回退到 legacy；解析器返回空集，待管理员前向修复。

## 5. Stop / rollback 条件

发现以下任一项必须停止部署或回滚当前未上线提交：

- 任一在线读取入口未调用唯一解析器或又出现 viewer-only 分支；
- partial Customer 响应出现客户 profile、外部编号、客户级正文、兄弟 Matter 或其计数；
- owner transfer、角色降级或 actor 删除后，旧 JWT/MCP 下一请求仍保留旧资源；
- 未知 policy/role 产生非空集合；
- SQLite/PostgreSQL schema 或恢复演练不一致；
- 任一跨租户 fixture 可见。

回滚规则：

1. `scoped` 租户数量为零时，可回退应用代码，但保留 `Tenant.dataScopePolicy` 列与 migration 历史；不得回滚 tenant 过滤。
2. 任何租户一旦启用 `scoped`，不得回退到不识别该策略的旧代码，也不得为兼容旧代码把 policy 改回 `legacy_tenant_shared`，因为两者都会放宽访问。应停止入口并前向修复。
3. 不删除该列、不手工删除 migration 记录、不用 `db push` 覆盖生产 migration 历史。
4. 负责人数据不自动重写；未归属资源继续失败关闭，不按姓名补权。

## 6. 验证快照

- Domain contracts：6 files / 52 tests；TypeScript strict 通过；`tenant.data_scope` 的 `planned=[]`。
- Server 定向：5 files / 66 tests。
- Server 全量：52 files / 396 tests；TypeScript strict 与 PostgreSQL schema check 通过。
- 读取入口切换提交 `f6e4ea2`：GitHub Actions `32529272001`，精确 SHA 12/12 jobs 全绿。
- 残余旁路修复提交 `1a528c7`：GitHub Actions `32529925236`，精确 SHA 12/12 jobs 全绿。
- 本任务收口提交仍须自身 GitHub Actions 精确 SHA 12/12；未通过前不得启动 CORE-110。
