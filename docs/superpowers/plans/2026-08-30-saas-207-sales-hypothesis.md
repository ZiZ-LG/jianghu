# SAAS-207 SalesHypothesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Add tenant-scoped, revision-preserving SalesHypothesis, SalesHypothesisRevision and HypothesisEvidenceLink authorities with deterministic read-only status suggestions and explicit human-confirmed status transitions, while migrating and freezing legacy `StrategyRisk(kind=assumption)` rows without changing risk handling or formal CRM state automatically.

**Architecture:** Shared Zod contracts define strict hypothesis revisions, reviewed-Evidence links, list/detail projections, deterministic status suggestions and body-free command receipts outside the legacy App `Action` union. Three expand-only Prisma models store the current hypothesis identity, immutable revisions and immutable evidence links using portable scalar/text fields. Dedicated Fastify commands execute through hashed-idempotency `CommandRun`, reload the actor's current database role, resolve `sales.workspace` EffectiveResourceScope and validate exact Customer/Matter/optional MatterParticipant and Evidence closure inside serializable transactions. A marker-last migration backfills existing manual legacy assumptions into canonical hypotheses without inventing owner, review time, expected signals, falsification conditions or truth status; legacy assumption writers are then frozen while `StrategyRisk(kind=risk)` remains unchanged.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod, SQLite development migration, deterministically rendered PostgreSQL schema, versioned PostgreSQL `migrate deploy` migration, Vitest.

## Global constraints

- **Task:** `SAAS-207`; **branch:** `codex/g4-candidate-review-intelligence`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`; **base:** `bd2f9eec5265853e90e831247733b5e293ed3f4b`; **status:** `IN_PROGRESS` after the independent start-governance gate.
- `SAAS-207` is the only CRM `IN_PROGRESS` item. `SAAS-208` stays `PENDING` until the independent business and governance-close SHAs each pass all 12 remote CI jobs.
- The project owner explicitly approved SAAS-207 changes to the shared root file `scripts/test-postgres-ops-integration.sh`. That approval is limited to the interruption, semantic/marker/partial drift, authenticated recovery and fresh-install proof required by this migration; it authorizes no other shared/high-conflict file.
- Every create/revise/metadata/status/link command, idempotent replay, list, direct-ID read and suggestion read is scoped by exact `tenantId`, current database role, `sales.workspace`, active Customer/Matter closure and EffectiveResourceScope. Viewer writes fail before `CommandRun`/`AuditEvent`; viewer reads retain Customer ownership isolation.
- Only `assertionMode=user_asserted` commands may create/revise a formal hypothesis, set status or link Evidence. AI, Agent and methodology code may only create source-bearing Candidate/draft output; they cannot import or call the formal writer. A deterministic status suggestion is read-only and never writes status, Candidate, Evidence, stage, forecast, focus, relation, G64111 or methodology state.
- A user-created revision requires a non-empty claim and reason, at least one expected signal and at least one falsification condition. Legacy migration may preserve explicit empty arrays and an empty legacy mitigation only on a revision marked `legacy_assumption`; the first user revision must remove that incomplete state rather than inventing content during migration.
- `SalesHypothesis.status` is exactly `untested | testing | supported | contradicted | retired`. Only a user-confirmed command changes formal status. Revising a hypothesis advances `currentRevisionId` with optimistic concurrency and resets the revised current judgment to `untested`; old revisions, links and audit records remain immutable.
- Evidence links are append-only, attach to the exact current revision, and require an approved tenant/customer/matter-local `EvidenceEvent` at compatibility version `0`. The same Evidence may appear once per revision with exactly one direction. Linked Evidence cannot be deleted.
- `StrategyRisk(kind=assumption)` is a frozen predecessor after backfill: runtime add/update/delete and risk↔assumption conversion fail closed. `StrategyRisk(kind=risk)` behavior remains unchanged. The migration does not delete or rewrite predecessor rows and new SalesHypothesis writes do not dual-write a stale legacy truth source.
- Backfill is conservative: `open -> untested`; `resolved | dismissed -> retired`; non-manual origins, unknown values, empty claims, duplicate IDs, orphan/cross-parent rows or successor conflicts stop the migration. It never infers `supported` or `contradicted`, owner, Person, review time, expected signals, falsification conditions or creator identity.
- Use no Prisma native enum, `Json` or array. Structured signal/condition arrays are strict canonical JSON text, validated on every write/read and in migration verification. SQLite and PostgreSQL schemas, markers, interrupted adoption, recovery and fresh install must agree. Production remains versioned `migrate deploy`; never use `db push` in production.
- SAAS-207 adds no App UI, graph overlay, Commitment link, relationship radar or portfolio behavior; those stay SAAS-208/SAAS-212. It does not modify `app/src/store.ts`, the legacy `Action` schema, App package/lock/Vite/dist, navigation, Docker Compose, Nginx, public CI, any self-cultivation path, production, Mac mini or `main`.

## Fixed authority and cutover

`SalesHypothesis` becomes the sole online hypothesis authority after the migration marker is valid. `SalesHypothesisRevision` is append-only history and `HypothesisEvidenceLink` is append-only reviewed-Evidence attribution. The legacy App state may continue to carry frozen predecessor assumptions for rollback compatibility, but no production writer or new hypothesis reader may use them as authority or fallback. Runtime source inventory and tests must classify:

- canonical reads: `server/src/hypotheses/routes.ts` and `server/src/hypotheses/service.ts`;
- canonical writes: `server/src/hypotheses/service.ts` only;
- immutable adapters/contracts: `packages/domain-contracts/src/hypotheses.ts` and `server/src/hypotheses/model.ts`;
- migration-only predecessor reader: `server/src/hypotheses/migration.ts`;
- frozen predecessor guard: `server/src/mutate.ts`;
- planned consumers only: `SAAS-208 relationship-map and Commitment review projection`, `SAAS-209 portfolio`, and `SAAS-212 relationship radar`.

No fallback read, background dual-write, automatic formal status transition or destructive predecessor deletion is allowed.

## Fixed portable models

```prisma
model SalesHypothesis {
  id                         String    @id
  tenantId                   String
  tenant                     Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customerId                 String
  matterId                   String
  personId                   String?
  status                     String    @default("untested")
  ownerUserId                String?
  nextReviewAt               DateTime?
  currentRevisionId          String
  legacyStrategyRiskId       String?
  createdByUserId            String?
  statusConfirmedByUserId    String?
  statusConfirmedAt          DateTime?
  version                    Int       @default(0)
  createdAt                  DateTime  @default(now())
  updatedAt                  DateTime  @updatedAt

  @@unique([tenantId, id])
  @@unique([tenantId, legacyStrategyRiskId])
  @@index([tenantId, customerId, updatedAt])
  @@index([tenantId, matterId, updatedAt])
  @@index([tenantId, personId, updatedAt])
  @@index([tenantId, ownerUserId, nextReviewAt])
  @@index([tenantId, status, nextReviewAt])
}

model SalesHypothesisRevision {
  id                        String   @id
  tenantId                  String
  hypothesisId              String
  revisionNumber            Int
  claim                     String
  reason                    String   @default("")
  expectedSignals           String   @default("[]")
  falsificationConditions   String   @default("[]")
  origin                    String   @default("user")
  createdByUserId           String?
  createdAt                 DateTime @default(now())

  @@unique([tenantId, id])
  @@unique([tenantId, hypothesisId, revisionNumber])
  @@index([tenantId, hypothesisId, createdAt])
}

model HypothesisEvidenceLink {
  id                    String   @id
  tenantId              String
  hypothesisId          String
  hypothesisRevisionId  String
  evidenceId            String
  evidenceVersion       Int      @default(0)
  direction             String
  linkedByUserId        String
  linkedAt              DateTime @default(now())

  @@unique([tenantId, id])
  @@unique([tenantId, hypothesisRevisionId, evidenceId])
  @@index([tenantId, hypothesisId, linkedAt])
  @@index([tenantId, evidenceId])
}
```

Add only the three inverse arrays to `Tenant`. Do not add destructive parent cascades or implicit cross-tenant relations to Account, Opportunity, Person, User or Evidence; the service and migration validate exact tenant/customer/matter closure on every operation.

## Fixed shared contract

- Commands are a standalone discriminated union: `CREATE_SALES_HYPOTHESIS`, `REVISE_SALES_HYPOTHESIS`, `UPDATE_SALES_HYPOTHESIS_REVIEW`, `SET_SALES_HYPOTHESIS_STATUS`, and `LINK_HYPOTHESIS_EVIDENCE`.
- Create requires hypothesis/revision IDs, exact Customer/Matter, optional Person, tenant-local owner, future `nextReviewAt`, and a complete initial revision. Revise requires `expectedVersion`, `expectedCurrentRevisionId` and a complete new immutable revision. Review metadata update requires `expectedVersion`, owner and future review time.
- Status change requires `expectedVersion` and one exact target status; caller-supplied confirmer/time is impossible. Link requires a link ID, hypothesis ID, `expectedVersion`, `expectedCurrentRevisionId`, approved Evidence ID/version `0`, and `supporting | contradicting`.
- Receipts expose only command type, IDs, status/revision number, version and replay state. Claim, reason, signal, condition and Evidence body never enter receipts, `CommandRun.result`, or AuditEvent details.
- List/detail projections expose the current revision plus bounded revision/link history only after current scope and storage integrity are revalidated. Default list excludes retired hypotheses. Cursors are stable by `updatedAt/id`; limits are 1–50.
- Bounds: IDs 1–200 visible non-secret characters; claim 1–2,000; reason 1–1,000; each signal/condition 1–500; 1–8 unique signals and 1–8 unique falsification conditions for user revisions; review time explicit UTC/offset and future. Unknown keys, duplicate strings, stale versions/current revision, invalid status/direction or unbounded history requests fail closed.
- Status suggestion is a deterministic read projection over links to the exact current revision: only supporting links suggest `supported`; only contradicting links suggest `contradicted`; mixed or no links return no formal suggestion. It returns `ruleVersion=hypothesis-evidence-balance.v1`, counts, exact body-free Evidence references and latest link time, and never mutates storage.

## Task 1: Lock strict standalone contracts with RED tests

**Files:**
- Create: `packages/domain-contracts/src/hypotheses.ts`
- Create: `packages/domain-contracts/tests/hypotheses.test.ts`
- Modify: `packages/domain-contracts/src/index.ts`

- [ ] Write failing tests for every command/projection/status/direction, complete user revisions, legacy-incomplete stored revisions, CAS shapes, body-free receipts, history/list bounds and deterministic suggestion output.
- [ ] Run the focused suite and confirm RED is caused by the missing contract/export.
- [ ] Implement minimal strict schemas and inferred types outside `ActionSchema`; do not modify `app/src/store.ts`, `actions.ts` or legacy wire actions.
- [ ] Run focused and full domain type/test gates.

## Task 2: Add expand-only models and guarded dual-database migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260830_pre_saas207.prisma`
- Create: `server/prisma/postgres/migrations/20260830000000_expand_sales_hypothesis/migration.sql`
- Create: `server/src/hypotheses/migration.ts`
- Create: `server/scripts/migrate-sales-hypotheses.ts`
- Create: `server/scripts/postgres-sales-hypothesis-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify under explicit owner approval: `scripts/test-postgres-ops-integration.sh`
- Create/modify focused migration, schema-render, SQLite and PostgreSQL operations tests.

- [ ] Write RED tests for exact predecessor/successor shapes, expand-only SQL, conservative legacy mapping, stable IDs/checksums, duplicate/orphan/AI-origin conflicts, marker-last interruption rollback/adoption, drift rejection and formal-data zero mutation.
- [ ] Add portable models, render PostgreSQL deterministically and create marker `SAAS-207-sales-hypothesis-v1`. Report/apply/verify accept only exact known states and verify every migrated predecessor row against immutable revision history without rewriting the predecessor.
- [ ] Wire backup-first SQLite report/apply/verify and versioned PostgreSQL `migrate deploy`; cover committed-DDL adoption, semantic/marker/partial drift, authenticated isolated restore and fresh install plus second update.
- [ ] Extend only the approved root script and emit `SAAS_207_SALES_HYPOTHESIS_MIGRATION_OK=1` while preserving every prior marker and `POSTGRES_OPS_INTEGRATION_OK=1`.

## Task 3: Implement immutable model and human commands

**Files:**
- Create: `server/src/hypotheses/model.ts`
- Create: `server/src/hypotheses/service.ts`
- Create: focused model/service tests.

- [ ] Write RED tests for create/revise/review/status/link, append-only history, CAS conflicts, current-role downgrade, viewer denial, tenant/customer/matter/person/user/Evidence closure, idempotent replay reauthorization and body-free receipts/audit.
- [ ] Prove revisions and links have no production update/delete path. Prove revising advances only the current pointer and resets status to `untested`; old claim/reason/signals/conditions/links remain byte-for-byte unchanged.
- [ ] Validate approved Evidence version `0`, append-only direction, duplicate conflict and Evidence deletion protection. Snapshot formal Relation/Stage/Forecast/Focus/G64111/methodology rows around every operation and prove zero changes.
- [ ] Implement minimal service logic in serializable transactions. Machine assertions fail before `CommandRun` or canonical writes.

## Task 4: Add current-scope reads and deterministic status suggestions

**Files:**
- Modify: `server/src/hypotheses/model.ts`
- Modify: `server/src/hypotheses/service.ts`
- Create: focused read/suggestion tests.

- [ ] Add paginated list and direct-ID detail reads that reload current role and EffectiveResourceScope, revalidate active parent/participant/user/Evidence closure and parse canonical stored arrays strictly.
- [ ] Return immutable revision/link history in deterministic order without Evidence body. Corrupted current pointers, revision numbering, structured JSON, link parent/version/direction or linked Evidence status fail closed.
- [ ] Implement the fixed read-only suggestion rule and prove it cannot write hypothesis status, AuditEvent, Candidate, Evidence or any other formal object.

## Task 5: Expose routes, freeze predecessor writes and cut authority inventory

**Files:**
- Create: `server/src/hypotheses/routes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/mutate.ts`
- Modify: Evidence deletion guard and focused tests.
- Modify: `server/src/seed-demo.ts`
- Modify: `server/tests/helpers/testDb.ts`
- Modify: `packages/domain-contracts/src/authority.ts` and tests.
- Create/modify route, scope, capability and dependency-boundary tests.

- [ ] Register `/api/commands/sales-hypothesis`, `/api/sales-hypotheses`, `/api/sales-hypotheses/:id`, and `/api/sales-hypotheses/:id/status-suggestion` with strict body/query/params and safe errors.
- [ ] Freeze only assumption predecessor add/update/delete and risk↔assumption conversion; preserve exact `StrategyRisk(kind=risk)` behavior. Remove demo seed bypass by seeding complete canonical hypotheses separately from risks.
- [ ] Extend Evidence deletion protection for immutable hypothesis links. Prove cross-tenant IDs do not leak and viewer writes fail before command/audit creation.
- [ ] Add `sales.hypothesis` to the executable authority map as a core authority, classify every predecessor consumer/migration, forbid fallback/dual-write/automatic status changes and leave only later task consumers planned.
- [ ] Prove G64111-disabled parity and static boundaries: App Action unchanged; Agent/AI/methodology cannot import the writer; production code cannot update/delete revisions or links or write legacy assumptions.

## Task 6: Full verification and exact-SHA business delivery

- [ ] Refresh copied workspace packages with `npm ci --install-links` in App and Server because domain-contracts changed.
- [ ] Inspect the exact diff. Only planned CRM files plus the explicitly approved root operations script may appear; no App source/Action/package/lock/Vite/dist, public navigation, Nginx/Compose/CI or self-cultivation path.
- [ ] Run Domain, Server, App, G64111, PDE, schema/render, SQLite and full PostgreSQL operations matrices from fresh outputs.
- [ ] Commit business code as `feat(crm): implement SAAS-207 sales hypotheses`, push the feature branch and wait for all 12 jobs on the exact business SHA. Do not merge or deploy.

## Task 7: Close governance separately

- [ ] Only after business exact-SHA CI is green, update this plan, `docs/架构-双版本关系与变更治理v1.md` and `docs/商业版开发待办清单v1.md`. Mark SAAS-207 `DONE`, move only SAAS-208 to `READY`, and record exact tests/CI/shared-script/rollback evidence.
- [ ] Add `docs/SAAS-207-SalesHypothesis迁移回滚说明.md` with marker/schema checks, SQLite backup-only restore, authenticated PostgreSQL recovery, non-destructive application rollback and retained predecessor/revisions/links/audit/command history.
- [ ] Commit/push governance separately and require its exact SHA 12/12 CI green before SAAS-208 starts.
- [ ] Report the required atomic-task template with `SELF-CULTIVATION FILES TOUCHED=NONE`, `PRODUCTION TOUCHED=NO`, `HOMEPAGE CHECK=NOT RUN (no deployment)`.

## Verification commands

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd ../../server && npm ci --install-links && npm run generate && npm run schema:postgres:render && npm run schema:postgres:check && npx tsc --noEmit && npm run test
cd ../app && npm ci --install-links && npx tsc --noEmit && npm run test
cd ../packages/g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm run test
cd ../..
bash scripts/test-postgres-ops-integration.sh
```

## Rollback

- Before application rollback, stop new hypothesis writers and export body-free counts/IDs plus schema/marker state. Revert application/contract code only; preserve SalesHypothesis, all revisions/links, linked Evidence, `StrategyRisk` predecessor rows, DataMigrationState, AuditEvent/CommandRun records and migration history.
- Never run destructive down migration, rewrite/delete immutable revisions or links, convert a deterministic suggestion into formal status, reconstruct canonical hypotheses from a later-edited predecessor, or re-enable legacy assumption writes as a fallback.
- SQLite restores only from an explicit pre-write backup. PostgreSQL restores only through the authenticated isolated recovery path and requires separate production approval. No SAAS-207 step touches production, Mac mini, public homepage, self-cultivation or `main`.
