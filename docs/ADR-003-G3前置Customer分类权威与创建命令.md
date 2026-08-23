# ADR-003：G3 前置 Customer 分类权威与创建命令

- **状态：** 已接受（Accepted）
- **日期：** 2026-08-23
- **Approved at：** 2026-08-23
- **决策人：** 项目所有者
- **关联决策：** `docs/ADR-002-商业版单一演进与通用CRM能力分层.md`
- **关联任务：** `CORE-115`、`SAAS-102`
- **执行分支：** `codex/g3-lightweight-personal-crm`

## 1. 背景

`SAAS-102` 实施前检查发现：共享契约已经声明 `CREATE_CUSTOMER` 和
`Customer.categoryKey`，但物理 `Account` 行仍只有非空的
`customerType 1..4`，服务端也没有可执行、幂等、可审计的通用 Customer
创建命令。直接复用 `ADD_ACCOUNT`、写入任意 1–4 或新增哨兵值，都会把“尚未分类”
伪造成销售分类；先建 Account 再建 Commitment 还会留下部分写入风险。

这是 G3 快速记录的真实前置缺口，不是允许 UI 绕过的数据校验。

## 2. 决策

在 `SAAS-102` 前插入独立任务 `CORE-115`，仅完成下列最小切换：

1. 继续复用 `Account` 物理行和稳定 ID，不新建第二张 Customer 主表。
2. 为 Account 增加可空开放字符串 `categoryKey` 和 `version`；将
   `customerType` 放宽为可空，只供显式销售 adapter 兼容。
3. 通用 Customer 分类唯一权威切换为 `categoryKey`。既有 1–4 值原样保留，
   不猜测或自动回填 `categoryKey`；`categoryKey` 为空时禁止回退读取
   `customerType`，两者也不做长期双写。
4. 只落地 `CREATE_CUSTOMER` 正式命令及非敏感 receipt：命令必须执行
   tenant scope、当前数据库角色、viewer 禁写、稳定 owner 校验、幂等键、
   同事务 AuditEvent 和冲突处理。`UPDATE/ARCHIVE/RESTORE_CUSTOMER` 仍不开放。
5. SQLite 与 PostgreSQL 均提供版本化迁移、写前备份／恢复、fresh install、
   中断重跑和 schema parity 证据；商业与冻结内部路径都要通过回归。
6. `SAAS-102` 只能调用这个正式 Customer 命令和既有 Commitment 命令；
   自然语言解析仍只生成待确认草稿，未确认时正式数据零变化。

## 3. 范围边界

- 本决策只提前执行原 `CORE-501` 中 `customer.category` 的必要子集；
  `status`、`pipelineStage`、`engageStage`、`primaryDPersonId` 等消费者切换仍留在 G7。
- 不实现通用 Customer 更新、归档、恢复、合并、候选或 Agent 写入。
- 不改变 G64111/PDE 算法、Team scope、部署、套餐或 G4 顺序。
- 销售入口可以继续显式写合法的 `customerType 1..4`，但通用入口不得要求、
  推导、展示或回写该字段。

## 4. 验收与停止条件

必须同时满足：

- 未分类 Customer 可用 `categoryKey=null` 创建，且 `customerType=null`；
- 同幂等键重放只产生一行 Customer、一条 AuditEvent 和一个完成态 CommandRun；
- 同键不同 payload、重复 ID、viewer、跨租户 owner、失效 actor 和能力缺失均失败关闭；
- AuditEvent/CommandRun 不保存客户名称等敏感正文；
- 旧销售 1–4 数据和内部 shell 回归不变，通用读取不存在 category fallback；
- SQLite/PostgreSQL fresh install、升级、恢复和重复执行通过。

任一数据库无法安全放宽旧非空约束、任一通用消费者必须 fallback
`customerType`、或必须新建第二 Customer 主表时，停止并重新提交偏差决策。

## 5. 回滚

部署前可整体 revert `CORE-115` 实现提交。部署后保留 expand 字段、历史审计和已创建
Customer，设置 `CUSTOMER_COMMANDS_ENABLED=0` 关闭新入口并前向修复；不得删除业务行、
把空分类猜回 1–4 或恢复通用 fallback。

## 6. 审批记录

- **原始决定：** “批准按最小方案修复并重跑”
- **解释口径：** 批准新增并执行 `CORE-115`，完成后恢复 `SAAS-102`；不授权部署、
  合并 `main`、提前实施 G4 或扩大到完整 `CORE-501`。
