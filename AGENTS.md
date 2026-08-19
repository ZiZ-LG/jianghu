# AGENTS.md — 江湖 (Game of JiangHu)

> 给 Codex 的项目操作手册。每次对话都会被读入，**保持精简**。

## 这是什么

面向复杂大客户/大项目销售的「干系人作战地图」SaaS：可视化客户内部权力关系网（关系地图 L1–L4），用 **G64111 趋赢力** 方法论打分，多人云端协作。

## 技术栈

- **前端 `app/`**：Vite + React + **TypeScript**（`.tsx` 组件 / `.ts` 逻辑）。乐观本地更新 + 云端同步。
- **后端 `server/`**：Fastify + Prisma + JWT。多租户 SaaS，RBAC，免费多人协作（50 席）+ 自愿捐赠。
- **数据库**：dev = SQLite（`server/prisma/dev.db`，零配置）；prod = Postgres（由 `schema:postgres:render` 确定性生成专用 schema，版本化 migration 经 `migrate deploy` 执行）。
- 源码全是 TypeScript（仓库统计里的 `.js/.map` 来自 `node_modules`）。

## 仓库结构（monorepo）

```
app/                     前端 SPA
  src/store.ts           ★ 前后端数据契约（Action 定义）
  src/lib/g64111.ts      G64111 前端领域 adapter/re-export
  src/ui.ts              主题(useTheme)/UI偏好(usePersistentState，localStorage)
  src/aiContext.ts       AI 推演台上下文
  src/api.ts  types.ts  styles.css  data/seed.ts  components/
server/                  后端 API
  src/index.ts           入口（Fastify，含 helmet/限流/CORS/JWT 守卫）
  src/auth.ts            认证 / JWT / RBAC（owner/admin/member/viewer）
  src/mutate.ts          写操作（对齐前端 Action 契约）
  src/state.ts           组装整树 GET /api/state
  src/ai.ts  suggest.ts  enrich.ts   AI 推演 / 关系推断 / 企查查建图
  src/qccMcp.ts          企查查 MCP（streamable-HTTP）客户端
  prisma/schema.prisma   数据模型
packages/pde-kernel/     ★ PDE 数学内核（G64111×EV 决策引擎，纯函数零依赖）；权威规范=docs/pde-handoff/（oracle+golden **禁手改**）；硬规则见包内 AGENTS.md
packages/g64111/       ★ G64111 唯一评分实现（公式单测+兼容 fixtures）
packages/domain-contracts/  共享领域契约（Action/schema，app 与 server 共用）
docs/                    PRD、G64111-评分规格.md、部署指南（设计权威来源）
docs/pde-handoff/        PDE 交接包（SPEC/TASKS/DECISIONS/reference_impl.py/golden/seeds）
参考文件/                 原始原型与方法论素材
deploy-macmini.sh        单机/内网一键部署（复用生产 Docker 栈）
docker-compose.yml       生产部署栈（Postgres + 后端 + Nginx 前端）
```

## 常用命令

后端（:3001）
```bash
cd server && npm install
npm run generate     # 生成 Prisma 客户端
npm run db:push      # 建/同步库（SQLite dev.db）
npm run dev          # tsx watch
```

前端（:5173）
```bash
cd app && npm install && npm run dev
```

收尾必跑（提交前）
```bash
cd packages/g64111 && npm run typecheck && npm test   # G64111 类型 + 公式/兼容回归
cd app && npx tsc --noEmit && npm run test   # 前端类型 + adapter 消费回归
cd server && npx tsc --noEmit                # 后端类型
# 改过 packages/pde-kernel 时追加：
cd packages/pde-kernel && npx tsc --noEmit && npm run test   # 内核类型 + golden(1e-6) + 属性测试
```

> 完整脚本以各 `package.json` 的 `scripts` 为准（含 build / preview）。**改算法后务必跑 `packages/g64111/`、`app/` 和 server parity 单测。**
> ⚠️ 改过 `packages/*` 后，先在 `app/`、`server/` 重跑 `npm ci --install-links` 再跑收尾——`file:` 协议安装是**复制不是软链**，不刷新会拿着过期副本得到假红/假绿。

## 不可违背的硬规则

1. **多租户隔离**：所有数据读写**必须按 `tenantId` 作用域**过滤；新增任何查询/接口都要带租户隔离。数据安全红线，**绝不跨租户**。viewer 角色（销售包只读投影）再加一层行级隔离：只见 `Account.primaryOwner === User.name` 的客户——新增「按 id 直查」的读接口须带 viewer 归属校验，写接口须挡 viewer（helper 在 `server/src/scope.ts`）。
2. **AI 结果绝不自动写库**：AI 推断的关系/节点一律先作为候选（带置信度/证据/来源、画布灰虚线 ❓），**人审采纳后才建边**；导入的企查查/AI 节点要带「待验证」溯源日志。企查查多候选时同理——**展示候选让用户点选，不自动锁定主体**。
3. **跨库可移植**：Prisma schema **不用原生 enum/json**，保证 SQLite ↔ Postgres 一致。
4. **用户自配模型/数据 Key（BYO）**：Key（AI 模型、企查查 MCP token）经 **AES-256-GCM 加密存服务端**、用用户自己额度调用，平台零成本；无 Key 走演示/回退模式。**绝不明文落库、绝不外发、绝不写进提交。**
5. **数据契约 = `app/src/store.ts` 的 Action**：改契约要前端 store、后端 `mutate.ts` / `types.ts` 同步。
6. **G64111 引擎对齐规格**：改 `packages/g64111/src/score.ts` 前先读 `docs/G64111-评分规格.md`；App/Server 只做 adapter，禁止复制公式。改完跑通共享包和 server parity 单测。
7. **密钥/本地产物不入库**：`.env`、`server/.env`、`*.db` 等不提交（已在 `.gitignore`），变量清单走 `.env.example` / `.env.production.example`。

## 大陆合规上下文

- 生产上线需域名 **ICP 备案**；备案审核期用 `VITE_BEIAN_MODE=1` 只展示中性介绍页（`Landing.tsx`），过审后置空重建。备案号经 `VITE_ICP_BEIAN` 注入页脚。
- 登录走**手机号/邮箱 + 密码**（个人可用，无需企业资质）；收款用**捐赠**（`DONATE_URL` / `DONATE_QR_URL`）。
- 微信登录/微信支付需**营业执照**，个人阶段不做——**别假设可以轻易加上**。
- 大陆服务器构建慢：Dockerfile 已配 npmmirror + Prisma 引擎镜像加速。

## 部署现状（双轨）

- **阿里云大陆轻量服务器**：Docker 栈已实测跑通，等 ICP 备案过审后开放公网（80/443）+ 域名 + HTTPS。
- **Mac mini（内网/Tailscale）**：备案期给团队验证用，`bash deploy-macmini.sh` 一键起；团队走 `http://Leons-Mac-mini.local`（局域网）或 Tailscale IP（远程）。数据在 Docker 卷 `pgdata`，**勿 `docker compose down -v`**。

## 在本仓库怎么干活

- **小步**：一次一个功能/修复 → 跑通 → commit；别一次大改。
- 改后端数据模型：先动 `schema.prisma` → 本地 SQLite 可用 `npm run generate && npm run db:push` → 为生产新增并验证版本化 migration、运行 `schema:postgres:check`；生产只能 `migrate deploy`，禁止 `db push`。生成客户端后须**完全重启 node 进程**。
- **高风险区**（多租户 / 认证·RBAC / AI 写库 / 计费 / 数据契约 / 加密 Key）：动手前先用一两句说明影响，再改。
- 主题/暗色：CSS 用语义变量（`--panel`/`--ink`/`--line`/`--hover` 等），暗色靠 `html[data-theme="dark"]` 覆盖块；**别硬编码颜色**，画布 SVG 也用 `var(--node-*)`。
- 保持 **TS 严格类型**；引入新的重依赖前先问。
- 优先**复用现有模式与组件**，而不是另起一套。
- 端口被占：`lsof -ti:3001 | xargs kill -9`（前端 5173 同理）。

## 当前执行基线（2026-08-19）

- 产品路线与能力分层：`docs/ADR-002-商业版单一演进与通用CRM能力分层.md`；`docs/架构-双版本关系与变更治理v1.md` 继续约束共享核心、安全边界、物理隔离和重大偏差治理。
- 商业持续演进详细计划：`docs/superpowers/plans/2026-08-19-lightweight-personal-crm-commercialization.md`。
- 唯一日常状态清单：`docs/商业版开发待办清单v1.md`；持续建设代码任务必须引用 `CORE-*` 或 `SAAS-*` ID，同一时间最多一项 `IN_PROGRESS`。
- `docs/内部版开发待办清单v1.md` 已转维护冻结；只有安全、兼容、恢复或经批准的显式迁移维护，才可另行授权 `INT-*` 任务。`INT-502` 及其发布验收资料仅作 `NO-GO / STOPPED` 历史证据，不再阻塞商业主线。
- 除重大偏差外严格按商业清单阶段门执行；重大偏差先暂停、写 ADR、由项目所有者批准，再更新计划和清单。

## /compact 时保留

schema 与接口契约的变更及理由、报错与解决办法、改过的文件清单、未完成的待办、真实外部接口（如企查查 MCP）的实测结论。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
