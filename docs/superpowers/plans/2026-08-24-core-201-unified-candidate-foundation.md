# CORE-201 Unified Candidate Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不切换任何现有写入、收件箱读取或人审采纳路径的前提下，新增唯一、跨 SQLite/PostgreSQL 可移植的 `Candidate` 物理表，并为 `PersonSuggestion`、`RelSuggestion`、`ChangeProposal`、`Reminder` 与 `pending_review EvidenceEvent` 生成逐租户、只读、可重复的回填 dry-run 报告。

**Architecture:** `Candidate` 只是 G4 候选层的 expand 基座，以开放字符串保存 kind/status/source/target/old-new/payload/evidence/visibility，以 `tenantId + dedupeKey` 保证租户内幂等，以 `tenantId + legacySourceKind + legacySourceId` 保证存量一对一映射。本任务只建表、索引、迁移护栏和 dry-run；旧表仍是在线权威，`Candidate` 保持无在线 producer/consumer。无法稳定映射创建者的存量行不猜测，dry-run 投影为 `createdByUserId = null` 且 `visibility = owner_admin_only`；父实体、租户、状态或去重异常均失败关闭。

**Tech Stack:** TypeScript strict、Prisma 5、SQLite/PostgreSQL、Vitest、版本化 SQL migration、现有运维故障注入脚本。

## Global Constraints

- 每一次存量扫描先枚举 Tenant，再以 `tenantId` 过滤逐租户分页读取；全局 SQL 只允许返回无正文的完整性计数。
- `Candidate` 不用原生 enum/JSON/array；`payload` 与结构化引用使用 canonical JSON 字符串。
- AI/机器候选仍必须有 source、evidence 与 confidence；本任务不把 dry-run 投影写入 Candidate，更不改动正式 Person/Relation/Evidence/Commitment/Interaction。
- 只允许 canonical `pending | accepted | rejected` 审核状态；Reminder `done -> accepted`、`dismissed -> rejected`，Evidence `pending_review -> pending`，原状态保留在 payload 供回滚对账。
- `accountId` 必填，`matterId` 可空；存量 relation 候选从其 tenant-scoped Matter 解析 Customer，不跨租户猜测。
- 父实体归档不在 CORE-201 中改写候选状态；dry-run 只报告可映射、隔离与无效数量。
- 不修改 Action、app store、Inbox API/UI、现有 producer、现有 acceptance transaction 或旧表状态。这些分别属于 CORE-202、CORE-203 和 CORE-205。
- 不实施 SourceArtifact/ReviewBatch 物理表、sensitive ACL helper 或 Agent Job；只预留可空引用字段，分别留给 CORE-204/205/206。
- 旧表不删除、不冻结在线写入、不双写；CORE-201 回滚只回退应用层/执行脚本，新表与 migration 历史保留。
- 不修改 `app/package.json`、`app/package-lock.json`、Vite、dist、Compose、通用 Nginx/CI、主站导航或任何“自我修养”路径。

## Canonical Candidate Contract

`server/prisma/schema.prisma` 的中性物理字段固定为：

```prisma
model Candidate {
  id               String   @id
  tenantId         String
  tenant           Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  kind             String
  status           String   @default("pending")
  accountId        String
  matterId         String?
  targetKind       String
  targetId         String?
  fieldKey         String?
  oldValue         String?
  newValue         String?
  payload          String   @default("{}")
  source           String
  sourceRef        String
  evidence         String   @default("")
  confidence       Float    @default(0.5)
  sourceArtifactId String?
  reviewBatchId    String?
  createdByUserId  String?
  visibility       String   @default("private")
  dedupeKey        String
  legacySourceKind String?
  legacySourceId   String?
  version          Int      @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([tenantId, dedupeKey])
  @@unique([tenantId, legacySourceKind, legacySourceId])
  @@index([tenantId, status, createdAt])
  @@index([tenantId, accountId, status, createdAt])
  @@index([tenantId, matterId, status, createdAt])
  @@index([tenantId, sourceArtifactId])
  @@index([tenantId, reviewBatchId])
  @@index([tenantId, createdByUserId, visibility])
}
```

`targetKind` 与 `kind` 均为开放字符串；CORE-201 dry-run 只产生 `person_create | relation_create | field_change | reminder | evidence_create`。`dedupeKey` 对存量回填使用 `legacy-v1:<legacySourceKind>:<legacySourceId>` 的租户内稳定摘要，保证一行对一行、可重试且不把当前多表语义猜成新业务去重规则。CORE-202/203 为新 producer 另行固化 semantic dedupe helper。

---

### Task 1: Lock the mapping and migration contract with red tests

**Files:**
- Create: `server/tests/candidate-migration.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`

**Interfaces:**
- Produces a deterministic `CandidateMigrationReport` containing only counts, IDs/reason codes and checksums; it must never emit evidence/rawContent/payload text.
- Produces exactly five source reports and a top-level `sourceRows = projectedRows + invalidRows` invariant.
- Produces creator mapping outcomes `private` or `owner_admin_only`, never a guessed user.

- [ ] **Step 1: Add failing portable-schema assertions**

Assert the rendered schema and PostgreSQL migration contain the exact model fields, tenant FK, tenant-scoped unique keys and indexes above. Assert the SQL begins with `BEGIN`, sets lock/statement timeouts, creates only the Candidate foundation, and ends with `COMMIT`.

- [ ] **Step 2: Add failing five-source mapping fixtures**

Build two tenants with every legacy status, same local IDs across tenants where allowed, valid and missing creators, valid and cross-tenant/missing Customer/Matter/Person endpoints, pending Evidence, and existing accepted/rejected legacy rows. Assert canonical kind/status/sourceRef, canonical JSON stability, parent resolution, confidence preservation and creator quarantine.

- [ ] **Step 3: Add failing dry-run purity assertions**

Snapshot counts and statuses for all five legacy sources, Candidate, Person, Edge and EvidenceEvent before/after inspection. Assert exact equality and assert the CLI exposes no `--apply` path.

- [ ] **Step 4: Run RED tests**

Run: `cd server && npm ci --install-links && npm run generate`

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/candidate-migration.test.ts tests/schema-render.test.ts tests/sqlite-matter-upgrade.test.ts tests/postgres-ops-scripts.test.ts`

Expected: FAIL only because Candidate schema, migration module/scripts and deploy integration do not exist.

---

### Task 2: Add the portable Candidate schema and dual-database expand migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260824_pre_core201.prisma`
- Create: `server/prisma/postgres/migrations/20260824000000_expand_candidate_foundation/migration.sql`
- Create: `server/scripts/postgres-candidate-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`

**Interfaces:**
- Adds the exact `Candidate` model above and `Tenant.candidates Candidate[]`.
- Adds `CandidateSchemaState = uninitialized | legacy | expanded | partial` for both SQLite and PostgreSQL recovery logic.
- Adds migration identity `20260824000000_expand_candidate_foundation`.

- [ ] **Step 1: Add schema and deterministic render**

Modify only the hand-authored SQLite Prisma source, then run the existing renderer to update PostgreSQL. Save the exact pre-CORE-201 rendered PostgreSQL schema as the recovery/adoption snapshot; do not hand-edit two model authorities independently.

- [ ] **Step 2: Add atomic PostgreSQL DDL**

The migration must:

1. start one transaction and set bounded lock/statement timeouts;
2. verify required parent tables exist before DDL;
3. create Candidate, tenant FK, both tenant-scoped unique constraints and all declared indexes;
4. perform no legacy-source UPDATE/INSERT/DELETE;
5. commit atomically.

- [ ] **Step 3: Extend SQLite fail-closed upgrade**

Before `prisma db push`, classify Candidate schema. Reject partial state; on an existing legacy database, run the read-only candidate report and make a consistent `VACUUM INTO` backup before DDL. After push, require exact expanded shape and rerun verification. Fresh databases and idempotent reruns must not create unnecessary recovery ambiguity.

- [ ] **Step 4: Extend PostgreSQL recovery/adoption**

Register the migration and pre-snapshot in `deploy-postgres-migrations.sh`. A failed transactional migration with legacy state may be marked rolled back and replayed; an exact fully expanded but unregistered state may be verified and adopted; partial or drifted Candidate shape must fail closed and require authenticated restore. Run the read-only report before `migrate deploy` and verification after it.

- [ ] **Step 5: Run focused schema GREEN tests**

Run: `cd server && npm run generate && npm run schema:postgres:render && npm run schema:postgres:check`

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/schema-render.test.ts tests/sqlite-matter-upgrade.test.ts tests/postgres-ops-scripts.test.ts`

Expected: deterministic SQLite/PostgreSQL parity, fresh/upgrade/idempotent/partial/interrupted recovery cases green, with zero legacy source mutation.

---

### Task 3: Implement the tenant-scoped five-source dry-run mapper

**Files:**
- Create: `server/src/candidates/migration.ts`
- Create: `server/scripts/migrate-candidates.ts`
- Modify: `server/package.json`
- Modify: `server/tests/candidate-migration.test.ts`

**Interfaces:**

```ts
export type LegacyCandidateSourceKind =
  | 'PersonSuggestion'
  | 'RelSuggestion'
  | 'ChangeProposal'
  | 'Reminder'
  | 'EvidenceEvent';

export interface CandidateMigrationReport {
  sourceRows: number;
  projectedRows: number;
  quarantinedCreatorRows: number;
  invalidRows: CandidateMigrationIssue[];
  bySource: CandidateMigrationSourceReport[];
  byStatus: CandidateMigrationStatusReport[];
  projectionChecksum: string;
}

export async function inspectCandidateMigration(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<CandidateMigrationReport>;
```

- [ ] **Step 1: Implement deterministic canonicalization**

Use sorted-key JSON serialization and SHA-256 over non-secret projection metadata. Candidate IDs, sourceRefs and legacy dedupe keys derive only from tenant/source kind/source ID. Never place evidence, rawContent or payload into the CLI report or checksum input.

- [ ] **Step 2: Map all five legacy sources**

- PersonSuggestion -> `person_create`; preserve proposed person fields in payload and map `proposedBy` only when it is a current tenant-local User.
- RelSuggestion -> `relation_create`; resolve account from tenant-local Matter, preserve endpoint kinds/IDs and relation values, and quarantine creator because the legacy row has no stable creator.
- ChangeProposal -> `field_change`; preserve target/field/old/new, map `proposedBy` only when tenant-local, and preserve existing dedupe identity in payload for compatibility evidence.
- Reminder -> `reminder`; preserve rule kind/title/detail/severity/entity, map done/dismissed to accepted/rejected, and quarantine creator because none is stored.
- pending_review EvidenceEvent -> `evidence_create`; preserve target person/signal/direction/tier/occurredAt in payload, copy rawContent only to Candidate.evidence projection in memory, and map `createdBy` only when tenant-local.

- [ ] **Step 3: Validate tenant and parent closure**

For every projected row require tenant-local Customer; when matter is present require it belongs to the same tenant and Customer. Validate PersonSuggestion resolution, relation formal/candidate endpoints, field-change target parentage, reminder entity when present and Evidence person parentage. Missing/cross-tenant/mismatched parents become reason-coded invalid rows and never a projection.

- [ ] **Step 4: Enforce count, status and dedupe parity**

Require each valid source row to produce exactly one projection, every canonical status to match the fixed mapping, every tenant/source legacy identity to map to one unique Candidate dedupe key, and the aggregate checksum to be stable across repeated runs and source insertion order.

- [ ] **Step 5: Expose read-only CLI modes**

Add only:

```json
"migrate:candidate-report": "tsx scripts/migrate-candidates.ts --dry-run",
"migrate:candidate-verify": "tsx scripts/migrate-candidates.ts --verify"
```

`--verify` fails non-zero on invalid parent/status/dedupe/count parity but still performs no writes. Unknown flags, including `--apply`, fail closed.

- [ ] **Step 6: Run focused mapper GREEN tests**

Run: `cd server && DATABASE_URL=file:./test.db npx vitest run tests/candidate-migration.test.ts`

Expected: all five source/status/tenant/parent/creator/dedupe/purity cases green; repeated report checksum identical; no formal or legacy business row changes.

---

### Task 4: Prove cross-database migration, failure recovery and rollback safety

**Files:**
- Modify: `server/tests/postgres-ops-scripts.test.ts`
- Modify: `scripts/test-postgres-ops-integration.sh`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`
- Create: `docs/CORE-201-Candidate迁移与回滚说明.md`

- [ ] **Step 1: Add SQLite upgrade/recovery matrix**

Cover fresh install, pre-CORE-201 upgrade, repeat upgrade, dry-run failure before DDL, partial Candidate shape refusal, interruption after SQLite DDL/before post-check, authenticated backup restore and preserved five-source checksums.

- [ ] **Step 2: Add real PostgreSQL migration matrix**

Use the existing isolated Docker/PostgreSQL harness to cover fresh install, tracked upgrade, exact untracked pre-schema adoption, transaction failure/rollback/retry, complete-but-unregistered adoption, partial/drift refusal, encrypted backup/isolated restore and final zero schema drift. Confirm `_prisma_migrations` contains the exact CORE-201 identity once.

- [ ] **Step 3: Document deploy and rollback rules**

Record source schema, migration ID, report/verify commands, failure meanings, backup/restore procedure, and rollback boundaries. State explicitly: production only runs `migrate deploy`; no `db push`; CORE-201 does not backfill Candidate or switch authority; rollback never deletes legacy rows, Candidate rows, audit data or migration history.

- [ ] **Step 4: Run the affected server gate**

Run: `cd server && npm run generate && npm run schema:postgres:check && npm run typecheck`

Run: `cd server && npm test`

Run: `bash scripts/test-postgres-ops-integration.sh`

Run: `git diff --check`

Expected: server full suite and real PostgreSQL ops integration green; output includes a CORE-201-specific success marker and no production connection.

---

### Task 5: Complete the atomic task without starting CORE-202 early

**Files:**
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: `docs/CORE-201-Candidate迁移与回滚说明.md`

- [ ] **Step 1: Inspect the complete changed-path boundary**

Run: `git status --short`

Run: `git diff --name-only 558d22a5971626eedd1cae42cddd45bccc10cb14...HEAD`

Run protected/shared-path scans. Expected: no app package/lock/Vite/dist, Compose, main navigation, generic Nginx/CI, self-cultivation path or production artifact.

- [ ] **Step 2: Run repository completion gates**

Run: `cd packages/domain-contracts && npm ci && npm run typecheck && npm test`

Run: `cd packages/g64111 && npm ci && npm run typecheck && npm test`

Run: `cd packages/pde-kernel && npm ci && npx tsc --noEmit && npm test`

Run: `cd app && npm ci --install-links && npx tsc --noEmit && npm test && npm run build`

Run: `cd server && npm ci --install-links && npm run generate && npm run schema:postgres:check && npm run typecheck && npm test`

Run: `bash scripts/test-postgres-ops-integration.sh`

Run: `git diff --check`

Expected: all local gates green; existing G64111/PDE and G3 commercial behavior unchanged.

- [ ] **Step 3: Commit and push the business implementation**

Commit only schema/migration/runtime/test/ops code as:

```bash
git commit -m "feat(core-201): add unified candidate foundation"
git push -u origin codex/g4-candidate-review-intelligence
```

Wait for the exact pushed SHA to complete every required CI job successfully. Do not update the checklist to DONE before that evidence exists.

- [ ] **Step 4: Close CORE-201 in a separate governance commit**

After exact-SHA CI is green, change only `CORE-201 IN_PROGRESS -> DONE` and `CORE-202 PENDING -> READY`, append commands/run URL/SHA/rollback evidence, and commit:

```bash
git commit -m "docs(core-201): close unified candidate foundation"
git push
```

Wait for this exact docs SHA CI to pass. Only then may CORE-202 move `READY -> IN_PROGRESS`; do not implement its helper/cutover during CORE-201.

## Self-review

- Spec coverage: single table, all five legacy sources, count/status/parent/dedupe parity, creator quarantine, SQLite/PostgreSQL migration, failure recovery and rollback each have explicit tests.
- Authority boundary: old tables remain online authorities and there is no Candidate producer, consumer, Inbox switch, acceptance transaction or formal write in CORE-201.
- Security boundary: every scan is tenant-scoped; cross-tenant/malformed parents fail closed; dry-run output contains no evidence/raw payload; creator identity is never guessed.
- Scope boundary: SourceArtifact/ReviewBatch/ACL/Agent/Interaction and new candidate kinds remain in their registered later tasks.
- Delivery boundary: business and governance commits are separate; feature branch push is allowed, main merge and production deployment are not.
- Placeholder scan: no TODO/TBD/example-only acceptance criterion or unnamed migration/rollback step remains.
