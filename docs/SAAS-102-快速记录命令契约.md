# SAAS-102：快速记录命令契约

- **状态：** 已实现并通过阶段门
- **日期：** 2026-08-23
- **关联任务：** `SAAS-102`、`CORE-115`
- **执行分支：** `codex/g3-lightweight-personal-crm`
- **实现提交：** `b89a0228002da69b70c0aefe048e2435cc5cabf1`
- **远端证据：** [GitHub Actions 32660745299](https://github.com/ZiZ-LG/jianghu/actions/runs/32660745299)，精确 SHA 12/12 jobs 全绿

## 1. 用途与边界

`POST /api/commands/quick-capture` 是用户确认后的单一应用命令，用于把：

1. 已有 Customer，或一个待原子创建的 inline Customer；
2. 一条客户级或 Matter 级的下一步 Commitment；

在一个 Serializable 事务内正式保存。它组合既有 `CREATE_CUSTOMER` 与
`CREATE_COMMITMENT` 领域命令，不建立第二套 Customer/Commitment 写路径，也不加入
`CrmCommandSchema`。

自然语言只在客户端生成待确认草稿。解析、预览或修改草稿均不得写正式 Customer、
Commitment、AuditEvent 或 CommandRun；只有用户点击确认才调用本端点。AI 或解析器不得
直接写入关系、阶段、Forecast、关键人状态或其他正式业务字段。

## 2. 请求

### 2.1 HTTP

- 方法与路径：`POST /api/commands/quick-capture`
- 认证：有效 Bearer JWT；`viewer` 一律拒绝写入。
- 能力：当前产品策略必须允许 `crm.core`。
- 幂等：必须带 `Idempotency-Key`，去空白后长度至少 8、原始长度不超过 200；网络结果未知时只能使用同一个请求体和同一个 key 重试。
- Content-Type：`application/json`。

### 2.2 请求体

以下示例创建一个未分类 Customer，并为当前用户创建客户级下一步：

```json
{
  "customer": {
    "mode": "create",
    "command": {
      "type": "CREATE_CUSTOMER",
      "customer": {
        "id": "customer_0123456789abcdef0123456789abcdef",
        "name": "示例客户",
        "categoryKey": null,
        "primaryOwnerUserId": "current-user-id"
      }
    }
  },
  "commitment": {
    "type": "CREATE_COMMITMENT",
    "commitment": {
      "id": "commitment_0123456789abcdef0123456789abcdef",
      "customerId": "customer_0123456789abcdef0123456789abcdef",
      "matterId": null,
      "personId": null,
      "title": "周四与客户交流方案",
      "kind": "follow_up",
      "ownerUserId": "current-user-id",
      "confirmationStatus": "not_required",
      "scheduledAtUtc": "2026-08-27T22:00:00.000Z",
      "dueAtUtc": null,
      "timeZone": "America/Los_Angeles",
      "isAllDay": false,
      "localDate": null,
      "confirmationDueAtUtc": null,
      "source": "manual_quick_capture",
      "sourceRef": null
    }
  }
}
```

选择已有 Customer 时，`customer` 改为：

```json
{ "mode": "existing", "customerId": "existing-customer-id" }
```

### 2.3 固定约束

- 新实体 ID 必须是类型前缀加 128-bit 小写十六进制随机后缀。
- Customer 名称去空白后为 1–120 字符；下一步标题为 1–200 字符。
- Customer 与 Commitment 的 `customerId` 必须完全相同。
- inline 新 Customer 的 `primaryOwnerUserId` 必须是当前 actor；下一步
  `ownerUserId` 也必须是当前 actor。
- inline 新 Customer 尚无正式 Matter/Person，因此 `matterId` 与 `personId` 必须为
  `null`。
- 已有 Customer、可选 Matter 与 Person 必须同时通过当前数据库角色重验、tenant
  scope 和 `EffectiveResourceScope`；越权统一按不存在处理。
- Quick Capture 只接受定时跟进：`kind=follow_up`、`scheduledAtUtc` 为规范 UTC
  instant、`dueAtUtc=null`、`isAllDay=false`、`localDate=null`、
  `source=manual_quick_capture`、`sourceRef=null`。客户端不能覆盖这些字面量。
- `confirmationStatus` 只能是 `not_required` 或 `pending`；为 `pending` 时必须提供早于
  事件时间的 `confirmationDueAtUtc`，否则必须为 `null`。

## 3. 原子性、审计与重放

端点由外层 `runCommand` 建立单一 Serializable 事务。在同一事务内：

1. 重新验证当前 actor、产品能力、tenant/scope 和父树；
2. inline 模式执行正式 `CREATE_CUSTOMER`；
3. 执行正式 `CREATE_COMMITMENT`；
4. 写入各自的脱敏 AuditEvent，并把 Quick Capture CommandRun 标记完成。

任一步失败时 Customer、Commitment、AuditEvent 与完成态 CommandRun 一起回滚，不允许
留下“只有客户、没有下一步”的半成品。同一 tenant/actor/kind/key 且 payload 相同的
完成态重放只返回原 receipt，不重复写业务行或审计；同 key 不同 payload 返回冲突。
CommandRun/receipt 不保存客户名称、下一步标题等正文。企微同步只在首次成功提交后异步
触发，幂等重放不重复触发，也不影响主事务成功结论。

## 4. 成功响应

inline 创建成功时返回脱敏 Customer receipt；已有 Customer 时 `customer` 为 `null`：

```json
{
  "customer": {
    "customerId": "customer_0123456789abcdef0123456789abcdef",
    "categoryKey": null,
    "primaryOwnerUserId": "current-user-id",
    "version": 0,
    "undoable": false
  },
  "commitment": {
    "commitmentId": "commitment_0123456789abcdef0123456789abcdef",
    "customerId": "customer_0123456789abcdef0123456789abcdef",
    "matterId": null,
    "executionStatus": "planned",
    "confirmationStatus": "not_required",
    "version": 0,
    "scheduleVersion": 0,
    "nextCommitmentId": null,
    "linkedFromCommitmentId": null,
    "undoable": false,
    "repairCommands": ["RESCHEDULE_COMMITMENT", "CANCEL_COMMITMENT"]
  },
  "replayed": false
}
```

客户端必须运行时校验 receipt、`replayed` 及返回的 Customer/Commitment/Matter ID 是否与
提交命令一致。畸形或错配的 2xx 响应按 `invalid_response` 处理，不得把草稿误标成保存
成功。

## 5. 失败语义

| HTTP | 代表场景 | 处理要求 |
|---:|---|---|
| 400 | 无效幂等 key、请求体或固定字面量不合法 | 保留原始输入／草稿，修正后使用新的业务动作 key |
| 401 | 未认证或会话失效 | 不跨会话自动重放旧命令 |
| 403 | viewer、能力未启用、owner/assignment 不合法 | 失败关闭，不泄露其他租户数据 |
| 404 | Customer/Matter/Person 不在当前 tenant/effective scope | 返回通用“资源不存在”，不披露真实存在性 |
| 409 | 同 key 不同 payload、命令仍在执行、ID/版本/状态冲突 | 刷新正式状态后由用户决定是否创建新业务动作 |
| 503 | Customer/Commitment 命令关闭或事务暂时可重试 | 原 key、原 payload 有界重试 |
| 500 | 未预期内部错误 | 服务端按 requestId 记录详情；客户端只显示通用错误并保留草稿 |

客户端只对网络错误或 timeout 自动重试一次，并固定认证快照、请求体与
`Idempotency-Key`。若命令已经成功但后续 `/api/state` 刷新失败，必须立即清除已提交
草稿、展示“已保存”并只允许重试刷新；不得再次提交 Quick Capture。

## 6. 客户端草稿与时间边界

- 首屏只要求 Customer、下一步标题和本地时间；Matter、Person 与临近确认渐进展开。
- 自然语言输入上限 500 字符；解析失败必须原样保留输入。
- 本地时间由显式 IANA 时区确定性转换；夏令时跳空或回拨歧义时间拒绝生成草稿，要求
  用户选择明确时间，不能静默猜测。
- 草稿确认前正式数据库计数保持不变；保存期间整个编辑 fieldset 禁用，避免慢请求期间
  修改后被成功响应覆盖。

## 7. 运行门与回滚

- `COMMITMENT_COMMANDS_ENABLED=0`：关闭整个 Quick Capture 正式保存入口。
- `CUSTOMER_COMMANDS_ENABLED=0`：只关闭 inline Customer 模式；已有 Customer 仍受
  Commitment 门控制。
- 部署前可 revert `b89a0228002da69b70c0aefe048e2435cc5cabf1`；部署后优先关闭
  Commitment 命令并前向修复，保留已经确认的 Customer、Commitment、AuditEvent 与
  CommandRun，禁止删除或改写正式业务记录。
- 本任务不包含 SAAS-103 Today 读模型、SAAS-104 状态闭环、schema/migration、生产部署
  或 `main` 合并。

## 8. 验收证据

- Domain Contracts：7 files / 72 tests；G64111：2 / 32；PDE Kernel：3 / 25。
- App：35 files / 278 tests、严格类型检查与 production build 全绿。
- Server：60 files / 465 tests、严格类型检查、PostgreSQL schema check 与真实
  PostgreSQL 运维集成全绿。
- 浏览器 QA：未确认草稿正式数据零变化；确认后 Customer 1、Commitment 1、Audit 2；
  390×844 无横向溢出，输入 16px、交互控件至少 44px；慢请求期间编辑器完全禁用；命令
  成功而 state 刷新失败时不重复提交。
- 独立安全、设计、测试、维护性、性能、红队与对抗复审发现的问题均在提交前关闭；最终
  无未关闭 Critical / Important 阻断项。
- [GitHub Actions 32660745299](https://github.com/ZiZ-LG/jianghu/actions/runs/32660745299)
  对应精确实现 SHA `b89a0228002da69b70c0aefe048e2435cc5cabf1`，12/12 jobs 全绿。
