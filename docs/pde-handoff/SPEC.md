# 江湖 PDE 模块 · 实现规范（SPEC）

**版本**：v1.0 · 2026-07-01
**文档关系**：《PDE 模块设计 v0.1》给出引擎设计与理由，《G64111×PDE 量化转化设计 v0.1》给出领域映射与理由。**本 SPEC 是可执行实现规范，与前两者冲突时以本文件为准**（差异均已在 §K5、DECISIONS.md 中记录原因）。
**权威数值来源**：`kernel/reference_impl.py`（oracle）与其生成的 `kernel/golden-tests.json`。

---

## 0. 范围

本期交付江湖 Strategize 模块的 PDE 内核与最小可用闭环：

**In scope**：纯函数内核（TS 移植）、Prisma 数据层与行业包种子、评估/证据/审核/快照/VoI/行动排序 API、G64111 xlsx 导入、5 个前端组件。
**Out of scope**（明确不做）：参数管理界面（决策#3）、参数自动校准管线（决策#4，但数据留痕是硬要求）、LLM 证据抽取（预留接口，M 里程碑之外）、对客输出物、按人员聚合的任何评分视图（决策#5）。

## 1. 架构

```
packages/pde-kernel        纯 TS 库（零依赖、纯函数）← 移植自 kernel/reference_impl.py
apps/server  src/pde/      Fastify 路由 + 服务层（调内核、管快照、审核流）
apps/web     src/pde/      React 组件 ×5
prisma/                    模型迁移 + seeds 加载器（行业包）
```

内核对外只暴露纯函数：`blend / evaluate / weightedScore / actionDeltaEV / voiStance / voiCComp / recommend / entropy3`。类型定义与 `reference_impl.py` 的字典结构一一对应（TS 侧用 interface 固化）。

## 2. 内核规范（K1–K7）

公式细节以 `reference_impl.py` 为准，此处给实现要点与设计意图：

**K1 立场混合**：`(mark, cred, q, age_days) → (p, n_eff)`。目标分布 × 有效样本量 + 均匀先验 N0=2 混合。低可信度自动向中性收缩（贝叶斯收缩），旧信息按半衰期衰减 `n_eff = n(cred) × q × 0.5^(age/halflife)`。mark=unk 时忽略 cred，n 取 1。

**K2 胜率**：`S = Σw(pS − 1.3·pO)/Σw`；`pWin = σ(4(S−0.15)) × c_comp`；否决门：任一 A-slot 干系人 `pO ≥ 0.60` → pWin 封顶 0.15。MEMBER 权重池：≤5 人各 1，>5 人各 5/N。同一自然人多 slot 权重相加。

**K3 双轨分**：名义分 = Σraw；加权分 = Σraw × c̃，`c̃ = c(cred) × q × decay`。差值是"判断建立在推测上的比例"的直观信号。

**K4 VoI 与行动 ΔEV**：立场类未知 → 乐观/悲观合理值扫描（默认 +/明确 ↔ −/明确）；C5 未知 → c_comp 扫描 [0.70, 1.00]；C3.budget 未知 → pot 扫描 [0.6, 1.4]（EV 摆动口径）。行动效果三型：`item_resolve / cred_upgrade / mark_shift`，统一表达为对干系人 (mark, cred) 或 deal 参数的变换，`ΔEV = ΔpWin × pot × m(stage) − cost`。**信息动作 = 可信度升级**，无需特殊分支（见 golden：deal_B 的 act-verify-D，ratio 5.83）。

**K5 四动作纪律**：优先级 FOLD > CHECK > RAISE > CALL。
- FOLD：EV 连续两期 < 0 且无正 ΔEV 动作；
- CHECK：任一关键干系人（w_norm ≥ 0.15）`n_eff < 3.0`，或名义−加权分差 > 20；
- RAISE：存在动作 ΔEV > 0 且 gross/cost ≥ 1.5，且 m(stage) ≥ 0.40；
- CALL：其余。
⚠️ **与设计文档 v0.1 的差异**：CHECK 原设计用"熵 > 0.85"，数值验证发现混合分布天然偏软（"明确+"的熵即达 0.89），阈值会误伤正常状态；改用 n_eff 判据后判别干净（推理 2.5 / 不清 1 触发，明确 5 / 共识 8 不触发）。熵保留为展示字段，不参与触发。

**K6 741 子策略**：八策略不再由总分阶跃触发，作为 RAISE/CALL 的推荐菜单由构成规则驱动（见 `seeds/scoring-schema.json → strategy741.compositionRules`）。名义分区间仅用于展示"传统态势"标签，保持与纸面工具的沟通连续性。

**K7 快照触发**：`evidence_approved / stage_gate / manual / scheduled(每周)`。阶段门（进入 tender_design、tender_execution 前）强制生成快照并要求 deal owner 确认建议后才能推进阶段。

## 3. 黄金测试解读（实现完成的判定标准）

四案例 + 两个 VoI 断言，全部数值见 `golden-tests.json`（容差 1e-6）：

| 案例 | 关键期望 | 验证点 |
|---|---|---|
| deal_A_raise | S=0.2991, pWin=0.5481, EV=46.81, 加权分 50.60 → **RAISE**(act-p3-coplan, ratio 2.97) | 主链路 + RAISE 触发 |
| deal_B_check | 同为名义 60 分，加权分 19.65, pWin=0.3920 → **CHECK**；act-verify-D ratio 5.83 居首 | 双轨分区分力 + 信息动作涌现优势 |
| deal_B_voi_A | VoI(解决A立场)=15.00万；VoI(c_comp)=8.99万 | 情报优先级排序 |
| deal_Gate | A=x/明确 → gate=True, pWin 封顶 0.1500 → RAISE(act-flip-A, ΔEV+15.67) | 否决门 + "被否决时唯一出路是翻转A"的涌现策略 |
| deal_Fold | pot=10, EV=−6.53 连续两期, 所有动作 ΔEV<0 → **FOLD** | 止损纪律 |

## 4. 数据模型（Prisma，基于《PDE v0.1》§5 的增量）

> ⚠️ **2026-07-02 裁决 B 修订**（见 DECISIONS.md）：下方 `StanceAssessment` 独立表**作废**——改为 **OppRole 扩字段**承载（`credibility` 四档 / `assessedAt` / `sourceQuality`；`sentiment` 即 mark 六档一一对应；既有 `confidence` 三档迁移映射到 credibility 四档）。M2 按此实现，避免支持度出现第 4 个数据源。其余模型（ScoringItemState / DealPdeConfig / IndustryPack / ActionCatalog）不变。

沿用：`EvidenceEvent`（字段不变）、`EVSnapshot`（增 `schemaId/schemaVersion/confidenceFlag` 已在 v0.1）、`WhatIfRun`、`SignalCatalog`（增 `group/behavioral/mapsToMark/appliesToSlots/requiresManualDirection` 字段以承载种子）。

变更与新增：

```prisma
// StanceProfile 改名 StanceAssessment：存输入而非导出值（alphas 由内核在快照时派生）
model StanceAssessment {
  id            String   @id @default(cuid())
  tenantId      String
  dealId        String
  stakeholderId String
  slots         String[]                    // ["A"] / ["A","D"] / ["MEMBER"] ...
  mark          String                      // star|plus|eq|unk|minus|x
  credibility   String   @default("unclear")// consensus|explicit|inference|unclear
  sourceQuality Float    @default(1.0)      // 教练五级映射，v1 默认 1.0
  assessedAt    DateTime                    // age_days 的计算基准
  evidenceNote  String?
  @@unique([tenantId, dealId, stakeholderId])
  @@index([tenantId, dealId])
}

model ScoringItemState {                    // E 类必清项状态（含子项）
  id          String   @id @default(cuid())
  tenantId    String
  dealId      String
  itemKey     String                        // "C1" / "C3" ...
  subItemKey  String?                       // "form7" / "budget" ...
  known       Boolean  @default(false)
  credibility String   @default("unclear")
  sourceQuality Float  @default(1.0)
  collectedAt DateTime?
  note        String?
  @@unique([tenantId, dealId, itemKey, subItemKey])
  @@index([tenantId, dealId])
}

model DealPdeConfig {
  id           String  @id @default(cuid())
  tenantId     String
  dealId       String  @unique
  potValue     Float                        // 万元
  plannedCost  Float
  sunkCost     Float   @default(0)
  cComp        Float   @default(1.0)
  stage        String                       // stageEnum
  industryPackId String                     // → IndustryPack
  @@index([tenantId])
}

model IndustryPack {                        // 行业包：schema+params+signals+actions+roles 的版本化容器
  id            String @id @default(cuid())
  tenantId      String
  packKey       String                      // "digital-energy"
  schemaVersion String                      // "1.1"
  payload       Json                        // 五个 seed 文件的合并快照
  active        Boolean @default(true)
  @@unique([tenantId, packKey, schemaVersion])
}

model ActionCatalog {                       // 由行业包展开，便于查询与租户级增删
  id         String @id @default(cuid())
  tenantId   String
  packId     String
  actionKey  String                         // "act-exec-visit"
  category   String                         // info|relationship
  effectJson Json
  costTier   String
  stageWindow String
  targetSlots String[]
  gist       String
  scriptRef  String                         // 源xlsx sheet+行号
  @@unique([tenantId, packId, actionKey])
}
```

种子加载器：`prisma/seed-pde.ts` 读取 `seeds/*.json` → 写 IndustryPack + 展开 SignalCatalog/ActionCatalog。幂等（upsert by unique key）。

## 5. API（Fastify，基于《PDE v0.1》§6 的增量）

沿用 v0.1 全部路由（init / stances / evidence / review / ev / ev-history / whatif / review-inbox / signal-catalog），`stances` 的 PATCH 语义改为提交 StanceAssessment 输入字段。新增：

```
POST /api/v1/deals/:dealId/pde/import-g64111     multipart xlsx → 解析⑤打分表 → init（见 §6）
GET  /api/v1/deals/:dealId/pde/intel-priorities  VoI 排序清单（挂 ActionCatalog 中的 info 动作）
GET  /api/v1/deals/:dealId/pde/action-ranking    全动作 ΔEV 排序（含 741 子策略标签）
POST /api/v1/deals/:dealId/pde/stage-gate        阶段推进（强制快照 + owner 确认，见 K7）
```

横切：tenant 守卫复用仓库既有 hook；review 路由要求角色 ≥ deal owner；所有写路径落审计日志。

## 6. G64111 xlsx 导入映射

- 定位 sheet：名称含"趋赢力打分表"；锚定行：`编号` 列值 ∈ {C1..C6, P1..P4, 1K}。
- 列映射：`自评得分→raw`；`佐证/备注→evidenceNote`；v1.2 增列 `可信度→credibility`、`采集日期→collectedAt/assessedAt`。
- **v1.1 文件无可信度列**：全部默认 `inference` 并置 `needsReview=true`，导入完成页强制引导逐项确认（这是把存量表拉进新体系的迁移路径）。
- 表头区映射：项目名称/客户名称/客户类型（→industryPack 的 customerType）/所处阶段（中文标签→stageEnum）/主要竞争对手（→cComp 建议）/评估日期。
- 干系人：v1.1 打分表不含逐人清单 → 导入后进入"补录干系人"引导流（按 role-templates 的 slot 清单生成待填卡片）；P1/P3/P4/1K 的 raw 分仅入名义分展示。
- 导入结果落一条 `trigger=import` 的 EVSnapshot 作为基线。
- 测试夹具：M4 交付时需按 v1.1 与 v1.2 各构造一个夹具 xlsx（用 golden deal_A 数据反填），导入结果与 golden 对齐。

## 7. 前端组件（5 个）

> ⚠️ **2026-07-02 裁决 A 修订**（见 DECISIONS.md）：五组件**不建独立新面板，全部嵌入现有承载**——ReviewInbox→收件箱第 5 类卡；EvidenceTimeline→焦点面板「动态」tab；StanceRangeBar→「档案」tab 头部；IntelAndActionPanel 上半(VoI)→拜访卡、下半(ΔEV)→推演坞行动列+今日一屏；DealPokerDashboard→EngineBar 局势条日常态 + 坞全展开复盘态。下表「要点」列的内容要求全部保留，仅落位改变。术语按 DECISIONS 映射（强攻/跟进/摸底/止损、赢面）。

| 组件 | 要点 |
|---|---|
| `StanceRangeBar` | 三色堆叠条 + n_eff 角标（替代熵环，与 K5 对齐）；点击展开该人证据时间线 |
| `DealPokerDashboard` | pWin 仪表**强制伴随 confidenceFlag**；名义/加权双轨分并列；四动作建议卡（动作+理由+触发条件）；pWin 走势图打点关键证据；gate 触发时全局警示条 |
| `EvidenceTimeline` | 时间序 + 待审高亮 + rawContent 展开 |
| `ReviewInbox` | 跨 deal 聚合 pending_review；采纳/修改后采纳/拒绝三按钮；无静默生效路径 |
| `IntelAndActionPanel` | 上：情报作战清单（VoI 排序，每条挂 info 动作 gist+scriptRef）；下：行动 ΔEV 排序（关系动作，含 741 子策略标签）；替代 v0.1 的独立 WhatIfSimulator——what-if 能力并入本面板的"假设调整"抽屉 |

交互铁律沿用 v0.1：AI 建议三按钮、pWin 永不裸出、加权分处注明"作战工具，非考核指标"（决策#5）。

## 8. 验收标准

- **内核**：`npm run test:golden` 全绿（1e-6）；内核包 `tsc --noEmit` 零错误；无任何 I/O import。
- **数据层**：迁移可重放；seed 幂等；随机抽 3 个模型验证缺 tenantId 的查询被守卫拒绝。
- **API**：evidence approve → 分布重算 → 快照落库全链路集成测试；快照 inputsJson 能完整还原一次 evaluate 输入。
- **导入**：两个夹具 xlsx 导入后 evaluate 结果与 golden deal_A 一致（v1.1 夹具额外断言全项 needsReview）。
- **前端**：Playwright 走通"导入→补录干系人→录证据→审核→看板更新→读情报清单"快乐路径；gate 案例展示警示条。
- **全局**：三个真实在途单可完成端到端评估，单次 ≤ 10 分钟（沿用 P0 验收线）。
