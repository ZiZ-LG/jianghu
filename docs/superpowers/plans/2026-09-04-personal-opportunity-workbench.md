# 江湖个人商机推进工作台治理与实施计划

> **For agentic workers:** 先读 [研发协作协议](../../研发协作协议v1.md)，按已授权功能批次自动推进，子任务用复选框记录。选择任务需要的 Skill，不机械叠加流程或逐任务索要批准；不自动启动并行任务。

**Goal:** 将已确认的个人客户经营定位落入唯一治理基线，复用既有曹经理旅程与 G2–G4 能力，完成商机总览、干系人地图、证据、行动、复盘和首个 Agent 候选通路。

**Architecture:** 保持 monorepo、共享核心、正式数据单一权威和服务端租户隔离。先收敛产品入口与领域权威，再补齐必要体验；PostgreSQL 单一引擎作为独立迁移序列推进，退出 Gate 前保持双库纪律。

**Tech Stack:** React + TypeScript + Vite；Fastify + Prisma；当前 SQLite 开发/测试与 PostgreSQL 生产；目标为 PostgreSQL 单一引擎。

**状态：** 产品方向已批准；CORE-207 是本次执行任务，后续任务状态仅以商业清单为准。

**批准依据：** 2026-09-04 项目所有者回复“整体同意并批准。”；[ADR-004](../../ADR-004-个人商机推进工作台与研发范围收敛.md) 为本计划的产品与治理权威。

**2026-09-05 修订：** 项目所有者确认原始动力复盘后的理解 OK，并要求直接调整产品方案、复用既有用户模拟。[当前产品方案](../../designs/2026-09-05-jianghu-personal-customer-decision-workbench.md) 将地图恢复为商机主要界面，明确 C1–C7 场景与首版边界；本轮不开始业务代码。

**研发方式修订：** [ADR-005](../../ADR-005-按功能批次自主研发与上线前数据基线.md) 固化用户按成果验收、Agent 自主实现与检查的方式。项目所有者确认尚未正式投产、旧 CRM 库均为假数据，不安排旧数据迁库/保全；本轮只固化规则，实际 CI 分层由新增 CORE-215 承接。

**基线：** `main@9cccff76c7f22fbf2449a7507ef6ad5be789ec10`；[商业清单](../../商业版开发待办清单v1.md)；历史实施记录不重写。

## Global Constraints

- 面向个人大客户销售经理，默认导航为商机、今日、客户，快速记录为全局入口。
- 商机详情以干系人地图—证据—行动—复盘为核心，保留列表回退；无需先画完整地图或安装方法论。
- 一个注册账户原则上对应一个私有租户；tenantId、RBAC、资源范围及敏感 ACL 保持服务端执行。
- AI 只生成带来源、证据与置信度的候选；用户确认后才更新正式商机状态、关系、方法论结论和行动。
- 外部 Agent 不拥有采纳/正式写入权限；首版验证一个真实客户端通路，默认先验证 WorkBuddy，其他客户端后续逐项适配，不以 HTTP mock 代替联调。
- 首版六问可跳过，不默认评分或赢率，不强制填完，不自动决定销售阶段。
- 个人方法论上传后置；团队协作产品化、销售管理、组织层级、经理看板、团队预测、带教和企业方法论中心不开发。
- G64111、PDE、协作实现与工程历史不破坏性删除；保留安全和必要回归。旧假数据无需保全或迁入，新产品产生的记录仍要可靠持久化。
- 不触碰自我修养开发线；不部署 lake2ocean.top、阿里云或 Mac mini。
- PR #46 保持暂停，不合并、不关闭、不改写；新路线获批不自动恢复其处理。
- PostgreSQL 退出 Gate 通过前，SQLite/PostgreSQL 验证、无原生 enum/json 及版本化 migration 纪律保持不变。
- tenant scope、版本化 migration、备份恢复、审计、精确 SHA CI 和回滚能力不得因产品精简取消。
- 共享文件修改按已授权批次明确范围，同批次内持续有效；未授权的 main 合并、部署及外部数据操作继续禁止。
- 复用曹经理个人模拟推进设计和工程验收；真实用户价值由后续 SAAS-219 观察，不要求本轮重新指定真人，不把合成测试当作付费或省时证明。

## 1. 本次执行边界

本文件提供 CORE-207 文档落盘的执行步骤，以及后续任务的范围、依赖和验收结果。后续代码任务应在启动检查点补齐各自的文件差异、接口与测试计划，不在本次治理任务中预写未经权威盘点的代码或 schema。

产品方向无需重复审批。阶段字段的物理权威、共享修改范围和适用的恢复目标由 Agent 在对应批次计划中明确；不为旧测试账号建设迁移项目。常规技术检查由 Agent 完成，只有协议列明的产品取舍、授权缺口、范围变化或无法安全解决的阻塞才请用户决定。

### Task CORE-207：治理批准落盘

**Files:**

- Create: `docs/ADR-004-个人商机推进工作台与研发范围收敛.md`
- Create: `docs/superpowers/plans/2026-09-04-personal-opportunity-workbench.md`
- Create: `docs/designs/2026-09-05-jianghu-personal-customer-decision-workbench.md`（2026-09-05 修订增加）
- Create: `docs/ADR-005-按功能批次自主研发与上线前数据基线.md`（研发方式固化）
- Create: `docs/研发协作协议v1.md`（研发方式固化）
- Modify: `AGENTS.md`
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: `docs/ADR-002-商业版单一演进与通用CRM能力分层.md`（只增加部分替代提示）
- Modify: `docs/designs/jianghu-lightweight-personal-crm-methodology-packs.md`（只增加历史设计提示）
- Modify: `docs/superpowers/plans/2026-08-19-lightweight-personal-crm-commercialization.md`（只增加历史计划提示）

**Interfaces:**

- Consumes: 已批准的产品方案、main 精确 SHA、商业清单原始历史、PR #46 状态。
- Produces: 当前产品方案、ADR-004、活跃任务队列、旧目标处置与安全承接表、数据库退出条件；不产生运行时接口或 schema 变化。

- [x] **Step 1：只读核对基线与保护范围。** 完整阅读根 AGENTS；确认 main、PR #46、当前文件和历史待办状态，不在落后的根 main 上修改。
- [x] **Step 2：创建隔离工作区。** 分支 `codex/core-207-personal-crm-governance` 从基线 SHA 创建；`.worktrees/` 已被忽略，不带入根目录未跟踪文件。
- [x] **Step 3：更新七份治理文件。** 写入批准记录和新首版范围，保留原 DONE 行、旧 G5–G7 表与所有状态历史；旧路线明确标为不再调度。
- [x] **Step 4：核验一致性与本地必跑检查。** 逐条核对 ADR-004 的边界、任务映射、路径、依赖与候选状态规则；运行下列仓库检查。

以上 Step 1–4 保留为 2026-09-04 首次治理落盘记录。2026-09-05 在同一干净 worktree 上继续 CORE-207，基于 `9a4faf6555c6dfee75516799df3f3cf67088c03a` 修订，不改写前次提交。

- [x] **Step 5：复用现有场景调整产品方案。** 新增当前产品方案，说明 C1–C7、地图与行动、低成本人审、首个真实 Agent、个人复盘和网站三部分边界；同步 ADR、AGENTS、任务依赖及历史设计入口。当前修订只涉及这六份 Markdown，分支累计相对 main 为八份 Markdown。
- [x] **Step 6：核验本次修订。** 检查所有新要求有任务承接，旧 DONE 行、旧 G5–G7 表和历史不变，新增链接有效，只有 CORE-207 为 IN_PROGRESS；已重新运行下列必跑检查，结果见本节记录。

```bash
git diff --check
(cd packages/g64111 && npm run typecheck && npm test)
(cd app && npx tsc --noEmit && npm run test)
(cd server && npx tsc --noEmit)
```

这些代码检查验证未改变的运行时代码在当前 worktree 可用，不代表个人产品新体验已实现。文档任务不运行生产 migration、备份或恢复；本次没有修改 packages 源码、依赖清单、锁文件或数据库。

2026-09-04 本地结果：G64111 类型检查与 2 文件 / 32 tests、App 类型检查与 60 文件 / 413 tests、Server 类型检查全部通过。文档核验确认 40 条历史 DONE 行原样保留、全部原状态历史和旧 G5–G7 表原样保留、任务 ID 唯一、仅 CORE-207 为 IN_PROGRESS、11 个新增本地链接有效。历史设计里原有的未跟踪资料链接未改写，也不列作本次新增链接验证结果。

2026-09-05 修订本地结果：G64111 类型检查与 2 文件 / 32 tests、App 类型检查与 60 文件 / 413 tests、Server 类型检查全部通过。文档核验确认本次仅六份 Markdown、40 条历史 DONE 与全部原任务状态/历史/旧 G5–G7 保留、曹经理 C1–C7 覆盖、新增 SAAS-216～219 均为 PENDING、依赖有效、仅 CORE-207 为 IN_PROGRESS、12 个新增本地链接及 20 个完整仓库路径有效；ADR 的私有账户与 PostgreSQL 保护段、数据库退出序列原样保留。本地验证不代表新版运行时已实现或新提交 CI 已完成。

以上代码检查与文件数量是前次修订的历史记录；本次研发协议修订属于纯说明文档，按新协议核验范围、链接、规则/依赖一致性和历史保留，不重复运行未改变的业务/数据库套件。

- [x] **Step 7：固化合作方式与上线前数据前提。** 建立 ADR-005 和研发协作协议，同步 AGENTS、产品方案、当前计划和商业清单；登记 CORE-215 待实施，不修改工作流、运行时代码或数据库。
- [x] **Step 8：核验本地候选。** 本次七份 Markdown 范围、40 条历史 DONE、原历史/旧 G5–G7、15 个新增本地链接、任务依赖与 AGENTS 安全条款核验通过，`git diff --check` 通过。随本次单一本地提交保存，不单独推送完整 CI；本地任务完成不代表 main 或 CI 已更新。

**提交后的交付 Gate：** 文档适用的本地验证通过后可记录 CORE-207 文档完成；主线集成、远程检查和发布分别记录。当前工作流未分层，不虚报本次新 SHA CI 成功，不为说明文档单独推送完整流水线；需要合入时遵守实际必需检查。CORE-215 的技术实施需进入自己的已授权批次，不能把本文档完成当作工作流已优化。不修改 PR #46，不自动创建或合并 PR。

**交付记录规则：** 对外报告提交、实际 CI run/attempt/job 结果和主线尚未合入状态；保留 worktree 供审阅。CI 身份以 GitHub 当前候选 SHA 的不可变运行记录核验，不在提交前预填“全绿”或未来 run ID。main 合并及合并 SHA 验证继续走既有授权门。

## 2. 执行序列与任务大小

```text
CORE-207 治理
  → CORE-215 CI 分层与交付规则实现
  → CORE-208 私有账户默认与鉴权
  → CORE-209 客户决策与行动权威设计
  → CORE-210 最小正式命令与迁移
  → SAAS-213 商机/今日/客户及地图入口
  → SAAS-216 商机地图、证据与行动衔接
  → SAAS-214 会后速审与情境六问
  → SAAS-217 行动结果、个人复盘与摘要
  → SAAS-218 首个外部 Agent 真实通路
  → SAAS-215 模拟旅程工程与安全验收

工程验收后的价值观察
SAAS-219 真实使用、净成本与付费假设验证

数据库独立序列（SAAS-215 后，按清单单项调度）
CORE-211 依赖盘点 → CORE-212 schema 权威与迁移衔接
  → CORE-213 开发/隔离测试迁移 → CORE-214 SQLite 新功能支持退出 Gate
```

工程任务按 1–3 工程日拆分，超过时由 Agent 在不扩大已授权批次范围的前提下细分；不能把一整条链标为 IN_PROGRESS。子任务逐个实现和本地核验，批次统一远程检查和产品交付。估时是任务大小约束，不是日历承诺；真实用户观察窗口单独记录。已有能力满足验收时只复用与验证，不重复建设。SAAS-219 与数据库退出互不作为前置；没有新真人案例不回头阻断设计。

数据库完整退出不作为首版界面迭代前提；新基线初始化、持久化及上线前恢复能力持续验证。满足依赖后可在同一已授权批次内继续，相关文件授权持续有效；不允许隐式并行或越过失败的安全前置。

用户交付节点按成果组织：先由 CORE-215 建立检查机制；第一批把 CORE-208～210、SAAS-213/216 串成“私有账户 → 商机地图查证 → 行动接续”，内部保持小任务并尽早提供可运行预览；第二批 SAAS-214/217 完成“会后整理 → 判断与行动复盘”；第三批 SAAS-218/215 完成真实 Agent 通路和个人旅程工程验收。数据库收敛作为独立技术批次验收。批次范围在实际启动时登记，现有分组不自动授权本轮代码实施。

## 3. 个人闭环任务范围

### CORE-215：CI 分层与交付规则实现（3d）

**主要位置：** `.github/workflows/ci.yml`、必要的 CRM 检查选择/汇总与文档验证脚本、PostgreSQL 隔离集成入口及相关测试；可拆分保留旧套件，文件范围在批次启动时登记。读取共享发布链以核对触发关系，不在本项修改自我修养或生产部署工作流。

**结果：** 将协作协议的文档轻量检查、关联代码回归、关键安全/新基线恢复检查和实际发布验证落实到工作流。按影响区分旧库数据接续演练与新库/未来真实数据安全；旧演练资产留档，不以全量 legacy 升级矩阵阻塞每次普通迭代。

**验收：** 纯说明文档、被构建消费的资料、前端、后端、共享契约、schema、依赖、运维及检查器自身变化均有路由证据；全部候选差异与传递依赖纳入选择，未知范围扩大检查；必需汇总不会把失败/取消/漏跑写成成功；避免 push/PR 重复，过时开发运行可取消，发布运行不被误取消；main 的轻量结果不能触发未经完整验证的发布。保留精确 SHA、租户/人审/审计与新基线恢复、回滚证据。先用隔离测试与配置核验验证工作流变化，再按实际必需检查交付，不通过关闭保护实现提速。若必须改动排除的发布线才能达成，先提出具体方案，不能越界实施。

#### CORE-215 实施批次（2026-09-05 启动）

| 项目 | 本次登记 |
|---|---|
| 用户成果 | 说明文档在开发 PR 只做轻量核验；代码按整个候选影响选检查；一次提交只运行一次开发 CI，失败和漏跑明确阻断 |
| 范围 | `.github/workflows/ci.yml`、新增 `scripts/ci/` 选择/汇总/文档检查及测试、`scripts/test-postgres-current-baseline.sh`、必要的隔离 fixture；同步本计划、协议过渡提示与商业清单。旧 PostgreSQL 演练及所有生产/自我修养工作流只读保留 |
| 验证 | Node 内置测试覆盖路由、累计差异、未知范围、消费者、失败/取消/漏跑、版本身份与发布边界；本地类型及关联回归；GitHub 精确候选 SHA 的完整检查和新 PostgreSQL 空库/持久化/恢复/回滚实测 |
| 交付 | 本批候选 PR 与 CI 运行摘要、检查选择 JSON 和耗时；回滚点 `1176cda2090bef79f481984fd4d6011d310677e9`。后续进入 CORE-208～210、SAAS-213/216 的可体验批次 |
| 授权 | 本轮用户明确授权研发、技术审查、测试、修复及按协议集中推送；不合并 main、不部署、不触碰 PR #46/自我修养、不操作既有数据库 |

**实现选择：** `CI` 名称继续保留。开发使用 `pull_request`，push 只接受 main；人工完整核验与每周安全检查使用独立事件。只有同一 PR 的旧运行自动取消，main/人工/定期检查按 run ID 独立执行。共享发布当前仅以 main push 的 CI success 为上游，因此 main 一律完整核验；本批不让 main 产生轻量发布放行结果，也不修改发布流程。合并仍须明确授权。

**文件与接口：** `scripts/ci/select-checks.mjs` 消费 base/head Git 对象和事件，输出版本化 JSON（精确 SHA、merge base、整个候选路径、所需 job 和原因）；`scripts/ci/check-docs.mjs` 校验变更 Markdown 的新增链接与商业任务一致性；`scripts/ci/verify-results.mjs` 消费选择 JSON 与 `needs` 结果，仅当所有必要任务成功且身份一致时通过。Node 测试使用临时 Git 仓库验证真实累计差异，不依赖网络或 npm 包。

- [x] 先以 `node --test scripts/ci/*.test.mjs` 固定路由与失败汇总边界：说明文档、消费文档、前端、后端、三共享包、依赖、schema、运维、未知路径、选择器自身；rename/delete 和早期代码后续文档均保留影响。
- [x] 实现选择与文档检查：未知影响完整选择；共享包扩大到消费者；依赖变化/定期/完整检查保留五包 audit；工作流始终启动固定 `CI required` 汇总。
- [ ] 新建隔离 PostgreSQL 入口：只创建本任务随机 Compose 项目和临时目录；空库 `migrate deploy`、重复迁移、合成数据、重启持久化、认证备份/恢复、错误密钥/篡改/坏归档/危险目标拒绝及应用镜像回滚。旧 2743 行接续演练原样留档，不再用于每次普通开发。
- [x] 工作流接线与自查：`git diff --check`、Node 边界测试、YAML/表达式检查、Bash 语法、关联 Server/五包回归；通过 `verification-before-completion` 核对实际证据再提交。
- [ ] 集中推送候选并创建本批 draft PR，核对精确 head/base、运行事件、attempt、全部所选 job、PostgreSQL 标记与耗时。结果引用不可变运行，不为回写成功记录重复触发全量 CI；未完成的远程验证不写成通过。

**本地环境核对：** 2026-09-05 当前工作区干净且 HEAD 精确为上述回滚点；Docker daemon 的 Unix socket 不存在，数据库实测由 GitHub 隔离 runner 承担。未启动或连接任何既有部署环境。

**本地核验（2026-09-05）：** 41 个 Node 边界测试、actionlint 1.7.12、Bash 语法、工作文档新增链接/历史一致性及 `git diff --check` 通过；Domain 17/161、App 60/413 + production build、Server 122/975、G64111 2/32、PDE 3/25 与全部类型检查、Prisma generate/PostgreSQL schema check 通过。技术自查补强人工完整验证仍使用候选相对 main 的累计差异，并阻止重跑旧 PR 自动取消较新运行。PostgreSQL 新入口已实现，Docker 本地不可用，真实运行及最终 SHA CI 待远程验证；未声称 CORE-215 DONE。

### CORE-208：私有账户默认与鉴权（2d）

**主要位置：** `server/src/auth.ts`、`server/src/scope.ts`、`packages/domain-contracts/src/capabilities.ts`、`app/src/components/Auth.tsx`；现有 auth/capability/scope 测试。

**结果：** 新个人账户进入私有租户，无需创建团队或填写组织层级。检查注册中租户与账户创建的失败一致性；不直接添加全局手机号/邮箱唯一索引。

**验收：** 两个个人账户无法互读；直接 API 不能借隐藏入口绕过授权；保留角色/资源权限安全测试；注册失败和身份冲突有明确行为。无需迁入旧测试账号、协作数据或历史租户，不为它们安排保全与身份合并项目。

### CORE-209：客户决策与行动权威设计（3d）

**主要位置：** `packages/domain-contracts/src/crm.ts`、`authority.ts`、`methodology.ts`、`matterPortfolio.ts`、`relationshipWorkspace.ts`、`intelligence.ts`；`server/prisma/schema.prisma`；`server/src/crmContext.ts`、`server/src/methodology/`、`server/src/matterPortfolio/`、`server/src/intelligenceFocus/`、`server/src/hypotheses/`、`server/src/mcpServer.ts`。本项先形成领域设计与任务实施计划，不执行 migration。

**结果：** 对待判断线索、销售进展、客户业务目标、本次决策中的人物角色、关系依据、关键缺口、六问核实状态、行动预期/结果与候选入口，逐项给出当前权威、最小复用方式、写命令和历史映射。阶段不依赖 G64111 安装，不与 MethodologyStageState、pipelineStage、OppStage 建立双主写入。焦点沿用 StakeholderFocus，不回写 primaryDPersonId；行动沿用 Commitment。盘点旧 MCP `sync_business` 与候选权限，明确新 Agent 通路只读/提案/人审边界，不在此项改造客户端。

**验收：** C1–C7 的每项数据和动作有明确权威；同一人在不同商机中的角色、转述与已采纳状态、过期/冲突来源、无包与历史绑定、阶段回退/暂停和恢复均有映射；不会用“新值为空就读旧值”掩盖权威冲突。具体阶段列表、字段和存储选择属于该项设计结果，不能假定本 ADR 已批准一套固定行业流程。若盘点后实现缺口超过 CORE-210 的 3d 边界，先按独立验收项拆分清单，不隐式扩大任务。

### CORE-210：最小正式命令与迁移（3d）

**主要位置：** 依 CORE-209 结果限定 `packages/domain-contracts/src/`、`server/src/mutate.ts` / `server/src/mutation/`、`server/src/crmContext.ts`、`server/prisma/` 与对应 app adapter；具体文件白名单在任务检查点记录。

**结果：** 只补核心盘点证明缺少的正式命令与投影，保持线索到商机的记录/证据连续、阶段可手动更新、人物/关系/缺口与行动结果可关联。复用现有版本、幂等、审计和候选人审基础，不为地图或个人复盘创建另一套事实库。

**验收：** 跨租户、viewer 写入、版本冲突、重复采纳失败/回放路径均符合既有约束；AI 候选在确认前零正式变化；适用引擎的空库初始化、合成数据持久化和相关 schema 变更通过，新基线恢复/回滚按影响检查。无 schema 差异时明确记录，不制造空 migration；不搬运或逐历史版本升级旧假数据。

### SAAS-213：商机、今日、客户与地图入口（3d）

**主要位置：** `app/src/components/CommercialShell.tsx`、`MatterPortfolioPanel.tsx`、`CrmContextPages.tsx`、`TodayPanel.tsx`、`QuickCapture.tsx`；`app/src/lib/productRoutes.ts`；必要的 capability/组合投影。

**结果：** 三个默认入口、一处全局快速记录；待判断线索在商机视图内。总览显示阶段、用户选定的关键缺口、下一步与时间；进入商机后提供主要地图入口和列表回退，保持同一上下文。允许搜索、筛选和手动重点标记，不强制先画完整关系图或安装方法论。本项收敛入口，图内衔接由 SAAS-216 验收。

**验收：** 无包/无 Key/无 WorkBuddy 场景可以手动工作；多个客户、多条商机的上下文不串写；刷新、空态、权限变化后不显示过期他人数据；旧高级能力与历史记录有受控入口。App 主站导航、Vite、锁文件和自我修养路径不在本项默认修改范围。

### SAAS-216：商机地图、证据与行动衔接（3d）

**主要位置：** `app/src/components/CrmRelationshipGraph.tsx`、`RelationshipWorkspacePanel.tsx`、`CrmContextPages.tsx`；`app/src/lib/relationshipWorkspace.ts`；`server/src/relationshipWorkspace/`。复用对应组件/服务测试和 `app/src/testFixtures/relationshipWorkspace.ts`，不重写旧 Canvas 或评分引擎。

**结果：** 地图作为商机详情主要界面，连接客户业务目标、人物/关系依据、当前缺口和行动；选择节点/关系后可查来源、确定关注对象、创建未提交的验证行动。小屏与无图操作路径保持相同上下文，不要求用户维护全部 L1–L4 标签或完整组织图。

**验收：** C2/C4/C5 成立；未知决策人不会生成虚构节点；同一人物跨商机的角色不互相覆盖；候选/假设/已采纳记录可区分；无 G64111 路径无评分空壳；来源撤销或版本变化后隐藏受限正文并提示复核；布局和看图操作零正式写入，创建行动仍由用户确认。

### SAAS-214：会后速审与情境六问（3d）

**主要位置：** `app/src/components/CrmContextPages.tsx`、`PostMeetingReviewPanel.tsx`、`PostMeetingSourceImport.tsx`、`PreMeetingBriefPanel.tsx`；`server/src/methodology/`、`server/src/sourceArtifacts/`、`server/src/reviewBatches/` 与既有候选服务。

**结果：** 一次沟通形成一页变更预览，突出新增、改前/改后、来源和不确定项；可编辑、部分采纳、驳回或稍后处理，结果返回同一商机地图与行动。六问围绕当前缺口给出相关提示及理由，可展开、可跳过。复用资料导入/候选速审；无 Key 的手动记录仍可靠可用。

**验收：** 不产生默认总分/赢率，不根据填答完整度推进阶段；无引用或冲突信息保持未知/待核实；撤销来源权限后不显示原文；重复采纳幂等；历史 G64111/PDE 绑定与结果保持不变。个人方法论上传、公式语言和企业发布中心不在本项内。

### SAAS-217：行动结果、个人复盘与工作摘要（3d）

**主要位置：** `app/src/components/CommitmentActionEditor.tsx`、`RelationshipWorkspacePanel.tsx`、`CrmContextPages.tsx`；`server/src/hypotheses/`、`server/src/relationshipWorkspace/` 及现有 Commitment/Interaction 命令。复用 `server/tests/commitment-hypothesis-verification.test.ts` 和组件测试。

**结果：** C5/C6 中可对照原预期、实际记录和下一步调整，保留原判断；允许先完成行动、稍后补结果。用户选择已采纳记录后可预览并复制工作摘要，减少二次整理，不自动同步公司 CRM 或发送给别人。

**验收：** 新记录能支持、反对或不足以判断原假设，不静默覆盖历史；AI 复盘结论只作候选；重复完成/采纳不制造第二行动；摘要遵守当前权限，默认不包含原始转写、未审推断或私人关系判断；不新增经理带教流程或强制复盘表。

### SAAS-218：首个外部 Agent 真实通路（3d）

**主要位置：** `server/src/mcpServer.ts`、`server/src/mcp/`、当前访问 token/候选/ReviewBatch 服务，以及必要的人审深链；`server/tests/mcpBoundary.test.ts`、`mcp-capability-policy.test.ts`、`access-token-scope.test.ts`、`workbuddy-e2e.test.ts`。连接配置文档和实际客户端证据在本任务新增，凭据不入库。

**结果：** 默认先以 WorkBuddy 完成 C7：读授权商机上下文、提交来源与候选、获得收据并打开江湖人审、查看采纳结果。当前候选提交接口不足时只补此通路所需的适配，不扩展通用 Agent 编排；ChatGPT/Claude 作为后续目标，不声称同时完成。

**验收：** 记录真实客户端版本、隔离测试环境、授权方式、实际请求/收据、失败与重试；旧 HTTP 模拟不代替联调。Agent token 无采纳或正式状态/关系/方法论/行动直接写权限，模型文本不能冒充确认；tenant/资源/敏感 ACL、撤销、幂等、冲突重验有效。旧 `sync_business` 能力按 CORE-209 权限盘点处理，保留旧客户端与历史兼容；无客户端、无 Key 或连接失败时可回到文本/手动流程。若客户端限制使当前入口不可行，记录证据并在任务检查点决策替代，不以演示数据报成功。

### SAAS-215：个人销售旅程工程与安全验收（2d）

**主要位置：** App 的 CommercialShell/CrmContext/QuickCapture/Today/Portfolio 测试；`server/tests/` 的现有 scope、candidate、敏感 ACL、methodology、commitment 与 migration/restore 套件；新增个人旅程验收记录。

**结果：** 按既有曹经理改编的 C1–C7 场景，以客户、线索、商机地图、来源、人审、判断、行动结果和导出形成完整个人闭环；承接 CORE-301、CORE-503、SAAS-501/502 的安全、数据连续性与必要发布职责。

**必须证明：**

- 无包/无 Key 路径可用；未知信息无需编造；跨日返回可接续工作；多商机排序可由用户解释。
- tenant scope 覆盖列表/直查/搜索/聚合/AI/导出/写入；viewer、存量角色、creator/share ACL、撤销与幂等矩阵持续有效。
- 人审前正式状态零变化；缺口与事实有来源；既有 G64111/PDE 公式、fixture、parity/golden 回归通过。
- 商机总览和地图可接续同一上下文；图内查证、确认关注对象、建立验证行动、记录结果与回看原判断完成；SAAS-218 提供真实首个客户端证据。
- 当前支持引擎从空库初始化，拟上线基线的升级、PostgreSQL 加密备份/隔离恢复、应用回滚与精确 SHA CI 通过；不要求接续旧假数据或跑全历史升级兼容矩阵，备份能力不被写成 PITR。
- 此门只记录工程和客户端验证，不宣称真实省时、能力提升、留存或付费。真实用户观察由 SAAS-219 独立记录；没有新增真人案例不阻止本方案或上述工程设计。
- 发布材料记录当前候选 SHA、风险、回滚点和环境身份；本任务不直接授权任何生产部署。

### SAAS-219：真实使用与价值假设验证（观察窗口）

**主要材料：** 在获授权的试用环境中形成独立观察记录；复用 C1–C7 的任务描述，保留匿名结果、时间口径、限制与项目所有者结论，不收集无关客户原文。

**结果：** 至少跨两个工作日观察接续使用，记录录入加复核/修改的净成本、发现的关键缺口、因此采取的行动与结果、主动使用和付费反馈。付费意愿与实际付款分别记录，不用合成测试或演示满意度推导留存与成交率。

**验收：** 每项有实际观察或明确的未验证结论，不虚构用户、访谈和支付。没有观察时不标 DONE，但不回头阻断已获授权的方案与工程工作，也不把本观察作为 PostgreSQL 退出序列的前置。邀约、外发、收款和生产试用仍需对应操作授权。

## 4. PostgreSQL 开发与测试切换序列（不搬运旧库数据）

| 任务 | 范围与主要文件 | 独立验收结果 |
|---|---|---|
| CORE-211（2d） | 盘点 `server/prisma/`、`server/package.json`、`server/scripts/`、测试配置、`.github/workflows/ci.yml`、备份恢复/共享部署脚本；不改生产 | SQLite 代码/工具依赖、共享边界、新库初始化方案、恢复目标和回滚设计；排除旧假数据保全/迁库，不把 PITR 或生产调度当作已核实事实 |
| CORE-212（3d） | 确定 PostgreSQL schema 权威、`render-postgres-schema.mjs` 的受控替代及版本化初始化基线；旧 migration 文件保留 | 空库安装、合成场景及拟上线基线演进通过；不要求旧测试库升级接续；过渡期现有 SQLite 消费者仍可验证，不让两套 schema 各自演进 |
| CORE-213（3d） | 切换 `server/package.json`、Prisma 生成、隔离测试/fixture 与 CI 数据库流程；遵循批次文件范围 | PostgreSQL 覆盖原事务、约束、scope、人审、幂等、审计和适用恢复场景；仅重建自己创建并核实身份的隔离测试库；不以删安全测试制造通过 |
| CORE-214（3d） | SQLite 支持退出验收、新基线备份恢复/回滚与完整适用检查 | 空库安装、可靠保存、拟上线基线演进、恢复/回滚可验证；精确版本检查通过，记录退出生效版本；不要求转换、导出或恢复旧假数据 |

如果 CORE-211 盘点显示某个任务超过 3 工程日，Agent 按可独立验收的测试域拆分并更新清单；实质扩大范围按协议处理。退出生效前不删除仍被消费者依赖的 SQLite 工具；旧 migration 和用户文件不顺手清理。旧假数据不构成切换前置，本计划不预先放开 PostgreSQL 原生 enum/json。

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

任务完成和批次集成分别记录。纯说明文档以本地范围、链接、规则及历史一致性核验完成；子任务以约定的实现和适用验证闭合，批次远程检查/用户验收/主线集成/发布状态单列。远程通过结论须实时核对 SHA、event、attempt、必需任务与 conclusion，本地通过或旧 SHA 不替代尚未完成的远程检查。

批准内容已落盘但未合入 main 时，称为“治理文档本地完成，主线待集成”。后续任务依赖本轮候选时，在载入同一规则且对应批次已授权的前提下可以从该候选继续，不要求每个子任务先合入主线；不能从旧主线擅自继续 SAAS-301。本轮固化协议不自动启动 CORE-215 或其它代码任务。

CORE-207 的回滚是撤销白名单内的文档提交；2026-09-05 修订可单独撤回到 `9a4faf6`，完整治理候选可撤回到原 main 基线。无数据库回滚、无生产切换；根工作区未跟踪文件和其它 worktree 均保持原样。
