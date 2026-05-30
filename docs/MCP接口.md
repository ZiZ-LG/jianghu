# 江湖 · 只读 MCP 接口

> 让 AI 客户端（Claude Desktop、Cline、或任何支持 MCP 的客户端）**只读查询**你在「江湖」里的销售作战数据：客户、干系人、关系网、商机的 G64111 趋赢力评分。
>
> - **传输**：streamable-HTTP，单一端点 `POST /api/mcp`（无状态，每个请求自带鉴权）。
> - **鉴权**：复用平台 JWT。请求头 `Authorization: Bearer <平台token>`，服务端据此解出工作区（tenantId）。
> - **隔离**：所有工具严格按你所在的工作区过滤，**不会跨租户**。
> - **只读**：本批工具**绝不写库**，纯查询。

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

| 工具 | 作用 | 入参 |
|---|---|---|
| `list_accounts` | 列出本工作区所有客户：名称、客户类型、干系人数、商机数 | 无 |
| `get_account_detail` | 某客户的干系人概览（姓名/职务/层级/是否友商/在各商机中的角色与支持度）+ 关系连线（L1-L4）+ 商机列表 | `accountId`（来自 `list_accounts`） |
| `get_win_tendency` | 某商机的 **G64111 趋赢力**评分：总分(-50~100)、百分比、741 竞争策略带、6必清/4优势/1决胜各分项明细 | `opportunityId`（来自 `get_account_detail`） |

典型对话路径：`list_accounts` 拿到客户 → `get_account_detail` 看某客户的人与商机 → `get_win_tendency` 评估某商机赢面。

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

---

## 5. 设计要点（给维护者）

- 协议处理在 `server/src/mcpServer.ts`，手写 JSON-RPC（不引第三方 MCP SDK，与 `qccMcp.ts` 风格一致、少依赖）。支持 `initialize` / `ping` / `tools/list` / `tools/call`，并接受 `notifications/*` 通知（返回 HTTP 204）。
- 路由在 `server/src/index.ts` 的 `POST /api/mcp`，`preHandler` 走现有 `app.authenticate`（JWT 校验失败回 401），随后用 `req.user.tenantId` 调工具。
- G64111 评分在 `server/src/g64111.ts`，按 `docs/G64111-评分规格.md` 在服务端自包含实现（不跨目录引用 `app/`），与前端 `app/src/lib/g64111.ts` 算法一致。
- **加新工具**：在 `mcpServer.ts` 的 `TOOL_DEFS` 加定义、`callTool` 加分支，函数内 Prisma 查询**必须** `where { tenantId }`，且保持只读。
