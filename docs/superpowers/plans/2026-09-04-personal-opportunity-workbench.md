# 江湖个人商机推进工作台治理与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 不自动启动并行任务。

**Goal:** 将已批准的个人商机推进定位落入唯一治理基线，再复用现有能力完成阶段、关键缺口和下一步闭环。

**Architecture:** 保持 monorepo、共享核心、正式数据单一权威和服务端租户隔离。先收敛产品入口与领域权威，再补齐必要体验；PostgreSQL 单一引擎作为独立迁移序列推进，退出 Gate 前保持双库纪律。

**Tech Stack:** React + TypeScript + Vite；Fastify + Prisma；当前 SQLite 开发/测试与 PostgreSQL 生产；目标为 PostgreSQL 单一引擎。

**状态：** 产品方向已批准；CORE-207 是本次执行任务，后续任务状态仅以商业清单为准。

**批准依据：** 2026-09-04 项目所有者回复“整体同意并批准。”；[ADR-004](../../ADR-004-个人商机推进工作台与研发范围收敛.md) 为本计划的产品与治理权威。

**基线：** `main@9cccff76c7f22fbf2449a7507ef6ad5be789ec10`；[商业清单](../../商业版开发待办清单v1.md)；历史实施记录不重写。

## Global Constraints

- 面向个人大客户销售经理，默认导航为商机、今日、客户，快速记录为全局入口。
- 一个注册账户原则上对应一个私有租户；tenantId、RBAC、资源范围及敏感 ACL 保持服务端执行。
- AI 只生成带来源、证据与置信度的候选；用户确认后才更新正式商机状态、关系、方法论结论和行动。
- 首版六问可跳过，不默认评分或赢率，不强制填完，不自动决定销售阶段。
- 个人方法论上传后置；团队协作产品化、销售管理、组织层级、经理看板、团队预测、带教和企业方法论中心不开发。
- G64111、PDE、协作模型、绑定与历史数据不破坏性删除；保留安全、兼容、恢复和必要回归。
- 不触碰自我修养开发线；不部署 lake2ocean.top、阿里云或 Mac mini。
- PR #46 保持暂停，不合并、不关闭、不改写；新路线获批不自动恢复其处理。
- PostgreSQL 退出 Gate 通过前，SQLite/PostgreSQL 验证、无原生 enum/json 及版本化 migration 纪律保持不变。
- tenant scope、版本化 migration、备份恢复、审计、精确 SHA CI 和回滚能力不得因产品精简取消。
- 共享文件修改按任务明确范围；未授权的 main 合并、部署、生产数据操作继续禁止。

## 1. 本次执行边界

本文件提供 CORE-207 文档落盘的执行步骤，以及后续任务的范围、依赖和验收结果。后续代码任务应在启动检查点补齐各自的文件差异、接口与测试计划，不在本次治理任务中预写未经权威盘点的代码或 schema。

产品方向无需重复审批。阶段字段的物理权威、历史身份冲突处理、共享文件范围，以及实际恢复目标必须在对应任务开始前明确；只有重大偏差、共享文件超范围或既有高风险边界才触发新的授权决策。

### Task CORE-207：治理批准落盘

**Files:**

- Create: `docs/ADR-004-个人商机推进工作台与研发范围收敛.md`
- Create: `docs/superpowers/plans/2026-09-04-personal-opportunity-workbench.md`
- Modify: `AGENTS.md`
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: `docs/ADR-002-商业版单一演进与通用CRM能力分层.md`（只增加部分替代提示）
- Modify: `docs/designs/jianghu-lightweight-personal-crm-methodology-packs.md`（只增加历史设计提示）
- Modify: `docs/superpowers/plans/2026-08-19-lightweight-personal-crm-commercialization.md`（只增加历史计划提示）

**Interfaces:**

- Consumes: 已批准的产品方案、main 精确 SHA、商业清单原始历史、PR #46 状态。
- Produces: ADR-004、活跃任务队列、旧目标处置与安全承接表、数据库退出条件；不产生运行时接口或 schema 变化。

- [x] **Step 1：只读核对基线与保护范围。** 完整阅读根 AGENTS；确认 main、PR #46、当前文件和历史待办状态，不在落后的根 main 上修改。
- [x] **Step 2：创建隔离工作区。** 分支 `codex/core-207-personal-crm-governance` 从基线 SHA 创建；`.worktrees/` 已被忽略，不带入根目录未跟踪文件。
- [x] **Step 3：更新七份治理文件。** 写入批准记录和新首版范围，保留原 DONE 行、旧 G5–G7 表与所有状态历史；旧路线明确标为不再调度。
- [x] **Step 4：核验一致性与本地必跑检查。** 逐条核对 ADR-004 的边界、任务映射、路径、依赖与候选状态规则；运行下列仓库检查。

```bash
git diff --check
(cd packages/g64111 && npm run typecheck && npm test)
(cd app && npx tsc --noEmit && npm run test)
(cd server && npx tsc --noEmit)
```

这些代码检查验证未改变的运行时代码在当前 worktree 可用，不代表个人产品新体验已实现。文档任务不运行生产 migration、备份或恢复；本次没有修改 packages 源码、依赖清单、锁文件或数据库。

2026-09-04 本地结果：G64111 类型检查与 2 文件 / 32 tests、App 类型检查与 60 文件 / 413 tests、Server 类型检查全部通过。文档核验确认 40 条历史 DONE 行原样保留、全部原状态历史和旧 G5–G7 表原样保留、任务 ID 唯一、仅 CORE-207 为 IN_PROGRESS、11 个新增本地链接有效。历史设计里原有的未跟踪资料链接未改写，也不列作本次新增链接验证结果。

**提交后的交付 Gate：** 只提交上述七个文件；推送独立候选分支后核对当前 HEAD 的 CI，全部 12 jobs 成功前不把候选 DONE 作为下一任务已获放行的依据。不修改 PR #46，不自动创建或合并 PR。

**交付记录规则：** 对外报告提交、实际 CI run/attempt/job 结果和主线尚未合入状态；保留 worktree 供审阅。CI 身份以 GitHub 当前候选 SHA 的不可变运行记录核验，不在提交前预填“全绿”或未来 run ID。main 合并及合并 SHA 验证继续走既有授权门。

## 2. 执行序列与任务大小

```text
CORE-207 治理
  → CORE-208 私有账户默认与历史兼容
  → CORE-209 线索/阶段/关键缺口权威设计
  → CORE-210 最小正式命令与迁移
  → SAAS-213 商机/今日/客户入口收敛
  → SAAS-214 六问与会后速审嵌入详情
  → SAAS-215 个人销售闭环与安全验收

数据库独立序列（首个产品闭环验收后顺序推进）
CORE-211 依赖盘点 → CORE-212 schema 权威与迁移衔接
  → CORE-213 开发/隔离测试迁移 → CORE-214 SQLite 新功能支持退出 Gate
```

每项按 1–3 工程日拆分，超过时先拆出可独立验收的任务，不能把一整条链标为 IN_PROGRESS。估时不是日历承诺；真实用户观察窗口单独记录。已有能力满足验收时只复用与验证，不重复建设。

数据库完整退出不作为首版界面迭代前提；当前 PostgreSQL 生产安全基础持续验证。顺序调整可以在依赖满足后更新清单，但不允许隐式并行、跨任务复用共享文件授权或跳过 Gate。

## 3. 个人闭环任务范围

### CORE-208：私有账户默认与历史兼容（2d）

**主要位置：** `server/src/auth.ts`、`server/src/scope.ts`、`packages/domain-contracts/src/capabilities.ts`、`app/src/components/Auth.tsx`；现有 auth/capability/scope 测试。

**结果：** 新个人账户进入私有租户，无需创建团队或填写组织层级。检查注册中租户与账户创建的失败一致性；不直接添加全局手机号/邮箱唯一索引。

**验收：** 两个个人账户无法互读；直接 API 不能借隐藏入口绕过授权；旧多租户登录和协作数据仍可按原权限访问；不自动合并身份、删除成员或迁移历史租户。任何必须处理的身份冲突先输出不含敏感正文的盘点与可回滚方案。

### CORE-209：线索、阶段、关键缺口权威设计（2d）

**主要位置：** `packages/domain-contracts/src/crm.ts`、`authority.ts`、`methodology.ts`、`matterPortfolio.ts`；`server/prisma/schema.prisma`；`server/src/crmContext.ts`、`server/src/methodology/`、`server/src/matterPortfolio/`。本项先形成领域设计与任务实施计划，不执行 migration。

**结果：** 对待判断线索、销售进展、暂停/关闭、关键缺口、六问核实状态与 Commitment 引用，逐项给出当前权威、最小复用方式、写命令和历史映射。阶段不依赖 G64111 安装，不与 MethodologyStageState、pipelineStage、OppStage 建立双主写入。

**验收：** 同一客户多条线索/商机、未配置方法论、已绑定 G64111/PDE、未知金额/日期、回退/暂停/关闭及重新进入推进均有明确映射；不会用“新值为空就读旧值”掩盖权威冲突。具体阶段列表和存储选择属于该项设计结果，不能假定本 ADR 已批准一套固定行业流程。

### CORE-210：最小正式命令与迁移（3d）

**主要位置：** 依 CORE-209 结果限定 `packages/domain-contracts/src/`、`server/src/mutate.ts` / `server/src/mutation/`、`server/src/crmContext.ts`、`server/prisma/` 与对应 app adapter；具体文件白名单在任务检查点记录。

**结果：** 只补核心盘点证明缺少的正式命令与投影，保持线索到商机的记录/证据连续、阶段可手动更新、关键缺口与行动可关联。复用现有版本、幂等、审计和候选人审基础。

**验收：** 跨租户、viewer 写入、版本冲突、重复采纳失败/回放路径均符合既有约束；AI 候选在确认前零正式变化；SQLite/PostgreSQL 新建与升级、恢复及应用回滚通过。无 schema 差异时明确记录，不制造空 migration。

### SAAS-213：商机、今日、客户与快速记录收敛（3d）

**主要位置：** `app/src/components/CommercialShell.tsx`、`MatterPortfolioPanel.tsx`、`CrmContextPages.tsx`、`TodayPanel.tsx`、`QuickCapture.tsx`；`app/src/lib/productRoutes.ts`；必要的 capability/组合投影。

**结果：** 三个默认入口、一处全局快速记录；待判断线索在商机视图内。总览显示阶段、用户选定的关键缺口、下一步与时间；允许搜索、筛选和手动重点标记，不强制先画关系图或安装方法论。

**验收：** 无包/无 Key/无 WorkBuddy 场景可以手动工作；多个客户、多条商机的上下文不串写；刷新、空态、权限变化后不显示过期他人数据；旧高级能力与历史记录有受控入口。App 主站导航、Vite、锁文件和自我修养路径不在本项默认修改范围。

### SAAS-214：六问与会后速审嵌入详情（3d）

**主要位置：** `app/src/components/CrmContextPages.tsx`、`PostMeetingReviewPanel.tsx`、`PreMeetingBriefPanel.tsx`；`server/src/methodology/` 与既有候选/ReviewBatch 服务。

**结果：** 六问可展开、可跳过；显示来源、更新时间和核实状态，缺口可以连接验证行动。复用资料导入/候选速审，减少独立工作台；手动记录仍可靠可用。

**验收：** 不产生默认总分/赢率，不根据填答完整度推进阶段；无引用或冲突信息保持未知/待核实；撤销来源权限后不显示原文；重复采纳幂等；历史 G64111/PDE 绑定与结果保持不变。个人方法论上传、公式语言和企业发布中心不在本项内。

### SAAS-215：个人销售旅程与安全验收（2d + 用户观察窗口）

**主要位置：** App 的 CommercialShell/CrmContext/QuickCapture/Today/Portfolio 测试；`server/tests/` 的现有 scope、candidate、敏感 ACL、methodology、commitment 与 migration/restore 套件；新增个人旅程验收记录。

**结果：** 以客户、线索、商机、记录、人审、关键缺口、行动结果和导出形成完整个人闭环；承接 CORE-301、CORE-503、SAAS-501/502 的安全、数据连续性与必要发布职责。

**必须证明：**

- 无包/无 Key 路径可用；未知信息无需编造；跨日返回可接续工作；多商机排序可由用户解释。
- tenant scope 覆盖列表/直查/搜索/聚合/AI/导出/写入；viewer、存量角色、creator/share ACL、撤销与幂等矩阵持续有效。
- 人审前正式状态零变化；缺口与事实有来源；既有 G64111/PDE 公式、fixture、parity/golden 回归通过。
- 当前双库升级、PostgreSQL 加密备份/隔离恢复、应用回滚与精确 SHA CI 通过；备份能力不被写成 PITR。
- 真实使用与合成 fixture 分开记录。至少完成两个工作日的实际接续观察，由项目所有者确认用户是否能减少反复翻资料；未发生观察不能用自动化测试替代。邀约或发送消息需另有明确授权。
- 发布材料记录当前候选 SHA、风险、回滚点和环境身份；本任务不直接授权任何生产部署。

## 4. PostgreSQL 迁移序列

| 任务 | 范围与主要文件 | 独立验收结果 |
|---|---|---|
| CORE-211（2d） | 盘点 `server/prisma/`、`server/package.json`、`server/scripts/`、测试配置、`.github/workflows/ci.yml`、备份恢复/共享部署脚本；不改生产 | SQLite 依赖与存量保全清单、共享路径边界、恢复目标、后续任务白名单与回滚设计；不能把 PITR 或生产调度当作已核实事实 |
| CORE-212（3d） | 依清单确定 PostgreSQL schema 权威、`render-postgres-schema.mjs` 的受控替代及既有 migration 衔接 | fresh install 与既有版本升级均通过；不重写已发布 migration；过渡期 SQLite 能力仍可验证；不得让两套 schema 各自演进 |
| CORE-213（3d） | 迁移 `server/package.json`、Prisma 客户端生成、测试准备/配置与 CI 数据库流程；共享 CI/运维文件逐项授权 | PostgreSQL 覆盖原事务、约束、scope、幂等、迁移与恢复矩阵；测试使用专属数据库与凭据，重置不触及开发/生产；不为假绿删测试 |
| CORE-214（3d） | SQLite 退出验收、存量保全/显式迁移材料、`scripts/backup-postgres.sh` / `restore-postgres.sh` 相关验证与安全总门 | 存量可读取/导出/恢复；恢复目标实测；新建/升级/回滚完整；候选及合并 SHA CI 全绿；才更新日常支持规则，记录停止新增 SQLite 支持的生效版本 |

如果 CORE-211 盘点显示某个任务超过 3 工程日，必须在开始代码前按可独立验收的测试域或迁移边界拆分并更新商业清单。退出生效前不删除 SQLite 工具、历史 migration 或存量文件；本计划不预先放开 PostgreSQL 原生 enum/json。

## 5. 历史路线承接与停排

旧 G5–G7 原表保留为历史，不能由其中的 PENDING 推导 READY。以下职责在新任务中有明确承接：

- CORE-301 的现有权限安全矩阵 → SAAS-215。
- CORE-503 的当前双库/备份恢复/回滚/依赖安全 → SAAS-215；数据库退出后的矩阵 → CORE-214。
- SAAS-501 的本账户数据连续性与导出 → SAAS-215；Team/Enterprise 升级链撤下。
- SAAS-502 的必要观测、发布身份、受控验证与回滚 → SAAS-215 及实际发布门；重型 GA 路线撤下。
- CORE-501/502 物理兼容层收缩冻结；G64111/PDE 权威、已有方法论版本和历史访问持续维护。
- PR #46 / SAAS-211 只保留旧 G4 候选证据，保持暂停；不把其三类 Job/双库验收直接认作新个人旅程通过。

## 6. 交付状态与证据规则

商业清单保留 `PENDING / READY / IN_PROGRESS / BLOCKED / DONE` 状态。旧路线的“取消/冻结/安全承接”使用独立处置说明，不伪装成 DONE，也不删除原任务。

候选文档中预先记录的完成状态只在该候选最终 HEAD 的所有必需检查通过后生效。远端 SHA、workflow event、attempt、job 数和 conclusion 必须实时核对；本地通过、旧 SHA 全绿或 PR 可合并状态不替代该门。

批准内容已落盘但尚未合入 main 时，应明确称为“治理候选已完成”，不得称“main 已切换”或自动从旧主线继续 SAAS-301。后续任务进入 READY 仍需满足治理合入、精确合并 SHA 验证和自己的启动检查点。

CORE-207 的回滚是撤销七份文档的本任务提交；无数据库回滚、无生产切换。根工作区未跟踪文件和其它 worktree 均保持原样。
