# 集成 · WorkBuddy 侧 M-A 部署指南（客户档案自动同步江湖）

> 让 WorkBuddy 新建客户 / 企查查增强时，自动把客户档案同步到江湖（云端 SoR + 关系地图）。
> **江湖侧已就绪并验证通过**；本指南是 WorkBuddy 侧的配置 + 部署 + 真机验证（GUI 操作，需你执行）。
> 配套：`集成-端到端最小链实施方案v1.md`。

---

## 一、我已改的源码（你不用改代码，只需部署）

| 文件 | 改动 |
|---|---|
| `客户档案/01-新建客户工作空间.md` | 步骤 **6.8**：新建客户落微盘后，调 `upsert_account` 同步基础字段（externalRef/name/region/group/primaryOwner）到江湖 |
| `客户档案/05-企业情报增强.md` | 步骤 **6.b**：企查查情报渲染到 A.1 后，调 `upsert_account` 回填 `profile`(工商/集团/招投标/风险/我方合作) + USCC 副锚 |
| `客户档案/SKILL.md` | `allowed-tools` 加 `mcp__jianghu__*`（工具白名单，必需）；依赖工具表加江湖一行 |

- 两套源码（`3-WorkBuddy-skill-源码/` + `一键装配包/skills/`）已同步一致。
- 备份在 `*.bak-20260624-1213`（销售包非 git，出问题可整目录还原）。
- 设计要点：江湖同步**失败不阻塞**（flow 内 try/except，客户档案仍正常落微盘）；客户档案是业务实体 → 直写江湖正式表（非候选）；干系人/关系不在 M-A（走 `propose_person` 候选，属 M-B）。

---

## 二、你要做的 4 步

### 1 · 生成江湖接入令牌
江湖产品内「🔌 接入 AI」→ 生成令牌 → 复制 `jh_xxxx`（仅显示一次）。
> 本地联调：worktree 江湖在 `http://localhost:3002`，注册账号后在「接入 AI」生成。

### 2 · 给 WorkBuddy 配 `jianghu` MCP server
编辑 `~/.workbuddy/mcp.json`，在 `mcpServers` 加一条（WorkBuddy 4.24+ 原生支持 HTTP，无需 `npx mcp-remote`）：

```json
{
  "mcpServers": {
    "jianghu": {
      "type": "http",
      "url": "https://<江湖域名>/api/mcp",
      "headers": { "Authorization": "Bearer jh_<你的令牌>" },
      "timeout": 60000
    }
  }
}
```

- 本地联调把 `url` 换成 `http://localhost:3002/api/mcp`。
- 令牌**只放这里、chmod 600、绝不入库**。
- 完成判定：在 WorkBuddy 里调 `mcp__jianghu__list_accounts`，能返回客户清单（哪怕空）即通。

### 3 · 重新部署「客户档案」skill
按你当前的装配方式二选一：
- **文件装配**（install 脚本铺到 `~/.workbuddy/skills/` 的方式）：把改后的 `3-WorkBuddy-skill-源码/客户档案/` 重新铺到 `~/.workbuddy/skills/客户档案/`（或重跑一键装配），**重启 WorkBuddy**。
- **GUI 建的 skill**：在 skill 编辑器更新「客户档案」的 system prompt 依赖工具说明 + Flow 01 / Flow 05 内容（重新贴改后的 .md），并确认工具列表勾上 `mcp__jianghu__*`。
- 关键：无论哪种，`allowed-tools` 必须含 `mcp__jianghu__*`，否则 flow 调江湖会被白名单拦截。

### 4 · 真机验证 M-A
在 WorkBuddy 说：「新建客户工作空间：江湖验收集团」

预期：
1. 微盘照常建客户档案（原有行为不变）。
2. **江湖出现该客户**——打开江湖前端看 CustomerHub，或调 `mcp__jianghu__list_accounts` 看到它（`externalRef` = WorkBuddy 的 customer_id）。
3. 几十秒后 Flow 05 企查查跑完 → 江湖该客户 `profile` 补上工商基础 + 集团关系，`unifiedCreditCode` 回填。

---

## 三、反向（江湖入口认领，可选增强）
销售在江湖原生建的客户 `externalRef` 为空。WorkBuddy 可定时（cron）调 `mcp__jianghu__list_accounts` → 筛 `externalRef` 为空的 → 认领、分配 customer_id、企查查建档 → 回写。江湖读工具已暴露 `externalRef` 支撑此判据。本轮先跑通 WorkBuddy 入口，认领流作为下一步增强。

---

## 四、红线（已内建，勿改）
- **同步状态不同步分数**：WorkBuddy 不推 `qwl_*` 趋赢力分，江湖引擎自算。
- **干系人/关系走候选**：M-B 用 `propose_person`/`propose_relationship`，人审采纳才上图（PIPL）。
- **令牌加密不外发**：`jh_` 令牌只存 `~/.workbuddy/mcp.json` / `_secrets/`，不入库。

---

## 五、出问题怎么排查
| 现象 | 排查 |
|---|---|
| `list_accounts` 调不通 | 令牌错/过期；url 不对（本地要 :3002）；江湖后端没起 |
| 新建客户江湖没出现 | flow 没读到改后版本（重启 WorkBuddy / 确认装配路径）；`allowed-tools` 没加 `mcp__jianghu__*` |
| 调用报权限/白名单错 | SKILL.md 的 `allowed-tools` 缺 `mcp__jianghu__*` |
| 想还原改动 | `cp -r 3-WorkBuddy-skill-源码.bak-20260624-1213/* 3-WorkBuddy-skill-源码/` |
