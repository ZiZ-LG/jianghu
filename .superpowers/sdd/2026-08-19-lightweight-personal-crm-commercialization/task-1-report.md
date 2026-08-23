# Task 1 Report — SAAS-101 商业 shell 与默认能力

## 状态

- 实现候选已完成并就地提交；`SAAS-101` 仍保持 `IN_PROGRESS`。
- 未启动 `SAAS-102+`、G4、Agent、Candidate、关系雷达、定价／支付、部署或 canary。
- 未 merge、未 push、未修改 schema / migration / 运行数据。
- 控制器仍需在宿主权限下复验完整 Server suite，再决定是否关闭任务。

## 实现

1. 在 `packages/domain-contracts/src/capabilities.ts` 建立唯一产品装配点：
   - `commercial | internal` edition；
   - Free 默认 policy 仅 `crm.core`；
   - 默认导航精确为 `今日 / 客户 / 事项 / 快速记录`；
   - `sales.workspace / team.operations / methodology.g64111 / decision.pde` 只在显式 grant 后装配；
   - 内部版返回 `internal_legacy` shell 且保留原能力；
   - 未知或畸形运行配置返回零授权；
   - 旧 Action 显式映射到 `crm.core / sales.workspace / methodology.g64111`，未登记的未来 Action 不默认放行。
2. 新增 `CommercialShell` 和纯函数产品路由解析：
   - Free 只渲染四个轻量入口；
   - 每条已装配路由都有非空 panel / empty state；
   - capability-off 直达 URL 回到 `/today` 并显示拒绝提示；
   - `/account/*` 只在 `sales.workspace` 开启时进入旧作战室；
   - 浏览器前进／后退执行同一 resolver；
   - G64111 Today/缺口/评分与 PDE fetch 仅在各自 capability 开启后运行。
3. 服务端执行同一 policy：
   - 注册、登录和 `/api/me` 返回服务端装配的 `product`，App 不自行猜测套餐；
   - 集中 `onRoute` 装配在原 `authenticate` 之后执行，因此未认证仍 401，已认证但缺能力统一 403 `capability_denied`；
   - 覆盖 core state/mutate、团队、复杂销售、方法论与 PDE 真实 API 边界；
   - `/api/mutate` 在 ActionSchema 解析后、`applyAction` 写库前执行 Action entitlement，关闭 `ADD_OPP` / `SET_ROLE` 直接绕过。
4. 运行配置：
   - `PRODUCT_EDITION=commercial` 默认 Free；
   - `PRODUCT_ENTITLEMENTS` 逗号分隔显式增量；
   - `PRODUCT_EDITION=internal` 为可逆的商业 shell 回滚开关，不改写业务记录；
   - Compose 显式传入两个变量，内部／商业数据库、密钥、备份和发布仍由独立部署隔离。

## TDD RED 证据

1. `cd packages/domain-contracts && npm test -- --run tests/capabilities.test.ts`
   - 首轮：7 tests 中新增 3 项失败，`TypeError: assembleProductAccess is not a function`。
   - Action 绕过审查轮：8 tests 中 1 项失败，`capabilityRequirementForActionType is not a function`。
2. `cd app && npm test -- --run src/lib/productRoutes.test.ts`
   - suite 因 `Cannot find module './productRoutes'` 失败。
3. `cd app && npm test -- --run src/components/CommercialShell.test.ts`
   - suite 因 `Cannot find module './CommercialShell'` 失败。
4. `cd server && DATABASE_URL=file:./test.db npx vitest run tests/product-capabilities.test.ts`
   - 首轮 `/api/me.product` 为 `undefined`。
   - 未认证 `/api/members` 一度错返 403，新增 401 测试按预期失败。
   - 畸形 product config 下 `/api/state` 一度返 200，新增零授权测试按预期失败。
   - Free 下有效 `ADD_OPP` 直调 `/api/mutate` 一度进入 handler 并返 404，新增 entitlement 测试按预期失败（应为 403）。

## GREEN 与验证证据

### 共享契约

```text
cd packages/domain-contracts && npm run typecheck && npm test
```

- exit 0；7 files / 68 tests passed。

### G64111 / PDE 边界

```text
cd packages/g64111 && npm run typecheck && npm test
cd packages/pde-kernel && npx tsc --noEmit && npm test
```

- G64111：exit 0；2 files / 32 tests passed。
- PDE：exit 0；3 files / 25 tests passed。
- 未修改公式、oracle、golden 或 engine adapter。

### App

```text
cd app && npm run typecheck && npm test && npm run build
```

- exit 0；31 files / 242 tests passed；Vite production build exit 0。
- 警告：Node 的 `localStorage` experimental warning 与 Vite `>500 kB` chunk warning；无测试／构建失败。

### Server focused / type / schema

```text
cd server && npm run typecheck
cd server && DATABASE_URL=file:./test.db npx vitest run tests/product-capabilities.test.ts tests/actions.test.ts
cd server && npm run schema:postgres:check
```

- 全部 exit 0。
- focused：2 files / 16 tests passed，包含 Free off、capability-on、internal legacy、畸形 config、未认证 401、Action 直达拒绝。
- PostgreSQL rendered schema 无漂移。

### Server full suite（当前受限环境）

```text
cd server && npm run typecheck && npm test && npm run schema:postgres:check
```

- Server typecheck、test DB prepare 和 Prisma `db push --skip-generate` 通过。
- Vitest：56/57 files passed，432/434 tests passed。
- 仅 `tests/postgres-ops-scripts.test.ts` 的 2 项失败：
  - `reaps a stale lock without deleting an ABA successor lock`
  - `never auto-reaps the operation guard and delayed cleanup cannot remove its successor`
- 这两项为项目已知的受限 `/bin/ps` 宿主权限假红；未修改相关代码，未反复重跑。链式命令因 test exit 1 没有执行末尾 schema check，随后已单独执行并通过。
- Action 直达绕过是该次全量后的自审补强；补强后已重跑 Server typecheck 与 `product-capabilities + actions` 16 项 focused tests。完整 final-tree Server suite 仍由控制器在宿主权限复验。

### 安装、Compose 与 diff

```text
cd app && npm ci --install-links --cache /private/tmp/saas101-app-npm-cache
cd server && npm ci --install-links --cache /private/tmp/saas101-server-npm-cache
docker compose --env-file .env.production.example config --quiet
git diff --check
```

- 两个 `npm ci --install-links` 最终 exit 0，各自 audit 0 vulnerabilities。
- 默认 npm cache 首次因 `unexpected end of file` 失败，改用任务专用 `/private/tmp` cache 后通过。
- Compose config 和 `git diff --check` exit 0。
- 受限环境下 `npm run generate` 曾因无权 `utime /Users/leonge/.cache/prisma/.../libquery-engine` 失败；本任务无 schema 改动，测试使用同一 G2 final schema 的已生成 Prisma client，`db push --skip-generate`、Server typecheck/focused/full 和 PostgreSQL schema check 均已实际运行。

## 改动文件

- `.env.production.example`
- `app/src/App.tsx`
- `app/src/api.ts`
- `app/src/components/CommercialShell.tsx`
- `app/src/components/CommercialShell.test.ts`
- `app/src/lib/productRoutes.ts`
- `app/src/lib/productRoutes.test.ts`
- `app/src/styles.css`
- `docker-compose.yml`
- `docs/商业版开发待办清单v1.md`
- `packages/domain-contracts/src/capabilities.ts`
- `packages/domain-contracts/tests/capabilities.test.ts`
- `server/.env.example`
- `server/src/app.ts`
- `server/src/auth.ts`
- `server/tests/helpers/testApp.ts`
- `server/tests/product-capabilities.test.ts`
- `.superpowers/sdd/2026-08-19-lightweight-personal-crm-commercialization/task-1-report.md`

## 自审

- 导航、前端路由和服务端拒绝共用 `ProductAccess.policy` 及稳定 entitlement key，没有按 plan 字符串或 `if (internal)` 散落到业务组件。
- UI 拒绝不是唯一防线；真实路由和 legacy Action 都有服务端 fail-closed。
- capability pre-handler 追加在原 `authenticate` 之后，不改 JWT、当前角色回库复核、RBAC、tenantId 或 effective scope。
- 内部集成 fixtures 显式运行 `internal` adapter；原 Hub、作战室、WorkBuddy journey 与 API handler 没有被复制或改写。
- 商业 shell 展示现有数据的轻量概览和有内容的 empty state；没有偷跑 SAAS-102 的快速记录表单、SAAS-103 Today 读模型或 SAAS-105 通用详情页。
- 无新依赖，无密钥，无数据复制，无 AI 直写，无 G64111/PDE 公式改动。
- 回滚是 edition 切回 `internal` 或 revert 独立提交；不删除或重写业务记录。

## 关注与待复验

1. 控制器必须在可用 `/bin/ps` 的宿主权限下运行 final-tree Server full suite；当前不宣告 Server 全量全绿。
2. `PRODUCT_EDITION` / `PRODUCT_ENTITLEMENTS` 是独立部署级配置，不是用户请求或前端 localStorage；未来若改为按租户授权，需新任务设计存储、迁移和管理员权限，不应在 SAAS-101 顺手扩展。
3. `快速记录`、`今日`、`客户`、`事项` 在本任务只是可达、非空的 shell surface；完整业务行为依次属于 SAAS-102–105。
4. App build 仍有已知大 chunk 警告；本任务未引入新重依赖，不在 SAAS-101 扩展性能重构。

## 回滚

- 实现前 Git 点：`2cca2049c32df7d543028a496b7d03a151a9efaf`。
- 运行时快速切回：`PRODUCT_EDITION=internal`，重启服务后使用旧 internal shell。
- 代码回滚：revert 本 SAAS-101 独立提交。
- 不回滚、不删除、不重写任何业务数据。
