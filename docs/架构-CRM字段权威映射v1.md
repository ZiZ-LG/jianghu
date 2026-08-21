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
6. 本任务只登记权威，不切换数据库字段、API 或运行时读写路径。
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
| `matter.current_stage` | `legacy_path: Opportunity.pipelineStage` | `methodology_value: MethodologyStageState` | AI context；OpportunityForm；server state/AI | 已绑定销售 Matter 做 binding parity；未绑定时明确显示“未配置” | 组合页、通用 UI、AI 不再读 pipelineStage；G7 收缩 | 与 OppStage 或 MethodologyStageState fallback 双读 |
| `g64111.engage_stage` | `legacy_path: Opportunity.engageStage` | `methodology_value: MethodologyValue(g64111.engage_stage)` | gaps；server AI/WeCom；G64111 engine | 仅 G64111 adapter 比较；fixtures 与 server parity 通过后切换 | 仅 adapter 可读旧字段；G7 在 legacy binding 消费者清零后收缩 | 进入通用 Matter；PDE 继续读取该值 |
| `pde.decision_stage` | `legacy_path: Opportunity.engageStage` | `core_path: PdeDecisionContext.stageKey` | app PDE adapter；server PDE assembler | 不改 oracle/golden，显式上下文与旧输入影子比较 | CORE-113 切换后 assembler 只读 decisionProfileRef/context；G7 移除旧读 | 从 MethodologyValue 推导；切换后继续读 engageStage |
| `g64111.primary_d` | `legacy_path: Opportunity.primaryDPersonId` | `methodology_value: MethodologyRoleAssignment(g64111:D)` | gaps/Sidebar；server AI/PDE | 仅 G64111 adapter 比较角色；评分 parity 通过后切换 | 非 adapter 消费者为零；G7 收缩 | 当作通用关键人；解绑方法论时删除通用 Focus |
| `stakeholder.focus` | `none` | `core_path: StakeholderFocus` | SAAS-206 命令；关系图投影 | 不把旧 primaryD 自动提升；理由、证据、权限和用户确认测试通过后建立 | 通用消费者永不 fallback 到主 D；无 legacy 删除 | 由评分自动创建；生命周期绑定方法论包 |
| `sales.forecast` | `legacy_path: expectedAmountW + winProbability + expectedSignDate` | `core_path: ForecastEntry` | OpportunityForm；server state/PDE | 只生成待确认迁移候选；币种、周期、类别和金额均确认且快照可重放后切换 | 团队预测只读 ForecastEntry；G7 清零旧消费 | 预计金额冒充已签；概率隐式变成预测类别 |
| `sales.outcome` | `legacy_path: Opportunity.status + expectedAmountW` | `core_path: SalesOutcomeRecord` | server state；G5 forecast assembler | 对 won 行列出缺金额／日期／币种原因，用户确认后写正式结果 | 实绩只读 SalesOutcomeRecord；G7 完成迁移后收缩 | 用 won＋预计金额推断已签；静默接受缺失输入 |
| `matter.participants` | `legacy_path: OppRole + OpportunityMember` | `core_path: MatterParticipant` | app store；server opp/state/jobs | dry-run 分离方法论角色、legacy visibility 与通用参与关系；权限与跨库 migration 通过后切换 | 通用读写只用 MatterParticipant；G7 清零旧表通用消费者 | ADURC 兼任参与关系；OpportunityMember 兼任真相源 |
| `commitment.record` | `legacy_path: PlanAction` | `core_path: 同一 PlanAction 行的通用 Commitment 字段` | Today/store；server mutate/jobs/WeCom | 以稳定 ID 比较负责人、UTC/IANA 时间、双状态与 scheduleVersion；全部消费者兼容后切换 | 新通用命令写同一物理行；G7 收缩旧命令，物理表名可保留 | 新建第二主表；长期双写或 fallback 双读 |

## 4. 切换记录模板

每次权威切换在任务清单和本节追加记录：

| 日期 | 逻辑字段 | 旧权威 → 新权威 | 消费者清零证据 | parity／恢复证据 | 回滚点 |
|---|---|---|---|---|---|
| YYYY-MM-DD | `logical.field` | `legacy_path` → `core_path/methodology_value` | 文件、查询、命令清单 | 测试、dry-run、备份恢复 | commit / migration / backup |

`CORE-102` 仅建立映射，没有发生权威切换。
