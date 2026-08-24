# SAAS-106｜G3 商业轻量个人 CRM 阶段门验收记录

> 验收日期：2026-08-23
> 分支：`codex/g3-lightweight-personal-crm`
> Worktree：`/Volumes/PowerData/江湖APP/.worktrees/g3-lightweight-personal-crm`
> 计划：`docs/superpowers/plans/2026-08-23-saas-106-g3-stage-gate.md`

## 1. 结论

SAAS-106 业务验收候选提交 `e9464935a4f64f39741571f6142310905b36d025` 已 push，[GitHub Actions 32696251118](https://github.com/ZiZ-LG/jianghu/actions/runs/32696251118) 对应该精确 SHA，12/12 jobs 全部成功。G3 的产品旅程、租户/权限、跨库迁移恢复、部署隔离、桌面/移动端及 internal legacy 回归均已取得通过证据。

本次判定：

- `SAAS-106 = DONE`；
- `G3 = PASS`；
- `CORE-201` 及 G4 仍为 `PENDING`，未转 `READY`，未开始实施；
- 未部署、未修改生产、未读写内部真实客户数据。

本文件与商业清单以独立 docs commit 收口；只有该 docs commit 的精确 SHA CI 同样全绿后，线程才对外宣告 G3 最终关闭。

## 2. G3 必须证据对照

| G3 条件 | 验收证据 | 结果 |
|---|---|---|
| `Customer.categoryKey` 唯一权威与审计创建 | CORE-115 已完成同行字段、SQLite/PostgreSQL migration/恢复、幂等 tenant-scoped `CREATE_CUSTOMER` 及 AuditEvent；本次旅程创建 `categoryKey=null` 的未分类 Customer，无 fallback/双写 | PASS |
| 两分钟激活 | commercial Free 只需“客户 + 一句话下一步 + 时间”，Quick Capture 在一个正式命令中建立 Customer 与客户级 Commitment，不要求 Matter/Person/方法论 | PASS |
| 临近确认与确认失效 | Today 精确返回 `confirmation_due`；确认后改期使旧 `version/scheduleVersion` 来源 404、旧命令 409，再确认可继续 | PASS |
| 改期/拒绝/错过/取消/完成/下一步 | SAAS-106 跨功能旅程覆盖改期、完成和原子关联下一步；SAAS-104 存量全量回归继续覆盖 decline/missed/cancel 与审计 | PASS |
| `reason/source/time/action` 可解释干预 | 固定时钟校验 `reasonCode`、`sourceRefs`、`observedAtUtc`、`time`、`suggestedAction`、`ruleVersion` 和目标 revision | PASS |
| 无 WorkBuddy/无 G64111 仍可完成 | commercial Free 导航精确为“今日 / 客户 / 事项 / 快速记录”；MCP/方法论/专有 Action 均 403 且正式业务零旁路写入 | PASS |
| tenant/effective-scope/viewer | 旅程测试走真实 Fastify + Prisma；全量 Server 回归包含跨租户、角色变更、viewer 及 effective scope 失败关闭证据 | PASS |
| SQLite/PostgreSQL 迁移与恢复 | 双 Prisma schema validate、PostgreSQL rendered schema check、本机完整 ops 故障注入/备份恢复/fresh install 脚本 exit 0，输出 `POSTGRES_OPS_INTEGRATION_OK=1` | PASS |
| 商业/内部物理隔离 | 只读 CLI 使用指定 env 渲染真实 Compose，比较 project/network/volume/数据库身份/备份目录/三类密钥/宿主端口；共享任一边界即失败 | PASS |

## 3. 自动化全矩阵

| 工作区 / 命令 | 新鲜结果 |
|---|---|
| `packages/domain-contracts: npm run typecheck && npm test` | 8 files / 87 tests，全绿 |
| `packages/g64111: npm run typecheck && npm test` | 2 files / 32 tests，全绿 |
| `packages/pde-kernel: npx tsc --noEmit && npm test` | 3 files / 25 tests，全绿；oracle/golden 未修改 |
| `app: npm ci --install-links && npm run typecheck && npm test` | 40 files / 301 tests，全绿；0 vulnerabilities |
| App production build | 119 modules，输出到 `/private/tmp`，未写 `app/dist/**`；仅有存量 chunk size 提示 |
| `server: npm ci --install-links && npm run generate && npm run schema:postgres:check && npm run typecheck && npm test` | 最终 65 files / 494 tests，全绿；0 vulnerabilities |
| SQLite/PostgreSQL Prisma validate | `prisma/schema.prisma` 与 `prisma/postgres/schema.prisma` 均 valid |
| `bash scripts/test-postgres-ops-integration.sh` | exit 0；旧库回填、未知值/非法日期失败关闭、提交前重试、提交后采用、并发加密备份、隔离恢复、fresh install 双遍全绿；随机 project/volume 已清理 |
| `server/tests/g3-deployment-isolation.test.ts` | 14/14；包含 8 类物理碰撞、4 类版本/权益政策错误、密钥不回显与终端环境污染失败关闭 |
| 隔离 CLI 手工执行 | 即使调用环境注入同名 `POSTGRES_PASSWORD` 和错误 `COMPOSE_FILE`，仍只采用指定 env 与仓库 Compose，输出 `G3_DEPLOYMENT_ISOLATION_OK=1` |
| 本地终审 | `git diff --check`、未跟踪文件行尾空白、CLI `node --check`、受保护/共享路径审计全绿 |
| 远端精确 SHA CI | `e9464935a4f64f39741571f6142310905b36d025`，Actions `32696251118`，12/12 jobs success |

## 4. commercial Free 首日旅程

`server/tests/g3-commercial-journey.test.ts` 使用真实 Fastify 路由、Prisma 测试库和 commercial Free policy，不 mock 业务层：

1. `/api/me` 精确返回 commercial shell、`crm.core`、空方法论权益和四个轻量入口。
2. WorkBuddy/MCP、方法论命令和 `SET_ROLE` 均返回 `403 capability_denied`，Account/Opportunity/PlanAction/AuditEvent 不产生旁路写入。
3. Quick Capture 在一笔事务中建立未分类 Customer 和客户级待确认 Commitment，来源为 `manual_quick_capture`，Matter/Person 可空。
4. Today 展示精确确认原因、来源 revision、观测时间、时间关系、建议操作与规则版本。
5. 确认后改期从 `v1/s0` 到 `v2/s1`；旧 Today source 404，旧确认命令 409；新 revision 可重新确认。
6. 完成后原子创建并关联下一步；审计链精确包含 Customer/Commitment 创建、确认、改期、完成和 next-link。
7. MethodologyPack/Binding、AccessToken、WorkBuddy sync、WeCom config/schedule sync 和 Opportunity 记录均为 0。

## 5. 浏览器人工门

所有浏览器数据均为 disposable 合成数据，两个版本使用独立 SQLite 测试库与独立密钥；验收后数据库已移入废纸篓。

### 5.1 commercial Free

- 桌面端和 390px 移动端导航精确为“今日 / 客户 / 事项 / 快速记录”，可见文案不包含 WorkBuddy、G64111、ADURC、固定阶段或 PDE 依赖。
- 通过 UI 建立新 Customer 和无 Matter 客户级 Commitment；草稿明示“创建客户 + 创建下一步”和“客户级（无事项）”。
- 完成待确认 → 确认 → 改期 → 重新确认 → 完成 → 建立下一步的完整 UI 闭环。
- 键盘对话框焦点保持在对话框内；刷新时服务端故障可见报错，但已有 Customer 仍保留，服务恢复后重试可继续。
- 浅色/暗色均通过，390px 水平溢出为 0。首轮量测发现顶部导航/退出仅 35px，最小 CSS 修复后 5 个头部交互控件均为 44px。
- Customer 页可显示未分类客户，无关系时详情仍可用；Matter 空状态友好且不阻塞快速记录。

### 5.2 internal legacy smoke

- 以 `PRODUCT_EDITION=internal` 和独立合成库启动；`data-app-shell=internal_legacy`、CustomerHub `.hub` 与旧首页文案均存在。
- 旧 CustomerHub 可见新建客户，桌面端无水平溢出，无新 console error。
- 浏览器截图仅作本机验收查看，未写入仓库，不含真实客户数据。

## 6. 部署隔离与失败关闭

`scripts/verify-g3-deployment-isolation.mjs` 只调用 `docker compose config --format json`，不执行 `build/up/down`，不连接或写入数据库。

- 它显式锁定仓库 `docker-compose.yml`，并在渲染前清除 Compose 引用变量及 `COMPOSE_FILE/COMPOSE_PROFILES/COMPOSE_PROJECT_NAME` 的终端继承，防止错误环境变量代替指定 env 被误放行。
- 商业部署必须是 `commercial + Free + METHODOLOGY_COMMANDS_ENABLED=0`；内部部署必须明确为 `internal`。
- 两者的 project、default network、`pgdata` volume、数据库身份/密码、备份目录/主密钥、JWT/AI 密钥及宿主发布端口必须全部不同。
- CLI 只输出 project/network/volume 资源名和成功标记，不回显密钥或完整 Compose JSON。

## 7. 边界与未发生事项

- 未修改 schema、migration、G64111/PDE 算法或 oracle/golden。
- 未修改 `docker-compose.yml`、`app/package.json`、lockfile、Vite 配置、`app/dist/**`、主站导航或跨站入口。
- 未修改“自我修养”专属路径；本商业清单仍由 CRM 线单一编辑。
- 未执行部署、未合并 `main`、未修改生产配置/数据、未复制内部数据到商业环境。
- 未实施 Candidate/ReviewBatch/Agent Job 或其他 G4 能力。

## 8. 提交、CI 与回滚点

| 节点 | SHA / CI | 用途 |
|---|---|---|
| SAAS-106 前置基线 | `f1e43a1a49367b2a67a7cb8503076b7aa72a1f80` / Actions `32687270832` 12/12 | SAAS-105 文档收口，SAAS-106 未开始 |
| SAAS-106 计划 checkpoint | `8fe37b5ccb4b8d6749c05fc5e2aed03b48fe5825` / Actions `32690654029` 12/12 | 固定范围、停止条件和验收命令 |
| SAAS-106 业务验收提交 | `e9464935a4f64f39741571f6142310905b36d025` / [Actions 32696251118](https://github.com/ZiZ-LG/jianghu/actions/runs/32696251118) 12/12 | 跨功能旅程、隔离 CLI/回归测试、商业壳层 44px 触控修复 |

本任务没有 schema/migration 或生产数据变更：

- 部署前可整体 revert `e9464935a4f64f39741571f6142310905b36d025`，移除验收测试/只读 CLI 并恢复头部原触控高度；
- 也可回到计划 checkpoint `8fe37b5ccb4b8d6749c05fc5e2aed03b48fe5825`；
- 未部署，因此无生产数据回滚、容器回滚或流量切换动作。
