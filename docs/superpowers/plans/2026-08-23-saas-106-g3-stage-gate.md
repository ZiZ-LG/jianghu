# SAAS-106｜G3 商业轻量个人 CRM 阶段门执行计划

> 日期：2026-08-23
> Owner：Codex（CRM 线程）
> Branch：`codex/g3-lightweight-personal-crm`
> Worktree：`/Volumes/PowerData/江湖APP/.worktrees/g3-lightweight-personal-crm`
> 基线：`f1e43a1a49367b2a67a7cb8503076b7aa72a1f80`，GitHub Actions `32687270832` 12/12 全绿

## 1. 目标与通过条件

SAAS-106 只关闭 R1/G3 阶段门，不新增 G4 能力。必须同时取得以下新鲜证据：

1. commercial Free 在未安装 WorkBuddy、未绑定方法论、未启用 G64111/PDE 时，仍可完成首日核心旅程：三项快速记录、临近确认、改期使旧 revision 失效、完成并建立下一步；
2. G3 Gate 摘要中的 Customer 分类权威、两分钟激活、确认失败案例、拒绝/错过/取消、`reason/source/time/action` 与无 G64111 导航/CRUD 均有自动或人工证据；
3. domain/app/server/G64111/PDE 全量、capability on/off、tenant/effective-scope、SQLite/PostgreSQL migration/恢复全部通过；
4. 同一 Compose 定义可用不同 project name 渲染物理分离的 network/PostgreSQL volume，并验证商业/内部部署的数据库身份、备份目录、密钥和宿主端口不复用；
5. 桌面与移动端首日旅程、commercial Free 四入口以及 internal legacy smoke 通过；
6. 不部署、不接触生产、不使用内部数据库或真实客户数据作为商业测试数据。

## 2. 不可越界范围

- 不修改 schema、migration、G64111/PDE 算法或方法论权威；
- 不修改 `docker-compose.yml`、`app/package.json`、lockfile、Vite 配置、`app/dist/**`、主站导航或跨站入口；
- 不修改项目所有者划给“自我修养”开发线的任何路径；
- 不新增 WorkBuddy、G64111、PDE 或复杂销售入口，不实施 SAAS-201/CORE-201 等 G4 任务；
- 若验收暴露必须修改上述共享冲突文件、生产配置或重大安全边界的问题，SAAS-106 保持 `IN_PROGRESS` 并暂停报告，不自行解决。

## 3. 原子任务

### Task 1｜RED：固定商业部署隔离检查器契约

**新增：**

- `server/tests/g3-deployment-isolation.test.ts`

测试直接运行尚不存在的真实 CLI，先观察预期失败：

- 两份安全的临时 fixture env 可生成互不重叠的 project/network/volume、数据库身份、备份目录、三类密钥与宿主端口；
- commercial 必须是 `PRODUCT_EDITION=commercial`、空 `PRODUCT_ENTITLEMENTS`、`METHODOLOGY_COMMANDS_ENABLED=0`；
- 复用 project、volume、备份目录、数据库身份、密钥或端口时失败关闭；
- CLI 不在 stdout/stderr 回显原始密钥。

**RED 命令：**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run tests/g3-deployment-isolation.test.ts
```

预期：因 `scripts/verify-g3-deployment-isolation.mjs` 尚不存在而产生明确断言失败。

### Task 2｜GREEN：实现只读 Compose 隔离验证 CLI

**新增：**

- `scripts/verify-g3-deployment-isolation.mjs`

最小实现：

- 接受 `--commercial-env` 与 `--internal-env`；
- 用 `docker compose --env-file ... -p ... config --format json` 渲染真实仓库 Compose，不启动容器、不写数据库；
- 比较 project、network、`pgdata` volume、数据库身份、备份目录、JWT/AI/backup 密钥和宿主端口；
- 验证 commercial Free/方法论关闭，internal edition 明确；
- 只输出安全的资源名和 `G3_DEPLOYMENT_ISOLATION_OK=1`，不输出密钥或完整 Compose JSON。

完成后重跑 Task 1，随后做 mutation check：任意共享资源或 commercial entitlement 放开都必须使测试失败。

### Task 3｜商业 Free 首日旅程验收测试

**新增：**

- `server/tests/g3-commercial-journey.test.ts`

使用真实 Fastify 路由、Prisma 测试库与 commercial Free policy，不 mock 业务层：

1. `/api/me` 精确返回 commercial shell、`crm.core` 和四个轻量入口；
2. WorkBuddy/MCP、G64111 方法论命令与专有 Action 均 403，正式业务零旁路写入；
3. Quick Capture 在一笔事务创建未分类 Customer 与客户级待确认 Commitment，来源为人工，不要求 Matter/Person/方法论；
4. 固定时钟构造 Today，核验确认提醒的 `reasonCode/sourceRefs/observedAt/time/action/ruleVersion`；
5. 确认后改期，旧 `version/scheduleVersion` 与旧来源失效；
6. 完成后原子建立下一步，核验审计链、无方法论绑定及无 WorkBuddy 同步记录；
7. 既有 SAAS-104 测试继续覆盖拒绝、取消、显式 missed 与跨租户负向路径。

该文件是跨功能验收门，不复制生产公式或实现；若现有行为已满足，作为 characterization gate 直接保持绿色。

### Task 4｜自动化全矩阵与跨库恢复

按仓库顺序执行：

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd packages/g64111 && npm run typecheck && npm test
cd packages/pde-kernel && npx tsc --noEmit && npm test
cd app && npm ci --install-links && npm run typecheck && npm test
cd server && npm ci --install-links && npm run generate && npm run schema:postgres:check && npm run typecheck && npm test
bash scripts/test-postgres-ops-integration.sh
node scripts/verify-g3-deployment-isolation.mjs --commercial-env <临时商业fixture> --internal-env <临时内部fixture>
```

追加：Prisma validate、临时目录 production build、Compose config、`git diff --check`、受保护路径与共享冲突文件 diff 审计。Docker/PostgreSQL 测试只使用随机 project 和 disposable 数据，结束后清理，不触碰当前部署卷。

### Task 5｜浏览器人工门

按 `/browse` 执行本地 disposable QA：

- commercial Free 新租户：桌面与 390px 移动端完成快速记录 → 待确认 → 确认/改期 → 完成/下一步；
- 导航精确为“今日 / 客户 / 事项 / 快速记录”，页面无 WorkBuddy、G64111、ADURC、固定阶段或 PDE 依赖；
- 检查浅色/暗色、键盘焦点、44px 触控、无横向溢出、刷新失败后的数据连续性；
- 单独以 internal edition 启动 disposable 服务，验证 legacy CustomerHub 与既有能力 smoke；
- 使用合成数据，禁止导入内部数据库或真实客户资料。

### Task 6｜提交、远端阶段门与收口

1. 业务提交只含验收测试与只读隔离检查器，commit message 包含 `SAAS-106`；
2. push 当前 feature branch，等待该精确 SHA GitHub Actions 全绿；
3. 新增 `docs/SAAS-106-G3阶段门验收记录.md`，记录命令、计数、浏览器矩阵、隔离证明、未部署声明与回滚点；
4. 以独立 docs commit 将 `SAAS-106` 标为 DONE、G3 标为通过；push 并等待 docs 精确 SHA CI 全绿；
5. 到此停止。`CORE-201`/G4 保持 PENDING，不自动转 READY 或开始实现。

## 4. 回滚与停止条件

- 本任务无 schema/migration/业务数据改动；业务提交可整体 revert，既有 G3 功能不变；
- 隔离 CLI 仅执行 `docker compose config`，不执行 `up/down/build`；
- disposable QA 数据和随机 Compose project 可删除，不涉及现有 `pgdata`；
- 发现商业 Free 需要 WorkBuddy/G64111、tenant/viewer 越权、内部数据复制、共享资源碰撞或恢复失败时，阶段门判定失败，先最小修复并重跑；若修复超出本计划边界，则暂停请求项目所有者决策。
