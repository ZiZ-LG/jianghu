# 集成设计 · WorkBuddy 销售包 → 江湖（阶段 1）

> **目标**：让销售包（WorkBuddy + 微盘 + Obsidian）把"客户档案 / 商机 / 拜访记录"经 MCP 推进江湖，江湖成为这三类数据的**云端唯一 SoR + 展示/协作端**；销售日常基本只看江湖，WorkBuddy 退为后台数据生产端。
> **本文档范围**：江湖侧需要的 schema 扩展 + 新增 MCP 写工具 + 字段映射；以及 WorkBuddy 侧的同步流程约定。
> **状态**：设计稿（待 LG 过）。对应江湖现状：`schema.prisma` / `mcpServer.ts` / `mutate.ts`（2026-06）。

---

## 0. 三决策落地（继承江湖红线 + 本次新增边界）

1. **江湖为唯一 SoR**：客户/商机/档案/拜访以江湖库为准，微盘降为 WorkBuddy 本机工作区 + 缓存。WorkBuddy 侧 `_shared/03-客户主数据查询.md` 的"写微盘主数据"改为"写江湖（经 MCP）"。
2. **人审边界**（关键）：
   - 🔴 **走候选人审**（PIPL）：**干系人本体（Person）+ 关系连线（Edge）** —— 复用现有 `propose_person` / `propose_relationship`，落候选层，人审采纳才上墙。
   - 🟢 **直接 upsert**（业务实体/评估，非个人身份判定）：**客户档案字段、商机及其阶段/竞争/金额、G64111 必清状态、拜访记录** —— 新增写工具直接落正式表，带 `origin=workbuddy` + "AI 生成/待确认"溯源，但不阻断展示。
3. **租户**：一个销售部门 = 一个江湖 tenant；AR/SR 是同租户 user；WorkBuddy 用各自长效令牌 `jh_` 写进同一租户。所有工具沿用铁律 `where { tenantId }`。

---

## 1. 跨系统幂等锚：`externalRef`

WorkBuddy 会反复推同一客户/商机，必须幂等（不重复建）。约定：

- **Account.externalRef** = 销售包 `customer_id`（如 `CNPC-BJ-001`），**主锚**。
- **Account.unifiedCreditCode**（已有）= USCC，**副锚**（externalRef 缺失时用）。
- **Opportunity.externalRef** = 销售包商机锚（单主商机可用 `{customer_id}#opp`）。
- **VisitNote.externalRef** = 销售包拜访记录文件名/hash。

upsert 逻辑（应用层去重，不靠 DB unique，保持跨库可移植 —— 与 `propose_person` 同款）：
`先按 (tenantId, externalRef) 查 → 命中则 UPDATE；未命中再按 (tenantId, unifiedCreditCode) 查 → 命中则 UPDATE 并补 externalRef；都未命中 → CREATE`。

---

## 2. Schema 扩展（`server/prisma/schema.prisma`）

> 沿用江湖惯例：不用原生 enum/json，JSON 一律 `String @default("{}")`；id 带前缀（`acc_`/`opp_`/`visit_`）。

**Account 增字段**
```prisma
externalRef  String?                 // 销售包 customer_id，跨系统幂等主锚
region       String   @default("")   // 大区
group        String   @default("")   // 集团/母公司
primaryOwner String   @default("")   // 主负责人
profile      String   @default("{}") // JSON：工商基础/集团关系/招投标/风险信号/我方现有合作/销售自填背景/AI建议
```

**Opportunity 增字段**（销售包商机有、江湖暂无的业务字段）
```prisma
externalRef          String?
status               String  @default("active") // active/paused/won/lost
productSolution      String  @default("")
competitor           String  @default("")
competitiveSituation String  @default("")        // 领先/胶着/落后/未识别
winProbability       Float   @default(0)         // ⚠️ 销售自填，AI/WorkBuddy 永不覆盖（在江湖 UI 里由销售填）
expectedSignDate     String  @default("")        // YYYY-MM-DD
expectedAmountW      Float   @default(0)         // 万元
meta                 String  @default("{}")      // JSON 兜底：BANT 辅助分等
```
> `winProbability` 体现决策②"销售自填类不被覆盖"：WorkBuddy **不推**这个字段，留给销售在江湖里填。

**新增 VisitNote 模型**（江湖目前无拜访记录实体，但它是销售包核心产出，做一等公民）
```prisma
model VisitNote {
  id            String   @id           // visit_xxx
  tenantId      String
  accountId     String
  opportunityId String?
  externalRef   String?                // 销售包拜访记录锚，幂等
  date          String   @default("")  // YYYY-MM-DD
  topic         String   @default("")
  summary       String   @default("")  // WorkBuddy 提炼正文
  participants  String   @default("[]")// JSON: [{name, side: our|customer}]
  origin        String   @default("workbuddy")
  createdBy     String   @default("")  // 提交者 userId
  createdAt     DateTime @default(now())
  @@index([accountId])
  @@index([opportunityId])
}
```
> 改 schema 后按 CLAUDE.md：`npm run generate` → `npm run db:push` → **完全重启 node 进程**。

---

## 3. 新增 MCP 写工具（`mcpServer.ts` 的 `TOOL_DEFS` + `callTool`）

> 实现 = 参数校验（仿现有 `str()/num()`）+ `where { tenantId }` 幂等查找 + 复用 `applyAction` 构造 Action 落库。全部直接写正式表（非候选），带溯源。

### 阶段 1（先打通"看得到完整客户/商机/拜访"）

| 工具 | 入参（必填**粗体**） | 落库 | 复用 |
|---|---|---|---|
| `upsert_account` | **externalRef** 或 **unifiedCreditCode**；name、customerType(1/2/3)、region、group、primaryOwner、profile | Account（幂等 upsert） | `ADD/UPDATE_ACCOUNT` + 新字段 |
| `upsert_opportunity` | 父客户(accountExternalRef/unifiedCreditCode/accountId)、**externalRef**、**name**；pipelineStage、engageStage、status、changeMode、productSolution、competitor、competitiveSituation、customerBusinessGoal、buyingMotivation、singleSalesGoal、expectedSignDate、expectedAmountW、c3Items、c5Items | Opportunity（幂等 upsert） | `ADD/UPDATE_OPP` + 新字段 |
| `append_visit_note` | 父客户、**date**、**summary**；opportunity 定位、externalRef、topic、participants | VisitNote（按 externalRef 幂等） | 新增 |

### 阶段 1.5（评分状态对齐，依赖干系人已采纳为正式 Person）

| 工具 | 作用 | 人审顺序 |
|---|---|---|
| `set_opportunity_roles` | 设 ADURC 决策链：roles[{personId, role(A/D/U/R/C), sentiment(star/plus/neutral/unknown/minus/x), isKeyInfluencer, procurementType/Status}]；R=影响者·技术把关，C=教练；P4 仅允许非 A/D 且同一商机单选 | 只能对**已存在正式 Person**；候选人物须先 `propose_person`→人审采纳，再设角色 |
| `set_burning_issue` / `set_ucv` | 设 D 的燃眉之急(BI) / 我方 UCV | 同上 |
| `propose_person`（扩展） | 增可选 `suggestedRole/suggestedSentiment`，采纳时一并落 OppRole | 候选人审 |

---

## 4. 关键设计：G64111「同步状态，不同步分数」

江湖硬规则⑥：趋赢力分由引擎（`g64111.ts` / `scoreFromState`）从**结构化状态**算出，不存死分。销售包档案里 AI 直接打了 `qwl_*` 分——**不要把分推过来存**，否则与江湖引擎不一致。

正确做法：WorkBuddy 同步**趋赢力的输入状态**，江湖自行算分：
- 6 必清 → `c3Items`/`c5Items`（boolean map：某必清项是否齐）；C5 只写五个权威键：竞标方名单/家数、招标参数、评标规则、甲方项目代表、招标代理机构
- 决策链支持度 → `set_opportunity_roles`（OppRole.role/sentiment）
- BI/UCV → `set_burning_issue`/`set_ucv`

这样 `get_win_tendency` 读到的分始终是江湖引擎算的，全局一致。

---

## 5. 字段映射总表（销售包档案 ↔ 江湖）

| 销售包（客户档案模板） | 江湖模型字段 | 写工具 | 边界 |
|---|---|---|---|
| customer_id | Account.externalRef | upsert_account | 🟢 |
| customer_name / 别名 | Account.name | upsert_account | 🟢 |
| 统一社会信用代码 | Account.unifiedCreditCode | upsert_account | 🟢 |
| customer_category(央企能源/电建/地方民营) | Account.customerType(1/2/3) | upsert_account | 🟢 |
| region / group / primary_owner | Account.region/group/primaryOwner | upsert_account | 🟢 |
| A 企业背景(工商/集团关系/招投标/风险/我方合作) | Account.profile(JSON) | upsert_account | 🟢 |
| funnel_stage(6段) | Opportunity.pipelineStage | upsert_opportunity | 🟢 |
| opportunity_status | Opportunity.status | upsert_opportunity | 🟢 |
| product_solution / competitor / competitive_situation | Opportunity 同名 | upsert_opportunity | 🟢 |
| change_mode(GTEKOC) | Opportunity.changeMode | upsert_opportunity | 🟢 |
| customer_business_goal / buying_motivation / single_sales_goal | Opportunity 同名 | upsert_opportunity | 🟢 |
| expected_signing_date / _amount_w | Opportunity.expectedSignDate/expectedAmountW | upsert_opportunity | 🟢 |
| win_probability | Opportunity.winProbability | **不推**（销售在江湖填） | ✏️ |
| qwl 必清项状态 | Opportunity.c3Items/c5Items | upsert_opportunity | 🟢 |
| ADURC 决策链（A/D/U/R/C + 支持度；R=影响者·技术把关，C=教练；P4 非 A/D 且单选） | OppRole.role/sentiment | set_opportunity_roles | 🟢（人须先采纳） |
| 干系人本人(姓名/职务/层级) | Person | propose_person | 🔴 候选 |
| 关系连线 | Edge | propose_relationship | 🔴 候选 |
| D 的 BI / 我方 UCV | BurningIssue / UCV | set_burning_issue/set_ucv | 🟢 |
| 拜访记录 | VisitNote | append_visit_note | 🟢 |

> 三类客户类型、ADURC 角色码、支持度符号（☆/+/=/?/-/x）、6 段商机阶段在两边**已经是同一套**，无需翻译层，仅做枚举值规整。

---

## 6. WorkBuddy 侧同步流程（销售包改动）

新增"同步到江湖"流程（挂进"客户档案"skill + 一个 WorkBuddy 定时任务，因平台只有定时任务、无文件监听）：

1. 配置：`~/.workbuddy/mcp.json` 加 `jianghu` server（同企查查写法），header 填本人 `jh_` 令牌；装配脚本存令牌到 `~/.digital-sales/_secrets/`。
2. 触发：① 销售跑完"企业情报增强/刷新档案/拜访提炼"后顺手同步；② 定时任务每 N 小时兜底扫描有更新的客户。
3. 动作顺序（幂等、可重复跑）：
   `upsert_account` → `upsert_opportunity` → `append_visit_note`（新拜访）→ 干系人走 `propose_person`/`propose_relationship`（候选）→（人审采纳后）`set_opportunity_roles` / `set_burning_issue` / `set_ucv`。
4. 反向（可选）：同步前先 `get_account_detail` 读江湖现有干系人，避免重复 propose。

---

## 7. 落地顺序与工作量（1–2 人）

- **M0 接通**（~0.5 天）：mcp.json + 装配脚本存令牌；用现有只读/候选工具验证管道。
- **M1 江湖 schema + 三个 upsert 写工具**（~2–3 天）：第 2、3.阶段1 节；江湖前端补"客户档案 + 商机"两个只读展示模块（读已有 state + 新字段 + VisitNote 时间线）。
- **M2 WorkBuddy 同步流程**（~2 天）：第 6 节；客户档案 skill 加同步动作 + 定时任务。
- **M3 评分状态对齐**（~2 天）：阶段 1.5 工具 + propose_person 扩展。
- **M4 收敛**：微盘主数据"写"路径切到江湖，微盘降本机缓存。

> 收尾必跑（江湖侧）：`cd app && npx tsc --noEmit && npm run test`（含 17 个 G64111 单测）；`cd server && npx tsc --noEmit`。改 G64111 相关务必跑单测。

---

## 8. 设计点 —— 2026-06-05 全部拍板：**5 项全 Yes**

> 另定：**内测数据不保留** → 本文档 §0/§1/§2/§7 中"保数据无损 / 加列迁移 / 上线前演练"相关约束**作废**；上线直接 `docker compose down -v` 重建库 + `db:push`。bug 走 A（内测冻结、只收反馈）。详见 `集成-M1实现清单.md` 决策快照。

以下 5 项均已确认为「是」：

1. **VisitNote 做一等模型**（vs 塞进 Person.logs）？建议：是。
2. **externalRef 作为跨系统幂等主锚**（销售包 customer_id）？建议：是，USCC 作副锚。
3. **G64111「同步状态不同步分数」**（WorkBuddy 推必清状态/角色/BI，江湖算分）？是。江湖 MCP 返回的分项、总分和 741 策略是唯一权威分数；WorkBuddy 不维护可独立演进的评分规则。`_shared/score.py` 仅用于断网兼容预览，必须通过江湖共享包发布的 `packages/g64111/fixtures/compatibility.json` 校验；在 `packages/g64111/` 执行 `npm run check:score-py -- --score-py <path>` 会逐项对比共享 fixture。fixture 不一致时以 MCP 结果为准并停止离线展示。

   **2026-07-12 兼容性实测：PENDING。** 销售包源码与两份装配产物中的三份 `score.py` 内容一致（SHA-256 `bbe405a06c3c6d26717f3656b2bdf584a38307541935755aa7ddb14525eb84fd`），实际运行兼容执行器仅通过 8/9 组；`fractional-c1-procurement-third` 的 C1=`2.3333333333333335` 被旧脚本以“不是整数”拒绝。在 WorkBuddy 源码与装配产物更新并通过 9/9 前，离线评分必须保持禁用，M1 阶段门不得标记通过。
4. **Opportunity 业务字段做成列**（status/competitor/金额…）vs 全塞 meta JSON？建议：常用于看板筛选的做列，其余进 meta。
5. **win_probability 留给销售在江湖填、WorkBuddy 不推**（守"销售自填不覆盖"）？建议：是。
