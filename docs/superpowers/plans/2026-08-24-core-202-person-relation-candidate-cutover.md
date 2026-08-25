# CORE-202 Person and Relation Candidate Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 voice、enrich job、suggest 与 MCP 产生的候选人物/关系统一写入 `Candidate`，由唯一 helper 在同一事务内维护 `PersonSuggestion`/`RelSuggestion` 物化兼容投影，保持现有 API、收件箱与人审回执不变，并继续执行 tenant、父实体和 CAS 保护。

**Architecture:** CORE-202 是 Candidate 的首个 write-cutover，不是 Inbox cutover。对本任务之后创建或处理的 `person_create` / `relation_create`，`Candidate` 是写入权威；所有创建、pending 更新、采纳、拒绝和人物合并导致的候选引用改写只能经过 `server/src/candidates/personRelation.ts`。helper 在调用方事务中原子更新 Candidate 与旧表物化投影，旧 API 和当前五表 Inbox 暂时继续读取旧 DTO；这是一段明确止于 CORE-203 的 Expand → Migrate 兼容期，不允许出现第二个独立双写入口。CORE-202 不全量回填未触碰的存量行：旧行在第一次状态/内容变更时由 helper 以稳定 legacy identity 纳入 Candidate；CORE-203 负责五类全量迁移、单表 Inbox 和旧表只读冻结。

**Tech Stack:** TypeScript strict、Prisma 5、SQLite/PostgreSQL、Vitest、Fastify、现有 Serializable/CAS 事务与 effective-scope helper。

## Global Constraints

- 不修改 Prisma schema、SQLite/PostgreSQL migration 或生产部署脚本；CORE-201 的 Candidate 字段与唯一键足够完成本任务。
- 不修改 App `Action`、store、共享领域契约或 UI；旧 REST/MCP 回执形状保持兼容。
- 不切换 `/api/inbox` 为 Candidate 单表，不迁移 ChangeProposal、Reminder 或 pending Evidence，不创建 SourceArtifact、ReviewBatch、Interaction、AgentJob 或新候选 kind。
- 新机器候选必须保留非空 source/sourceRef/evidence、`0..1` confidence、tenant-local Customer/Matter/endpoint 和明确 creator；系统任务无法映射 creator 时使用 `createdByUserId = null`、`visibility = owner_admin_only`，不得猜测用户。
- CORE-204 前不提前启用 creator/share ACL 行为；旧 API 继续复用当前 effective resource scope。Candidate 字段必须准确填充，为 CORE-204 留下可迁移事实。
- viewer 写接口继续由现有 route/MCP policy 失败关闭；helper 本身仍要求显式 tenantId 并逐父实体校验，不能依赖调用者已经校验。
- 旧表只允许 helper 写入；生产源码中除 helper 和 CORE-201 只读 mapper 外，不得再出现 PersonSuggestion/RelSuggestion create/update/delete。
- 兼容投影必须与 Candidate 在同一事务提交或一起回滚；禁止“先写 Candidate、稍后异步补旧表”或反向异步同步。
- 不删除旧表、旧行、Candidate、正式 Person/Edge、审计或 migration 历史。回滚应用时保留 Candidate，旧应用依赖同事务维护的旧表投影继续工作。
- 不修改 `app/package.json`、`app/package-lock.json`、Vite、dist、Compose、通用 Nginx/CI、主站导航或任何“自我修养”路径。

## Authority and Compatibility Contract

### New or touched rows

```text
producer / review transaction / merge transaction
                  |
                  v
      candidates/personRelation.ts
           | same DB transaction
           +--> Candidate (write authority)
           +--> PersonSuggestion or RelSuggestion (materialized legacy projection)
```

- `Candidate.legacySourceKind + legacySourceId` anchors exactly one compatibility row.
- `Candidate.payload` uses CORE-201 canonical JSON and contains the exact old DTO fields; status and mutable projected fields are refreshed on every helper mutation.
- `Candidate.version` is the CAS authority for helper-managed rows. Legacy `status` remains an exact compatibility projection and is changed in the same transaction.
- A pre-CORE-202 legacy-only row is adopted lazily by deterministic legacy identity before its first mutation; adoption validates tenant/parent closure and writes no formal business data.
- Reads remain on the legacy materialized projection until CORE-203. There is no null fallback between two read authorities.

### Dedupe

- Every create call supplies a non-empty, producer-scoped semantic `dedupeKey`; `tenantId + dedupeKey` is the concurrency boundary.
- Person enrich/MCP paths preserve current pending same-Customer/same-normalized-name behavior. Voice extraction may use an extraction-local stable ref because current behavior allows distinct utterances to produce distinct candidates.
- Suggest/MCP relation paths use Matter + unordered typed endpoint pair. Voice extraction may use an extraction-local stable ref where current behavior intentionally records separate observations.
- Repeating the same key returns the same compatibility receipt and never creates a second Candidate or old-table row. A key collision with different kind/tenant/parent/payload identity fails closed.
- When a pending candidate reaches accepted/rejected, helper atomically moves its active semantic key to a terminal key derived from Candidate ID. This preserves current MCP/enrich ability to submit a later new pending observation while exact request retries still resolve through legacy identity/sourceRef.

---

### Task 1: Lock helper, authority and rollback behavior with red tests

**Files:**
- Create: `server/tests/candidate-person-relation.test.ts`
- Modify: `server/tests/candidate-migration.test.ts`
- Modify: `server/tests/tenant-parentage.test.ts`
- Modify: `server/tests/suggestion-role-validation.test.ts`

**Interfaces:**

```ts
createPersonCandidate(db, input): Promise<{ row: PersonSuggestion; candidateId: string; created: boolean }>
updatePendingPersonCandidate(db, input): Promise<{ row: PersonSuggestion; candidateId: string }>
createRelationCandidate(db, input): Promise<{ row: RelSuggestion; candidateId: string; created: boolean }>
claimPersonCandidate(db, input): Promise<PersonSuggestion>
finalizePersonCandidate(db, input): Promise<PersonSuggestion>
claimRelationCandidate(db, input): Promise<RelSuggestion>
finalizeRelationCandidate(db, input): Promise<RelSuggestion>
rejectPersonCandidate(db, input): Promise<boolean>
rejectRelationCandidate(db, input): Promise<boolean>
redirectCandidatePersonReferences(db, input): Promise<RedirectCounts>
```

- [ ] **Step 1: Add RED portable helper tests**

Cover Candidate + compatibility projection atomic create, canonical payload parity, same-key replay, conflicting-key refusal, same key across tenants, missing/cross-tenant/archived Customer/Matter/Person refusal, candidate endpoint parentage and non-empty source/evidence/confidence validation.

- [ ] **Step 2: Add RED CAS/adoption tests**

Cover legacy-only lazy adoption, Candidate `pending@version` claim, terminal finalize, reject, stale/double decision conflict, transaction fault rollback, terminal dedupe release and exact Candidate/legacy status parity.

- [ ] **Step 3: Add RED no-bypass inventory test**

Scan production `server/src` and allow PersonSuggestion/RelSuggestion mutations only in `candidates/personRelation.ts`; CORE-201 mapper and other consumers may read but not write. Test fixtures remain free to seed legacy rows directly.

- [ ] **Step 4: Run RED tests**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/candidate-person-relation.test.ts tests/candidate-migration.test.ts tests/tenant-parentage.test.ts tests/suggestion-role-validation.test.ts`

Expected: fail only because the CORE-202 helper/cutover does not exist.

---

### Task 2: Implement the single Candidate helper and compatibility projection

**Files:**
- Create: `server/src/candidates/personRelation.ts`
- Modify: `server/src/candidates/migration.ts`
- Modify: `server/tests/candidate-person-relation.test.ts`

- [ ] **Step 1: Reuse the CORE-201 canonical identity and JSON rules**

Export only the pure legacy identity/canonical projection primitives needed by the runtime helper; do not duplicate hashing, payload fields or status mapping.

- [ ] **Step 2: Implement transaction-safe create/update**

When given a root Prisma client, open one transaction; when given an existing transaction client, reuse it. Validate tenant-local parents and actor, then create/update Candidate and materialized legacy projection atomically. Handle `P2002` by reading the same tenant/key and returning the existing compatible receipt; never accept a mismatched collision.

- [ ] **Step 3: Implement CAS review transitions**

Adopt a legacy-only row when necessary, CAS Candidate on tenant/id/status/version, update the old projection in the same transaction, refresh canonical payload and fail the transaction if either count is not exactly one.

- [ ] **Step 4: Implement reference redirects**

When an accepted Person is merged or a candidate endpoint materializes, update Candidate payload/target references and legacy projections through the same helper. Revalidate every affected Matter/Customer endpoint before mutation.

- [ ] **Step 5: Run focused helper GREEN tests**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/candidate-person-relation.test.ts tests/candidate-migration.test.ts`

Expected: helper invariants, lazy adoption, CAS, replay and rollback green on SQLite.

---

### Task 3: Cut all four producer classes to the helper

**Files:**
- Modify: `server/src/voice.ts`
- Modify: `server/src/jobs.ts`
- Modify: `server/src/suggest.ts`
- Modify: `server/src/mcp/syncBundle.ts`
- Modify: `server/src/mcpServer.ts`
- Modify: `server/tests/voiceContext.test.ts`
- Modify: `server/tests/jobs-recovery.test.ts`
- Modify: `server/tests/mcp-sync-idempotency.test.ts`
- Modify: `server/tests/mcpBoundary.test.ts`
- Modify: `server/tests/tenant-parentage.test.ts`

- [ ] **Step 1: Cut voice producers**

Route AI person/relation extraction through the helper with actor, origin, evidence, confidence and extraction-local source refs. Keep authenticated explicit manual Person/Edge writes unchanged.

- [ ] **Step 2: Cut enrich and suggest producers**

Route enrich person create/pending merge and graph/LLM relation creation through the helper. Preserve capacity limits, existing pair filtering and job completion atomicity.

- [ ] **Step 3: Cut MCP producers**

Route both atomic sync-bundle and direct MCP propose tools through the helper. Preserve SyncRun idempotency, pending capacity, same-name/pair dedupe and existing receipt shapes.

- [ ] **Step 4: Prove producer coverage**

For voice, enrich, suggest, MCP sync and MCP direct tool fixtures, assert one Candidate and one compatibility row, exact tenant/parents/source/evidence/confidence, replay count parity and zero formal Person/Edge before acceptance.

- [ ] **Step 5: Run producer GREEN tests**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/voiceContext.test.ts tests/jobs-recovery.test.ts tests/mcp-sync-idempotency.test.ts tests/mcpBoundary.test.ts tests/tenant-parentage.test.ts`

---

### Task 4: Cut review, batch rejection and person-merge mutations to the helper

**Files:**
- Modify: `server/src/suggest.ts`
- Modify: `server/src/mutation/compoundCommands.ts`
- Modify: `server/src/personMerge.ts`
- Modify: `server/tests/compound-commands.test.ts`
- Modify: `server/tests/person-merge.test.ts`
- Modify: `server/tests/suggestion-role-validation.test.ts`
- Modify: `server/tests/tenant-parentage.test.ts`

- [ ] **Step 1: Preserve acceptance transaction boundaries**

Person and relation acceptance must claim Candidate before any formal write; Person/participant/role/Edge creation, compatibility projection finalize and Candidate finalize stay in the caller's existing transaction. Any parent/CAS/formal write failure rolls everything back.

- [ ] **Step 2: Preserve reject and batch behavior**

Single reject and existing compound Inbox batch route use helper CAS. CORE-202 does not redesign batch semantics or add ReviewBatch; that remains CORE-203/205.

- [ ] **Step 3: Preserve merge referential closure**

Person merge redirects Candidate and compatibility projection references together, validates tenant/Customer/Matter closure and leaves unrelated candidate kinds untouched.

- [ ] **Step 4: Prove old API receipt parity**

Run existing person/relationship list, generate, accept, reject, compound and MCP list fixtures. Assert DTO/status/ID/created Person/Edge receipts match pre-cutover behavior and viewer remains write-denied.

- [ ] **Step 5: Run review GREEN tests**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/candidate-person-relation.test.ts tests/compound-commands.test.ts tests/person-merge.test.ts tests/suggestion-role-validation.test.ts tests/tenant-parentage.test.ts tests/effective-scope-routes.test.ts`

---

### Task 5: Verify both databases, regressions and rollback readiness

**Files:**
- Modify: `docs/CORE-201-Candidate迁移与回滚说明.md`
- Modify: `docs/商业版开发待办清单v1.md`

- [ ] **Step 1: Run focused and full server verification**

Run: `cd server && npm run generate && npm run schema:postgres:check && npm run typecheck`

Run: `cd server && npm test`

Run: `bash scripts/test-postgres-ops-integration.sh`

- [ ] **Step 2: Run unchanged cross-workspace gates**

Run: `cd packages/domain-contracts && npm run typecheck && npm test`

Run: `cd packages/g64111 && npm run typecheck && npm test`

Run: `cd packages/pde-kernel && npx tsc --noEmit && npm test`

Run: `cd app && npx tsc --noEmit && npm test`

Do not run a local App production build because it writes shared/high-conflict `app/dist/**`; exact-SHA remote CI retains the build gate on an isolated runner.

- [ ] **Step 3: Verify change boundaries**

Run: `git diff --check`

Run the no-bypass inventory, protected-path diff check and secret-pattern scan. Assert no schema/migration/Action/App/shared/self-cultivation/production file changed.

- [ ] **Step 4: Document rollback and CORE-203 handoff**

Record that reverting CORE-202 application code is safe because old projections were committed atomically; Candidate rows and migration history remain. Record that CORE-203 must first verify/backfill all five source types, switch Inbox to Candidate, then freeze old tables—never delete them as part of cutover.

- [ ] **Step 5: Commit, push and require exact-SHA CI**

Create one independent CORE-202 business commit, push the feature branch and wait for all exact-head CI jobs to pass. Only then create a separate governance close commit marking CORE-202 DONE and CORE-203 READY; wait for that exact SHA CI before starting CORE-203.

## Stop Conditions

Stop and request project-owner approval if implementation requires any Prisma schema/migration change, App/Action/domain-contract change, shared file, public navigation/Nginx/CI change, self-cultivation path, production access, long-lived double-write design, relaxed tenant/viewer/AI-human-review boundary, or scope expansion into CORE-203+.
