# 江湖 · MCP 接口（查询 + 提议建图）

> 让 AI 客户端（Claude Desktop、Cline、Workbuddy、或任何支持 MCP 的客户端）连接「江湖」：
> **读**——查询客户、干系人、关系网、商机的 G64111 趋赢力评分；
> **同步**——把用户确认的客户/商机事实、原始拜访与机器候选作为一个原子 bundle 写入，并返回可重放回执；
> **提议**——把外部联网调研到的新干系人/关系**写入候选层**，由你在江湖里人审采纳后才画到关系地图上。
>
> - **传输**：streamable-HTTP，单一端点 `POST /api/mcp`（无状态，每个请求自带鉴权）。
> - **鉴权**：复用平台 JWT。请求头 `Authorization: Bearer <平台token>`，服务端据此解出工作区（tenantId）。
> - **隔离**：所有工具严格按你所在的工作区过滤，**不会跨租户**。
> - **红线**：只有带稳定业务锚的客户/商机事实和原始拜访可进入正式事实层；机器提出的人、关系、Evidence 只进入 pending 候选层。正式商机已有字段的变化进入 ChangeProposal，不静默覆盖。
> - **联网在客户端侧**：江湖后端不联网。由外部 agent 用自己的 WebSearch/WebFetch 调研，再经下面的 `propose_*` 工具把结果交给江湖。

---

## 1. 拿到平台 token

MCP 复用你登录江湖时拿到的 JWT。两种方式：

```bash
# 注册新账号（首个用户自动成为工作区 owner）
curl -s -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"yourpassword","name":"你的名字","tenantName":"你的工作区"}'

# 或登录已有账号
curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"yourpassword"}'
```

返回 JSON 里的 `token` 字段即平台 token（登录 JWT）。把它填到下面客户端配置的 `Authorization` 头里。

> **推荐：用产品内「🔌 接入 AI」面板生成长效令牌**（形如 `jh_...`），而不是用登录 JWT。长效令牌独立于登录态、可命名、可单独吊销、长期有效，更适合给外部 agent。`/api/mcp` 同时接受登录 JWT（向后兼容）和长效令牌。

> 生产环境把 `http://localhost:3001` 换成你的域名（如 `https://你的域名`，经 Nginx 反代到 `/api`）。

---

## 2. 客户端配置

### Claude Desktop（推荐）

Claude Desktop 原生 MCP 配置走 stdio，要连远程 HTTP MCP 需通过 `mcp-remote` 桥接。编辑配置文件：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jianghu": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3001/api/mcp",
        "--header",
        "Authorization: Bearer 这里填你的平台token"
      ]
    }
  }
}
```

改完**重启 Claude Desktop**。连上后即可对它说「列出我的客户」「看看西部基地这个商机的趋赢力」。

### 直接支持 streamable-HTTP 的客户端（Cline / 自研等）

如果客户端原生支持 HTTP MCP，直接填：

```json
{
  "mcpServers": {
    "jianghu": {
      "url": "http://localhost:3001/api/mcp",
      "headers": { "Authorization": "Bearer 这里填你的平台token" }
    }
  }
}
```

---

## 3. 可用工具

**WorkBuddy 推荐同步工具**

| 工具 | 作用 | 入参 |
|---|---|---|
| `sync_intel_bundle` | 一次原子同步客户、商机、拜访原文、人物候选、关系候选和 Evidence 候选；返回 `SyncReceipt` | `idempotencyKey`、`bundle` |

同一次业务同步的首次调用、网络超时重试和进程恢复必须复用同一个 `idempotencyKey`。该 key 及 people/relation/evidence 的 `ref` 必须是只含字母、数字和 `._:#/-` 的 opaque ID，禁止放姓名、手机号或正文；服务端只保存 key 的 SHA-256。相同 key + 相同 bundle 返回同一个 `syncRunId` 且 `replayed=true`；相同 key + 不同 bundle 会失败，不会误回放旧结果。

```json
{
  "idempotencyKey": "wb:customer-42:visit-20260714:v1",
  "bundle": {
    "account": { "externalRef": "customer-42", "name": "示例能源集团", "customerType": 2 },
    "opportunity": { "externalRef": "customer-42#opp", "name": "新能源数字化项目" },
    "visit": { "externalRef": "visit-20260714", "date": "2026-07-14", "summary": "用户确认的原始拜访纪要" },
    "people": [
      { "ref": "leader", "name": "李总", "title": "总经理", "evidence": "用户确认的参会名单" },
      { "ref": "director", "name": "王处长", "title": "信息处处长", "evidence": "用户确认的参会名单" }
    ],
    "relations": [
      { "ref": "reports-to", "sourceRef": "director", "targetRef": "leader", "layer": "L1", "label": "汇报" }
    ],
    "evidences": []
  }
}
```

`SyncReceipt` 字段：`created`、`updated`、`proposed`、`skipped`、`failed`。回执保存调用方提供的 opaque 业务引用和状态，不复制拜访正文、Evidence 原文或人员姓名；调用方不得把个人信息编码进引用。Bundle 在写入前整体校验，事务中任一步失败都会整体回滚。

**读工具（只读）**

| 工具 | 作用 | 入参 |
|---|---|---|
| `list_accounts` | 列出本工作区所有客户：名称、客户类型、干系人数、商机数 | 无 |
| `get_account_detail` | 某客户的干系人概览（姓名/职务/层级/是否友商/在各商机中的角色与支持度）+ 关系连线（L1-L4）+ 商机列表 | `accountId`（来自 `list_accounts`） |
| `get_win_tendency` | 某商机的 **G64111 趋赢力**评分：总分(-50~100)、百分比、741 竞争策略带、6必清/4优势/1决胜各分项明细 | `opportunityId`（来自 `get_account_detail`） |

**写工具（只写候选层，待人审）**

| 工具 | 作用 | 入参 |
|---|---|---|
| `propose_person` | 提议一个**新干系人**为候选（不立即上图）。返回候选 ID，可作 `propose_relationship` 的端点 | `accountId`、`name`（必填）；`title`/`orgLevel`(1-4)/`opportunityId`/`evidence`/`sourceUrl`/`confidence`(0-1) 可选 |
| `propose_relationship` | 提议两人之间的一条**候选关系**（不立即画线） | `opportunityId`、`source`、`target`、`label`（必填）；`layer`(L1-L4)/`evidence`/`confidence` 可选。端点 `source`/`target` 形如 `{kind:"person",id}`（已有干系人，id 来自 `get_account_detail`）或 `{kind:"suggestion",id}`（你刚 `propose_person` 的候选） |
| `list_pending` | 列出本工作区待人审的候选（人物+关系），避免重复提议 | `accountId` 可选 |

典型路径：
- **查询**：`list_accounts` → `get_account_detail` → `get_win_tendency`。
- **提议建图**：（外部 agent 先联网调研）→ `propose_person` 提交新发现的人 → `propose_relationship` 把他和已知干系人/其他候选连起来 → 提示用户「已提交 N 个候选，请到江湖『🔮 荐关系』面板人审采纳」。

> 写工具返回里会带 `note`/`deduped` 等提示：同名候选自动去重；若该客户已有同名正式干系人，会提醒由人审决定合并还是新建（AI 不自动合并）。

`upsert_account`、`upsert_opportunity`、`append_visit_note` 暂保留一版兼容，内部已复用同步服务，响应增加 `syncReceipt` 和 `deprecatedAfter: "2026-10-01"`。新 Flow 应直接改用 `sync_intel_bundle`；到期是否移除仍需单独决策。

---

## 4. 自测（curl 端到端）

```bash
TOKEN="<上面拿到的平台token>"

# 1) 握手
curl -s -X POST http://localhost:3001/api/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2) 列出工具
curl -s -X POST http://localhost:3001/api/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) 调用 list_accounts
curl -s -X POST http://localhost:3001/api/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}'
```

> 还没有数据？先带 token 调 `POST /api/demo` 载入示例工作区（含客户「西部电力建设集团」与一个风光储数字化商机），再跑上面的 `tools/call`。

### 提议建图自测（写候选 → 看图）

```bash
# 提议一个候选干系人（accountId 来自 list_accounts）
curl -s -X POST http://localhost:3001/api/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"propose_person","arguments":{"accountId":"<ACC>","name":"张调研","title":"信息化总监","orgLevel":2,"evidence":"联网调研：某新闻提及其任职","sourceUrl":"https://example.com/x"}}}'
# 返回的 suggestionId 作为关系端点，提议候选关系（target 用 get_account_detail 里的某 person id）
curl -s -X POST http://localhost:3001/api/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"propose_relationship","arguments":{"opportunityId":"<OPP>","source":{"kind":"suggestion","id":"<PS_ID>"},"target":{"kind":"person","id":"<PERSON_ID>"},"layer":"L2","label":"分管信息化"}}}'
```

提交后：候选**不会**出现在 `GET /api/state`（关系地图）里，直到你在江湖前端「🔮 荐关系」面板点采纳。采纳候选关系会**级联**把端点的候选人物一并建为正式节点并连线。

---

## 5. 外部 agent 联网调研建图（端到端工作流）

让 Workbuddy / OpenClaw / Hermes / Claude 等带联网能力的 agent 自动充实你的关系地图：

1. **连上江湖 MCP**（§2 配置，填你的平台 token）。
2. **给 agent 下指令**，例如：
   > 「用江湖 MCP 看客户『西部电力建设集团』现有干系人（`get_account_detail`）；然后联网搜索这家公司近一年的高管/信息化/采购负责人变动，把**图上还没有的人**用 `propose_person` 提交（写明 evidence 和来源链接），并用 `propose_relationship` 把他们与已知干系人的关系连起来。最后告诉我提交了几个候选。」
3. agent 用**自己的** WebSearch/WebFetch 调研（江湖后端不联网），把结果经 `propose_*` 写入候选层。
4. **你在江湖**「🔮 荐关系」面板逐个**人审**：采纳的才上图（带「📥 待核实」溯源日志），不实的忽略。

这样既借力 AI 的联网调研，又守住「真实个人关系必须人审、绝不自动写库」的合规红线。

---

## 6. 设计要点（给维护者）

- 协议处理在 `server/src/mcpServer.ts`，手写 JSON-RPC（不引第三方 MCP SDK，与 `qccMcp.ts` 风格一致、少依赖）。支持 `initialize` / `ping` / `tools/list` / `tools/call`，并接受 `notifications/*` 通知（返回 HTTP 204）。
- 路由在 `server/src/index.ts` 的 `POST /api/mcp`，`preHandler` 走现有 `app.authenticate`（JWT 校验失败回 401），随后用 `req.user.tenantId` 调工具。
- G64111 评分的唯一实现在 `packages/g64111/`，严格对齐 `docs/G64111-评分规格.md`。`server/src/g64111.ts` 与 `app/src/lib/g64111.ts` 只是 typed adapter/re-export；MCP 通过服务端 adapter 返回权威分。
- **加新工具**：在 `mcpServer.ts` 的 `TOOL_DEFS` 加定义、`callTool` 加分支，函数内 Prisma 查询**必须** `where { tenantId }`。
- **写工具铁律**：业务事实同步与机器候选分层；`PersonSuggestion` / `RelSuggestion` / pending Evidence 绝不自动成为正式 Person/Edge/approved Evidence。候选采纳逻辑在 `server/src/suggest.ts`。
- 部署唯一约束前先运行 `cd server && npm run migrate:sync-anchor-report`。若输出冲突，脚本以非零状态停止；必须人工处理清单，禁止自动合并。
- **候选数据隔离**：候选表独立存放，天然不进 `state.ts`/`get_account_detail`/`get_win_tendency`/`g64111` 等 Person 查询路径——未采纳的候选不会泄漏到关系地图/趋赢力/只读工具。
- **容量与去重**：写工具有每租户 pending 上限（防 agent 刷爆）+ 应用层去重（不靠 DB unique，保持跨 SQLite/PG 可移植）。
