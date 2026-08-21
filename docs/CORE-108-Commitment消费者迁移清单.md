# CORE-108｜Commitment 消费者迁移清单

- 状态：`IN_PROGRESS`
- 权威源：同一 `PlanAction` 行的通用 Commitment 字段
- 放宽门：本表所有消费者为 `DONE`、跨库 migration 与恢复验证通过后，才允许 `PlanAction.opportunityId` 可空
- 回滚：每一批消费者独立提交；回滚单批不得回写或删除通用 Commitment 数据

| 消费者 | 目标 | 状态 | 验证证据 |
|---|---|---|---|
| 通用 state | 客户级 Commitment 仅进入 `commitments`，不进入 legacy `planActions` | IN_PROGRESS | CORE-107 已切通用投影；待 nullable fixture |
| Today / 需要你 | 只读 `Account.commitments`，不 fallback legacy PlanAction；同一到期提醒不重复计数 | DONE | `app/src/lib/today.test.ts` |
| 确定性巡检 | 生成 `confirmation_due`、`commitment_due`、`matter_without_next_commitment`；只写 Reminder | DONE | `server/tests/commitment-reminders.test.ts`、`server/tests/business-date-boundary.test.ts` |
| 提醒版本与终止 | Commitment key 含 `scheduleVersion`；确认/终态/拒绝/改期结束旧提醒；有效下一步结束 Matter 缺口 | DONE | `server/tests/commitment-reminders.test.ts` |
| 删除反向引用 / undo | legacy 删除与 StrategyCard 引用只接受同 Matter Commitment；客户级行失败关闭 | PENDING | 待 scope/store/state fixture |
| StrategyCard 派发 | 继续作为销售 Matter adapter，引用同 Matter Commitment ID | PENDING | 待派发/父树回归 |
| 行动反馈 | 使用 generic version/schedule CAS，审计实体改为 Commitment；客户级完成不伪造 Evidence | PENDING | 待 WorkBuddy 与 customer-level fixture |
| WorkBuddy / MCP adapter | 外部候选不直写正式 Commitment；既有反馈 adapter 走受检命令 | PENDING | 待 WorkBuddy E2E/MCP 边界回归 |
| 企微日程 | 读取通用时间/负责人，客户级上下文可同步；终态删除旧日程 | PENDING | 待 WeCom connector fixture |
| 物理 nullable 与跨库 migration | SQLite/PostgreSQL 可允许客户级空 Matter，旧销售命令仍强制 Matter | BLOCKED | 必须等待以上消费者清零 |
| authority map / 运维文档 | 清零 planned consumer，登记 migration、停止与回滚条件 | PENDING | 最终阶段门更新 |

## 巡检不变量

1. 巡检只允许新增、刷新或结束 `Reminder`；不得写 `PlanAction`、`Opportunity`、`Account`、确认状态或执行状态。
2. 当前租户业务时区沿用产品既有 `Asia/Shanghai` 策略；周键使用该时区的周一业务日期。
3. 存量 `action_overdue` 不再生成，并在下一轮巡检自动结束；不得与 `commitment_due` 双重提醒。
