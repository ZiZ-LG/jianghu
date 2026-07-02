# 决策记录（DECISIONS）

产品负责人 LG 于 2026-07-01 拍板。Claude Code 在实现中遇到相关问题时以本记录为准，**不再重新提出这些问题**。

| # | 决策 | 实现影响 |
|---|---|---|
| 1 | P2/招采相关内容沿用 G64111 v1.1 原始表述与判定标准，不做合规性改写。产品负责人确认此为小团队内部工具，合规风险由其自行承担 | 评分刻度、信号库、动作库均保留原文表述（如 `proc_strategy_alignment`、`act-procurement-intel`）；不实现敏感词提示或字段脱敏；`rawContent` 正常存储佐证原文 |
| 2 | 影响力权重 wᵢ 完全沿用 G64111 分值先验，不按客户类型微调 | `slotWeights` = A:20 / D:20 / 采购4:2:4 / 关键影响人:10 / 组员各1池5；四类客户共用；同一自然人占多 slot 时权重相加（民企 A=D → 40） |
| 3 | 可信度四档 c = 1.0 / 0.8 / 0.45 / 0.15；等效样本量 n = 8 / 5 / 2.5 / 1；半衰期 = 招采30天 / 人事倾向90天 / 结构180天 | 固化为 `seeds/params.json` 行业包默认值；实现为租户级可配但**本期不做参数管理界面** |
| 4 | 教育 BU 资料（G64111 v2.1 + GDU行动计划 v2.1）确认不含历史打分数据，无其他校准数据源 | k=4.0、S₀=0.15、λ=1.3 采用专家标定冷启动；**每个 EVSnapshot 必须完整存 inputsJson**，为未来校准积累训练集（校准管线本期不实现，但数据留痕是本期硬要求） |
| 5 | 加权分定位为作战工具，不接入任何考核 | UI 文案统一"内部决策参考"；不提供按人员聚合的加权分排行；导出报告页脚注明非考核用途 |

## 实现期间新增决策（如有）追加于下表

| 日期 | 决策 | 决策人 | 备注 |
|---|---|---|---|
| 2026-07-01 | CHECK 触发条件由"熵>0.85"改为"关键干系人 n_eff<3.0" | 引擎设计（数值验证驱动） | 混合分布天然偏软，熵阈值误伤"明确+"正常态；详见 SPEC §K5 |
| 2026-07-02 | **裁决A·前端组件嵌入式交付**：SPEC §7 五组件不建独立新面板，全部嵌入现有承载——ReviewInbox→收件箱(InboxPanel)第5类卡；EvidenceTimeline→焦点面板「动态」tab 增强；StanceRangeBar→「档案」tab 头部；IntelAndActionPanel 上半(VoI)→拜访卡引擎、下半(ΔEV)→推演坞行动列+今日一屏；DealPokerDashboard→拆两级=EngineBar 局势条日常态(四动作徽章+赢面带置信)+坞全展开复盘态(双轨分/走势/what-if) | LG（屏效三场景方案结合裁决） | 避免与既有 UI 平行重复；对齐「不新增对话框」极简约束。M5 工作量不减、形态改变 |
| 2026-07-02 | **裁决B·StanceAssessment 与 OppRole 单源化**：不建平行的 StanceAssessment 表——OppRole 扩字段承载（credibility 四档/assessedAt/sourceQuality；sentiment 即 mark 六档一一对应，confidence 三档迁移到 credibility 四档）。SPEC §4 的 StanceAssessment 模型作废，M2 落地时按此实现 | LG | 改支持度已有 3 入口，再加一表=第 4 个数据源双写灾难。M2 前必须完成迁移映射 |
| 2026-07-02 | **裁决C·引擎分层不替代**：名义分（app/server 的 g64111，60 单测不动）=团队沟通语言；PDE 加权分/赢面/EV=决策内核；现有 playbook 方案包被 741 子策略推荐菜单收编退役（避免三套打法建议并存） | LG | 铁律⑥不受影响；playbook 退役在 M3 action-ranking 落地后执行 |
| 2026-07-02 | **术语映射（展示层）**：RAISE=⬆强攻 / CALL=▶跟进 / CHECK=🔍摸底 / FOLD=⛔止损；pWin=赢面；ΔEV=预期增益；VoI=情报价值。内核与 seeds 保留英文键名 | LG | 界面语言只出现「建议动作+值多少钱+为什么」；n_eff/熵不出现在手机场景 |
| 2026-07-02 | **M0 工程决策：不引入 npm workspaces**——packages/pde-kernel 为独立包（自带 tsc build 产 dist + vitest），server/app 后续经 `file:` 依赖消费 dist | 实现（Claude Code） | workspaces 依赖提升会破坏现有 Docker 构建（server 独立 COPY+install）；file: 方案零侵入，M2 接 server 时同步改 Dockerfile COPY packages/ |
