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

1. **令牌**：江湖「🔌 接入 AI」生成 `jh_…`（本地联调我已帮你生成过一个，配在 mcp.json 即可）。
2. **`~/.workbuddy/mcp.json`** 加 `jianghu` server（本地联调 `url` 用 `http://localhost:3002/api/mcp`）：
   ```json
   { "mcpServers": { "jianghu": {
       "type": "http", "url": "http://localhost:3002/api/mcp",
       "headers": { "Authorization": "Bearer jh_<你的令牌>" }, "timeout": 60000 } } }
   ```
3. **部署两个 skill**（客户档案 + 拜访记录）到 WorkBuddy：文件装配则重铺 `~/.workbuddy/skills/` 后重启；GUI 建的则更新对应 Flow + SKILL 内容。**务必确认两个 SKILL 的 `allowed-tools` 都含 `mcp__jianghu__*`**。

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
| 新建客户/商机江湖没出现 | flow 没读到改后版本（重启 WorkBuddy/确认装配路径）；`allowed-tools` 缺 `mcp__jianghu__*` |
| 干系人没进收件箱 | LLM 没抽出 `adurc_changes`；或 customer 还没 upsert_account（先有客户再有干系人） |
| 支持度变更没进提案 | 该人还是候选（未采纳）→ 走的是候选不是 human-wins；先采纳为正式人 |
| 还原改动 | `cp -r 3-WorkBuddy-skill-源码.bak-20260624-1213/* 3-WorkBuddy-skill-源码/` |

---

## 七、本轮未覆盖（留后续）
- `propose_relationship`（关系候选）：拜访 LLM 提炼暂未专门抽"人↔人关系"，需扩 Flow 02 的 schema。
- **BI / UCV 同步**（C2/C6 评分输入）：需 person 关联 + 扩 `proposals.ts` 支持 burningIssue/ucv 的 human-wins。
- 江湖入口认领（江湖原生建的客户 externalRef 空 → WB cron 认领）：读工具已支持，差 WB 侧 cron flow。
