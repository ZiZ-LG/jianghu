# 江湖内部版可信化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 Workbuddy-first 内部工具收敛为可信、可恢复、可审计的内部生产版本，并保持其领域核心可直接复用于未来商业 SaaS。

**Architecture:** 江湖数据库继续作为唯一 SoR；Workbuddy 只通过版本化 MCP/API 传递用户明确事实、原始材料或机器提案。共享核心负责租户、契约、G64111/PDE、人审、审计和可靠写入；内部产品壳只负责决策工作台、最低纠错和 Workbuddy 状态呈现。

**Tech Stack:** TypeScript 5.x、React 18、Vite 5、Fastify 4、Prisma 5、SQLite(dev/test)、PostgreSQL(prod)、Vitest、Docker Compose。

## Global Constraints

- 关系与治理以 `docs/架构-双版本关系与变更治理v1.md` 为上位约束。
- 内部版固定为 Workbuddy-first，但 Workbuddy 不是数据 SoR，也不能拥有独立领域规则。
- 所有业务读写必须按 `tenantId` 隔离；父对象、子对象和引用端点必须属于同一租户及同一业务树。
- 用户明确事实可在服务端校验、幂等和审计后写入；机器抽取、推断及覆盖性修改必须进入候选/提案。
- 客户端提交的 `origin`、`status`、`actorRole` 不能作为信任依据；信任级别由鉴权渠道和服务端命令上下文决定。
- DB 是唯一可写真相源；Markdown、微盘和导出文档只作为输入材料、缓存或单向快照。
- G64111 的权威是 `docs/G64111-评分规格.md`；PDE 的权威是 `docs/pde-handoff/` 中的 SPEC、DECISIONS、oracle 和 golden。
- 不使用 Prisma 原生 enum/json，保持 SQLite 与 PostgreSQL 可移植。
- 内部版继续采用 Workbuddy/BYO 模型能力；平台代付模型费用不在本计划内。
- 不增加公共注册、在线计费、营销漏斗、连接器市场、原生移动 App、通用 schema builder 或全功能 CRM 后台。
- 不引入新的重依赖；确有必要时先按重大偏差流程获得批准。
- 每个任务先写失败测试，再做最小实现；一个任务一个提交，前一阶段门未通过不得进入后一阶段。
- 自动化测试不得使用真实客户数据；人工验收使用脱敏副本，并在验收后按内部数据规则处置。

---

## 1. 执行基线

计划基于 2026-07-11 的 `303cf87` 工作区审阅结果编制。基线验证为：

- `app` TypeScript 检查通过；8 个测试文件、85 项测试通过；生产构建通过。
- `packages/pde-kernel` 类型检查和 24 项测试通过。
- `server` TypeScript 检查通过，但没有测试脚本和自动化测试。
- 当前主要阻断是租户父子关系校验、破坏性删除、机器写入失败开放、PDE 证据闭环、复合写原子性和客户端保存可靠性。

执行前不得用历史评估报告替代当前代码验证。若基线已变化，先对照任务验收目标确认现有代码是否已经满足；满足则补测试、更新待办并关闭任务，不重复实现。

## 2. 内部版目标旅程

```text
Workbuddy 采集/整理
  → MCP 鉴权与命令分类
  → 用户明确事实幂等写入 / 机器内容生成提案
  → 江湖收件箱人审与最低纠错
  → G64111/PDE 权威重算
  → 今日行动与执行反馈
  → 证据、快照、审计与复盘
```

内部版不追求让用户在网页中完成所有资料生产，但必须保证任何 Agent 错误都能在江湖中被发现、解释、纠正或恢复。

## 3. 计划文件结构

计划实施后新增或明确下列边界：

```text
packages/domain-contracts/    Action 类型、Zod schema、命令上下文和公共值域
packages/g64111/              前后端唯一评分实现和规格 fixtures
server/src/app.ts             可测试的 Fastify app factory
server/src/mutation/          scope guard、policy、command、audit
server/src/mcp/               Workbuddy/MCP 适配、scope、sync receipt
server/tests/                 HTTP/DB 集成测试
app/src/lib/sync/             串行写队列、草稿提交、同步状态
app/src/components/RepairPanel.tsx  内部最低纠错入口
docs/内部版开发待办清单v1.md      唯一日常状态清单
```

目录拆分只在对应任务内进行；禁止为追求目录整齐而提前大搬迁。

## 4. 阶段门

| 阶段 | 目标 | 通过条件 |
|---|---|---|
| M0 | 可测试、可追踪 | 后端测试隔离，不接触 dev.db；CI 能跑前端、后端、Kernel |
| M1 | 安全与决策正确 | 无跨租户父子注入；无全租户 reset；机器内容失败关闭；Evidence 真正进入 PDE |
| M2 | 写入可靠 | 同实体不乱序；复合操作无部分成功；Workbuddy 重试不重复；Job 可崩溃恢复 |
| M3 | 人可纠错 | 可编辑关键字段、归档恢复、重新绑定、合并重复人物、查看来源和同步回执 |
| M4 | 主旅程闭环 | ADURC/G64111 单一口径；移动审核、日期、上下文、AI 数据最小化正确 |
| M5 | 内部生产门禁 | 版本化迁移、自动备份、恢复演练、监控与两周受控运行达标 |

---

### Task INT-000: 固化双版本关系和内部执行基线

**状态：** 本轮完成。

**Files:**
- Create: `docs/架构-双版本关系与变更治理v1.md`
- Create: `docs/superpowers/plans/2026-07-11-internal-edition-development.md`
- Create: `docs/内部版开发待办清单v1.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: 双版本职责、文档权威顺序、重大偏差流程、任务 ID 与阶段门。
- Consumes: `docs/产品设计方案.md:302-334`、`docs/架构-江湖自算主线设计v1.md`、Workbuddy 集成资料和 2026-07-11 代码审阅结果。

- [x] **Step 1: 写明一个共享核心、内部版、商业版、Workbuddy 四层职责**
- [x] **Step 2: 重新定义直写、原始追加、机器提案和评分派生边界**
- [x] **Step 3: 定义重大偏差、文档权威顺序和变更审批步骤**
- [x] **Step 4: 建立内部版计划和唯一状态清单**
- [x] **Step 5: 用户审阅并确认本计划作为后续执行基线（2026-07-11）**

---

## M0：后端测试地基

### Task INT-001: 建立可注入的 Fastify App 和隔离测试库

**Files:**
- Create: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/package.json`
- Create: `server/vitest.config.ts`
- Create: `server/tests/helpers/testDb.ts`
- Create: `server/tests/helpers/testApp.ts`
- Create: `server/tests/smoke.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `buildApp(options?: { logger?: boolean }): Promise<FastifyInstance>`。
- Produces: `createTestContext(): Promise<{ app; prisma; tenant; owner; token; cleanup }>`。
- Consumes: 当前 `server/src/index.ts` 的插件和路由注册；后台 worker 仍只由 `index.ts` 在监听成功后启动。

- [ ] **Step 1: 写失败的 app factory 冒烟测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('buildApp', () => {
  it('injects health without opening a port', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
```

- [ ] **Step 2: 运行测试并确认因 `buildApp` 不存在而失败**

Run: `cd server && npx vitest run tests/smoke.test.ts`  
Expected: FAIL，错误包含 `buildApp` 导出不存在。

- [ ] **Step 3: 提取 app factory，保持启动副作用在 index.ts**

```ts
// server/src/app.ts
export interface BuildAppOptions { logger?: boolean }

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: true });
  await registerSecurityPlugins(app);
  registerRoutes(app);
  return app;
}
```

`registerSecurityPlugins` 和 `registerRoutes` 是 `app.ts` 内的私有函数；把当前注册代码原样迁入，不在测试 app 中调用 `listen()`、`startJobWorker()` 或 `startPatrol()`。

- [ ] **Step 4: 配置独立 SQLite 测试数据库和清理助手**

`server` 测试脚本固定使用 `DATABASE_URL=file:./prisma/test.db`。`cleanup()` 按外键依赖逆序清空测试租户数据，最后关闭 Fastify；测试启动前和结束后都断言 `prisma/dev.db` 的 mtime 未变化。

- [ ] **Step 5: 增加认证与双租户隔离冒烟用例**

覆盖未认证 `/api/state` 返回 401、租户 A/B 可创建同名客户、A 的 `/api/state` 不包含 B 数据。

- [ ] **Step 6: 运行并提交**

Run: `cd server && npm run typecheck && npm test`  
Expected: 全部 PASS，测试后只产生被 `.gitignore` 排除的 `prisma/test.db`。

Commit: `test(server): add isolated Fastify integration harness`

---

## M1：共享核心、安全和决策正确性

### Task INT-101: 建立共享 Action 契约和服务端命令上下文

**Files:**
- Create: `packages/domain-contracts/package.json`
- Create: `packages/domain-contracts/tsconfig.json`
- Create: `packages/domain-contracts/src/actions.ts`
- Create: `packages/domain-contracts/src/context.ts`
- Create: `packages/domain-contracts/src/index.ts`
- Create: `packages/domain-contracts/tests/actions.test.ts`
- Modify: `app/package.json`
- Modify: `app/src/store.ts`
- Modify: `server/package.json`
- Modify: `server/src/index.ts`
- Modify: `server/src/mutate.ts`

**Interfaces:**
- Produces: `ActionSchema`、`Action`、`CommandContext`、`ActionType`。
- `CommandContext` exact shape:

```ts
export interface CommandContext {
  tenantId: string;
  actorId: string;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
  channel: 'web' | 'mcp' | 'worker' | 'system';
  requestId: string;
  assertionMode: 'user_asserted' | 'raw_append' | 'machine_proposed';
}
```

- `applyAction` becomes `applyAction(ctx: CommandContext, action: Action, db?: DbClient): Promise<void>`。

- [ ] **Step 1: 为缺字段、旧 TB 角色、伪造 evidence 状态写失败测试**

```ts
expect(ActionSchema.safeParse({ type: 'ADD_PERSON', person: {} }).success).toBe(false);
expect(ActionSchema.safeParse({ type: 'SET_ROLE', accId: 'a', oppId: 'o', personId: 'p', patch: { role: 'TB' } }).success).toBe(false);
expect(ActionSchema.safeParse({ type: 'ADD_EVIDENCE', accId: 'a', oppId: 'o', evidence: { status: 'approved', origin: 'ai' } }).success).toBe(false);
```

- [ ] **Step 2: 运行并确认现有 passthrough 接受非法载荷**

Run: `cd server && npm test -- actions`  
Expected: FAIL，非法 Action 尚未被共享 schema 拒绝。

- [ ] **Step 3: 将 `app/src/store.ts` 的 discriminated union 迁入共享包**

为现有每一种 Action 建立 `.strict()` Zod object；共享包不得 import React、Prisma 或 `app/src/types.ts`。实体 payload 使用共享的最小输入 schema，额外 UI 字段由 app adapter 去除后提交。

- [ ] **Step 4: 由服务端构造 CommandContext**

Web 路由只从认证态设置 `actorId/role/channel`；客户端不得覆盖。MCP 和 worker 分别在自己的入口设置 channel 和 assertionMode。

- [ ] **Step 5: 替换公开入口的 passthrough 和 any**

`/api/mutate` 使用 `ActionSchema.safeParse(req.body.action)`；`applyAction` 的公开参数不再是 `any`。未知字段和非法值返回 400，错误不回显目标对象是否存在。

- [ ] **Step 6: 全量验证并提交**

Run: `cd packages/domain-contracts && npm test && npm run typecheck`  
Run: `cd ../../app && npm run typecheck && npm test`  
Run: `cd ../server && npm run typecheck && npm test`

Commit: `refactor: share and validate mutation contracts`

### Task INT-102: 封闭父子关系和引用端点的租户边界

**Files:**
- Create: `server/src/mutation/scopeGuards.ts`
- Create: `server/tests/tenant-parentage.test.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/state.ts`
- Modify: `server/prisma/schema.prisma`

**Interfaces:**

```ts
export async function requireAccount(db: DbClient, tenantId: string, accountId: string): Promise<void>;
export async function requireOpportunity(db: DbClient, tenantId: string, accountId: string, opportunityId: string): Promise<void>;
export async function requirePerson(db: DbClient, tenantId: string, accountId: string, personId: string): Promise<void>;
export async function requireEdgeEndpoints(db: DbClient, tenantId: string, accountId: string, sourceId: string, targetId: string): Promise<void>;
```

- [ ] **Step 1: 建立两租户攻击矩阵失败测试**

用租户 A 的 token，逐个把租户 B 的 Account/Opportunity/Person ID 放入 `ADD_OPP`、`ADD_PERSON`、`ADD_EDGE`、`SET_ROLE`、`ADD_OPP_MEMBER`、`ADD_BI`、`ADD_UCV`、`ADD_VISIT`、`ADD_NOTE`、`ADD_EVIDENCE`。每个请求必须返回统一 404/400，B 的树不发生变化。

- [ ] **Step 2: 运行并确认至少一个 create 路径可跨租户挂载**

Run: `cd server && npm test -- tenant-parentage`  
Expected: FAIL，现有 create 路径没有完整父对象校验。

- [ ] **Step 3: 在同一事务内执行 guard 和写入**

所有 create/update/delete 先验证 account，再验证 opportunity/person/BI/edge 端点。验证失败统一抛 `ScopedNotFoundError`，不泄漏对象属于其他租户。

- [ ] **Step 4: 增加复合唯一和索引基础**

为 Account、Opportunity、Person 及高频子表补足 `(tenantId,id)`、`(tenantId,accountId)`、`(tenantId,opportunityId)` 的唯一/索引能力；不使用数据库原生 enum/json。若 Prisma/SQLite 无法表达复合外键，应用守卫和测试仍是强制门禁。

- [ ] **Step 5: 在 assembleState 的嵌套 include 后再做 tenant 防御过滤**

即使存在历史异常记录，返回树中也不得混入其他租户子对象；同时记录结构化安全告警供后续清理。

- [ ] **Step 6: 验证并提交**

Run: `cd server && npm run typecheck && npm test -- tenant-parentage`  
Expected: 攻击矩阵全部 PASS。

Commit: `fix(security): enforce tenant parent-child invariants`

### Task INT-103: 取消全租户 reset，以可恢复归档替代破坏性删除

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/state.ts`
- Modify: `server/prisma/schema.prisma`
- Create: `server/src/mutation/audit.ts`
- Create: `server/tests/archive-recovery.test.ts`
- Modify: `app/src/api.ts`
- Modify: `app/src/store.ts`
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/CustomerHub.tsx`

**Interfaces:**

```ts
export type ArchiveTarget = 'account' | 'opportunity';
export async function archiveEntity(ctx: CommandContext, target: ArchiveTarget, id: string, reason: string): Promise<void>;
export async function restoreEntity(ctx: CommandContext, target: ArchiveTarget, id: string): Promise<void>;
```

- [ ] **Step 1: 写 member reset、归档、恢复和审计失败测试**

断言旧 `/api/reset` 返回 404；member 不能硬删除客户；归档后子记录仍在；owner/admin 恢复后整树完整；跨租户归档和恢复失败。

- [ ] **Step 2: 运行并确认旧 reset 仍可级联清空**

Run: `cd server && npm test -- archive-recovery`  
Expected: FAIL，当前 `/api/reset` 对 member 开放。

- [ ] **Step 3: 删除 reset 路由并增加软归档字段**

Account、Opportunity 增加 `archivedAt`、`archivedBy`、`archiveReason`。普通 state 默认排除归档对象；恢复路由只允许 owner/admin。

- [ ] **Step 4: 建立最小 AuditEvent**

AuditEvent 记录 actor、channel、action、entityKind、entityId、requestId、sourceRef、changedFields、createdAt。`changedFields` 不保存 FORM、BI、日志和原始纪要正文；归档恢复依靠原记录，不复制敏感快照。

- [ ] **Step 5: 把前端删除入口替换为归档确认**

文案明确“可由管理员恢复”；不提供物理清理 API。物理清理由离线运维脚本和备份门禁控制，不属于日常产品能力。

- [ ] **Step 6: 验证并提交**

Run: `cd server && npm test -- archive-recovery && npm run typecheck`  
Run: `cd ../app && npm run typecheck && npm test`

Commit: `fix(data): replace destructive reset with audited archive`

### Task INT-104: 让 AI、录音和 Workbuddy 机器内容失败关闭

**Files:**
- Create: `server/src/ingestTrust.ts`
- Modify: `server/src/voice.ts`
- Modify: `server/src/mcpServer.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/proposals.ts`
- Modify: `server/src/suggest.ts`
- Create: `server/tests/ingest-trust.test.ts`
- Create: `server/tests/evidence-trust.test.ts`

**Interfaces:**

```ts
export const AssertionModeSchema = z.enum(['user_asserted', 'raw_append', 'machine_proposed']);
export function canWriteFormal(ctx: CommandContext, entityKind: string): boolean;
export function effectiveEvidenceStatus(ctx: CommandContext): 'approved' | 'pending_review';
```

- [ ] **Step 1: 写缺 kind/confidence、伪造 manual origin 和机器覆盖字段的失败测试**

缺 `kind` 或 `confidence` 的 LLM 人物/关系不得进正式表；MCP 发送 `origin=manual,status=approved` 的机器证据仍必须 pending；已有支持度的机器修改只能产生 ChangeProposal。

- [ ] **Step 2: 运行并确认缺失字段被当成 explicit**

Run: `cd server && npm test -- ingest-trust evidence-trust`  
Expected: FAIL，当前 `isExplicit` 对缺失 confidence 使用 1。

- [ ] **Step 3: 为 LLM 输出建立完整 Zod schema**

`kind` 和 `confidence` 缺失或解析失败时，整条记录按 `machine_proposed` 处理；Person 和 Edge 永远进入 suggestion。禁止依赖正则截取后的任意 JSON 直接进入落库流程。

- [ ] **Step 4: 服务端决定 origin/status**

Web、MCP、worker 分别由服务端设置 channel。只有认证 Web 人工动作或具有 `human_command` scope 且带 sourceRef/sourceExcerpt 的 Workbuddy 用户命令可成为 user_asserted；客户端字段不能升级信任。

- [ ] **Step 5: 统一证据与字段更新边界**

机器 Evidence 强制 pending_review；机器修改正式 Person/OppRole/Opportunity/BI/UCV 字段生成 ChangeProposal；重复提议使用稳定 dedupe key 覆盖 pending 草稿而不是堆叠。

- [ ] **Step 6: 验证并提交**

Run: `cd server && npm test -- ingest-trust evidence-trust && npm run typecheck`

Commit: `fix(ai): fail closed at machine write boundaries`

### Task INT-105: 接通 approved Evidence 到服务端 PDE 和可靠快照

**Files:**
- Modify: `docs/pde-handoff/SPEC.md`
- Modify first: `docs/pde-handoff/kernel/reference_impl.py`
- Regenerate: `docs/pde-handoff/kernel/golden-tests.json`
- Modify: `packages/pde-kernel/src/types.ts`
- Modify: `packages/pde-kernel/src/kernel.ts`
- Create: `packages/pde-kernel/tests/evidence.test.ts`
- Create: `server/src/pde/evidence.ts`
- Modify: `server/src/pde/assemble.ts`
- Modify: `server/src/pde/routes.ts`
- Create: `server/tests/pde-evidence-chain.test.ts`

**Interfaces:**

```ts
export interface Stakeholder {
  id: string;
  slots: Slot[];
  mark: Mark;
  cred?: Cred;
  q?: number;
  age_days?: number;
  evidence_alpha?: [number, number, number];
}
```

`blend` 在既有目标分布伪计数与 `evidence_alpha` 相加后归一化；缺省值保持旧行为和全部旧 golden 数值。

本任务是关闭 `docs/pde-handoff/SPEC.md:184` 已要求的 Evidence 审核到分布/快照集成缺口，不授权改变 K1–K7 的既有业务含义。若 oracle 评审得出的接口不是 `evidence_alpha`，应按重大偏差流程先修订本任务，不得由 TS 实现自行发明另一套公式。

- [ ] **Step 1: 先写 oracle 证据案例和旧值不变断言**

新增同一 Deal 的 no-evidence、approved-positive、approved-negative 三个案例；pending/rejected 不进入组装层。旧 golden 的每个数值保持不变。

- [ ] **Step 2: 运行 TS 测试并确认新 Evidence 案例失败**

Run: `cd packages/pde-kernel && npm test -- evidence`  
Expected: FAIL，当前 Stakeholder 不接受证据伪计数。

- [ ] **Step 3: 按硬规则先改 Python oracle，再生成 golden**

不得先手改 TypeScript 期望值。oracle 接受可选 `evidence_alpha`，与 app 现有 `evidenceAlpha` 的方向和强度定义一致；生成文件记录 schemaVersion 升级原因。

- [ ] **Step 4: 移植到 TS Kernel，并保持 1e-6 容差**

实现只扩展可选输入，不改无证据路径。`server/src/pde/evidence.ts` 从 tenant 的 SignalCatalog 读取 delta，聚合 approved Evidence ID 和三态增量。

- [ ] **Step 5: 组装、审核和快照同一可靠链路**

`assembleDeal` 只读取同 tenant/opp 的 approved Evidence；`inputsJson` 写入 evidence ID 与聚合增量。Evidence approve 必须等待 `evidence_review` 快照成功；失败返回明确错误或使用可靠 outbox 重试，禁止静默吞掉。

- [ ] **Step 6: 全量验证并分三次提交**

Run: `cd packages/pde-kernel && npm run typecheck && npm test`  
Run: `cd ../../server && npm test -- pde-evidence-chain && npm run typecheck`

Commit 1: `spec(pde): define evidence alpha input`  
Commit 2: `feat(pde): apply approved evidence in kernel`  
Commit 3: `fix(pde): make evidence snapshots reliable`

### Task INT-106: 生产密钥、出站访问和依赖收口

**Files:**
- Create: `server/src/security/outboundUrl.ts`
- Modify: `server/src/ai.ts`
- Modify: `server/src/qccMcp.ts`
- Modify: `server/src/getnote.ts`
- Modify: `server/src/recording.ts`
- Modify: `server/src/index.ts`
- Modify: `.env.production.example`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Create: `server/tests/outbound-url.test.ts`
- Create: `server/tests/production-config.test.ts`

**Interfaces:**

```ts
export interface OutboundPolicy {
  allowedHosts: Set<string>;
  allowedPrivateHosts: Set<string>;
  requireHttps: boolean;
}
export async function assertOutboundUrl(rawUrl: string, policy: OutboundPolicy): Promise<URL>;
```

- [ ] **Step 1: 写 loopback、RFC1918、link-local、IPv6、重定向和默认密钥失败测试**
- [ ] **Step 2: 运行并确认任意 baseUrl 仍可触发服务端 fetch**
- [ ] **Step 3: 生产环境没有 `AI_KEY_SECRET` 时拒绝启动**
- [ ] **Step 4: 默认拒绝私网与非 HTTPS；内部可信服务只能由部署环境 allowlist 明确放行**
- [ ] **Step 5: 所有外部请求增加 AbortSignal 超时、重定向后复核和响应体上限**
- [ ] **Step 6: 升级 Fastify/JWT 相关依赖并回归**

Run: `cd server && npm audit --omit=dev && npm test -- outbound-url production-config && npm run typecheck`  
Expected: 无 critical/high；若上游暂时无法消除，逐条记录当前代码路径不可达证据并设置升级期限。

Commit: `fix(security): fail closed on secrets and outbound requests`

### Task INT-107: 修正用户归属、敏感可见性和企微回调权限

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/scope.ts`
- Modify: `server/src/state.ts`
- Modify: `server/src/wecom.ts`
- Modify: `server/src/index.ts`
- Create: `server/tests/visibility-acl.test.ts`
- Create: `server/tests/wecom-authorization.test.ts`

**Interfaces:**
- Account 使用稳定 `primaryOwnerUserId`；姓名仅展示。
- 服务端执行 `self/team/org` 和 `isPrivate` 访问策略；客户端隐藏不算权限控制。
- 企微回调每次重新查询当前 User、role、tenant 和 bind 状态。

- [ ] **Step 1: 写同名 viewer、private BI/log、已删除用户企微审批的失败测试**
- [ ] **Step 2: 增加 owner userId 并编写可重复迁移；同名冲突进入人工清单，不猜测归属**
- [ ] **Step 3: 在 state、AI context 服务和详情路由统一执行 ACL**
- [ ] **Step 4: WeCom token cache key 改为 tenantId+corpId，并在回调复核当前权限**
- [ ] **Step 5: 验证并提交**

Run: `cd server && npm test -- visibility-acl wecom-authorization && npm run typecheck`

Commit: `fix(auth): enforce stable ownership and sensitive ACLs`

### Task INT-108: 将 G64111 收敛为单一共享包

**Files:**
- Create: `packages/g64111/package.json`
- Create: `packages/g64111/tsconfig.json`
- Create: `packages/g64111/src/types.ts`
- Create: `packages/g64111/src/score.ts`
- Create: `packages/g64111/src/index.ts`
- Move tests to: `packages/g64111/tests/g64111.test.ts`
- Modify: `app/src/lib/g64111.ts`
- Modify: `server/src/g64111.ts`
- Modify: `app/package.json`
- Modify: `server/package.json`
- Create: `server/tests/g64111-parity.test.ts`

**Interfaces:**
- `scoreFromState(account: ScoringAccount, opportunity: ScoringOpportunity, profile?: ScoringProfile): ScoreBreakdown` 是唯一算法入口。
- App 和 Server 文件只保留领域 adapter/re-export，不包含独立公式。

- [ ] **Step 1: 用同一 fixture 证明当前 app/server 输出存在漂移检测能力**
- [ ] **Step 2: 把经 17 项测试覆盖的公式迁入 domain-agnostic 包**
- [ ] **Step 3: 前端和服务端改用 file dependency，共享完全相同的版本**
- [ ] **Step 4: Workbuddy 文档改为通过 MCP 获取权威分；离线 score.py 只跑兼容 fixtures，不再独立演进**
- [ ] **Step 5: 全量验证并提交**

Run: `cd packages/g64111 && npm run typecheck && npm test`  
Run: `cd ../../app && npm run typecheck && npm test`  
Run: `cd ../server && npm run typecheck && npm test -- g64111-parity`

Commit: `refactor(g64111): use one shared scoring package`

---

## M2：数据可靠性与原子写入

### Task INT-201: 建立前端写入协调器和可见保存状态

**Files:**
- Create: `app/src/lib/sync/mutationCoordinator.ts`
- Create: `app/src/lib/sync/mutationCoordinator.test.ts`
- Create: `app/src/lib/sync/commitScheduler.ts`
- Create: `app/src/lib/sync/commitScheduler.test.ts`
- Create: `app/src/components/SyncStatus.tsx`
- Modify: `app/src/App.tsx`
- Modify: `app/src/api.ts`
- Modify: `app/src/components/DetailDrawer.tsx`
- Modify: `app/src/components/EdgeDrawer.tsx`
- Modify: `app/src/components/OpportunityForm.tsx`

**Interfaces:**

```ts
export type SyncPhase = 'idle' | 'saving' | 'saved' | 'retrying' | 'failed' | 'conflict';
export interface MutationCoordinator {
  enqueue(entityKey: string, action: Action): Promise<void>;
  retry(entityKey: string): Promise<void>;
  state(entityKey: string): SyncPhase;
  subscribe(listener: () => void): () => void;
}
```

- [ ] **Step 1: 写慢 A/快 B、连续输入、网络失败、401 与 409 的纯函数测试**

```ts
it('serializes writes for the same entity', async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let callIndex = 0;
  const send = async (a: Action) => {
    if (a.type !== 'UPDATE_PERSON') throw new Error('test only accepts UPDATE_PERSON');
    order.push(`start:${String(a.patch.name)}`);
    if (callIndex++ === 0) await firstGate;
    order.push(`end:${String(a.patch.name)}`);
  };
  const q = createMutationCoordinator(send);
  const actionA: Action = { type: 'UPDATE_PERSON', accId: 'a1', personId: 'p1', patch: { name: 'A' } };
  const actionB: Action = { type: 'UPDATE_PERSON', accId: 'a1', personId: 'p1', patch: { name: 'B' } };
  const a = q.enqueue('person:p1', actionA);
  const b = q.enqueue('person:p1', actionB);
  await Promise.resolve();
  expect(order).toEqual(['start:A']);
  releaseFirst();
  await Promise.all([a, b]);
  expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
});
```

- [ ] **Step 2: 运行并确认当前 `applyRaw` 无队列、失败不回滚**

Run: `cd app && npm test -- mutationCoordinator commitScheduler`  
Expected: FAIL，新模块尚不存在。

- [ ] **Step 3: 实现同实体串行、不同实体可并行的 coordinator**

错误状态保留最后失败 Action；重试成功后清除。401 交给统一认证处理；409 保留用户草稿并进入 conflict，不直接用服务端树覆盖未保存输入。

- [ ] **Step 4: 文本字段使用草稿 + 400ms debounce/blur 提交**

连续输入只发送最后值；组件卸载前 flush 已产生的有效草稿。拖拽位置使用较短合并窗口，但仍按 person/edge key 串行。

- [ ] **Step 5: 增加全局与实体级保存反馈**

`SyncStatus` 展示保存中、已保存、重试中、失败和冲突；失败提供重试，冲突提供“查看云端值/保留我的值”选择。

- [ ] **Step 6: API 加超时、Abort 和统一 401**

启动恢复阶段只有确定的 401/403 才清 token；网络失败和 5xx 保留会话。所有错误使用类型化 `ApiError { status; code; message; retryable }`。

- [ ] **Step 7: 验证并提交**

Run: `cd app && npm run typecheck && npm test && npm run build`

Commit: `fix(sync): serialize mutations and expose durable save state`

### Task INT-202: 将复合业务动作改为事务命令和幂等执行

**Files:**
- Create: `server/src/mutation/commandRunner.ts`
- Create: `server/src/mutation/compoundCommands.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/opp.ts`
- Modify: `server/src/voice.ts`
- Modify: `server/src/proposals.ts`
- Modify: `server/prisma/schema.prisma`
- Create: `server/tests/compound-commands.test.ts`
- Modify: `app/src/api.ts`
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/InboxPanel.tsx`

**Interfaces:**

```ts
export async function runCommand<T>(
  ctx: CommandContext,
  input: { kind: string; idempotencyKey: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ replayed: boolean; result: T }>;
```

CommandRun 使用 `(tenantId, actorId, kind, idempotencyKey)` 唯一约束，保存 completed/failed 状态和不含敏感正文的结果摘要。

- [ ] **Step 1: 为四类复合动作写故障注入测试**

覆盖商机+骨架、一次 voice ingest、行动完成+Evidence、收件箱批处理。每个测试在第 2/3 步抛错，断言数据库没有部分记录。

- [ ] **Step 2: 运行并确认当前 App/voice 会留下半成品**

Run: `cd server && npm test -- compound-commands`  
Expected: FAIL，当前多次 `api.mutate` 和 voice 链不在同一事务。

- [ ] **Step 3: 让 `applyAction` 接受 transaction client**

所有 guard、query、write 使用传入的同一个 `DbClient`；事务函数中不得回退全局 prisma。

- [ ] **Step 4: 建立三个明确命令端点和一个批处理端点**

- `POST /api/commands/opportunity-skeleton`
- `POST /api/commands/action-feedback`
- voice/recording 现有入口内部调用 `runCommand`
- `POST /api/commands/inbox-batch` 返回逐项结果

每个入口要求 `Idempotency-Key`；App 使用业务动作开始时生成一次的 UUID，网络重试复用同一值。

- [ ] **Step 5: 删除 App 中同一业务动作的 3–N 次独立 mutate 调用**

商机骨架、行动反馈和批量审核只调用对应命令一次；只有收到成功结果才刷新/翻到下一卡。

- [ ] **Step 6: 验证并提交**

Run: `cd server && npm test -- compound-commands && npm run typecheck`  
Run: `cd ../app && npm run typecheck && npm test`

Commit: `fix(data): make compound workflows atomic and idempotent`

### Task INT-203: 为 Workbuddy 增加数据库幂等约束和同步回执

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/src/mcp/syncBundle.ts`
- Create: `server/src/mcp/syncReceipt.ts`
- Modify: `server/src/mcpServer.ts`
- Create: `server/tests/mcp-sync-idempotency.test.ts`
- Modify: `docs/MCP接口.md`
- Modify: `docs/集成-WB侧部署指南.md`

**Interfaces:**

```ts
export interface SyncReceipt {
  syncRunId: string;
  replayed: boolean;
  created: string[];
  updated: string[];
  proposed: string[];
  skipped: Array<{ ref: string; reason: string }>;
  failed: Array<{ ref: string; code: string; message: string }>;
}
```

- [ ] **Step 1: 写相同 externalRef、并发重复 bundle 和失败重试测试**
- [ ] **Step 2: 为 Account、Opportunity、VisitNote 增加租户内复合唯一约束**

目标键：Account `(tenantId,externalRef)` 和 `(tenantId,unifiedCreditCode)`；Opportunity `(tenantId,accountId,externalRef)`；VisitNote `(tenantId,accountId,externalRef)`。空值继续允许多个，迁移前输出重复冲突清单并停止自动合并。

- [ ] **Step 3: 建立 SyncRun 和原子 `sync_intel_bundle` 工具**

Bundle 可同时携带客户事实、商机事实、原始拜访、人物候选、关系候选和证据候选。所有内容先完成校验，再在一个事务内写入；同 idempotencyKey 重放同一 receipt。

- [ ] **Step 4: 保持旧离散工具兼容一版**

旧工具内部复用相同 service，并在返回中标记 `deprecatedAfter` 的明确版本；Workbuddy Flow 迁移完成后再单独决策是否移除。

- [ ] **Step 5: 验证并提交**

Run: `cd server && npm test -- mcp-sync-idempotency && npm run typecheck`

Commit: `feat(mcp): add atomic workbuddy sync receipts`

### Task INT-204: 为后台任务增加租约、重试和崩溃恢复

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/jobs.ts`
- Create: `server/tests/jobs-recovery.test.ts`

**Interfaces:**

```ts
export async function claimNextJob(workerId: string, now: Date): Promise<ClaimedJob | null>;
export async function recoverExpiredLeases(now: Date): Promise<number>;
```

- [ ] **Step 1: 写 processing 崩溃、多 worker 抢占和重复入队测试**
- [ ] **Step 2: 增加 `leaseOwner`、`leaseUntil`、`nextAttemptAt` 和 attemptCount**
- [ ] **Step 3: 使用条件 updateMany 原子 claim，只有一个 worker 获得任务**
- [ ] **Step 4: 超时 processing 回 pending；指数退避后达到上限进入 failed**
- [ ] **Step 5: 为 enqueue dedupe 建数据库唯一约束或事务 upsert**
- [ ] **Step 6: 验证并提交**

Run: `cd server && npm test -- jobs-recovery && npm run typecheck`

Commit: `fix(jobs): add leases retries and crash recovery`

---

## M3：内部最低纠错能力和 Workbuddy 适配

### Task INT-301: 提供关键字段纠错、归档恢复和重新绑定

**Files:**
- Create: `app/src/components/RepairPanel.tsx`
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/OpportunityForm.tsx`
- Modify: `app/src/components/CustomerHub.tsx`
- Modify: `app/src/components/DetailDrawer.tsx`
- Create: `server/src/repair.ts`
- Create: `server/tests/repair.test.ts`
- Modify: `app/src/api.ts`

**Interfaces:**
- `PATCH /api/repair/account/:id`
- `PATCH /api/repair/opportunity/:id`
- `POST /api/repair/rebind`
- `POST /api/archive/:kind/:id`
- `POST /api/archive/:kind/:id/restore`

- [ ] **Step 1: 写挂错商机的 VisitNote/Note 重绑和关键字段修正测试**
- [ ] **Step 2: 连接当前不可达的 OpportunityForm，但只暴露内部必要字段**

允许修正客户名称/类型/负责人，以及商机名称、阶段、状态、金额、签约日、目标、竞争态势；不建设通用数据库后台。

- [ ] **Step 3: RepairPanel 展示来源、sourceRef、同步时间、SyncRun 和最近 AuditEvent**
- [ ] **Step 4: 重新绑定必须服务端验证新旧父树，并在事务中更新所有冗余 accountId/opportunityId**
- [ ] **Step 5: 所有修正写 AuditEvent，并支持归档/恢复**
- [ ] **Step 6: 验证并提交**

Run: `cd server && npm test -- repair && npm run typecheck`  
Run: `cd ../app && npm run typecheck && npm test && npm run build`

Commit: `feat(internal): add minimum viable data repair tools`

### Task INT-302: 支持同客户重复人物的安全合并

**Files:**
- Create: `server/src/personMerge.ts`
- Create: `server/tests/person-merge.test.ts`
- Modify: `app/src/components/RepairPanel.tsx`
- Modify: `app/src/api.ts`

**Interfaces:**

```ts
export interface PersonMergeDecision {
  targetPersonId: string;
  sourcePersonId: string;
  roleConflictByOpportunity: Record<string, 'keep_target' | 'keep_source'>;
}
```

- [ ] **Step 1: 写 FORM、日志、角色、边、BI、Evidence 和 OpportunityMember 的合并测试**
- [ ] **Step 2: 在单一事务中重定向引用并归档 source Person**
- [ ] **Step 3: Edge 重定向后删除自环和完全重复边；OppRole 冲突必须使用用户选择**
- [ ] **Step 4: AuditEvent 记录源/目标 ID、重定向计数和冲突决策，不复制敏感正文**
- [ ] **Step 5: 验证并提交**

Run: `cd server && npm test -- person-merge && npm run typecheck`

Commit: `feat(internal): merge duplicate stakeholders safely`

### Task INT-303: 为 MCP Token 增加最小权限 scope

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/accessToken.ts`
- Modify: `server/src/mcpServer.ts`
- Modify: `app/src/components/McpAccess.tsx`
- Modify: `app/src/api.ts`
- Create: `server/tests/access-token-scope.test.ts`
- Modify: `docs/集成-WB侧部署指南.md`

**Interfaces:**

```ts
export type AccessScope = 'read' | 'human_command' | 'sync_business' | 'propose_people' | 'propose_relations' | 'submit_evidence';
```

- [ ] **Step 1: 写 read token 写入、proposal token 直写和已删除用户 token 的失败测试**
- [ ] **Step 2: AccessToken 增加 scopes 字符串数组 JSON 和 tokenVersion**
- [ ] **Step 3: `mcpAuthenticate` 回填 tokenId/scopes，并每次复核当前 User/role**
- [ ] **Step 4: 每个 MCP tool 声明 required scope；JWT 兼容路径也按当前用户权限映射 scope**
- [ ] **Step 5: UI 提供“Workbuddy 同步、只读分析、调研提案”三个预设，不让用户手拼权限**
- [ ] **Step 6: 验证并提交**

Run: `cd server && npm test -- access-token-scope && npm run typecheck`

Commit: `feat(mcp): scope workbuddy access tokens`

### Task INT-304: 固化 Workbuddy 到决策闭环的契约回归

**Files:**
- Create: `server/tests/fixtures/workbuddy-sync-bundle.json`
- Create: `server/tests/workbuddy-e2e.test.ts`
- Modify: `docs/MCP接口.md`
- Modify: `docs/集成-WB侧部署指南.md`

**Interfaces:**
- Fixture 只含虚构客户、商机、人物、关系、原始拜访和 Evidence。
- 同一 fixture 可重复运行，第二次不增加业务实体或 pending 数量。

- [ ] **Step 1: 固定完整链路断言**

链路为：同步客户/商机 → 重放 bundle → 人物/关系进入收件箱 → 改后采纳 → Evidence 审核 → PDE 变化并留快照 → 行动完成回填 → SyncRun/AuditEvent 可追溯。

- [ ] **Step 2: 先运行并确认当前链路缺少原子 receipt/PDE 证据变化**
- [ ] **Step 3: 只补契约和回归，不在本任务新增业务能力**
- [ ] **Step 4: 更新 Workbuddy 部署手册中的请求/回执/重试示例**
- [ ] **Step 5: 验证并提交**

Run: `cd server && npm test -- workbuddy-e2e`

Commit: `test(mcp): cover workbuddy to decision-loop journey`

---

## M4：决策主链和内部体验收口

### Task INT-401: 对齐 ADURC、主 D、P4 和 G64111 界面语义

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `packages/domain-contracts/src/actions.ts`
- Modify: `app/src/types.ts`
- Modify: `app/src/components/NewOpportunityDialog.tsx`
- Modify: `app/src/components/DetailDrawer.tsx`
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/mcpServer.ts`
- Create: `server/tests/scoring-selection.test.ts`
- Modify: `packages/g64111/tests/g64111.test.ts`

**Interfaces:**
- Opportunity 增加可空 `primaryDPersonId`；必须属于该商机的 D。
- P4 同一商机只能有一个；设置新 P4 时事务化解除旧 P4。

- [ ] **Step 1: 写 C 标签、旧 TB、主 D、多个 P4 和多 D 低中位数测试**
- [ ] **Step 2: 修正骨架和全部文案为 A/D/U/R/C：C=教练、R=影响者**
- [ ] **Step 3: UI 提供主 D 选择；存量缺失时保持兼容并提示补确认**
- [ ] **Step 4: 服务端强制 P4 单选和主 D 归属，客户端不能绕过**
- [ ] **Step 5: Sidebar/C5/敏感措辞与权威规格逐项对齐**
- [ ] **Step 6: 验证并提交**

Run: `cd packages/g64111 && npm test`  
Run: `cd ../../server && npm test -- scoring-selection`  
Run: `cd ../app && npm run typecheck && npm test && npm run build`

Commit: `fix(g64111): align role labels and selection constraints`

### Task INT-402: 修复 MomentFlow、日期和移动审核上下文

**Files:**
- Create: `app/src/lib/dateYmd.ts`
- Create: `app/src/lib/dateYmd.test.ts`
- Create: `app/src/lib/momentFlowModel.ts`
- Create: `app/src/lib/momentFlowModel.test.ts`
- Modify: `app/src/components/MomentFlow.tsx`
- Modify: `app/src/components/InboxPanel.tsx`
- Modify: `app/src/App.tsx`

**Interfaces:**

```ts
export function localYmd(date: Date, timeZone?: string): string;
export function buildMomentFlow(input: MomentFlowInput): MomentFlowViewModel;
```

- [ ] **Step 1: 写北京时间 00:30、逾期行动、Evidence-only 和拜访上下文测试**
- [ ] **Step 2: 替换全部 `toISOString().slice(0,10)` 业务日期生成**
- [ ] **Step 3: 未完成逾期行动始终进入今日流，QuickReview 纳入 Evidence**
- [ ] **Step 4: 审核 await 成功后再翻卡；失败留在原卡并显示错误**
- [ ] **Step 5: 拜访录入携带 accId/oppId/personId，不允许退回 Hub 后猜测归属**
- [ ] **Step 6: 批量处理显示逐项进度和失败项**
- [ ] **Step 7: 验证并提交**

Run: `cd app && npm test -- dateYmd momentFlowModel && npm run typecheck && npm run build`

Commit: `fix(mobile): preserve context dates and evidence review state`

### Task INT-403: 最小化 AI 上下文并更新内部帮助

**Files:**
- Modify: `app/src/aiContext.ts`
- Create: `app/src/aiContext.test.ts`
- Modify: `server/src/ai.ts`
- Modify: `app/src/components/HelpManual.tsx`
- Modify: `docs/用户手册.md`

**Interfaces:**
- AI context 必须由服务端可见范围裁剪；前端只做进一步最小化。
- 调用前返回 `ContextManifest`，列出实体数量、字段类别和被排除的敏感类别，不包含正文。

- [ ] **Step 1: 写 memberScoped、private BI、self 日志和非当前商机人物的排除测试**
- [ ] **Step 2: 服务端生成可见范围，前端不得重新加入未下发数据**
- [ ] **Step 3: 调模型前展示数据范围摘要，并允许用户排除原始日志/FORM**
- [ ] **Step 4: 重写内部手册**

手册只描述真实能力：Workbuddy 同步、收件箱、人审、纠错、合并、恢复、同步失败判断和 MCP Token。删除不存在的按钮、PDF/Excel、合并捷径及“实时同步”承诺。

- [ ] **Step 5: 验证并提交**

Run: `cd app && npm test -- aiContext && npm run typecheck && npm run build`  
Run: `cd ../server && npm test -- visibility-acl`

Commit: `fix(privacy): minimize AI context and refresh internal guidance`

### Task INT-404: 补齐内部版错误状态和基础无障碍

**Files:**
- Modify: `app/src/components/Modal.tsx`
- Modify: `app/src/components/OrientationGate.tsx`
- Modify: `app/src/components/Auth.tsx`
- Modify: `app/src/styles.css`
- Create: `app/src/lib/authValidation.ts`
- Create: `app/src/lib/authValidation.test.ts`

- [ ] **Step 1: 写注册字段中文错误、Modal Escape/焦点恢复和 OrientationGate 隔离验收用例**
- [ ] **Step 2: Auth 提交前校验所有必填项，错误统一中文；增加 autocomplete**
- [ ] **Step 3: Modal 增加 dialog 语义、aria-modal、焦点锁定、Escape 和关闭后焦点恢复**
- [ ] **Step 4: 横屏遮罩开启时让底层内容 inert/aria-hidden，焦点只在两个可见选项内**
- [ ] **Step 5: 为核心可点击 div 改用 button 或提供等价键盘入口**
- [ ] **Step 6: 浏览器回归 320/375/768/1440 四种宽度后提交**

Run: `cd app && npm test -- authValidation && npm run typecheck && npm run build`

Commit: `fix(a11y): make auth overlays and dialogs operable`

---

## M5：内部生产运维与发布门禁

### Task INT-501: 建立版本化 PostgreSQL 迁移、备份和恢复

**Files:**
- Create: `server/scripts/render-postgres-schema.mjs`
- Create generated: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/migrations/`
- Modify: `server/docker-entrypoint.sh`
- Modify: `server/Dockerfile`
- Modify: `deploy-macmini.sh`
- Modify: `docker-compose.yml`
- Create: `scripts/backup-postgres.sh`
- Create: `scripts/restore-postgres.sh`
- Create: `docs/内部版-备份恢复手册.md`
- Modify: `docs/Mac mini 内网部署与团队访问.md`
- Create: `server/tests/schema-render.test.ts`

**Interfaces:**
- `server/prisma/schema.prisma` 仍是跨库模型源。
- render 脚本只机械替换 datasource provider/URL 并输出 PostgreSQL schema；CI 断言生成结果无漂移，禁止手改生成文件。

- [ ] **Step 1: 写 schema render 稳定性和空库部署测试**
- [ ] **Step 2: 生成 PostgreSQL schema 并建立第一份 baseline migration**
- [ ] **Step 3: 容器启动从 `db push` 改为 `prisma migrate deploy`**
- [ ] **Step 4: 部署前自动备份，备份失败立即停止发布**
- [ ] **Step 5: 备份加密、校验、保留和恢复到隔离数据库**
- [ ] **Step 6: `/api/health` 增加 DB readiness；liveness 与 readiness 分离**
- [ ] **Step 7: 在空库和最近备份各完成一次恢复演练并记录时间**
- [ ] **Step 8: 验证并提交**

Run: `cd server && npm run typecheck && npm test && npx prisma validate`  
Run: `docker compose build && docker compose up -d`  
Expected: migration deploy 成功、readiness 正常、恢复库能跑 Workbuddy fixture。

Commit: `ops: add versioned migrations and verified recovery`

### Task INT-502: 执行内部版最终发布门禁

**Files:**
- Create: `docs/内部版-发布验收记录.md`
- Modify: `docs/内部版开发待办清单v1.md`
- Modify: `CHANGELOG.md` if present at execution time; otherwise add release notes to the验收记录，不为此单独创建 CHANGELOG。

**Interfaces:**
- Produces: 带 commit、环境、命令输出摘要、人工验收人、缺口和回滚点的发布记录。

- [ ] **Step 1: 运行全部自动门禁**

```bash
cd app
npm run typecheck
npm test
npm run build

cd ../server
npm run typecheck
npm test
npx prisma validate
npm audit --omit=dev

cd ../packages/g64111
npm run typecheck
npm test

cd ../pde-kernel
npm run typecheck
npm test
```

- [ ] **Step 2: 使用三套脱敏商机做完整人工旅程**

覆盖首次同步、相同资料重放、人审、挂错商机修正、重复人物合并、G64111/PDE 重算、行动回填、断网恢复、两成员并发和归档恢复。

> 2026-07-21 偏差备注：按 `docs/ADR-INT-502-发布验收简化与清库重装.md`，人工旅程压缩为一套核心旅程冒烟清单（自动回归全量保留），清单见 `docs/内部版-发布验收记录.md` §4。

- [ ] **Step 3: 完成备份恢复和部署回滚演练**
- [ ] **Step 4: 受控运行两周并记录指标**

通过阈值：Workbuddy 命令成功率不低于 99%；重复正式实体率低于 1%；无严重数据完整性事故；所有失败都能找到 SyncRun/AuditEvent 并有恢复路径。

> 2026-07-21 偏差备注：按 `docs/ADR-INT-502-发布验收简化与清库重装.md`，受控运行改为 48–72 小时、样本门槛 100→20 条（不足且零失败由项目所有者人工判定）；公司服务器投产路径改为「备份留档→清库→fresh install」，不再执行旧库 bridge 接管。

- [ ] **Step 5: 项目所有者签署内部生产基线**

发布条件：无跨租户问题、无机器绕人审、无复合写部分成功、无 critical/high 依赖漏洞或已有逐项不可达证明、全部测试通过、恢复演练通过。

Commit: `release: certify internal workbuddy-first baseline`

---

## 5. 任务依赖

```text
INT-000
  └─ INT-001
      ├─ INT-101
      │   ├─ INT-102
      │   │   ├─ INT-103
      │   │   ├─ INT-104
      │   │   │   ├─ INT-105
      │   │   │   └─ INT-203
      │   │   ├─ INT-107
      │   │   └─ INT-204
      │   ├─ INT-108
      │   └─ INT-201
      │       └─ INT-202
      │           ├─ INT-203
      │           └─ INT-401
      └─ INT-106

INT-103 + INT-201 + INT-203 → INT-301 → INT-302
INT-104 + INT-203 → INT-303
INT-105 + INT-203 + INT-303 → INT-304
INT-108 + INT-202 → INT-401
INT-201 + INT-202 → INT-402
INT-107 + INT-303 → INT-403
INT-201 → INT-404
M1 + M2 → INT-501
全部任务 → INT-502
```

默认执行顺序固定为：

```text
INT-001 → INT-101 → INT-102 → INT-103 → INT-104 → INT-105
→ INT-106 → INT-107 → INT-108 → M1 Gate
→ INT-201 → INT-202 → INT-203 → INT-204 → M2 Gate
→ INT-301 → INT-302 → INT-303 → INT-304 → M3 Gate
→ INT-401 → INT-402 → INT-403 → INT-404 → M4 Gate
→ INT-501 → INT-502
```

默认同一时间只有一个任务处于“进行中”。项目所有者明确分配两名执行者时，可以并行两个不存在依赖关系且不修改共享契约、Prisma schema或同一组核心文件的任务；两项都必须使用独立 worktree，并在待办清单记录并行原因。

## 5.1 审阅问题覆盖表

| 已确认问题 | 计划任务 |
|---|---|
| Server 没有自动化测试/CI | INT-001 |
| Action passthrough 和前后端契约漂移 | INT-101 |
| 跨租户父子/端点注入 | INT-102 |
| member 全租户 reset、不可恢复删除 | INT-103 |
| AI/录音/MCP 失败开放 | INT-104 |
| Evidence 未进入服务端 PDE、快照静默失败 | INT-105 |
| 默认加密密钥、SSRF、生产依赖告警 | INT-106 |
| viewer 姓名归属、private/visibility、企微失效用户 | INT-107 |
| App/Server 两份 G64111 | INT-108 |
| 客户端乱序保存、失败无恢复 | INT-201 |
| 骨架/voice/行动反馈/批量审核部分成功 | INT-202 |
| Workbuddy application-level 幂等和无同步回执 | INT-203 |
| Job 无 lease/崩溃恢复 | INT-204 |
| 商机编辑不可达、挂错实体无法修正 | INT-301 |
| 重复人物无安全合并 | INT-302 |
| MCP Token 无最小 scope | INT-303 |
| Workbuddy 到决策闭环无 E2E | INT-304 |
| ADURC、主 D、P4、C5 文案/约束漂移 | INT-401 |
| MomentFlow、UTC 日期、Evidence-only、上下文丢失 | INT-402 |
| AI context 过宽、帮助文档过期 | INT-403 |
| 注册文案、Modal、横屏遮罩和键盘可用性 | INT-404 |
| db push、备份恢复和 readiness | INT-501 |

## 6. 明确不进入本计划的事项

- 公共注册、验证码、用户自助注销和公开购买；
- 在线套餐、计费、发票、微信/支付宝支付；
- 营销落地页、转化漏斗和客户成功后台；
- 通用 Excel/CSV 导入中心；
- 全实体通用 CRUD 后台和自定义字段 builder；
- 企业 SSO、SCIM 和复杂组织架构；
- 实时 presence、多人光标和协同编辑；
- 原生 iOS/Android App；
- 白标、多语言和连接器市场；
- 平台代付 AI 和套餐内模型额度；
- 纯视觉目的的大规模组件重写；
- 与 Workbuddy 重复且不提供纠错价值的网页录入表单。

这些事项属于商业 SaaS 路线或独立产品判断，不能以“顺手一起做”为由插入内部版任务。

## 7. 普通调整和重大偏差

普通 bugfix、测试补充、文案、样式和同一任务内的小型重构可在任务边界内执行。任何触发 `docs/架构-双版本关系与变更治理v1.md` 第 7 节的事项，必须暂停当前任务，先更新 ADR、计划和待办清单并获得明确批准。

计划执行过程中若发现任务估算不准，但目标、边界、依赖和验收不变，只更新待办中的进度说明；不得降低验收标准来关闭任务。

## 8. 每个任务的统一完成定义

任务只有同时满足以下条件才能勾选完成：

1. 失败测试先出现，随后由最小实现变绿；
2. 聚焦测试和受影响项目全量测试通过；
3. TypeScript 无错误，生产构建通过；
4. 新增读写均有 tenant/RBAC/机器人审审查；
5. schema 变更有 SQLite dev 验证和 PostgreSQL migration/回滚说明；
6. 没有真实密钥、数据库、录音或客户信息进入 Git；
7. 文档、MCP 示例和用户文案与真实行为一致；
8. 待办状态、证据和 commit 已更新；
9. 一个任务只形成一个可独立回退的交付，PDE oracle/Kernel/adapter 例外按 INT-105 的三提交执行。
