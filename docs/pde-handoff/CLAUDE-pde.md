# PDE 模块规则（合并入江湖仓库 CLAUDE.md 或置于 packages/pde-kernel/CLAUDE.md）

## 不可违反的硬规则

1. **tenantId 硬隔离**：所有 PDE 数据模型带 `tenantId`，所有查询经 tenant 守卫中间件。无例外。
2. **AI 推断必须人工审核**：`source = ai_extracted` 的证据事件一律 `pending_review`，审核通过前不得影响立场分布或触发快照。这是仓库级既有规则在本模块的延伸。
3. **内核是纯函数**：`packages/pde-kernel` 零 I/O、零随机、零 LLM 调用、不依赖 Prisma/Fastify。同一输入永远同一输出。LLM 只出现在证据抽取与报告措辞层。
4. **黄金测试是契约**：`kernel/golden-tests.json` 的期望值**禁止手改**。测试不过 → 修代码；确需改公式 → 先改 `kernel/reference_impl.py` → 重新生成 golden → 再改 TS。任何"调整期望值让测试通过"的提交都是事故。
5. **快照完整留痕**：每个 EVSnapshot 存 `inputsJson`（全部干系人分布输入、参数、成本假设）+ `schemaVersion`。复盘功能依赖它还原决策时点。
6. **pWin 永不裸出**：任何返回 pWin 的 API 同时返回 `confidenceFlag`；任何展示 pWin 的组件同时展示置信状态。
7. **行业内容是数据不是代码**：评分项、信号、动作、角色模板全部走 seeds/行业包，按租户加载。新增行业 = 新增数据包，不改内核。

## 工程约定

- 技术栈沿用仓库现状：TypeScript strict / Fastify / Prisma / Vite + React；测试 vitest（内核）+ 既有集成测试框架 + Playwright（前端）。
- 内核数值容差：与 golden 比对 `|Δ| ≤ 1e-6`。
- 每个里程碑（TASKS.md）结束必须跑自验证循环：`tsc --noEmit && npm test`，M1 起加 `npm run test:golden`，M5 加 Playwright。门禁不过不得进入下一里程碑。
- 决策类问题先查 `DECISIONS.md`，已有结论不再向用户提问。
