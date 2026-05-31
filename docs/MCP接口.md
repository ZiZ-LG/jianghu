# 江湖 · MCP 接口（查询 + 提议建图）

> 让 AI 客户端（Claude Desktop、Cline、Workbuddy、或任何支持 MCP 的客户端）连接「江湖」：
> **读**——查询客户、干系人、关系网、商机的 G64111 趋赢力评分；
> **提议**——把外部联网调研到的新干系人/关系**写入候选层**，由你在江湖里人审采纳后才画到侦探墙上。
>
> - **传输**：streamable-HTTP，单一端点 `POST /api/mcp`（无状态，每个请求自带鉴权）。
> - **鉴权**：复用平台 JWT。请求头 `Authorization: Bearer <平台token>`，服务端据此解出工作区（tenantId）。
> - **隔离**：所有工具严格按你所在的工作区过滤，**不会跨租户**。
> - **红线**：写工具**只写候选层（pending）、绝不直接写正式数据**。AI 提议的人/关系必须经用户在江湖里人工采纳才上墙——这是 PIPL 合规底线，AI 不替用户做身份判定。
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

返回 JSON 里的 `token` 字段即平台 token。把它填到下面客户端配置的 `Authorization` 头里。

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

**读工具（只读）**

| 工具 | 作用 | 入参 |
|---|---|---|
| `list_accounts` | 列出本工作区所有客户：名称、客户类型、干系人数、商机数 | 无 |
| `get_account_detail` | 某客户的干系人概览（姓名/职务/层级/是否友商/在各商机中的角色与支持度）+ 关系连线（L1-L4）+ 商机列表 | `accountId`（来自 `list_accounts`） |
| `get_win_tendency` | 某商机的 **G64111 趋赢力**评分：总分(-50~100)、百分比、741 竞争策略带、6必清/4优势/1决胜各分项明细 | `opportunityId`（来自 `get_account_detail`） |

**写工具（只写候选层，待人审）**

| 工具 | 作用 | 入参 |
|---|---|---|
| `propose_person` | 提议一个**新干系人**为候选（不立即上墙）。返回候选 ID，可作 `propose_relationship` 的端点 | `accountId`、`name`（必填）；`title`/`orgLevel`(1-4)/`opportunityId`/`evidence`/`sourceUrl`/`confidence`(0-1) 可选 |
| `propose_relationship` | 提议两人之间的一条**候选关系**（不立即画线） | `opportunityId`、`source`、`target`、`label`（必填）；`layer`(L1-L4)/`evidence`/`confidence` 可选。端点 `source`/`target` 形如 `{kind:"person",id}`（已有干系人，id 来自 `get_account_detail`）或 `{kind:"suggestion",id}`（你刚 `propose_person` 的候选） |
| `list_pending` | 列出本工作区待人审的候选（人物+关系），避免重复提议 | `accountId` 可选 |

典型路径：
- **查询**：`list_accounts` → `get_account_detail` → `get_win_tendency`。
- **提议建图**：（外部 agent 先联网调研）→ `propose_person` 提交新发现的人 → `propose_relationship` 把他和已知干系人/其他候选连起来 → 提示用户「已提交 N 个候选，请到江湖『🔮 荐关系』面板人审采纳」。

> 写工具返回里会带 `note`/`deduped` 等提示：同名候选自动去重；若该客户已有同名正式干系人，会提醒由人审决定合并还是新建（AI 不自动合并）。

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

### 提议建图自测（写候选 → 看墙）

```bash
# 提议一个候选干系人（accountId 来自 list_accounts）
curl -s -X POST http://localhost:3001/api/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"propose_person","arguments":{"accountId":"<ACC>","name":"张调研","title":"信息化总监","orgLevel":2,"evidence":"联网调研：某新闻提及其任职","sourceUrl":"https://example.com/x"}}}'
# 返回的 suggestionId 作为关系端点，提议候选关系（target 用 get_account_detail 里的某 person id）
curl -s -X POST http://localhost:3001/api/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"propose_relationship","arguments":{"opportunityId":"<OPP>","source":{"kind":"suggestion","id":"<PS_ID>"},"target":{"kind":"person","id":"<PERSON_ID>"},"layer":"L2","label":"分管信息化"}}}'
```

提交后：候选**不会**出现在 `GET /api/state`（侦探墙）里，直到你在江湖前端「🔮 荐关系」面板点采纳。采纳候选关系会**级联**把端点的候选人物一并建为正式节点并连线。

---

## 5. 外部 agent 联网调研建图（端到端工作流）

让 Workbuddy / OpenClaw / Hermes / Claude 等带联网能力的 agent 自动充实你的侦探墙：

1. **连上江湖 MCP**（§2 配置，填你的平台 token）。
2. **给 agent 下指令**，例如：
   > 「用江湖 MCP 看客户『西部电力建设集团』现有干系人（`get_account_detail`）；然后联网搜索这家公司近一年的高管/信息化/采购负责人变动，把**墙上还没有的人**用 `propose_person` 提交（写明 evidence 和来源链接），并用 `propose_relationship` 把他们与已知干系人的关系连起来。最后告诉我提交了几个候选。」
3. agent 用**自己的** WebSearch/WebFetch 调研（江湖后端不联网），把结果经 `propose_*` 写入候选层。
4. **你在江湖**「🔮 荐关系」面板逐个**人审**：采纳的才上墙（带「📥 待核实」溯源日志），不实的忽略。

这样既借力 AI 的联网调研，又守住「真实个人关系必须人审、绝不自动写库」的合规红线。

---

## 6. 设计要点（给维护者）

- 协议处理在 `server/src/mcpServer.ts`，手写 JSON-RPC（不引第三方 MCP SDK，与 `qccMcp.ts` 风格一致、少依赖）。支持 `initialize` / `ping` / `tools/list` / `tools/call`，并接受 `notifications/*` 通知（返回 HTTP 204）。
- 路由在 `server/src/index.ts` 的 `POST /api/mcp`，`preHandler` 走现有 `app.authenticate`（JWT 校验失败回 401），随后用 `req.user.tenantId` 调工具。
- G64111 评分在 `server/src/g64111.ts`，按 `docs/G64111-评分规格.md` 在服务端自包含实现（不跨目录引用 `app/`），与前端 `app/src/lib/g64111.ts` 算法一致。
- **加新工具**：在 `mcpServer.ts` 的 `TOOL_DEFS` 加定义、`callTool` 加分支，函数内 Prisma 查询**必须** `where { tenantId }`。
- **写工具铁律**：写工具**只写候选表**（`PersonSuggestion` / `RelSuggestion`，status=pending），**绝不**直接写 `Person`/`Edge`。候选采纳逻辑在 `server/src/suggest.ts`：候选人物 `materializePerson` 落正式 Person（带溯源日志 + `resolvedPersonId` 回写保证幂等）；候选关系 accept 走 `$transaction` 级联——端点是候选人物时先建 Person 再建 Edge，返回 `createdPersons` 供前端先 `ADD_PERSON` 再 `ADD_EDGE`。
- **候选数据隔离**：候选表独立存放，天然不进 `state.ts`/`get_account_detail`/`get_win_tendency`/`g64111` 等 Person 查询路径——未采纳的候选不会泄漏到侦探墙/趋赢力/只读工具。
- **容量与去重**：写工具有每租户 pending 上限（防 agent 刷爆）+ 应用层去重（不靠 DB unique，保持跨 SQLite/PG 可移植）。
