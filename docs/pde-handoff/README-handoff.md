# PDE 交接包 · 使用说明

**目的**：把江湖 PDE 模块（G64111 × 德扑决策引擎）的全部实现输入一次性交给 Claude Code。
**生成**：2026-07-01 · 基线：G64111 数字能源 v1.1（LG 修订认证版）+《PDE 模块设计 v0.1》+《G64111×PDE 量化转化设计 v0.1》+ LG 五项拍板决策。

## 文件地图

```
pde-handoff/
├── README-handoff.md        本文件
├── SPEC.md                  ★ 主执行文档：架构/内核规范/数据模型/API/导入/组件/验收
├── TASKS.md                 ★ 里程碑 M0–M5 与每期门禁
├── DECISIONS.md             已拍板决策（Claude Code 不再重问）
├── CLAUDE-pde.md            合并入仓库 CLAUDE.md 的模块硬规则
├── kernel/
│   ├── reference_impl.py    ★ 数学内核权威规范（Python oracle，可直接运行）
│   └── golden-tests.json    由 oracle 生成的黄金测试（TS 实现的验收契约，禁手改）
└── seeds/                   行业包 digital-energy v1.1（数据，非代码）
    ├── params.json          全部参数（决策#2/#3 已固化）
    ├── scoring-schema.json  11 得分项类型化定义 + 741 子策略规则
    ├── role-templates.json  四类客户 × ADURC 角色先验
    ├── signal-catalog.json  24 个行为信号（P3/1K 判定条件原文照录）
    └── action-library.json  宝典⑥⑦ 22 个动作的结构化元数据
```

## 三步使用

1. **入库**：整个 `pde-handoff/` 目录放入江湖仓库（建议 `docs/pde-handoff/`）；把 `CLAUDE-pde.md` 内容合并进仓库 CLAUDE.md。
2. **启动 Claude Code**，建议开场提示词：
   > 读取 docs/pde-handoff/ 下的 README-handoff.md、SPEC.md、TASKS.md、DECISIONS.md。按 TASKS.md 从 M0 开始执行，每个里程碑末尾跑门禁命令并贴结果，全绿后再进入下一里程碑。数学内核以 kernel/reference_impl.py 为权威规范，TS 实现必须通过 kernel/golden-tests.json（容差 1e-6）。遇到 DECISIONS.md 已覆盖的问题直接采用既有决策。
3. **人工介入点**（只有三处）：M0 后确认 worktree/目录结构符合仓库习惯；M4 后用真实 v1.1 表格试导入一次；M5 后按 TASKS 收尾节用 3 个真实在途单走端到端。

## 两个上游事实（避免误解）

- **无校准数据**：教育 BU 资料确认只有模板无历史打分，k/S₀/λ 为专家标定冷启动值；快照 inputsJson 完整留痕是为未来校准积攒训练集（决策#4）。
- **一处内核重标定**：CHECK 触发从设计文档的"熵>0.85"改为"关键干系人 n_eff<3.0"，数值验证驱动，原因见 SPEC §K5 与 DECISIONS.md 附表。

## 维护约定

改公式或参数的唯一路径：`kernel/reference_impl.py` → 重新运行生成 golden → 同步 `seeds/params.json` → 改 TS → 门禁。逆序操作（先改 TS 或直接改 golden）视为事故。
