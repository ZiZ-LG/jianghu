# CORE-108｜Commitment 消费者迁移清单

- 状态：`IN_PROGRESS`（本地验收完成；等待本批独立 commit、push 与远端 CI 阶段门）
- 权威源：同一 `PlanAction` 行的通用 Commitment 字段
- 放宽门：全部消费者已为 `DONE`，SQLite/PostgreSQL migration 与恢复验证已通过，`PlanAction.opportunityId` 已按阶段门放宽
- 回滚：每一批消费者独立提交；回滚单批不得回写或删除通用 Commitment 数据。若已存在客户级行，禁止把列强制改回非空；应关闭通用命令入口、保留 nullable 数据并前向修复

| 消费者 | 目标 | 状态 | 验证证据 |
|---|---|---|---|
| 通用 state | 客户级 Commitment 仅进入 `commitments`，不进入 legacy `planActions` | DONE | `server/tests/customer-level-commitment.test.ts` |
| Today / 需要你 | 只读 `Account.commitments`，不 fallback legacy PlanAction；同一到期提醒不重复计数 | DONE | `app/src/lib/today.test.ts` |
| 确定性巡检 | 生成 `confirmation_due`、`commitment_due`、`matter_without_next_commitment`；只写 Reminder | DONE | `server/tests/commitment-reminders.test.ts`、`server/tests/business-date-boundary.test.ts` |
| 提醒版本与终止 | Commitment key 含 `scheduleVersion`；确认/终态/拒绝/改期结束旧提醒；有效下一步结束 Matter 缺口 | DONE | `server/tests/commitment-reminders.test.ts` |
| 删除反向引用 / undo | legacy 删除与 StrategyCard 引用只接受同 Matter Commitment；客户级行失败关闭 | DONE | `server/tests/customer-level-commitment.test.ts`、`server/tests/tenant-parentage.test.ts`、`app/src/store.test.ts` |
| StrategyCard 派发 | 继续作为销售 Matter adapter，引用同 Matter Commitment ID | DONE | `server/tests/customer-level-commitment.test.ts`、`server/tests/tenant-parentage.test.ts` |
| 行动反馈 | 使用 generic version/schedule CAS，审计实体改为 Commitment；客户级完成不伪造 Evidence | DONE | `server/tests/action-feedback-commitment.test.ts`、`server/tests/customer-level-commitment.test.ts` |
| WorkBuddy / MCP adapter | 外部候选不直写正式 Commitment；既有反馈 adapter 走受检命令 | DONE | `server/tests/workbuddy-e2e.test.ts`、`server/tests/mcpBoundary.test.ts` |
| 企微日程 | 读取通用时间/负责人，客户级上下文可同步；终态删除旧日程 | DONE | `server/tests/wecom-commitment.test.ts` |
| 物理 nullable 与跨库 migration | SQLite/PostgreSQL 可允许客户级空 Matter，旧销售命令仍强制 Matter | DONE | `server/tests/sqlite-matter-upgrade.test.ts`、`server/tests/schema-render.test.ts`、`server/tests/commitment-migration.test.ts`；migration `20260821030000_release_customer_level_commitments` |
| authority map / 运维文档 | 清零 planned consumer，登记 migration、停止与回滚条件 | DONE | `packages/domain-contracts/tests/authority.test.ts`、`docs/架构-CRM字段权威映射v1.md`、`docs/部署上线指南.md` |

## 巡检不变量

1. 巡检只允许新增、刷新或结束 `Reminder`；不得写 `PlanAction`、`Opportunity`、`Account`、确认状态或执行状态。
2. 当前租户业务时区沿用产品既有 `Asia/Shanghai` 策略；周键使用该时区的周一业务日期。
3. 存量 `action_overdue` 不再生成，并在下一轮巡检自动结束；不得与 `commitment_due` 双重提醒。

## 跨库与恢复不变量

1. PostgreSQL 只允许版本化 migration 在事务内先校验 CORE-106 标记、通用契约与 tenant/Customer/可选 Matter/Person/User/下一承诺父树，再 `DROP NOT NULL` 并写 CORE-108 cutover 标记。
2. SQLite 只能走 `upgrade-sqlite-schema.ts`：先一致性备份，再由 `db push` 重建表，DDL 成功后才校验通用权威并写 cutover 标记；DDL 与标记之间中断可安全重跑。
3. cutover 后 migration 校验只比较通用 Commitment 权威，不再把合法的改期、确认或完成误判为 legacy shadow drift，也绝不 fallback 到旧字段。
