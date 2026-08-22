# G2｜CORE-103～CORE-114 Readiness Report

- **结论：** `PASS`；G2「通用模型、权限与算法边界」阶段门通过
- **报告日期：** 2026-08-22
- **起始基线：** `origin/main@0ec73d6fcf9a680efa9475c237dbfcfd1bc1849a`
- **G2 收口 SHA：** `525b4bbfd07b19949c5dc2101e19954db6dd1c7a`
- **实施分支：** `codex/g2-core-model-foundation`
- **最终 main CI：** [GitHub Actions 32554125689](https://github.com/ZiZ-LG/jianghu/actions/runs/32554125689)，精确 SHA，12/12 jobs success
- **部署状态：** 未部署；未接触生产数据、生产密钥或生产数据库

## 1. 决策摘要

CORE-103～CORE-114 均已在[商业版开发待办清单](商业版开发待办清单v1.md)标记为 `DONE`。G2 的通过条件已经形成可执行证据：

1. Customer/Matter/Commitment 沿用现有 `Account/Opportunity/PlanAction` 主表扩展，没有建立第二主表；
2. 所有新增持久化结构按 `tenantId` 作用域约束，viewer 仍受客户归属上限限制；
3. `TenantDataScopePolicy + EffectiveResourceScope` 成为统一读取范围权威，未知 policy、失效角色或缺失 actor 失败关闭；
4. G64111 公式仍只存在于共享包，App/Server 仅经 adapter 使用；
5. PDE 决策阶段已切换为 `PdeDecisionContext.stageKey`，运行时不再从 `engageStage`、`STAGE_MAP` 或 `MethodologyValue` fallback；
6. SQLite/PostgreSQL migration、中断恢复、加密备份、隔离恢复和 fresh install 已演练；
7. AI/自动化结果仍只能进入候选或显式人工作业，不得自动写入正式关系、阶段、预测或关键人状态。

因此，`SAAS-101` 具备启动条件；本报告不授权提前启动其他 G3/G4/G5/G6/G7 任务。

## 2. 任务与提交清单

| 任务 | 已交付能力 | 主要提交／收口点 |
|---|---|---|
| CORE-103 | Opportunity 同行扩展 Matter kind、生命周期、结果、优先级、日期、稳定 owner 与 active binding 预留 | `af0d45a` |
| CORE-104 | Matter 稳定负责人、只读建议队列、CAS 转交和审计 | `53e1331` |
| CORE-105 | MatterParticipant 唯一通用参与权威、开放 Relation.kind、兼容回填 | `bb6b22a` |
| CORE-106 | PlanAction 同行 Commitment 时间、执行/确认双状态和版本化迁移 | `41472b8`、`5edef53` |
| CORE-107 | Commitment 幂等命令、CAS、scope、审计和前向修复边界 | `eab4165` |
| CORE-108 | Today/提醒/反馈/巡检/WorkBuddy/企微消费者迁移，放宽客户级空 Matter | `c0a5653`、`622c31f`、`ca53efc`、`050f439` |
| CORE-109 | TenantDataScopePolicy、EffectiveResourceScope、跨入口同集读取与即时收权 | `02f8806`、`5997549`、`a333264`、`f6e4ea2`、`1a528c7`、`fbc261c` |
| CORE-110 | MethodologyPack/Version/Binding/Pilot 基座、单一 active binding CAS | `c36caeb`、`f89fce2`、`4241e1c`、`556b119` |
| CORE-111 | 方法论 Field/Stage/Role/Rule/Action 定义及实例值、评估、迁移运行基座 | `cc4b6a3`、`f61a4f0`、`3da0ecd`、`2e37d47` |
| CORE-112 | G64111 storage binding、engineRef、唯一 adapter import 边界与无包 fixture | `54b9171`、`9f8de05`、`5501e87`、`771f2b2` |
| CORE-113 | PdeDecisionContext、一次性影子迁移、PDE 阶段权威切换与 CI readiness 诊断 | `66d55d4`、`6343aca`、`915e982`、`3af76de` |
| CORE-114 | G2 跨库、恢复、scope、算法、authority/no-fallback 最终阶段门 | `50dd95d`、`b05a93c`、`525b4bb` |

每个任务均有包含任务 ID 的独立提交；详细开始时间、Owner、依赖、验证和回滚点见[商业版开发待办清单状态记录](商业版开发待办清单v1.md#8-状态更新记录)。

## 3. Schema 与 migration

G2 新增八个版本化 PostgreSQL migration，并由 SQLite 升级脚本提供等价扩展与恢复路径：

| 顺序 | Migration | 作用 |
|---:|---|---|
| 1 | `20260821000000_expand_matter_fields` | Matter 通用字段、稳定 owner/version 与 tenant-first 索引 |
| 2 | `20260821010000_expand_matter_participants_relations` | MatterParticipant、开放 Relation.kind 与兼容回填 |
| 3 | `20260821020000_expand_commitment_fields` | Commitment 同行字段与双状态模型 |
| 4 | `20260821030000_release_customer_level_commitments` | 经消费者清零后放宽可空 Matter |
| 5 | `20260821040000_add_tenant_data_scope_policy` | TenantDataScopePolicy |
| 6 | `20260821050000_add_methodology_foundation` | Pack/Version/Binding/Pilot 基础模型 |
| 7 | `20260821060000_add_methodology_data_foundation` | 定义、实例值、评估与 MigrationRun 基座 |
| 8 | `20260821070000_add_pde_decision_context` | PDE 显式阶段和参数包上下文 |

约束与恢复入口：

- PostgreSQL 生产只允许 `migrate deploy`，入口为 `server/scripts/deploy-postgres-migrations.sh`；
- SQLite 入口为 `server/scripts/upgrade-sqlite-schema.ts`，写前备份、标记漂移、中断前重跑和提交后接管均有测试；
- migration 全部为 expand/contract-gated；禁止以删除表、删除历史或强制缩列作为回滚；
- Prisma 两份 schema 均未使用原生 enum/Json，也不存在 `Customer`、`Matter`、`Commitment` 第二模型。

## 4. 权限、AI 与算法边界

| 边界 | 最终证据 |
|---|---|
| Tenant 隔离 | 所有新表和仓储按 tenant＋parent 约束；跨租户返回通用 404/失败关闭 |
| Viewer 行级上限 | EffectiveResourceScope 继续以 Customer.primaryOwner 限制 viewer；新按 ID 入口同集校验 |
| 当前数据库角色 | owner/admin/member/viewer 在关键事务内重验，旧 JWT 不保留已撤销权限 |
| AI 人审 | 方法论、PDE、关系与 Evidence 的正式变化只允许显式人工命令或候选审核；无 Agent 自动权威写入 |
| G64111 | 公式只在 `packages/g64111`；生产直连 import 仅允许 App/Server adapter |
| PDE | assembler 只读 `PdeDecisionContext`；缺失/非法 context 409；阶段变更带幂等、version CAS、快照与审计 |
| 单一主表 | Account/Opportunity/PlanAction 同行扩展；第二 Customer/Matter/Commitment 模型为 0 |
| 跨库可移植 | 状态/类型使用 String；结构化快照存校验后的 JSON 文本，不用 Prisma 原生 Json/enum |

字段权威与消费者剩余项见[CRM 字段权威映射](架构-CRM字段权威映射v1.md)。G2 完成后仍需由 CORE-501 清零的 legacy 消费者为：

- `Account.customerType`；
- `Opportunity.status`；
- `Opportunity.pipelineStage`；
- `Opportunity.engageStage`；
- `Opportunity.primaryDPersonId`。

这些字段当前各自仍只有一个 `currentAuthority`，目标字段不是 fallback 读取源。

## 5. 验证证据

最终本地验收结果：

| 工作区／门 | 结果 |
|---|---|
| `packages/domain-contracts` | typecheck；7 files / 64 tests |
| `packages/g64111` | typecheck；2 files / 32 tests |
| `packages/pde-kernel` | typecheck；3 files / 25 tests，golden/property 未改 |
| `app` | typecheck；29 files / 238 tests；production build success |
| `server` | Prisma generate；PostgreSQL rendered schema check；typecheck；56 files / 430 tests |
| 定向安全矩阵 | scope、方法论、G64111、PDE：11 files / 60 tests |
| PostgreSQL 运维演练 | `POSTGRES_OPS_INTEGRATION_OK=1`；故障注入、并发加密备份、隔离恢复、fresh install 双遍 |
| Dependency audit | 五个工作区 full + production audit 均为 0 vulnerabilities |
| 静态门 | `git diff --check`、密钥模式扫描、Compose config、shell syntax 均通过 |
| 远端最终门 | [main Actions 32554125689](https://github.com/ZiZ-LG/jianghu/actions/runs/32554125689)，12/12 success |

CORE-114 还修复了一个测试可重复性问题：跨租户 PDE Evidence fixture 由不存在的 tenantId＋固定 ID 改为真实外部租户＋UUID；同一 SQLite 测试库连续两次 6/6 通过，随后 Server 全量 430 tests 通过。

## 6. 回滚与恢复

1. **未启用新入口时：** 可按独立 task commit revert 应用层；新增列、表、migration marker 和历史数据保留。
2. **已产生新数据后：** 关闭对应 capability/入口并前向修复；不得删表、删历史、恢复非空约束或退回会扩大权限的旧 scope 代码。
3. **Commitment：** 可用 `COMMITMENT_COMMANDS_ENABLED=0` 关闭新命令；已有客户级空 Matter 行不得伪造 Matter 或强制 `SET NOT NULL`。
4. **Methodology：** 可用 `METHODOLOGY_COMMANDS_ENABLED=0` 关闭入口；Binding、Version、Evaluation 和 MigrationRun 历史保留。
5. **PDE：** 出现问题时关闭 PDE 入口并前向修复；不得恢复 `engageStage`/MethodologyValue fallback，不删除 context/EVSnapshot/AuditEvent。
6. **数据库恢复：** SQLite 使用写前备份；PostgreSQL 使用认证加密备份并先在隔离数据库恢复验证。

安全的 G2 阶段门前检查点为 `3af76de6ae789b9e900eed09a380971b545a064c`；它不是破坏性数据库回滚点，不能用于删除已经产生的 expand 数据。

## 7. 剩余风险与 G3 启动条件

| 项目 | 当前状态／约束 |
|---|---|
| scoped 商业 tenant | 运行语义与测试已具备，但没有生产自动激活入口；启用仍需单独批准和租户级观测 |
| legacy 消费者 | 明确留给 CORE-501；G3 不得顺手切换或删除 |
| 企业 authoring/evaluator | G2 只有安全数据基座；G6 前不得开放完整企业 authoring 或 migration executor |
| Agent/关系雷达 | CORE-206、SAAS-212 保持 PENDING；本阶段没有提前实施 |
| 部署 | 未执行；大陆公网仍受 ICP、域名、HTTPS 和生产审批约束 |

G3 只能从 `SAAS-101` 开始，并继续遵守一次一个 `IN_PROGRESS`、先写检查点、验证后独立提交和 push 的规则。

## 8. GitHub 交付与用户资料保护

原执行计划要求在 CORE-114 后创建代码 PR 并等待批准。随后项目所有者在本任务中明确要求 `commit+push`、`合并 main`、`修复后合并`，因此实现分支已按授权 fast-forward 到 `main`；没有伪造一个无代码差异的实现 PR。本报告对应的 PR 只用于补齐 post-merge readiness 审计，不重演已经完成的代码合并。

本地 `main`、`origin/main`、实施分支及远端实施分支在 G2 收口时均指向 `525b4bbfd07b19949c5dc2101e19954db6dd1c7a`。主工作区原有未跟踪资料保持未跟踪、未暂存、未提交，尤其包括：

- `AI销售的自我修养-行业通用面试版.html`；
- `竞品分析/`；
- `docs/superpowers/plans/2026-08-21-stephen-three-domain-knowledge-hub.md`。
