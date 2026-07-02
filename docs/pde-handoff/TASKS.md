# 实施里程碑（TASKS）

执行方式：Claude Code 按 M0→M5 顺序推进，**每个里程碑末尾必须跑门禁命令，全绿才进入下一个**。建议在独立 git worktree 中开发（仓库既有惯例）。遇设计歧义先查 `DECISIONS.md` 与 `SPEC.md`，仍无答案才向用户提问。

## M0 · 脚手架（半天）
- [ ] 新建 `packages/pde-kernel`（tsconfig strict、vitest、零运行时依赖）
- [ ] `apps/server/src/pde/` 与 `apps/web/src/pde/` 目录与路由/组件占位
- [ ] 把 `kernel/golden-tests.json`、`seeds/*.json` 复制进 `packages/pde-kernel/fixtures/`
- [ ] 合并 `CLAUDE-pde.md` 内容到仓库 CLAUDE.md（或作为模块级文件）
- **门禁**：`tsc --noEmit` 全仓通过；`npm test` 既有用例不回归

## M1 · 内核移植 + 黄金测试（1–2 天，最高优先级）
- [ ] 按 `kernel/reference_impl.py` 逐函数移植：`decay/blend/entropy3/evaluate/weightedScore/applyEffect/actionDeltaEV/voiStance/voiCComp/recommend`
- [ ] TS 类型固化输入输出（Deal/Stakeholder/Action/EvalResult/…）
- [ ] `test:golden`：加载 golden-tests.json，六组案例逐数值断言（|Δ|≤1e-6），含 params_echo 一致性检查
- [ ] 属性测试（补充）：pWin∈(0,1]；gate 单调（A 的 pO 越高 pWin 不升）；decay 单调
- **门禁**：`tsc --noEmit && npm test && npm run test:golden` 全绿
- ⚠️ 禁改 golden 期望值（CLAUDE-pde.md 规则 4）

## M2 · 数据层 + 行业包种子（1 天）
- [ ] Prisma 迁移：StanceAssessment / ScoringItemState / DealPdeConfig / IndustryPack / ActionCatalog + SignalCatalog 字段扩展（SPEC §4）
- [ ] `prisma/seed-pde.ts`：加载 seeds → IndustryPack("digital-energy","1.1") + 展开目录表；幂等
- [ ] tenant 守卫覆盖全部新模型
- **门禁**：迁移重放通过；seed 连跑两次结果一致；tenant 隔离用例通过

## M3 · API + 快照管线 + 审核流（2 天）
- [x] v0.1 基线路由 + SPEC §5 新增四路由（`28b72b7` 评估主链；stage-gate 按江湖架构落 mutate 钩子而非独立路由——UPDATE_OPP.engageStage 实际变化时 fire-and-forget 落快照）
- [x] 快照服务：四类触发（K7）——manual✅(`9c4aaff`) / evidence_review✅ / stage_gate✅（2026-07-02）/ import 留 M4；共用 `takePdeSnapshot`；inputsJson 完整留痕 + schemaId/Version
- [x] 审核流（2026-07-02）：EvidenceEvent +status/origin/reviewedBy/reviewedAt（默认 approved=人工直落语义存量零迁移；机器写入显式 pending_review）→ 收件箱第 5 类「⚡信号」卡（批准/带定向修改后采纳/拒绝，无静默生效）→ approve 落 evidence_review 快照 + 进 E2 燃料池（前端 adapter 过滤 pending/rejected）；voice 抽取扩 evidences 类型（25 信号键白名单、tier 以库为准、signalKey 不在库即弃）。**双层人审**：证据审事实（信号真的吗）→ 背离黄条审判断（要不要改分），与 ChangeProposal 不重复
- [x] intel-priorities / action-ranking：内核 VoI/ΔEV + ActionCatalog 联查（`28b72b7`）
- **门禁 ✅**：集成测试两条链路全过（录证据→inbox→修改后采纳→approved+审计+快照 / reject 不落快照 / stage-gate 同值不触发·变化触发 / 跨租户 404+inbox 隔离 / 重复审核 404）；preview 实测第 5 类卡+动态 tab 待审琥珀高亮→批准后高亮消失。⚠️ voice 的 evidences 抽取 prompt 分支待真实模型验证（mock 不产 evidences 字段）

## M4 · G64111 xlsx 导入（1 天）
- [ ] 解析器（SPEC §6 映射，v1.1/v1.2 双版本，锚定行容错）
- [ ] v1.1 无可信度列 → inference + needsReview 强制确认流
- [ ] 构造两个夹具 xlsx（golden deal_A 反填）+ 导入断言
- **门禁**：夹具导入 evaluate 与 golden 一致；错误文件（缺 sheet/缺锚定行）返回可读错误

## M5 · 前端组件 + E2E（2–3 天）
- [ ] 五组件（SPEC §7），先 DealPokerDashboard + IntelAndActionPanel（价值主链）
- [ ] Playwright：快乐路径 + gate 警示条 + 加权分"非考核"文案存在性断言
- **门禁**：`tsc && npm test && npm run test:golden && npx playwright test` 全绿

> **2026-07-02 裁决 A 嵌入式落地进度**（形态改变，见 DECISIONS.md；E2E 用 preview 实测替代 Playwright）：
> - ✅ DealPokerDashboard 两级：坞头四动作徽章（`6048b54`）+ 坞 full 档复盘台（双轨分+非考核文案 / 建议卡 reason+薄弱关键人 / 赢面走势 sparkline+📸 手动打点 / gate 红条）
> - ✅ StanceRangeBar → 焦点面板「档案」tab 头部（三色分布+n_eff 角标+样本薄警示，点击跳「动态」证据时间线）
> - ✅ IntelAndActionPanel 上半 VoI → 场景 A 拜访卡（`00efe7a`）；下半 ΔEV → 今日一屏 ✅ + 坞列④引擎候选（2026-07-02：action-ranking top3 虚线卡=动作+目标人+≈ΔEV[pot 缺失降级纯 pp 口径]+gist；采纳→draft 草稿开抽屉守铁律②、忽略递补、同名未完成行动自动过滤防重；坞头徽章 hover 补人话最优先动作——第5刀 best_action 非人话遗留一并关闭）
> - ✅ what-if 假设调整抽屉（2026-07-02）：新端点 `POST /api/pde/:oppId/what-if`（纯计算零写库·入出参前端值域·hypo 只算 evaluate 层，四动作建议以实际局面为准）+ 复盘台「🧪 假设推演」抽屉（逐人立场/可信度 select 默认当前值·变更行高亮·赢面/红线/预期回报三项对比·重置）；假设=此刻新情报（age 归零 q 满格）
> - ✅ ReviewInbox → 收件箱第 5 类「⚡信号」卡（2026-07-02 随 M3 审核流）：批准/带定向修改后采纳/拒绝三动作、tier 类内排序、批量支持
> - ✅ EvidenceTimeline → 焦点面板「动态」tab 并入 PDE 证据（2026-07-02）：时间序 + 待审琥珀高亮「⏳待审核（未参与计算）」+ rawContent + 溯源；rejected 不显示
> **五组件全部落地收官。**

## 收尾
- [ ] 用 3 个真实在途单跑端到端（用户操作），记录问题清单
- [ ] 在 DECISIONS.md 追加实现期间的新决策
