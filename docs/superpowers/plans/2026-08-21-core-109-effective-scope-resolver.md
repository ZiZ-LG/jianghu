# CORE-109 Effective Scope Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `TenantDataScopePolicy` 与唯一的 Customer/Matter effective-scope resolver，使 state、按 ID 读取、AI/PDE、MCP 查询和 Hub 聚合返回同一授权集合，同时保持存量租户权限语义不变。

**Architecture:** `Tenant.dataScopePolicy` 只保存 `legacy_tenant_shared | scoped` 开放字符串，未知值失败关闭；`server/src/resourceScope.ts` 每次从数据库重验当前 User role、租户策略与稳定 owner User.id，返回 Customer 容器集合、Customer 完整数据集合及 Matter 集合。所有消费者只使用这些集合构造 Prisma `where`，不得先加载全租户业务数据再在响应层过滤；`server/src/scope.ts` 仅保留旧函数名兼容适配。CORE-109 不创建 Team、Grant 或敏感正文 ACL，也不提供把存量租户自动切到 scoped 的入口。

**Tech Stack:** TypeScript strict、Fastify、Prisma 5、SQLite/PostgreSQL、Zod、Vitest。

## Global Constraints

- 所有查询必须先限定 `tenantId`，跨租户与不存在 actor 均失败关闭。
- `legacy_tenant_shared` 保持 owner/admin/member 租户共享与 viewer 本人 Customer 的现状。
- `scoped` 下 owner/admin 保持全租户；member 只见本人稳定 User.id 归属的 Customer、本人归属 Matter 及这些 Matter 的最小 Customer 容器；viewer 上限不能被扩大。
- 未归属、离职 User.id、跨租户 owner 与未知 policy 不得产生可见资源。
- Customer 容器可返回 id/name/customerType；只有完整 Customer scope 才能返回客户级 Person、Relation、Note、Commitment、profile 或兄弟 Matter。
- 不使用姓名、地区、`OpportunityMember` 或前端筛选推导员工授权。
- 不新增原生 enum/Json/数组类型；SQLite 与 PostgreSQL schema 必须确定性一致。
- 不实现 CORE-204 敏感资料 ACL、SAAS-301 Team/Grant、CORE-206 Agent scope 或 CORE-301 团队安全矩阵。

---

### Task 1: Policy contract and portable schema

**Files:**
- Modify: `packages/domain-contracts/src/capabilities.ts`
- Modify: `packages/domain-contracts/tests/capabilities.test.ts`
- Modify: `server/prisma/schema.prisma`
- Modify: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260821_pre_core109.prisma`
- Create: `server/prisma/postgres/migrations/20260821040000_add_tenant_data_scope_policy/migration.sql`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`

**Interfaces:**
- Produces: `TenantDataScopePolicySchema` and `TenantDataScopePolicy`.
- Produces: `Tenant.dataScopePolicy: String @default("legacy_tenant_shared")`.

- [ ] **Step 1: Write failing contract and migration tests**

```ts
expect(TenantDataScopePolicySchema.parse('legacy_tenant_shared')).toBe('legacy_tenant_shared');
expect(TenantDataScopePolicySchema.parse('scoped')).toBe('scoped');
expect(TenantDataScopePolicySchema.safeParse('unknown').success).toBe(false);
expect(migration).toContain('ADD COLUMN "dataScopePolicy" TEXT NOT NULL DEFAULT \'legacy_tenant_shared\'');
```

- [ ] **Step 2: Run the red tests**

Run: `cd packages/domain-contracts && npm test -- capabilities.test.ts`

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/schema-render.test.ts tests/sqlite-matter-upgrade.test.ts`

Expected: FAIL because the contract, column, migration and pre-CORE-109 snapshot do not exist.

- [ ] **Step 3: Add the contract and schema**

```ts
export const TENANT_DATA_SCOPE_POLICIES = ['legacy_tenant_shared', 'scoped'] as const;
export const TenantDataScopePolicySchema = z.enum(TENANT_DATA_SCOPE_POLICIES);
export type TenantDataScopePolicy = z.infer<typeof TenantDataScopePolicySchema>;
```

Add `dataScopePolicy String @default("legacy_tenant_shared")` to both Tenant models. The PostgreSQL migration must be one transaction and only add the defaulted non-null text column. Copy the exact pre-change rendered PostgreSQL schema to `20260821_pre_core109.prisma` and register it as an approved untracked/adoption state in the deploy wrapper.

- [ ] **Step 4: Verify both databases and deterministic render**

Run: `cd server && npm run generate`

Run: `cd server && npm run schema:postgres:check`

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/schema-render.test.ts tests/sqlite-matter-upgrade.test.ts`

Expected: PASS; existing SQLite rows read `legacy_tenant_shared`, fresh SQLite uses the same default, backup restore returns to the pre-CORE-109 schema, and the pre-snapshot differs from current only by this Tenant field.

- [ ] **Step 5: Commit the portable policy substrate**

```bash
git commit -m "feat(core-109): add tenant data scope policy"
```

---

### Task 2: Single effective-resource resolver

**Files:**
- Create: `server/src/resourceScope.ts`
- Modify: `server/src/scope.ts`
- Create: `server/tests/resource-scope.test.ts`

**Interfaces:**
- Consumes: `TenantDataScopePolicySchema`, `ReadPrincipal`, Prisma `DbClient`.
- Produces:

```ts
export interface EffectiveResourceScope {
  tenantId: string;
  actorUserId: string;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
  policy: 'legacy_tenant_shared' | 'scoped';
  accountIds: ReadonlySet<string>;
  fullAccountIds: ReadonlySet<string>;
  matterIds: ReadonlySet<string>;
  canReadAccountContainer(accountId: string): boolean;
  canReadAccountData(accountId: string): boolean;
  canReadMatter(matterId: string): boolean;
}

export async function resolveEffectiveResourceScope(
  db: DbClient,
  principal: ReadPrincipal,
): Promise<EffectiveResourceScope>;
```

- [ ] **Step 1: Write the resolver matrix tests**

Create fixtures with two same-tenant members, one foreign-tenant user, directly owned/unassigned/cross-owner Customers, and owned/unassigned/sibling Matters. Assert:

```ts
expect([...scopedMember.fullAccountIds]).toEqual(['owned-customer']);
expect([...scopedMember.matterIds].sort()).toEqual(['matter-under-owned-customer', 'owned-matter']);
expect([...scopedMember.accountIds].sort()).toEqual(['owned-customer', 'parent-of-owned-matter']);
expect(scopedMember.canReadMatter('sibling-matter')).toBe(false);
```

Also assert legacy member full visibility, scoped owner/admin full visibility, viewer parity, current-role downgrade on the next call, unknown policy empty scope, deleted actor empty scope, and no cross-tenant IDs.

- [ ] **Step 2: Run the resolver test red**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/resource-scope.test.ts`

Expected: FAIL because `resourceScope.ts` does not exist.

- [ ] **Step 3: Implement current-state resolution**

Load Tenant and User with `{ id: principal.tenantId }` and `{ id: principal.userId, tenantId: principal.tenantId }`; parse both policy and current role. Query Accounts and Matters only with that tenant. Build sets as follows:

```ts
const fullAccountIds = currentRole === 'viewer'
  ? ownedAccountIds
  : policy === 'scoped' && currentRole === 'member'
    ? ownedAccountIds
    : allAccountIds;
const matterIds = currentRole === 'viewer'
  ? mattersUnder(fullAccountIds)
  : policy === 'scoped' && currentRole === 'member'
    ? union(mattersUnder(fullAccountIds), directlyOwnedMatterIds)
    : allMatterIds;
const accountIds = union(fullAccountIds, parentsOf(matterIds));
```

Unknown policy, invalid role or missing actor returns an immutable empty scope; it never falls back to tenant-shared.

- [ ] **Step 4: Convert legacy viewer helpers to adapters**

Keep `viewerAccountIds`, `viewerCanReadAccount` and `viewerCanReadOpp` exported for existing imports, but make them call the resolver for every request. `viewerCanReadAccount` must use `canReadAccountData`; `viewerCanReadOpp` must use `canReadMatter`. Preserve 404 responses to avoid existence disclosure.

- [ ] **Step 5: Run and commit**

Run: `cd server && npx tsc --noEmit`

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/resource-scope.test.ts tests/visibility-acl.test.ts tests/access-token-scope.test.ts`

Expected: PASS with current viewer behavior unchanged.

```bash
git commit -m "feat(core-109): add effective resource scope resolver"
```

---

### Task 3: Scope the state aggregate at query time

**Files:**
- Modify: `server/src/state.ts`
- Create: `server/tests/effective-scope-state.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveResourceScope()` and its three ID sets.
- Produces: `/api/state` projection in which partial Customer containers cannot expose customer-level or sibling-Matter data.

- [ ] **Step 1: Write the partial-container leakage test**

Seed one scoped member who owns only Matter A under a Customer that also contains Matter B. Put unique secrets in Customer profile, account-level Person/log/Edge/Note/Commitment, Matter B, and Matter A. Assert `/api/state` returns the Customer header and Matter A, but the JSON contains none of the Customer-level or Matter B secrets. Assert a direct Customer owner receives the complete Customer tree and a legacy member still receives both Matters.

- [ ] **Step 2: Run the state test red**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/effective-scope-state.test.ts`

Expected: FAIL because scoped members still receive the tenant-shared tree.

- [ ] **Step 3: Replace the all-tree include with scoped loading**

Resolve scope before business queries. Query only `Account.id IN accountIds` and `Opportunity.id IN matterIds`. For partial containers return only `id`, `name`, and `customerType`; normalize optional customer fields to empty/null values required by the wire contract. Query Persons and account Edges separately: complete Customers may load all valid rows; partial Customers may load only Person IDs referenced by visible Matter roles/participants/members/BI/edges and only Matter-specific Edges for visible Matters.

For tables loaded after the tree, use this exact authorization shape before the query:

```ts
const visibleParentWhere = {
  OR: [
    { accountId: { in: [...scope.fullAccountIds] } },
    { opportunityId: { in: [...scope.matterIds] } },
  ],
};
```

Customer-level rows with null Matter are therefore visible only through `fullAccountIds`. Unfiled Notes are visible only to tenant-wide owner/admin or legacy owner/admin/member, never to scoped member/viewer.

- [ ] **Step 4: Verify no query-time broad fallback**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/effective-scope-state.test.ts tests/tenant-parentage.test.ts tests/visibility-acl.test.ts tests/customer-level-commitment.test.ts`

Expected: PASS; malformed parent rows remain dropped and emit the existing security warning, while authorized scoped rows remain present.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(core-109): scope state aggregation"
```

---

### Task 4: Route all read surfaces through the same set

**Files:**
- Modify: `server/src/ai.ts`
- Modify: `server/src/pde/assemble.ts`
- Modify: `server/src/mcpServer.ts`
- Modify: `server/src/suggest.ts`
- Modify: `server/src/curated.ts`
- Modify: `server/src/recording.ts`
- Modify: `server/src/jobs.ts`
- Modify: `server/src/repair.ts`
- Create: `server/tests/effective-scope-routes.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveResourceScope`, `canReadAccountData`, and `canReadMatter`.
- Produces: the same visible IDs for list, ID, AI/PDE, MCP query/export-like reads, Inbox aggregate, transcript/job lists and repair context.

- [ ] **Step 1: Write a cross-entry parity test**

With one scoped member and one hidden sibling Matter, collect IDs from `/api/state`, MCP `list_accounts/get_account_detail/get_win_tendency/list_pending`, `/api/inbox`, `/api/ai/context-manifest`, `/api/pde/:id/ev`, `/api/curated`, `/api/recording/transcripts`, `/api/enrich/jobs`, and `/api/repair/context/opportunity/:id`. Assert visible IDs succeed consistently, hidden IDs return 404/tool error, and aggregate/list bodies do not contain hidden markers. Repeat after owner transfer and role downgrade without issuing a new JWT to prove revocation is effective on the next request.

- [ ] **Step 2: Run the cross-entry test red**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/effective-scope-routes.test.ts`

Expected: FAIL on current tenant-wide member reads.

- [ ] **Step 3: Apply resolver filters before every business query**

`buildServerAiContext` and PDE assembly must call `canReadMatter` before loading the graph. MCP list/detail/score/pending must replace viewer-only IDs with resolver sets; account detail requires full Customer data while score requires Matter access. Inbox, transcript and job list queries must use `fullAccountIds OR matterIds` and never query all tenant rows for a scoped member. Curated Customer reads require full Customer data; Matter reads require Matter access. Repair context uses the same rule and preserves 404.

- [ ] **Step 4: Preserve sensitive ACL and legacy parity**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/effective-scope-routes.test.ts tests/access-token-scope.test.ts tests/visibility-acl.test.ts tests/tenant-parentage.test.ts tests/mcpBoundary.test.ts`

Expected: PASS; viewer private BI/log behavior remains stricter than ordinary members, and MCP stored scopes continue to intersect the current database role.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(core-109): unify effective scope read surfaces"
```

---

### Task 5: Authority inventory, full verification and remote gate

**Files:**
- Create: `docs/CORE-109-effective-scope消费者清单.md`
- Modify: `docs/架构-CRM字段权威映射v1.md`
- Modify: `docs/部署上线指南.md`
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: `packages/domain-contracts/src/authority.ts`
- Modify: `packages/domain-contracts/tests/authority.test.ts`

**Interfaces:**
- Produces: a zero-PENDING consumer inventory and explicit stop/rollback conditions.

- [ ] **Step 1: Record every consumer and rollback rule**

The checklist must enumerate state, legacy scope adapters, MCP, AI/strategy, PDE, suggestions/Inbox, curated, transcripts/jobs, repair context and absent dedicated export/search routes. Mark a row DONE only with a named test. State that unknown policy fails closed, existing tenants remain `legacy_tenant_shared`, and rollback changes code/policy forward without removing the column or broadening tenant filters.

- [ ] **Step 2: Refresh copied shared packages**

Run: `cd app && npm ci --install-links`

Run: `cd server && npm ci --install-links && npm run generate`

Expected: both install successfully and Prisma Client includes `Tenant.dataScopePolicy`.

- [ ] **Step 3: Run the repository gates**

Run: `cd packages/domain-contracts && npm run typecheck && npm test`

Run: `cd packages/g64111 && npm run typecheck && npm test`

Run: `cd app && npx tsc --noEmit && npm test && npm run build`

Run: `cd server && npx tsc --noEmit && npm test && npm run schema:postgres:check`

Run: `git diff --check`

Expected: all tests pass; G64111/PDE authorities are unchanged; PostgreSQL render is deterministic.

- [ ] **Step 4: Commit, push and verify exact SHA**

```bash
git commit -m "docs(core-109): close effective scope stage gate"
git push origin codex/g2-core-model-foundation
```

Run: `gh run view <run-id> --json status,conclusion,headSha,jobs,url`

Expected: the exact pushed SHA completes all 12 jobs successfully before CORE-109 becomes DONE or CORE-110 becomes READY.

## Self-review

- Spec coverage: policy, current-role revocation, legacy parity, scoped member ownership, viewer ceiling, state/list/ID/AI/PDE/MCP/aggregate consistency, cross-database migration and rollback all have an explicit task.
- Deliberate exclusions: Team/Grant, sensitive SourceArtifact ACL, Agent scope and team portfolio aggregation stay in their registered later tasks.
- Placeholder scan: no placeholder markers or unnamed error-handling/testing steps remain.
- Type consistency: all consumers use `EffectiveResourceScope.accountIds/fullAccountIds/matterIds`; Customer detail always checks `fullAccountIds`, while Matter detail checks `matterIds`.
