# SAAS-206 IntelligenceItem and StakeholderFocus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Add method-neutral, tenant-scoped IntelligenceItem and StakeholderFocus authorities with strict commands, provenance, user confirmation, current-scope reads and portable dual-database migrations, without promoting rumor/inference to Evidence or coupling generic focus to G64111 `primaryDPersonId`.

**Architecture:** Shared Zod contracts define bounded intelligence, provenance, target, focus-basis, list/detail and command receipts outside the legacy App `Action` union. Two expand-only Prisma models store method-neutral state and history metadata as portable scalar/text fields. Dedicated Fastify commands execute through the existing hashed-idempotency `CommandRun` boundary, reloading the actor's current database role and resolving current `sales.workspace` EffectiveResourceScope inside a serializable transaction. Reads use the same current authorization intersection. Intelligence remains a distinct assertion even when later verified; StakeholderFocus is created or revised only by an explicit user command and has no read, write, fallback or migration path to `Opportunity.primaryDPersonId`.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod, SQLite development migration, deterministically rendered PostgreSQL schema, versioned PostgreSQL `migrate deploy` migration, Vitest.

## Global constraints

- **Task:** `SAAS-206`; **branch:** `codex/g4-candidate-review-intelligence`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`; **base:** `a702b229f28e117e2eeccc0513692cc60ca2b353`; **status:** `DONE` after the independent business and governance gates.
- `SAAS-206` remained the only CRM `IN_PROGRESS` item through implementation. `SAAS-207` moves to `READY` only after business SHA `5f2d0568a6f15216d98a8b0f9013ed1c0dfa2aa3` passed 12/12 jobs and this governance close is independently verified.
- The project owner explicitly approved SAAS-206 changes to the shared root file `scripts/test-postgres-ops-integration.sh`. That approval is limited to the migration failure-injection, recovery and fresh-install proof required by this task; it does not authorize any other shared/high-conflict file.
- Every create/update/archive/restore/set/retire, replay, list and direct-ID read is scoped by exact `tenantId`, current database role, `sales.workspace`, active Customer/Matter closure and EffectiveResourceScope. Viewer writes always fail; viewer reads remain constrained by Customer ownership and the resolver.
- Human commands may create formal IntelligenceItem and StakeholderFocus records. Machine/Agent/AI output may only create a Candidate with source, evidence and confidence; it cannot call these writers or silently create/revise focus. Static dependency tests and behavioral zero-write tests enforce that boundary.
- `assertionType` is exactly `observed | reported | inferred`; omitted type defaults to `reported`. Reported or inferred material stays IntelligenceItem forever. Verification may later create a separate formal Evidence record through its own approved command, but SAAS-206 never relabels, mutates or writes Evidence.
- Every IntelligenceItem carries a non-empty source description, learned time, confidence and bounded target references. Linked Interaction/Evidence sources must already be authorized, tenant-local and inside the exact Customer/Matter closure.
- StakeholderFocus represents the one current operating focus for a Matter, with one Person, desired change, rationale, evidence gap or bounded basis references, server-owned confirmer and finite validity. Changes use optimistic concurrency and body-free audit. Methodology may suggest a candidate only; this task exposes no machine writer.
- Generic focus code, contracts, migration and tests must not import, select, compare, write, backfill or fall back to `Opportunity.primaryDPersonId`, G64111 roles/scores, ADURC or methodology lifecycle. A fixture mutates legacy primary D independently and proves focus results remain unchanged.
- Use no Prisma native enum, `Json` or array. Structured target/basis references are strict canonical JSON text validated on every write/read. SQLite and PostgreSQL schemas, marker, interrupted adoption, recovery and fresh install must agree. Production remains versioned `migrate deploy`; never use `db push` in production.
- SAAS-206 adds no product UI. Relationship-map projection remains SAAS-208. It does not modify `app/src/store.ts`, the legacy `Action` union, App package/lock/Vite/dist, public/product navigation, Docker Compose, Nginx, public CI, any self-cultivation path, production, Mac mini or `main`.

## File map

- `packages/domain-contracts/src/intelligence.ts` and its tests — strict IntelligenceItem, StakeholderFocus, commands, receipts and read projections.
- `packages/domain-contracts/src/index.ts` — exports the new standalone domain contract; the legacy Action contract remains unchanged.
- `packages/domain-contracts/src/authority.ts` and tests — switch `stakeholder.focus` from planned/no-authority to the implemented core authority, retaining SAAS-208 as the only planned consumer.
- `server/src/intelligenceFocus/model.ts` — canonical target/basis serialization, cross-field validation and safe projections.
- `server/src/intelligenceFocus/service.ts` — current-role/scope/source/participant authorization, idempotent CAS commands, reads and body-free audit.
- `server/src/intelligenceFocus/routes.ts`, `server/src/app.ts` — authenticated commands plus paginated list/direct-ID reads under `sales.workspace`.
- `server/src/intelligenceFocus/migration.ts` — exact schema report/apply/verify and marker-last migration contract.
- `server/prisma/schema.prisma`, rendered PostgreSQL schema, predecessor snapshot and versioned SQL — portable expand-only models.
- `server/scripts/migrate-intelligence-focus.ts`, `server/scripts/postgres-intelligence-focus-schema-state.ts`, SQLite upgrader, PostgreSQL deploy script and `server/package.json` — operational integration.
- `scripts/test-postgres-ops-integration.sh` — owner-approved shared root failure-injection, authenticated recovery and fresh-install proof.
- `docs/SAAS-206-IntelligenceItem与StakeholderFocus迁移回滚说明.md` — governance-close migration, restore and non-destructive application rollback runbook.
- Focused Domain/Server migration, service, route, scope, authority and G64111-disabled boundary tests.

## Fixed shared contract

```ts
export type IntelligenceAssertionType = 'observed' | 'reported' | 'inferred';
export type IntelligenceSourceKind = 'manual' | 'interaction' | 'evidence';
export type IntelligenceTargetKind = 'customer' | 'matter' | 'person' | 'relation';

export interface IntelligenceSource {
  kind: IntelligenceSourceKind;
  description: string;
  refId: string | null;
  refVersion: number | null;
}

export interface IntelligenceTargetRef {
  kind: IntelligenceTargetKind;
  id: string;
}

export interface IntelligenceItemView {
  id: string;
  customerId: string;
  matterId: string;
  assertionType: IntelligenceAssertionType;
  statement: string;
  source: IntelligenceSource;
  occurredAt: string | null;
  learnedAt: string;
  confidence: number;
  targets: IntelligenceTargetRef[];
  status: 'active' | 'archived';
  createdByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type StakeholderFocusBasisKind = 'intelligence_item' | 'interaction' | 'evidence';

export interface StakeholderFocusBasisRef {
  kind: StakeholderFocusBasisKind;
  id: string;
  version: number;
}

export interface StakeholderFocusView {
  id: string;
  customerId: string;
  matterId: string;
  personId: string;
  desiredChange: string;
  rationale: string;
  evidenceGap: string | null;
  basisRefs: StakeholderFocusBasisRef[];
  validUntil: string;
  status: 'active' | 'expired' | 'retired';
  confirmedByUserId: string;
  confirmedAt: string;
  retiredByUserId: string | null;
  retiredAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

Commands are a separate discriminated union with exact types `CREATE_INTELLIGENCE_ITEM`, `UPDATE_INTELLIGENCE_ITEM`, `ARCHIVE_INTELLIGENCE_ITEM`, `RESTORE_INTELLIGENCE_ITEM`, `SET_STAKEHOLDER_FOCUS` and `RETIRE_STAKEHOLDER_FOCUS`. Update/archive/restore/retire require `expectedVersion`. `SET_STAKEHOLDER_FOCUS` requires the caller's expected current focus ID/version (or explicit `null`/`null` when none exists) so a stale client cannot replace another user's decision. Server responses expose only IDs, types/status, versions and replay state; statement, source description, rationale and evidence-gap text never enter receipts.

Bounds are fixed: IDs 1–200 visible non-secret characters; statement and desired change 1–2,000 characters; source description and rationale 1–1,000; evidence gap absent or 1–1,000; at most 12 unique Intelligence targets and 8 unique focus basis references; confidence finite within `[0,1]`; all instants require explicit UTC/offset. `observed` requires `occurredAt`; any `occurredAt` cannot follow `learnedAt`; `validUntil` must follow server confirmation time. A manual source has no reference; Interaction/Evidence sources require an exact reference and nonnegative snapshot version. Unknown keys, duplicate refs, cross-parent refs and forbidden content-bearing receipt fields fail closed.

## Fixed portable models

```prisma
model IntelligenceItem {
  id                 String   @id
  tenantId           String
  tenant             Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customerId         String
  matterId           String
  assertionType      String   @default("reported")
  statement          String
  sourceKind         String
  sourceDescription  String
  sourceRefId        String?
  sourceRefVersion   Int?
  occurredAt         DateTime?
  learnedAt          DateTime
  confidence         Float    @default(0.5)
  targetRefs         String   @default("[]")
  createdByUserId    String
  version            Int      @default(0)
  archivedAt         DateTime?
  archivedByUserId   String?
  archiveReason      String   @default("")
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@unique([tenantId, id])
  @@index([tenantId, customerId, learnedAt])
  @@index([tenantId, matterId, learnedAt])
  @@index([tenantId, assertionType, learnedAt])
  @@index([tenantId, archivedAt, learnedAt])
}

model StakeholderFocus {
  id                 String    @id
  tenantId           String
  tenant             Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customerId         String
  matterId           String
  personId           String
  desiredChange      String
  rationale          String
  evidenceGap        String?
  basisRefs          String    @default("[]")
  validUntil         DateTime
  activeMatterKey    String?
  confirmedByUserId  String
  confirmedAt        DateTime
  retiredByUserId    String?
  retiredAt          DateTime?
  retireReason       String    @default("")
  version            Int       @default(0)
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  @@unique([tenantId, id])
  @@unique([tenantId, activeMatterKey])
  @@index([tenantId, customerId, updatedAt])
  @@index([tenantId, matterId, updatedAt])
  @@index([tenantId, personId, updatedAt])
}
```

Add only the two inverse arrays to `Tenant`. Do not add parent cascade relations to Account/Opportunity/Person; the service validates exact tenant/customer/matter/person closure and MatterParticipant membership before each write and read. `activeMatterKey=matterId` exists only on the one current non-retired focus; replacing or retiring it is one serializable CAS transaction. Expiry is a read projection and never silently selects another person.

## Task 1: Lock strict standalone contracts with RED tests

**Files:**
- Create: `packages/domain-contracts/src/intelligence.ts`
- Create: `packages/domain-contracts/tests/intelligence.test.ts`
- Modify: `packages/domain-contracts/src/index.ts`

- [x] **Step 1: Write the failing contract suite first.** Cover default `reported`, all assertion/source/target/basis variants, observed-time ordering, confidence and size bounds, duplicate/dangling/unknown fields, body-free receipts, exact CAS shapes and list/detail cursor bounds.
- [x] **Step 2: Run RED and confirm the failure is missing contract/export, not fixture setup.**

```bash
cd packages/domain-contracts
npx vitest run tests/intelligence.test.ts
```

- [x] **Step 3: Implement the minimal strict schemas and inferred types.** Keep them separate from `ActionSchema`; do not modify `app/src/store.ts`, `actions.ts` or legacy mutate types.
- [x] **Step 4: Run GREEN focused/package gates.**

```bash
cd packages/domain-contracts
npx vitest run tests/intelligence.test.ts
npm run typecheck
npm test
```

## Task 2: Add expand-only SQLite/PostgreSQL models and guarded migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260827_pre_saas206.prisma`
- Create: `server/prisma/postgres/migrations/20260827000000_expand_intelligence_focus/migration.sql`
- Create: `server/src/intelligenceFocus/migration.ts`
- Create: `server/scripts/migrate-intelligence-focus.ts`
- Create: `server/scripts/postgres-intelligence-focus-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify under explicit owner approval: `scripts/test-postgres-ops-integration.sh`
- Create: `server/tests/intelligence-focus-migration.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`

- [x] **Step 1: Write RED schema/migration/ops tests.** Assert predecessor absence, exact successor shapes and indexes, expand-only SQL, no backfill and no mutation of Evidence, primary D, Candidate, ResearchBrief or other formal tables.
- [x] **Step 2: Add the exact portable models, render PostgreSQL deterministically and create marker-last migration `SAAS-206-intelligence-focus-v1`.** Report/apply/verify accepts only exact predecessor or successor state and rejects partial tables, unknown columns/indexes, invalid row semantics and marker checksum drift.
- [x] **Step 3: Wire guarded local/production operations.** SQLite inspects before backup/upgrade; PostgreSQL uses versioned `migrate deploy`, supports interrupted committed-DDL marker adoption, fails closed on semantic/marker/partial drift, performs authenticated isolated restore, and proves fresh install plus second update.
- [x] **Step 4: Extend only the approved root script.** It must print `SAAS_206_INTELLIGENCE_FOCUS_MIGRATION_OK=1` while retaining every earlier marker and `POSTGRES_OPS_INTEGRATION_OK=1`.
- [x] **Step 5: Run focused migration gates.**

```bash
cd server
npm run generate
npm run schema:postgres:render
npm run schema:postgres:check
DATABASE_URL=file:./test.db npx vitest run \
  tests/intelligence-focus-migration.test.ts \
  tests/schema-render.test.ts \
  tests/postgres-ops-scripts.test.ts \
  tests/sqlite-matter-upgrade.test.ts
cd ..
bash scripts/test-postgres-ops-integration.sh
```

## Task 3: Implement IntelligenceItem commands and current-scope reads

**Files:**
- Create: `server/src/intelligenceFocus/model.ts`
- Create: `server/src/intelligenceFocus/service.ts`
- Create: `server/tests/intelligence-model.test.ts`
- Create: `server/tests/intelligence-service.test.ts`

- [x] **Step 1: Write RED behavior tests.** Prove default `reported`, source/time/confidence/target preservation, strict source linkage, tenant/customer/matter/person/relation closure, current database-role reload, EffectiveResourceScope, viewer denial, CAS conflict, archive/restore, idempotent replay reauthorization and body-free audit/receipt.
- [x] **Step 2: Prove rumor/inference cannot become Evidence.** Snapshot Evidence rows before and after every command and replay; assertion updates remain the same IntelligenceItem row/type. A machine-facing module cannot import the formal writer.
- [x] **Step 3: Implement minimal canonicalization and service commands.** Lock actor and parent rows inside the command transaction; validate Interaction/Evidence reference version and authorization; persist canonical target JSON; emit audit metadata containing only IDs, assertion/source kinds, confidence, times, changed field names and version.
- [x] **Step 4: Implement paginated list and direct-ID reads.** Both reload current role/resolver scope; archived rows are excluded by default; projected structured references are reparsed strictly and corrupted storage fails closed.
- [x] **Step 5: Run focused GREEN tests.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/intelligence-model.test.ts \
  tests/intelligence-service.test.ts \
  tests/resource-scope.test.ts
```

## Task 4: Implement explicit StakeholderFocus commands without primary-D coupling

**Files:**
- Modify: `server/src/intelligenceFocus/model.ts`
- Modify: `server/src/intelligenceFocus/service.ts`
- Create: `server/tests/stakeholder-focus-service.test.ts`
- Modify: `server/tests/g64111-dependency-boundary.test.ts`

- [x] **Step 1: Write RED focus tests.** Require one active focus per Matter, active Person + MatterParticipant closure, desired change, rationale, evidence gap or basis, finite future validity, server-owned confirmer, CAS replacement/retirement and current-scope replay authorization.
- [x] **Step 2: Prove human confirmation and source authorization.** Basis Intelligence/Interaction/Evidence rows must be exact tenant/customer/matter scoped and currently readable. Candidate/Agent/AI code cannot import the writer; no score or methodology value creates focus.
- [x] **Step 3: Prove primary-D independence behaviorally.** Create a focus, change `Opportunity.primaryDPersonId` to another person and to null, then show list/detail/commands and persisted focus remain identical. Focus writes must leave primary D and methodology role/value row counts/versions unchanged.
- [x] **Step 4: Implement minimal serializable SET/RETIRE commands.** Use `activeMatterKey` plus expected current ID/version for concurrency; caller-supplied confirmer is impossible; only ID/status/version metadata enters receipt/audit.
- [x] **Step 5: Run focused GREEN/security suites.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/stakeholder-focus-service.test.ts \
  tests/g64111-dependency-boundary.test.ts \
  tests/sensitive-aggregate-boundary.test.ts
```

## Task 5: Expose dedicated commands/reads and cut over the authority inventory

**Files:**
- Create: `server/src/intelligenceFocus/routes.ts`
- Modify: `server/src/app.ts`
- Create: `server/tests/intelligence-focus-routes.test.ts`
- Modify: `server/tests/effective-scope-routes.test.ts`
- Modify: `server/tests/capability-route-contract.test.ts`
- Modify: `packages/domain-contracts/src/authority.ts`
- Modify: `packages/domain-contracts/tests/authority.test.ts`
- Modify at governance close only: `docs/架构-双版本关系与变更治理v1.md`

- [x] **Step 1: Write RED route tests.** Cover valid Idempotency-Key, strict body/query/params, `sales.workspace`, viewer preflight before CommandRun/Audit, current-role downgrade, cross-tenant/cross-customer/cross-matter/direct-ID hiding, cursor stability, replay after scope revocation and safe errors.
- [x] **Step 2: Register exact endpoints.** Use `/api/commands/intelligence-item`, `/api/intelligence-items`, `/api/intelligence-items/:id`, `/api/commands/stakeholder-focus`, `/api/stakeholder-focuses` and `/api/stakeholder-focuses/:id`; no legacy Action or generic mutate fallback.
- [x] **Step 3: Update the executable authority inventory.** `stakeholder.focus.currentAuthority` becomes `core_path: StakeholderFocus`; classify contract/service/routes/migration readers and writers; leave only `SAAS-208 relationship-map projection` planned. Preserve the explicit forbidden primary-D/score/methodology bindings.
- [x] **Step 4: Prove G64111-disabled parity.** The same commands and reads pass with no active methodology binding and no G64111-specific data.
- [x] **Step 5: Run the focused route/authority matrix.**

```bash
cd packages/domain-contracts
npx vitest run tests/intelligence.test.ts tests/authority.test.ts
cd ../../server
DATABASE_URL=file:./test.db npx vitest run \
  tests/intelligence-focus-routes.test.ts \
  tests/effective-scope-routes.test.ts \
  tests/capability-route-contract.test.ts \
  tests/g64111-dependency-boundary.test.ts
```

## Task 6: Full verification and exact-SHA business delivery

- [x] **Step 1: Refresh copied workspace packages.** Because `packages/domain-contracts` changes, rerun `npm ci --install-links` in both App and Server before cross-package verification.
- [x] **Step 2: Inspect scope.** `git diff --name-only` may include only planned CRM files plus the explicitly approved root integration script. It must contain no App source/Action, package/lock/Vite/dist, navigation, Nginx/Compose/CI, public site or self-cultivation path.
- [x] **Step 3: Run the complete local matrix.**

```bash
cd app && npm ci --install-links && npx tsc --noEmit && npm run test
cd ../server && npm ci --install-links && npm run generate && npm run schema:postgres:render && npm run schema:postgres:check && npx tsc --noEmit && npm run test
cd ../packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm run test
cd ../..
bash scripts/test-postgres-ops-integration.sh
```

- [x] **Step 4: Commit business code only.** Use `feat(crm): implement SAAS-206 intelligence focus`, push the feature branch and wait for all 12 jobs on the exact business SHA. Do not merge or deploy.

## Task 7: Close governance separately

- [x] **Step 1: Only after business exact-SHA CI is green, update this plan, `docs/架构-双版本关系与变更治理v1.md` and `docs/商业版开发待办清单v1.md`.** Mark SAAS-206 `DONE`, move only SAAS-207 to `READY`, record exact test/CI evidence, approved shared-script touch and rollback limits.
- [x] **Step 2: Add `docs/SAAS-206-IntelligenceItem与StakeholderFocus迁移回滚说明.md`.** Record exact marker/schema checks, SQLite backup-only restore, authenticated PostgreSQL restore, expand-only application rollback, retained tables/audit/command history and the prohibition on Evidence/primary-D conversion.
- [x] **Step 3: Commit/push governance separately and require its exact SHA CI 12/12 green.** Do not start SAAS-207 before that gate.
- [x] **Step 4: Report the required atomic-task template.** `SELF-CULTIVATION FILES TOUCHED=NONE`, `PRODUCTION TOUCHED=NO`, `HOMEPAGE CHECK=NOT RUN (no deployment)`, and the next gate names SAAS-207.

## Completion evidence

- Business commit `5f2d0568a6f15216d98a8b0f9013ed1c0dfa2aa3` is pushed and [GitHub Actions 33172038063](https://github.com/ZiZ-LG/jianghu/actions/runs/33172038063) attempt 1 completed successfully with 12/12 jobs on that exact SHA.
- Final local matrix: Domain Contracts 13 files / 126 tests; Server 103 files / 866 tests; App 49 files / 362 tests; G64111 2 files / 32 tests; PDE kernel 3 files / 25 tests. All required typechecks, Prisma generation, deterministic PostgreSQL schema checks and production image build gates passed.
- The local and remote PostgreSQL operations gates both emitted `INTERRUPTED_INTELLIGENCE_FOCUS_AFTER_COMMIT_ADOPTION_OK=1`, semantic/marker/partial fail-closed markers, authenticated restore success, `SAAS_206_INTELLIGENCE_FOCUS_MIGRATION_OK=1`, fresh-install first/second-update success and `POSTGRES_OPS_INTEGRATION_OK=1`.
- Scope remained CRM-only. The only shared/high-conflict file touched was the project-owner-approved `scripts/test-postgres-ops-integration.sh`; no App source/Action/package/lock/Vite/dist, public navigation, Nginx/Compose/CI, self-cultivation, production, Mac mini or `main` change occurred.

## Rollback

- Revert the SAAS-206 application/contract commit to remove the API behavior, but preserve IntelligenceItem/StakeholderFocus tables, rows, `DataMigrationState`, AuditEvent/CommandRun records and versioned migration history. Do not run a destructive down migration or convert intelligence into Evidence during rollback.
- Before a future application rollback, stop new writers and export body-free counts/IDs plus schema/marker state. SQLite restores only from an explicit pre-write backup; PostgreSQL restores only through the authenticated isolated recovery path and requires separate production approval.
- Existing `primaryDPersonId`, G64111 roles/values and methodology data are untouched by implementation and rollback. Never copy focus into primary D or reconstruct focus from primary D.
- A rollback must not change production, Mac mini, public homepage, self-cultivation or the frozen legacy CRM deployment. Production rollout remains a separate owner-approved task.
