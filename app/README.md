# 江湖 (Game of JiangHu) · MVP

销售干系人作战地图的可运行 MVP：**关系地图**（L1–L4 关系分层）+ **G64111 趋赢力评分引擎**。

技术栈：Vite + React + TypeScript（对应 [产品设计方案](../docs/产品设计方案.md) 推荐栈）。

## 运行

```bash
cd app
npm install
npm run dev        # → http://localhost:5173
npm test           # 运行前端 adapter / UI / store 回归
npm run typecheck  # TS 类型检查
npm run build      # 生产构建

# G64111 权威引擎
cd ../packages/g64111 && npm run typecheck && npm test
```

## 已实现（本 MVP）

- **完整用户旅程 + CRUD + 持久化**：客户工作台首页（多客户）→ 新建客户 → 新建商机 → 新建干系人 → 录入全部信息。客户/商机/干系人/角色/关系/BI/UCV/交往日志均可增删改；数据存 **localStorage**（刷新不丢，单用户即可投入实际使用）
- **全字段录入**：FORM 四维 + 家庭7问、角色(A/D/U/TB/R)/支持度/可信度、招采关键人类型与状态、关键影响人(P4)、BI/UCV、交往日志（敏感标记）、商机元信息(阶段/介入阶段/C3·C5 清单/目标)
- **关系编辑器**：增删 L1–L4 连线（起点/终点/层/标签/线型/颜色/有向）
- **关系地图画布**（SVG，可平移/缩放/拖拽节点，拖拽落库持久化）
  - 5 角色徽标 **A/D/U/TB/R**（紫/红/蓝/青/绿）、支持度符号 **☆/+/=/?/−/✕**、FORM 完整度进度条、真人头像位
  - **L1–L4 分层切换**：L1 组织架构(正交线) / L2 决策权力 / L3 情感阵营 / L4 战略本质
  - 存量边(L1+基础L3) 与 增量边(L2/L3/L4) 分别渲染
- **G64111 趋赢力评分引擎**（权威实现：[`packages/g64111`](../packages/g64111)；前端 adapter：[src/lib/g64111.ts](src/lib/g64111.ts)）
  - 严格实现 [评分规格](../docs/G64111-评分规格.md)：6必清+4优势+1决胜，满分100，**允许负分**
  - 多 A/D 取中位数低分、741 竞争策略带、可配置 ScoringProfile
  - **17 个公式单测 + 可移植兼容 fixtures**覆盖关键规则（[`packages/g64111/tests`](../packages/g64111/tests)）
- **情报档案抽屉**：FORM(能源版) + 家庭7问 + BI 燃眉之急 + UCV + 交往日志（敏感动作中性指代）
- **趋赢力面板**：总分/百分比/741 态势 + C1–1K 各项缺口可视化
- **实时重算**：在档案里改某人的角色/支持度，趋赢力与竞争态势立即更新（例：拍板人 D 由「明确支持」改「倒向对手」→ 67% 跌至 35%，态势由相对优势降为相对劣势）

## 尚未实现（按路线图 V1+，见设计方案 §10）

- **后端 / PostgreSQL / 多租户 / 认证 / 多端同步**（当前为单机 localStorage 持久化；数据层已抽象在 `src/store.ts`，切换后端 API 改动集中）
- 企查查自动建图、AI 关系推断、AI 战略推演台（LLM）
- MCP Server / CLI / Skill
- 直接在画布上拖拽拉线建边（当前用「关系编辑器」表单增删）、AntV G6 图引擎（当前自绘 SVG）

## 目录

```
src/
  lib/g64111.ts        趋赢力前端 adapter/re-export
  data/seed.ts         演示种子数据（西部电力建设集团风光储项目）
  types.ts             领域类型 + 角色/支持度配色
  components/          Canvas(关系地图) / Sidebar / DetailDrawer / WinTendencyPanel / LayerTabs
  App.tsx              状态编排（编辑 → 实时重算）
```
