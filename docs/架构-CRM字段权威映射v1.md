# CRM 字段权威映射 v1

- **状态：** Active，受 ADR-002 与 `CORE-102` 约束
- **日期：** 2026-08-19
- **适用范围：** Account → Customer、Opportunity → Matter、PlanAction → Commitment 的 Expand → Migrate → Contract 过渡
- **机器权威：** `packages/domain-contracts/src/authority.ts` 的 `CRM_FIELD_AUTHORITY`
- **验证入口：** `packages/domain-contracts/tests/authority.test.ts`

## 1. 使用规则

1. 每个逻辑字段在任一时刻只有一个 `currentAuthority`。`targetAuthority` 是经过阶段门后准备切换的目标，不是第二读取源。
2. `shadowComparison` 只允许独立比较和报告差异；不得把影子值写回正式字段，也不得以“新值为空就读旧值”形成 fallback 双读。
3. 切换前必须清点机器权威中的完整消费者清单，并区分 `reads / writes / adapters / migrations / planned`；影子比较和 `cutoverCondition` 均通过后才可切换。切换后必须执行 `stopCondition`，停止旧路径的新写入或非 adapter 读取。
4. `legacy_path` 只服务兼容和迁移。只有消费者为零、跨库恢复通过且存在回滚点时，才进入 `removalPhase`。
5. 修改映射必须同时修改机器权威、契约测试和本审计视图；重大边界变化先提交 ADR。
6. 映射登记本身不构成切换；只有完成阶段门并在第 4 节留下消费者、验证与回滚证据后，才可把 `currentAuthority` 改为目标路径。
7. `migrations` 分类只表示需要治理的可执行入口，不构成运行授权。`server/scripts/migrate-adurc-v1.1.ts` 当前包含未按 tenant 过滤的存量更新，保持禁止执行；只有完成 tenant-scoped 改写、迁移测试并取得显式批准后才能启用。

## 2. 来源类型

| 类型 | 含义 |
|---|---|
| `core_path` | 平台内唯一正式字段或正式记录；可属于通用核心、销售扩展或独立 PDE 上下文 |
| `methodology_value` | 由具体 MethodologyPack binding 拥有的阶段、角色或值 |
| `legacy_path` | 存量兼容字段；必须具备消费者、影子比较、停止条件和移除阶段 |
| `none` | 当前没有可安全提升为正式真相的旧字段；只能通过新的人工作业建立目标记录 |

消费者分类以机器权威为准：`reads` 是当前正式读取入口，`writes` 是当前写入入口，`adapters` 是兼容契约或算法适配器，`migrations` 是种子／修复／迁移入口，`planned` 是尚未启用但已登记的目标任务。表格中的“主要消费者”只用于人读摘要，不能替代机器清单，也不能作为消费者清零证据。

## 3. 当前权威总表

| 逻辑字段 | 当前唯一权威 | 目标权威 | 主要消费者 | 影子比较与切换门 | 停止条件／移除阶段 | 禁止事项 |
|---|---|---|---|---|---|---|
| `customer.category` | `legacy_path: Account.customerType` | `core_path: Customer.categoryKey` | app store；server state/mutate/voice | 仅由销售 adapter 映射 1..4；通用消费者全部改读 V2 且 dry-run 经审核后切换 | 通用命令和页面不再读写 customerType；G7 在销售 adapter 消费者清零后收缩 | 通用命令要求 1..4；categoryKey 为空时 fallback |
| `matter.lifecycle` | `legacy_path: Opportunity.status` | `core_path: Matter.lifecycleStatus + Matter.outcomeKey` | app store；server state/mutate/jobs | active/paused/won/lost 逐行影子映射；生命周期、重新打开审计和跨库 parity 通过后切换 | 通用写入只写生命周期与结果；G7 收缩旧 status | 把 won/lost 作为通用状态；两源 fallback |
| `matter.owner` | `core_path: Matter.primaryOwnerUserId` | `core_path: Matter.primaryOwnerUserId` | server state；owner dry-run；owner-transfer command；CORE-109 resolver | Account.primaryOwnerUserId 只生成管理员待确认建议；同租户稳定 User.id、CAS、审计与转交命令旧 owner 即时撤权测试通过；全局读 scope 另走 CORE-109 | 所有正式 owner 写只走转交命令；scope policy 切换另走 CORE-109 门禁 | 自动复制 Account owner；按姓名／地区／OpportunityMember 推导 Matter owner；Matter owner 为空时 fallback |
| `tenant.data_scope` | `core_path: Tenant.dataScopePolicy + EffectiveResourceScope` | 同当前权威 | resolver；state；MCP；AI/strategy；advisor；PDE；Inbox；curated；transcript/job；repair/person merge | legacy owner/admin/member 与 viewer parity、scoped Customer/Matter 集合、owner transfer、角色降级、未知 policy/actor 删除和跨入口 ID parity 全部通过；生产启用 scoped 仍须单独批准 | 所有在线读取先取唯一集合；机器消费者 `planned=[]`；未来 Team/Grant/正文 ACL 只与之取交集 | 未知值回退租户共享；按 JWT 旧角色／姓名／地区／OpportunityMember 授权；partial Customer 返回详情；scoped 租户回滚到旧代码 |
| `matter.current_stage` | `legacy_path: Opportunity.pipelineStage` | `methodology_value: MethodologyStageState` | AI context；OpportunityForm；server state/AI | 已绑定销售 Matter 做 binding parity；未绑定时明确显示“未配置” | 组合页、通用 UI、AI 不再读 pipelineStage；G7 收缩 | 与 OppStage 或 MethodologyStageState fallback 双读 |
| `g64111.engage_stage` | `legacy_path: Opportunity.engageStage` | `methodology_value: MethodologyValue(g64111.engage_stage)` | gaps；server AI/WeCom；G64111 engine | 仅 G64111 adapter 比较；fixtures 与 server parity 通过后切换 | 仅 adapter 可读旧字段；G7 在 legacy binding 消费者清零后收缩 | 进入通用 Matter；PDE 继续读取该值 |
| `pde.decision_stage` | `core_path: PdeDecisionContext.stageKey` | 同当前权威 | context access layer；server PDE assembler/routes；全部 Matter 创建入口 | legacy 仅执行一次映射；冲突失败关闭；跨库恢复、kernel golden/property、快照重放与消费者检查通过 | assembler 只读 context；可见 Matter 缺 context 返回 `pde_context_uninitialized`；机器 `planned=[]` | 从 MethodologyValue/engageStage 推导；缺 context 时 fallback |
| `g64111.primary_d` | `legacy_path: Opportunity.primaryDPersonId` | `methodology_value: MethodologyRoleAssignment(g64111:D)` | gaps/Sidebar；server AI/PDE | 仅 G64111 adapter 比较角色；评分 parity 通过后切换 | 非 adapter 消费者为零；G7 收缩 | 当作通用关键人；解绑方法论时删除通用 Focus |
| `stakeholder.focus` | `none` | `core_path: StakeholderFocus` | SAAS-206 命令；关系图投影 | 不把旧 primaryD 自动提升；理由、证据、权限和用户确认测试通过后建立 | 通用消费者永不 fallback 到主 D；无 legacy 删除 | 由评分自动创建；生命周期绑定方法论包 |
| `sales.forecast` | `legacy_path: expectedAmountW + winProbability + expectedSignDate` | `core_path: ForecastEntry` | OpportunityForm；server state/PDE | 只生成待确认迁移候选；币种、周期、类别和金额均确认且快照可重放后切换 | 团队预测只读 ForecastEntry；G7 清零旧消费 | 预计金额冒充已签；概率隐式变成预测类别 |
| `sales.outcome` | `legacy_path: Opportunity.status + expectedAmountW` | `core_path: SalesOutcomeRecord` | server state；G5 forecast assembler | 对 won 行列出缺金额／日期／币种原因，用户确认后写正式结果 | 实绩只读 SalesOutcomeRecord；G7 完成迁移后收缩 | 用 won＋预计金额推断已签；静默接受缺失输入 |
| `matter.participants` | `core_path: MatterParticipant` | `core_path: MatterParticipant` | app store；server state/mutate/opp/suggest/personMerge | 已按 OppRole＋OpportunityMember 去重并校验 tenant／Matter／Person／Customer 父树；SQLite 备份恢复、PostgreSQL 原子 migration、legacy visibility 与开放 Relation.kind 回归通过 | 通用读写只用 MatterParticipant；OppRole 仅保留方法论角色、OpportunityMember 仅保留旧可见性；G7 再评估旧表收缩 | ADURC 兼任参与关系；OpportunityMember 兼任真相源；切换后 fallback 双读 |
| `commitment.record` | `core_path: 同一 PlanAction 行的通用 Commitment 字段` | `core_path: 同一 PlanAction 行的通用 Commitment 字段` | 通用 command/state/Today/jobs/patrol/WeCom；旧 App/store/StrategyCard 为销售 Matter adapter | CORE-106 初始 parity、CORE-107 幂等命令与 CORE-108 消费者清单均通过；客户级行只进入 `commitments`，旧 Action/StrategyCard 失败关闭；改期/确认/反馈均使用 version＋scheduleVersion，巡检只写 Reminder | `opportunityId` 已放宽；客户级读写只用通用字段；旧 PlanAction 入口继续强制 Matter 且不能看见/修改客户级行；G7 再收缩旧命令，物理表名可保留 | 新建第二主表；长期双写或 fallback 双读；伪造 Matter；旧 adapter 绕过通用 version；用 createdBy、姓名或旧时段猜测负责人/精确时间 |

## 4. 切换记录模板

每次权威切换在任务清单和本节追加记录：

| 日期 | 逻辑字段 | 旧权威 → 新权威 | 消费者清零证据 | parity／恢复证据 | 回滚点 |
|---|---|---|---|---|---|
| YYYY-MM-DD | `logical.field` | `legacy_path` → `core_path/methodology_value` | 文件、查询、命令清单 | 测试、dry-run、备份恢复 | commit / migration / backup |
| 2026-08-21 | `matter.participants` | `OppRole + OpportunityMember` → `MatterParticipant` | 通用读仅 `app/src/store.ts`、`server/src/state.ts`；所有在线写显式落 MatterParticipant；旧表消费者只保留方法论／可见性语义 | `matter-participant.test.ts`、`sqlite-matter-upgrade.test.ts`、`schema-render.test.ts`、`actions.test.ts`；PostgreSQL 单事务 migration，SQLite 写前备份与中断恢复 | `53e1331`；`20260821010000_expand_matter_participants_relations`；回滚不删除已生成的 MatterParticipant 数据 |
| 2026-08-21 | `commitment.record` | `legacy_path: PlanAction` → `core_path: 同行 Commitment 字段` | 新通用写入 `server/src/mutation/commitments.ts` 与受检反馈事务；通用读为 state/Today/jobs/patrol/WeCom；旧 App/store/StrategyCard 仅保留 Matter-required adapter；机器 `planned` 消费者已清零 | CORE-106 初始 parity；CORE-107 命令/CAS/审计；CORE-108 客户级 state、旧路径失败关闭、提醒终止、无伪造 Evidence、企微客户上下文、SQLite 备份/中断恢复与 PostgreSQL 原子 nullable migration | `5edef534` 为通用切换前点；CORE-108 分消费者提交 `c0a5653`、`622c31f`、nullable cutover `ca53efc`。若已有空 Matter 行，回滚仅关闭入口并保留 nullable 数据，禁止强制 `SET NOT NULL` 或删除业务行 |
| 2026-08-21 | `tenant.data_scope` | ad-hoc tenant-wide/viewer 分支 → `Tenant.dataScopePolicy + EffectiveResourceScope` | [CORE-109 effective-scope 消费者清单](CORE-109-effective-scope消费者清单.md) 覆盖 resolver、legacy adapter、state、MCP、AI/strategy、advisor、PDE、Inbox、curated、transcript/job、repair/person merge；机器 `planned=[]`；专用 export/search 明确 absent | policy contract/migration、resolver matrix、partial Customer state 与跨入口 parity；owner transfer/角色降级不换 JWT 即时收权；SQLite/PostgreSQL 与全量 server 回归 | `050f439` 为 CORE-109 前点。仅当 scoped 租户为零才可回退应用；一旦启用 scoped 必须停止入口并前向修复，保留列与 migration，禁止改回 legacy 扩权 |
| 2026-08-21 | `pde.decision_stage` | `Opportunity.engageStage` → `PdeDecisionContext.stageKey` | server assembler 已无 `engageStage`/`STAGE_MAP`；app PDE adapter 不属于服务端决策阶段消费者；新建、克隆、MCP 同步与 demo 入口均显式创建 context；机器 `planned=[]` | `pde-decision-context.test.ts` 覆盖缺失失败关闭、阶段独立、CAS/幂等、即时角色降级、租户包隔离、快照精确重放与 migration marker；SQLite 中断恢复、PostgreSQL 原子迁移、PDE kernel golden/property、G64111 parity 与全量 server 回归 | `66d55d4` 为运行时切换前点；保留 `20260821070000_add_pde_decision_context` 和已生成 context。回滚只能关闭 PDE 入口并前向修复，禁止恢复到 legacy fallback 或删除 context/快照 |

`CORE-102` 仅建立映射，没有发生权威切换。

`CORE-106` 完成 Expand + 初始 Migrate，`CORE-107` 把新通用读写切到同一行的 Commitment 字段，`CORE-108` 清零受影响消费者并完成 Contract：物理 `opportunityId` 允许为空。客户级 Commitment 不进入 legacy `planActions`，旧 PlanAction 与 StrategyCard 路径必须失败关闭；旧字段只作为销售 Matter 兼容投影继续存在，不能成为通用命令或 migration 校验的 fallback。任何回滚都不得虚构 Matter、删除客户级业务行或在存在空值时恢复非空约束。

`CORE-109` 把 Customer/Matter 可见性从分散的 tenant-wide/viewer 判断收敛为唯一 resolver。存量租户仍默认 `legacy_tenant_shared`，因此没有自动缩权或扩权；`scoped` 只具备经测试的运行语义，没有生产切换入口。详细消费者、停机条件和不可扩权回滚规则见 [CORE-109 effective-scope 消费者清单](CORE-109-effective-scope消费者清单.md)。

`CORE-113` 把 PDE 决策阶段从 G64111 的 `engageStage` 独立出来。`engageStage` 仍由 G64111 adapter 用于其名义分 C4 兼容，不能再驱动 PDE kernel 的 `Deal.stage`；PDE 只接受 `PdeDecisionContext.stageKey`，缺失或非法均失败关闭。`decisionProfileRef=null` 明确表示租户内置行业包，显式引用则必须是同租户、启用且可解析的 `IndustryPack`。阶段／参数包变更只允许走带幂等键、version CAS、当前数据库角色复核、快照和审计的人工命令。
