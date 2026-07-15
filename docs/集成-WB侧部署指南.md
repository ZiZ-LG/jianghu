# 集成 · WorkBuddy 侧部署指南（M-A/B/C 端到端最小链）

> 让 WorkBuddy 通过原子 `sync_intel_bundle` 把客户档案、商机、拜访原文和机器候选同步到江湖（云端 SoR + 关系地图）。
> 江湖侧已就绪并验证；本指南 = WorkBuddy 侧配置 + 部署 + 真机验证（GUI 操作，需你执行）。
> 配套：`集成-端到端最小链实施方案v1.md`。

---

## 一、我已改的源码（你不用改代码，只需部署）

| 文件 | 改动 | 里程碑 |
|---|---|---|
| `客户档案/01-新建客户工作空间.md` | 步骤 **6.8**：新建客户落微盘后 `upsert_account` 同步基础字段 | M-A |
| `客户档案/05-企业情报增强.md` | 步骤 **6.b**：企查查情报渲染后 `upsert_account` 回填 `profile` + USCC | M-A |
| `客户档案/03-合并已确认更新.md` | 步骤 **8.b**：销售勾选确认商机字段后 `upsert_opportunity` 同步商机 | M-B |
| `拜访记录/02-提炼生成拜访记录.md` | 步骤 **6.b**：拜访写盘后 `append_visit_note` + 干系人 `propose_person`（候选）/ `set_*`（图上已有的人 human-wins） | M-C + M-B |
| `客户档案/SKILL.md` · `拜访记录/SKILL.md` | `allowed-tools` 各加 `mcp__jianghu__*` | 必需 |

- 江湖侧（worktree `:3002` 已部署）：读工具返回 `externalRef`（供反查 accountId/oppId）+ `set_*` human-wins。
- 两套源码（`3-WorkBuddy-skill-源码/` + `一键装配包/skills/`）已同步；备份 `*.bak-20260624-1213`（销售包非 git，可整目录还原）。
- 设计：江湖同步**失败不阻塞**（flow 内 try/except，微盘照常写）；客户/商机/拜访=业务实体直写；**干系人/关系=候选人审（PIPL）**；评分输入变更=human-wins 转提案。

---

## 二、配置（一次性，M-A 时已做的话跳过）

1. **令牌**：江湖「🔌 接入 AI」选择用途预设并生成 `jh_…`。WorkBuddy 正式同步请选择 **Workbuddy 同步**；升级前生成的旧令牌会安全降为只读，需要重新签发。
2. **`~/.workbuddy/mcp.json`** 加 `jianghu` server（本地联调 `url` 用 `http://localhost:3002/api/mcp`）：
   ```json
   { "mcpServers": { "jianghu": {
       "type": "http", "url": "http://localhost:3002/api/mcp",
       "headers": { "Authorization": "Bearer jh_<你的令牌>" }, "timeout": 60000 } } }
   ```
3. **部署两个 skill**（客户档案 + 拜访记录）到 WorkBuddy：文件装配则重铺 `~/.workbuddy/skills/` 后重启；GUI 建的则更新对应 Flow + SKILL 内容。**务必确认两个 SKILL 的 `allowed-tools` 都含 `mcp__jianghu__*`**。

### 令牌最小权限预设

| 预设 | 能力 | 适用场景 |
|---|---|---|
| **Workbuddy 同步** | 读取；同步客户/商机/拜访；提交人物、关系、证据候选 | 正式 WorkBuddy Flow |
| **只读分析** | 仅读取 | 报表、分析、诊断连接 |
| **调研提案** | 读取；提交人物、关系、证据候选；不能写正式业务数据 | 外部调研 Agent |

外部令牌不包含人工命令权限，不能调用 `set_opportunity_roles`、`set_burning_issue` 或 `set_ucv`。令牌吊销、所属成员被移除、或角色被降为只读后，下一次请求立即按当前权限生效；无需等待令牌过期。请勿复用旧令牌规避预设。

---

## 三、真机验证（按 M-A → M-B → M-C）

- **M-A**（已验通 ✅）：「新建客户：XX」→ 江湖 CustomerHub 出现客户。
- **M-B 商机 + 干系人**：
  1. 录一段拜访（口述客户参会人、谁是拍板人/技术把关等），命名 `【拜访】XX …` → 等 4h 定时 或 说"处理新拜访"。
  2. 预期：江湖**拜访时间线**出现该拜访；**收件箱**出现干系人候选（带建议角色/支持度）。
  3. 在 Obsidian 勾 `[x]` 确认商机字段 → 合并 → 江湖**出现商机**（externalRef=`{customer_id}#opp`）。
- **M-C 评分 human-wins**：对**已采纳**的干系人，下次拜访提到他支持度变化 → 江湖**收件箱出现"支持度变更提案"**（不直接改分，需你采纳）。

---

## 四、江湖端调用点（我已 curl 全部验通，真机若异常可对照）

| 调用 | 定位方式 | 验证结论 |
|---|---|---|
| `upsert_account` / `upsert_opportunity` | `accountExternalRef` + `externalRef` | 幂等 ✓ |
| `append_visit_note` | `accountExternalRef` + `opportunityExternalRef` | 幂等 ✓ |
| `propose_person` | `accountId`（WB 经 `list_accounts` 按 externalRef 反查）+ `opportunityId`（`get_account_detail` 按 oppExtRef 反查） | 候选不进 state ✓ |
| `set_opportunity_roles` | `opportunityExternalRef` + `accountExternalRef` | 首次直写 / 变更转提案 / unknown 不覆盖 ✓ |

### 新 Flow 迁移口径

1. 同一次 WorkBuddy 业务处理生成一个稳定 `idempotencyKey`，网络重试不得重新生成。
2. 用一次 `sync_intel_bundle` 提交客户、商机、拜访和候选；不要再把一次业务拆成多个相互独立的 upsert。
3. 保存返回的 `syncRunId`，按 `created / updated / proposed / skipped / failed` 判断结果。只有工具明确失败时才重试；重试复用原 key 与原 bundle。
4. `upsert_account`、`upsert_opportunity`、`append_visit_note` 兼容到 `2026-10-01`，响应会带 `deprecatedAfter` 和同结构 `syncReceipt`。迁移完成后再评估是否移除，不在本次部署中强删。

标准请求外壳与回执：

```json
{
  "jsonrpc": "2.0",
  "id": 304,
  "method": "tools/call",
  "params": {
    "name": "sync_intel_bundle",
    "arguments": { "idempotencyKey": "wb:customer-42:phase-a:v1", "bundle": { "account": { "externalRef": "customer-42", "name": "示例客户" } } }
  }
}
```

成功回执包含 `syncRunId / created / updated / proposed / skipped / failed / replayed`。首次为 `replayed: false`；同 key + **逐字段相同 bundle**重试时 `syncRunId` 和明细保持稳定，仅变为 `replayed: true`。同 key + 不同 bundle 是冲突，不能用“补字段”的方式重试。

### Evidence 必须分两阶段

1. **Phase A** 用 key A 同步客户、商机、拜访、人物候选和关系候选；人物/关系只进收件箱。
2. 销售在江湖逐个采纳或修改后采纳人物，再采纳关系；取得江湖生成的正式 `personId`。
3. **Phase B** 用 key B 提交 Evidence 候选，`personId` 必须是上一步的正式 ID。Phase B 不要再携带待审人物 ref 冒充 personId。
4. Evidence 仍为 `pending_review`，人审批准后才改变 PDE 并生成可复盘快照。

Phase A 和 Phase B 各自保存 key 与原请求；任何超时只原样重放对应 Phase。WorkBuddy 不得根据网络结果猜测“已经写入”并换新 key。

### 行动结果回填示例（人类登录态）

```bash
curl -s -X POST https://<江湖域名>/api/commands/action-feedback \
  -H "Authorization: Bearer <登录 JWT>" \
  -H "Idempotency-Key: cmd_01J304WB7R6M9K2Q5T8V1X3Z4A" \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"<ACCOUNT_ID>","opportunityId":"<OPPORTUNITY_ID>","actionId":"<PLAN_ACTION_ID>","outcome":"up","occurredAt":"2026-07-14"}'
```

这一步只能由当前工作区有写权限的登录用户执行。key 必须随机生成且保持 opaque，禁止放客户标识、姓名、日期、正文或 Token。相同 key 与参数重试返回 `replayed: true`，行动只完成一次、适用的结果 Evidence 只写一次；首次成功会与行动及 Evidence 在同一事务写一条脱敏审计，重放不会增加审计。不要把 `jh_…` WorkBuddy Token 当作人工命令凭证。

部署数据库唯一约束前先在目标环境运行：

```bash
cd server
npm run migrate:sync-anchor-report
```

若 `conflictCount` 非零，停止部署并人工核对清单；不得自动合并客户、商机或拜访。

---

## 五、红线（已内建，勿改）
- **同步状态不同步分数**：WorkBuddy 不推 `qwl_*`，江湖引擎自算。
- **干系人/关系走候选**：人审采纳才上图（PIPL）。
- **令牌不外发**：只存 `~/.workbuddy/mcp.json` / `_secrets/`，不入库不截图。

---

## 六、排查
| 现象 | 排查 |
|---|---|
| `list_accounts` 调不通 | 令牌错；url 不对（本地 :3002）；江湖后端没起 |
| 写工具提示令牌无权调用 | 检查令牌预设；旧令牌或降级成员仅能只读。按实际用途重新签发并替换本机配置后重试，业务重试继续复用原 `idempotencyKey` |
| 新建客户/商机江湖没出现 | flow 没读到改后版本（重启 WorkBuddy/确认装配路径）；`allowed-tools` 缺 `mcp__jianghu__*` |
| 干系人没进收件箱 | LLM 没抽出 `adurc_changes`；或 customer 还没 upsert_account（先有客户再有干系人） |
| 支持度变更没进提案 | 该人还是候选（未采纳）→ 走的是候选不是 human-wins；先采纳为正式人 |
| 还原改动 | `cp -r 3-WorkBuddy-skill-源码.bak-20260624-1213/* 3-WorkBuddy-skill-源码/` |

---

## 七、本轮未覆盖（留后续）
- `propose_relationship`（关系候选）：拜访 LLM 提炼暂未专门抽"人↔人关系"，需扩 Flow 02 的 schema。
- **BI / UCV 同步**（C2/C6 评分输入）：需 person 关联 + 扩 `proposals.ts` 支持 burningIssue/ucv 的 human-wins。
- 江湖入口认领（江湖原生建的客户 externalRef 空 → WB cron 认领）：读工具已支持，差 WB 侧 cron flow。
