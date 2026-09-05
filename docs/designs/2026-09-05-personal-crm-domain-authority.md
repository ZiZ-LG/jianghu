# CORE-209：个人商机的记录权威与命令边界

本设计落实已批准的 [产品方案](2026-09-05-jianghu-personal-customer-decision-workbench.md)、[ADR-005](../ADR-005-按功能批次自主研发与上线前数据基线.md) 和[研发计划](../superpowers/plans/2026-09-04-personal-opportunity-workbench.md)。盘点基于 `dd44c3e1ef1f7c583df11c64ecc8a0214d5f83eb`，只制定结构和命令，不在 CORE-209 执行迁移。

## 权威与场景

| 场景 / 信息 | 唯一物理权威及正式写入 | 读取、未知与历史映射 |
|---|---|---|
| C1 客户与线索 | `Account`、`Opportunity`；新增个人商机命令创建同一 Matter，默认本人负责 | 线索是阶段尚待判断的商机，不复制成第二张线索表；明确需求后更新同一 ID，人物、证据、行动持续关联 |
| C1/C2 销售进展 | 新增 `Opportunity.salesProgress`，可空的短文本；个人商机更新命令带 `baseVersion` | 空值明确显示“待判断”；用户可自由填写阶段，也可退回待判断。不规定行业流程、不按问卷推进；不读写 `pipelineStage`、`OppStage` 或 `MethodologyStageState` 作为替代值 |
| C1/C6 继续、暂停、结束 | 复用 `Opportunity.lifecycleStatus/outcomeKey/version`；个人商机命令手动更新 | active/paused/completed/canceled 的读取与阶段分开；首批写入支持继续、暂停、赢单/丢单和重新开始，沿用现有 won/lost 生命周期映射，canceled 仅保留历史读取。暂停保留原阶段，恢复需用户操作；结束和恢复记录审计。旧 `status` 只按现有生命周期映射形成兼容投影，不作为个人界面的第二权威 |
| C2 客户业务目标 | 复用 `Opportunity.customerBusinessGoal`；同一版本化更新命令 | 空值显示“业务目标待核实”；客户名、销售目标与客户业务结果不能互相冒充；旧字段原值可读，不猜测或自动补全 |
| C2/C4 人与商机角色 | `Person` 保管姓名/职务；新增 `MatterParticipant.decisionRole`、`roleBasisId/roleBasisVersion`、`version` | 角色是用户对本次决策的记录，非职务、ADURC 或预算权推断；同人跨商机各自保存。空值未知；依据可空（明确待核实），有依据时引用同商机、含该人物目标的 `IntelligenceItem` 精确版本 |
| C2/C4 人物顾虑与依据 | 复用 `IntelligenceItem` 的 statement、observed/reported/inferred、source、targets 与 version；既有情报命令 | 保存正式记录不改变其信息性质；“用户已记录的转述”仍是转述，不变成亲见事实。依据撤销、归档、版本变化或权限不足时，不返回旧正文；角色只显示待复核占位，不从历史文本补回 |
| C2/C4 关系 | `Edge` 是已由人确认的关系；新增个人关系创建命令，依据保存在目标为该关系的 `IntelligenceItem` | 地图实线只表达已记录关系，不声称客观确定；人物候选、关系候选、假设分别沿用既有 Candidate / ReviewBatch / SalesHypothesis；未知决策人不建立虚构节点 |
| C4 当前焦点、关键缺口 | 复用 `StakeholderFocus`：personId、desiredChange、evidenceGap、basisRefs、validUntil；既有确认/替换命令 | 不回写 `primaryDPersonId`；过期/依据冲突提示复核，来源不可读时既有 ACL 隐藏正文。无焦点时允许先记录目标与少量人物 |
| C3 可选六问 | 复用 `IntelligenceItem`，下一批增加可空的六问 topicKey 以关联业务问题与时机、价值、预算权、标准、流程、推动行为 | 不建问卷完成度或评分。没有记录为未知；转述/推断为待核实；亲见记录仍展示时间与来源，有冲突并列呈现。不把采纳、字段非空或旧方法论分值当作“已确认” |
| C4 判断 | `SalesHypothesis` 与不可变 `SalesHypothesisRevision`，复用新建/修订、支持/反对证据链接 | 保留原判断、预期信号与可证伪条件；当前修订不能覆盖历史；与角色或关系不自动相互转换 |
| C5 行动 | 唯一 `PlanAction` / Commitment，复用正式命令；把既有 `target` 通过 `expectedSignal` 字段纳入创建/读取契约 | personId 为对象、title 为目的、既有 UTC/timeZone 为时间、target 为期望观察。地图先形成可编辑的本地草稿，用户确认才提交；假设关联继续精确绑定 revisionId，不再造待办表 |
| C6 结果 | 复用 Commitment completionResult 与结果时间、版本、HypothesisReview | 本批补行动预期，下一批把现有仅限假设行动的结果命令扩展到普通已完成行动；完成和补结果分开。复盘只新增记录/修订，不覆盖原预期；摘要从用户所选、当前可读的已记录内容投影 |
| C7 外部 Agent | AccessToken → SourceArtifact / Candidate / ReviewBatch；复用收据、幂等、人审和当前权限校验 | 新通路只读/提案。人审前正式商机、人物、关系、阶段、行动零变化；重试返回同收据，采纳时重验来源版本与权限。真实 WorkBuddy 证据由 SAAS-218 提供 |

## CORE-210 的最小实现

使用新的共享 `personalWorkbench.ts` 契约和 `server/src/personalWorkbench/` 组合服务承载个人入口，继续读取上述原实体。中性的 `CrmContextSnapshot` 和历史方法论投影保持各自职责，不给个人首屏返回默认赢率或旧评分。新投影不是事实存储。

1. `GET /api/personal-workbench`：列出当前可读商机、客户、手动阶段、目标、重点和下一项自己的承诺；`GET /api/personal-workbench/:id` 在同一权限快照组合商机、参与人角色及现有关系工作台与行动。每次响应禁止缓存，来源版本和撤销状态按当前服务重验。
2. `POST /api/commands/personal-workbench`：严格联合命令仅接受新建商机、更新商机、新建真实人物并加入商机、加入已知人物/更新本商机角色、创建人工关系。命令不接受 actor、tenant、AI 已确认、方法论角色、分数和候选采纳参数；同名人物展示已有名单供选择，不自动合并。
3. 写入前和幂等回放前均重查数据库当前 actor、tenant、EffectiveResourceScope；viewer 拒绝，跨父级按 404，角色/关系依据引用必须属于同租户同商机并在当前 ACL 下可见且版本一致。事务内锁定当前 actor/父级与实体版本。未知角色、source 变更、版本冲突不能覆盖新值。
4. 复用 `runCommand` 事务/幂等；业务审计只记字段名、ID、版本与事件。命令日志不重复保存目标、阶段、人物角色、来源正文或期望信号；收据只包含 ID、版本与结果类型，不能绕过后续权限撤销读取正文。
5. 新增 `salesProgress` 和参与角色/依据/版本列，SQLite 通过受控 schema 初始化，PostgreSQL 生成 schema 并追加版本化 migration。只加可空列或有安全默认值的版本，不改历史 migration，不迁入旧假数据。`PlanAction.target` 已存在，不制造空迁移。
6. 将关系工作台、情报、焦点、假设的具体读/人工命令加入 `crm.core` 路由与服务能力检查；继续保留资源范围和敏感 ACL。旧 `/api/mutate`、复杂销售、MCP、方法论、团队与 PDE 的授权不随之扩大。候选层仍受独立授权；个人工作台在未开启旧销售能力时可先手动使用。

本项由结构/命令/安全测试三个内部检查点完成，仍在 3 工程日范围；不把会后六问、普通行动复盘或真实 Agent 改造塞入本项。下一批 SAAS-214 的 topicKey 和 SAAS-217 的普通结果命令各自随其任务验证，若后续发现跨出任务大小，再拆分清单。

## 兼容与回滚

新建商机为无包的 `sales_opportunity`，旧必填 pipelineStage/engageStage 只给现有合法初始值“线索 / 需求调研立项”，不把其值投射为个人阶段，不自动安装方法论或运行评分。当前初始化要求每个 Opportunity 有 PDE context，因此沿用既有 helper 创建 `system_default` 兼容行；它不拥有个人销售阶段，避免再次初始化时补行改变新记录摘要。旧绑定与历史字段原样保留；旧高级入口受现有 capability 控制。既有 stage authority registry 说明仅约束冻结的旧消费者，新增个人阶段以独立逻辑键登记，禁止空值回退或双主写入。

新增可空列允许回退至第一批基线镜像，回退后个人新功能不可用但原行不丢失；恢复候选前不得运行会清空/回填个人字段的旧迁移。后续版本仍从新库和合成场景验证结构、重复初始化、持久化、认证恢复及镜像回退。当前本地 Docker 不可用，PostgreSQL 在批次 CI 的隔离 runner 验证；不把 SQLite 测试称作双库通过。

## MCP 权限盘点与后续接点

现有 `sync_intel_bundle`、`upsert_account`、`upsert_opportunity`、`append_visit_note` 需要 `sync_business`；`set_opportunity_roles`、`set_burning_issue`、`set_ucv` 需要 `human_command`；`propose_person` / `propose_relationship` 分别需要提案 scope。它们还受旧销售 capability 和当前资源范围约束。仅隐藏工具按钮不足以形成边界。

SAAS-218 新个人 Agent 凭据不授予 `sync_business` 或 `human_command`，也不接受模型传入 `assertionMode=user_asserted`。当前用户 JWT 的人工路由不接受 AccessToken。旧凭据不在本批自动扩权、轮换或删除；新通路用独立 scope/profile 和工具白名单，按 ID 直查、列表、写候选、回放、撤销均验证。缺少真实客户端时明确未完成，不用现有 `workbuddy-e2e` HTTP 模拟替代。

## 验证清单

- C1/C2：线索推进保留 ID；手动阶段前进/回退、暂停/恢复互不覆盖；无包无 Key 首屏可用；旧方法论字段未变。
- C2/C4：同一 Person 两个 Matter 的角色独立；同名不自动合并；选图、布局、列表切换无写请求；依据更新/撤销后不返回旧角色或原文。
- C5：对象/目的/时间/期望可编辑，提交前 PlanAction 不增长；同 key 重试只一项行动，version 冲突提示刷新。
- 安全：两个私有租户、同租户受限成员、viewer、角色变更、跨父级、body 注入、来源不可读、幂等回放撤权；数据库故障不留下半个人物/关系/审计。
- 批次：SQLite 空库与相关回归、PostgreSQL 空库/重复迁移/合成数据/备份恢复、生产构建、浏览器多商机切换、小屏列表回退；精确 SHA 远程验证与用户体验验收分别记录。
