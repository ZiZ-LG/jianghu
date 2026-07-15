# ADR-INT-304：行动回填缺少事务内审计

- 状态：已批准（选项 A）
- 日期：2026-07-14
- 批准人：项目所有者
- 关联任务：INT-304
- 关联计划：`docs/superpowers/plans/2026-07-11-internal-edition-development.md`

## 背景

INT-304 只允许补契约回归和文档，同时要求完整链路达到：WorkBuddy 同步与重放、人物/关系候选人审、Evidence 审核后 PDE 变化与快照、行动完成回填，以及 `SyncRun/AuditEvent` 可追溯。

当前真实 HTTP E2E 已通过前述全部业务步骤。行动回填事务会：

1. 把 `PlanAction.done/doneAt` 更新为已完成；
2. 有目标人物且结果为 `up/down` 时创建一条 Evidence；
3. 写入一个可重放的 completed `CommandRun`；
4. 相同 `Idempotency-Key` 重放时不重复完成行动或创建 Evidence。

实现前，该事务不会写 `AuditEvent`。新增回归当时的唯一失败为：期望 1 条行动回填审计，实际 0。原有 `AuditEvent` 生产者仅覆盖归档/恢复、纠错和人物合并，不能证明这次行动回填。

## 决策选项

### A. 在行动回填事务中补最小 AuditEvent（推荐）

在完成 PlanAction、创建结果 Evidence 的同一事务中写且只写一次：

- `action = action_feedback`
- `entityKind = plan_action`
- `entityId = actionId`
- `channel = web`
- `sourceRef = evidenceId`（`flat` 或无目标人物时为空）
- `changedFields = [done, doneAt, evidenceId]`（无 Evidence 时不含 `evidenceId`）
- `metadata` 只保存非敏感 `evidenceId`，不保存行动标题、Evidence 原文、人员姓名、BI、FORM 或纪要

同 key 重放由 `CommandRun` 直接返回已完成结果，因此不会重复写审计。事务任一步失败时 PlanAction、Evidence、AuditEvent 和 completed CommandRun 一并回滚；失败可另留一条不含正文的 failed CommandRun 元数据，供安全重试和故障定位。

影响：修改 `server/src/mutation/compoundCommands.ts`（可按需抽取最小审计 helper）并让现有 INT-304 RED 转绿。它增加可追溯性，不改变行动完成、评分或人审业务语义。

### B. 把 completed CommandRun 视为充分审计并调整验收契约

保持生产代码不变，把计划、清单和 E2E 从 `SyncRun/AuditEvent` 改成 `SyncRun/CommandRun`。

影响：严格遵守“测试/文档 only”，但削弱既定的统一 AuditEvent 查询与后续 M5“所有失败能找到 SyncRun/AuditEvent”的门槛。

## 建议

批准选项 A。它是满足既定验收锚的最小生产变更，且可用已经观察到的失败测试进行 TDD；不需要新增接口、数据模型、前端入口或业务能力。

## 决策

项目所有者于 2026-07-14 批准选项 A。实现仅修改行动回填事务：写入脱敏 `AuditEvent`，并为 `flat`、无目标人物、不同重放键、跨租户拒绝及审计后故障回滚增加回归。该审计可由数据层查询；现有 RepairPanel 尚未把 `plan_action` 纳入详情类型，本任务不扩展其界面范围。

## 批准后执行

1. 保留当前 RED，不修改断言来迁就现状。
2. 只实现同事务、脱敏、一次性的行动回填 AuditEvent。
3. 运行 focused、Server 全量、App、G64111、PDE 和双 provider 门禁。
4. 独立复审事务原子性、重放唯一性、租户隔离和敏感信息泄漏。
5. 完成 INT-304 独立提交后再解锁 INT-401。

## 执行结果

选项 A 已按批准边界实施。行动完成、可选 Evidence、最小脱敏 AuditEvent 和 completed CommandRun 位于同一 Serializable 事务；同 key 重放不重复写入，不同 key 并发由 `done:false` CAS 保证仅一方成功，审计后注入故障会整体回滚。聚焦 20 项与全量门禁均通过，INT-304 和 M3 阶段门完成。

最终安全复审另确认两项既有中央契约缺口：`CommandRun.idempotencyKey` 尚未按 schema 注释统一保存 SHA-256，通用实体 ID 仍只要求非空字符串。这两项并非 INT-304 新增的租户隔离、权限或外部暴露路径，且在 action-feedback 局部修补会破坏存量重放或既有行动兼容性，因此不扩大本 ADR 的已批准范围；已登记为 INT-502 发布前中央兼容迁移与风险处置项。
