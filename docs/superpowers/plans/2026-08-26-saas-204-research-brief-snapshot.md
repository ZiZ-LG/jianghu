# SAAS-204 ResearchBriefSnapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Add an immutable, tenant-scoped and creator-private ResearchBriefSnapshot authority that preserves an exact subject match, source-level provenance/freshness, bounded sections, unknowns and partial failures without changing formal CRM state.

**Architecture:** Store one encrypted, canonically validated snapshot payload behind a portable metadata row. A narrow commit service receives prepared research from the future `pre_meeting_brief` handler, reauthorizes current tenant/role/capability/effective Customer-Matter scope and sensitive SourceArtifact ACL, then writes only the immutable snapshot plus body-free audit metadata. List/detail projection rechecks current scope and referenced sensitive sources; SAAS-204 does not register the Agent handler or build the UI, which remain SAAS-205.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod, AES-256-GCM through the existing server encryption authority, SQLite development migration, generated PostgreSQL schema and versioned `migrate deploy` migration, Vitest.

## Global Constraints

- **Task:** `SAAS-204`; **branch:** `codex/g4-candidate-review-intelligence`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`; **base:** `e1850e7e289110890068f826a48d950206e71453`; **status:** `IN_PROGRESS` after the start-governance commit.
- Keep `SAAS-204` as the only `IN_PROGRESS` item. Do not start SAAS-205 before the SAAS-204 business and governance exact-SHA CI gates are both 12/12 green.
- Stop after the start-governance CI gate and request project-owner approval before modifying the shared root file `scripts/test-postgres-ops-integration.sh`. The four-file approval granted for SAAS-203 is not reusable for SAAS-204.
- Every read/write is tenant-scoped. Current database role, `sales.workspace`, EffectiveResourceScope, active Customer/Matter closure and current creator-private/source ACL are rechecked on commit, replay, list and detail.
- Viewer cannot create or refresh a snapshot. A previously created private snapshot may be read after a viewer downgrade only when the viewer remains its creator and still passes Customer ownership/effective-scope and every sensitive-source check.
- AI/external output is a reproducible read-model snapshot, never a formal Customer/Matter/Person/Relation/Evidence/Commitment/Interaction, stage, Forecast or key-person write. Subject selection inside a snapshot does not update `Account.unifiedCreditCode` or establish a second formal customer identity authority.
- A matched subject requires an exact current CRM Customer anchor plus a stable external anchor when an external source is used. Ambiguous/unmatched subjects persist only candidates, failures and unknowns; they cannot contain conclusive sections.
- Every section has at least one source reference. Every source carries provider/kind, stable reference, fingerprint, subject anchor, observed/retrieved/fresh-until timestamps and `fresh | stale | failed | unavailable` state. Raw provider errors, credentials, prompts and unbounded responses never cross the preparation boundary.
- Encrypt the snapshot payload at rest. Persist only bounded metadata, hashes, counts and timestamps in plaintext. Audit and AgentRun references remain body-free.
- Reuse human-edited CuratedSummary only as an attributable source. Legacy unedited AI CuratedSummary is a labeled cache input, never a truth authority, and SAAS-204 does not change its creation/display behavior.
- Use no Prisma native enum, Json or array. SQLite and PostgreSQL schema/migration/marker/restore/fresh-install paths must agree. Production remains `migrate deploy`; never use `db push` in production.
- Do not modify App code, `app/src/store.ts`, App package/lock/Vite/dist, public/product navigation, Docker Compose, Nginx, public CI, any self-cultivation path, production, Mac mini, main or the frozen legacy CRM.

---

## File map

- `packages/domain-contracts/src/researchBrief.ts` — strict shared payload, metadata, list/detail and source/section contracts.
- `server/src/researchBriefs/model.ts` — canonicalization, bounded semantic validation, status/freshness derivation and payload hashing.
- `server/src/researchBriefs/service.ts` — tenant/scope/source reauthorization, encrypted immutable commit/replay and safe projection.
- `server/src/researchBriefs/routes.ts` — creator-private metadata list and authorized detail reads; no generation endpoint.
- `server/src/researchBriefs/migration.ts` — exact schema report/apply/verify and marker-last migration contract.
- `server/prisma/schema.prisma` plus PostgreSQL legacy/current/migration files — one portable expand-only snapshot model.
- `server/scripts/*research-brief*`, SQLite upgrader and PostgreSQL deploy script — operational report/apply/verify integration.
- `scripts/test-postgres-ops-integration.sh` — shared root failure-injection, recovery and fresh-install proof; owner approval is required before editing.

## Fixed shared contract

```ts
export type ResearchBriefSubjectStatus = 'matched' | 'ambiguous' | 'unmatched';
export type ResearchBriefSnapshotStatus = 'ready' | 'partial' | 'blocked';
export type ResearchBriefSourceStatus = 'fresh' | 'stale' | 'failed' | 'unavailable';

export interface ResearchBriefSubject {
  status: ResearchBriefSubjectStatus;
  query: string;
  crmCustomerId: string;
  selected: null | {
    legalName: string;
    anchorKind: 'unified_credit_code' | 'provider_subject_id';
    anchorValue: string;
    provider: string;
  };
  candidates: Array<{
    legalName: string;
    anchorKind: 'unified_credit_code' | 'provider_subject_id';
    anchorValue: string;
    provider: string;
  }>;
}

export interface ResearchBriefSource {
  id: string;
  kind: 'crm_fact' | 'curated_human' | 'curated_ai_cache' | 'source_artifact' | 'qcc' | 'external_reference';
  refId: string;
  version: number;
  fingerprint: string;
  provider: string;
  label: string;
  url: string | null;
  subjectAnchor: string;
  observedAt: string | null;
  retrievedAt: string;
  freshUntil: string | null;
  status: ResearchBriefSourceStatus;
  failureCode: string | null;
}

export interface ResearchBriefSection {
  key: 'company_overview' | 'recent_changes' | 'existing_cooperation' | 'active_matters' | 'stakeholders' | 'open_hypotheses' | 'last_commitments' | 'questions_to_verify';
  title: string;
  content: string;
  sourceIds: string[];
  asOf: string;
}

export interface ResearchBriefPreparedPayload {
  subject: ResearchBriefSubject;
  sources: ResearchBriefSource[];
  sections: ResearchBriefSection[];
  unknowns: Array<{ key: string; question: string; reasonCode: string; sourceIds: string[] }>;
  failures: Array<{ sourceId: string; code: string; retryable: boolean }>;
  generator: { version: 'saas-204.v1'; modelRef: string; connectorRefs: string[] };
}
```

Bounds are fixed: at most 5 subject candidates, 20 sources, 8 sections, 20 unknowns, 20 failures and 50,000 UTF-8 payload characters after canonical serialization. IDs/keys/provider/model/connector references are 1–200 visible non-secret characters; labels/titles/questions are 1–300 characters; section content is 1–4,000 characters; URL is absent or an `https:` URL no longer than 2,000 characters. Unknown keys are rejected at every level.

## Task 1: Lock the strict domain contract with RED tests

**Files:**
- Create: `packages/domain-contracts/src/researchBrief.ts`
- Create: `packages/domain-contracts/tests/researchBrief.test.ts`
- Modify: `packages/domain-contracts/src/index.ts`

**Interfaces:**
- Consumes: existing UTC instant, safe identifier and Agent output-reference conventions from `packages/domain-contracts`.
- Produces: `ResearchBriefPreparedPayloadSchema`, `ResearchBriefSnapshotMetadataSchema`, `ResearchBriefSnapshotDetailSchema`, list/detail response schemas and inferred TypeScript types.

- [x] **Step 1: Write strict schema tests before the implementation.** Cover one matched/ready payload, one matched/partial payload and one ambiguous/blocked payload; reject an ambiguous payload containing sections, matched external sources without a stable selected anchor, source-less sections, duplicate source IDs, dangling source IDs, failed sources without a safe failure code, a fresh source without `retrievedAt`, non-HTTPS citation URLs, future-inverted timestamps, count/size overflow and the fields `contentEnc`, `token`, `secret`, `prompt`, `rawResponse` or unknown keys.
- [x] **Step 2: Run the RED contract test.**

```bash
cd packages/domain-contracts
npx vitest run tests/researchBrief.test.ts
```

Expected result: the suite fails because `researchBrief.ts` and its exports do not exist.

- [x] **Step 3: Implement the exact schemas and cross-field refinements.** Canonical output must require `status=blocked` when the subject is not matched, derive `ready | partial | blocked` from the validated payload in Server code, and never accept caller-supplied counts or hashes.
- [x] **Step 4: Run the focused contract suite and package gates.**

```bash
cd packages/domain-contracts
npx vitest run tests/researchBrief.test.ts
npm run typecheck
npm test
```

Expected result: all commands pass and existing Agent contracts still accept only the existing body-free `research_brief` output reference.

## Task 2: Add one portable encrypted snapshot model and guarded dual-database migration

**Owner approval gate:** Do not execute this task until the project owner approves `scripts/test-postgres-ops-integration.sh` for SAAS-204.

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260826_pre_saas204.prisma`
- Create: `server/prisma/postgres/migrations/20260826000000_expand_research_brief_snapshot/migration.sql`
- Create: `server/src/researchBriefs/migration.ts`
- Create: `server/scripts/migrate-research-briefs.ts`
- Create: `server/scripts/postgres-research-brief-schema-state.ts`
- Modify: `server/src/agents/migration.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify after owner approval: `scripts/test-postgres-ops-integration.sh`
- Create: `server/tests/research-brief-migration.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`

**Interfaces:**
- Consumes: exact CORE-206 predecessor schema and `DataMigrationState` marker discipline.
- Produces: Prisma model `ResearchBriefSnapshot`, migration marker `SAAS-204-research-brief-snapshot-v1`, report/apply/verify functions and exact SQLite/PostgreSQL schema-state inspectors.

- [x] **Step 1: Write RED migration/schema tests.** Assert the new table is absent in `20260826_pre_saas204.prisma`, present with the exact fields/indexes in current schemas, created expand-only by migration `20260826000000_expand_research_brief_snapshot`, and never backfills or mutates Account, Opportunity, CuratedSummary, SourceArtifact, Candidate, ReviewBatch, AgentRun or formal tables.
- [x] **Step 2: Add the portable model exactly as follows.**

```prisma
model ResearchBriefSnapshot {
  id                String   @id
  tenantId          String
  tenant            Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customerId        String
  matterId          String?
  createdByUserId   String
  generationKey     String
  status            String
  subjectStatus     String
  payloadEnc        String
  payloadFingerprint String
  sourceSetHash     String
  sourceCount       Int
  sectionCount      Int
  unknownCount      Int
  failureCount      Int
  version           Int      @default(1)
  basedOnAt         DateTime?
  freshUntil        DateTime?
  generatedAt       DateTime
  createdAt         DateTime @default(now())

  @@unique([tenantId, createdByUserId, generationKey])
  @@index([tenantId, createdByUserId, customerId, generatedAt])
  @@index([tenantId, createdByUserId, matterId, generatedAt])
}
```

Also add `researchBriefSnapshots ResearchBriefSnapshot[]` to `Tenant`. Do not add a relation to Account/Opportunity/User that could cascade-delete a historical snapshot; parent identity is revalidated explicitly by tenant-scoped service queries.

- [x] **Step 3: Implement marker-last report/apply/verify.** The marker details contain schema contract version, canonical schema fingerprint and zero-backfill counts. `--dry-run` performs no DDL/data write; `--apply` accepts only the exact predecessor or exact successor shape; `--verify` rejects unknown columns/indexes, partial tables, invalid row counts/status/count ranges and marker checksum drift.
- [x] **Step 4: Integrate guarded SQLite and PostgreSQL operations.** SQLite must inspect/report before backup and `db push`; PostgreSQL must run versioned `migrate deploy`, report/apply/verify, adopt committed DDL after an interrupted marker step, reject partial/semantic/marker drift, exercise authenticated restore, and prove fresh install plus second update. The root integration test must print `SAAS_204_RESEARCH_BRIEF_MIGRATION_OK=1` and retain `POSTGRES_OPS_INTEGRATION_OK=1`.
- [x] **Step 5: Run the focused migration gates.**

```bash
cd server
npm run generate
npm run schema:postgres:render
npm run schema:postgres:check
DATABASE_URL=file:./test.db npx vitest run \
  tests/research-brief-migration.test.ts \
  tests/schema-render.test.ts \
  tests/postgres-ops-scripts.test.ts \
  tests/sqlite-matter-upgrade.test.ts
cd ..
bash scripts/test-postgres-ops-integration.sh
```

Expected result: focused tests pass; SQLite and PostgreSQL markers agree; the PostgreSQL script prints the SAAS-204 and global success markers; no production database is contacted.

## Task 3: Implement canonical semantics, encrypted commit/replay and formal-write-zero

**Files:**
- Create: `server/src/researchBriefs/model.ts`
- Create: `server/src/researchBriefs/service.ts`
- Create: `server/tests/research-brief-model.test.ts`
- Create: `server/tests/research-brief-service.test.ts`
- Modify: `server/tests/sensitive-aggregate-boundary.test.ts`

**Interfaces:**
- Consumes: `ResearchBriefPreparedPayload`, current capability policy, `resolveEffectiveResourceScope`, `authorizeSensitiveResource`, existing `enc`/`dec`, Prisma `ResearchBriefSnapshot` and body-free AuditEvent.
- Produces:

```ts
export interface CommitResearchBriefInput {
  tenantId: string;
  actorId: string;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
  customerId: string;
  matterId: string | null;
  generationKey: string;
  generatedAt: Date;
  payload: ResearchBriefPreparedPayload;
}

export async function commitResearchBriefSnapshot(
  db: DbClient,
  input: CommitResearchBriefInput,
  policy: CapabilityPolicy,
): Promise<{ id: string; version: number; replayed: boolean }>;
```

- [x] **Step 1: Write RED semantic tests.** Prove deterministic canonical serialization/hash/status/count/freshness derivation, timestamp ordering, duplicate/dangling source rejection, stable subject anchor matching and maximum payload bytes. Prove ambiguous/unmatched payloads cannot contain conclusive sections.
- [x] **Step 2: Write RED service tests.** Cover current role reload, viewer denial before side effects, tenant/customer/matter mismatch, archived parents, revoked capability/scope, source-artifact mount/creator/ACL/retention/fingerprint drift, human CuratedSummary attribution, legacy AI cache labeling, same-key replay, changed-payload conflict, concurrent duplicate commit and transaction rollback.
- [x] **Step 3: Implement canonical model helpers.** Export `canonicalResearchBriefPayload`, `hashResearchBriefPayload`, `deriveResearchBriefMetadata` and `validateResearchBriefPreparedPayload`. Derive status/counts/basedOnAt/freshUntil/sourceSetHash server-side; never trust caller metadata.
- [x] **Step 4: Implement the serializable commit.** Preparation remains outside the transaction. Inside one serializable transaction, reload actor/role, policy inputs, active Customer/Matter and every referenced local source; enforce creator-private ownership; encrypt canonical payload; insert one immutable row; write AuditEvent containing only snapshot ID, counts and hashes. No update/delete method and no formal Prisma model writer may be passed into this module.
- [x] **Step 5: Prove plaintext and formal-state absence.** Snapshot Account/Matter/Person/Edge/Evidence/PlanAction/Interaction/Candidate/ReviewBatch/CuratedSummary rows and versions before/after commit; assert equality. Query the snapshot row/AuditEvent/CommandRun/AgentRun fixtures and assert source text, section text, URLs, provider errors and credentials do not appear outside `payloadEnc`.
- [x] **Step 6: Run focused model/service/security suites.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/research-brief-model.test.ts \
  tests/research-brief-service.test.ts \
  tests/sensitive-aggregate-boundary.test.ts
```

Expected result: all focused tests pass with zero formal writes and no plaintext leakage.

## Task 4: Add creator-private list/detail projection with dynamic source reauthorization

**Files:**
- Create: `server/src/researchBriefs/routes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/helpers/testApp.ts`
- Create: `server/tests/research-brief-routes.test.ts`
- Modify: `server/tests/agent-job-routes.test.ts`

**Interfaces:**
- Consumes: `commitResearchBriefSnapshot`, encrypted snapshot payload and current scope/source authorization helpers.
- Produces: `GET /api/research-briefs?customerId=<id>&matterId=<optional>` and `GET /api/research-briefs/:id`; no create/refresh/select/share route.

- [x] **Step 1: Write RED route tests.** Cover unauthenticated, cross-tenant, non-creator, viewer-owned vs viewer-non-owned Customer, matter-parent mismatch, archived/reassigned parent, revoked product capability, cursor/limit bounds, hidden/missing same-shape, encrypted-at-rest detail, source ACL/retention/fingerprint drift and stale formal/CuratedSummary versions.
- [x] **Step 2: Implement metadata list projection.** Return only ID, Customer/Matter IDs, status/subjectStatus, counts, version and timestamps. Filter by tenant + creator before loading rows, intersect current EffectiveResourceScope, use a deterministic `(generatedAt,id)` cursor, cap page size at 50 and never decrypt payload for list.
- [x] **Step 3: Implement detail projection.** Decrypt only after creator/current-scope authorization. Revalidate every local source. If a sensitive source is now hidden/tombstoned, omit dependent section content and return a bounded `unavailable` source plus an unknown/failure marker; if formal or human-curated source versions changed, preserve the historical section but mark it stale. Never return ciphertext, raw failure data, prompt/model response or source body.
- [x] **Step 4: Preserve the Agent boundary.** `pre_meeting_brief@core-206.v1` remains unavailable and has no production handler in SAAS-204. Add a static assertion that the new routes do not call LLM/QCC/Feishu, do not create AgentRun and do not expose a mutation endpoint. The existing `research_brief` output kind remains body-free `{kind,id,version}`.
- [x] **Step 5: Run focused route and Agent regression suites.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/research-brief-routes.test.ts \
  tests/agent-job-routes.test.ts \
  tests/effective-scope-state.test.ts \
  tests/sensitive-acl-routes.test.ts
```

Expected result: list/detail are creator/tenant/scope/ACL safe; viewer writes remain impossible; the Job Card is still unavailable.

## Task 5: Full verification, separated commits, exact-SHA CI and governance close

**Files:**
- Create after implementation: `docs/SAAS-204-ResearchBriefSnapshot迁移与回滚说明.md`
- Modify after business exact-SHA CI succeeds: this plan
- Modify after business exact-SHA CI succeeds: `docs/商业版开发待办清单v1.md`

**Interfaces:**
- Consumes: all Task 1–4 outputs and repository CI/release gates.
- Produces: independently reviewable migration/operations commit, business commit, governance close commit, exact-SHA CI evidence and only SAAS-205 READY.

- [x] **Step 1: Refresh copied local package dependencies.**

```bash
cd server && npm ci --install-links
cd ../app && npm ci --install-links
```

Expected result: both installs succeed and package/lock files remain unchanged.

- [x] **Step 2: Run the complete local matrix.**

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd ../../server && npm run generate && npm run schema:postgres:check && npm run typecheck && npm test
cd ../app && npx tsc --noEmit && npm test
cd ../packages/g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../.. && bash scripts/test-postgres-ops-integration.sh
```

Expected result: all suites pass. Do not run local App production build because it writes shared `app/dist/**`; exact-SHA CI owns the isolated build gate.

- [x] **Step 3: Run static gates.** Confirm schema/migration parity, only one `IN_PROGRESS`, no App/Action/formal-writer/SAAS-205 handler/public/shared-unapproved/self-cultivation path, no plaintext/secret/raw-error strings in stored/audited outputs, `git diff --check`, and a clean generated PostgreSQL schema check.
- [x] **Step 4: Commit operations/migration separately from business code.** Stage only schema/migration/operational files including the approved root integration script and use `feat(crm): add SAAS-204 research brief storage`. Stage contracts/model/service/routes/tests separately and use `feat(crm): implement SAAS-204 research brief snapshots`. Do not include governance docs in either commit.
- [x] **Step 5: Push and require exact business-head CI.** Every GitHub Actions job must be successful on the exact final business SHA. A failure is fixed inside SAAS-204, locally reverified, committed and pushed before close.
- [x] **Step 6: Close governance independently.** Record actual commits/test counts/migration markers/rollback evidence, mark SAAS-204 DONE and only SAAS-205 READY, commit `docs(crm): close SAAS-204 research brief`, push and require its exact SHA CI 12/12 green before SAAS-205 starts.

## Rollback and stop conditions

- Runtime rollback disables future SAAS-205 handler availability and reverts SAAS-204 application reads/commit adapter. Preserve `ResearchBriefSnapshot`, migration marker, AuditEvent and migration history; never drop the table or reverse-write encrypted payload into CuratedSummary/Account.
- SQLite recovery uses an explicit pre-write backup. PostgreSQL recovery uses authenticated isolated restore and a separately approved production operation; migration rollback is never `db push` or destructive down SQL.
- Stop and ask the project owner before the shared root ops script; any App/Action/package/lock/Vite/dist, public navigation, Docker Compose, Nginx, public CI or self-cultivation change; any second formal subject/customer authority; any automatic formal write; any snapshot sharing that can outlive source ACL; any unencrypted payload; any provider/network/Agent handler implementation; any destructive migration, production/Mac mini deployment or main merge.

## Self-review record

- Spec coverage: subject match, multi-candidate block, source attribution, freshness, partial failure, unknowns, encrypted immutable snapshot, tenant/viewer/scope/ACL, dual-database migration, CuratedSummary compatibility and SAAS-205 separation each map to an explicit task and test.
- Placeholder scan: the plan contains no deferred implementation marker; contracts, bounds, signatures, routes, migration identity, commands and expected outcomes are explicit.
- Type consistency: `ResearchBriefPreparedPayload` is the only prepared payload; Server derives metadata; `commitResearchBriefSnapshot` returns the body-free `{id,version,replayed}` authority consumed by the future Agent output reference.
