# CORE-206 Controlled Agent Job and Run Audit Implementation Plan

> **Task:** CORE-206
> **Branch:** `codex/g4-candidate-review-intelligence`
> **Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
> **Base:** `a02b91a4bddf339ad94ca14d757181feb9db8b91`
> **Business commits:** `2a1901c92b3b31ef6e4aaee3fff0dd8b0270b90f`, `d70a6b3e0a683159e457d5d96d0d84ebde84840c`
> **Remote evidence:** [GitHub Actions 32921909448](https://github.com/ZiZ-LG/jianghu/actions/runs/32921909448), exact SHA `d70a6b3e0a683159e457d5d96d0d84ebde84840c`, 12/12 jobs successful
> **Status:** DONE

## Goal

Add the portable, fail-closed control plane for Jianghu CRM's three fixed built-in Agent jobs. A versioned Job Card is code-authoritative and tenant rows may only disable or narrow it. Every authorized execution creates a body-free AgentRun audit with the exact definition, trigger, requested Customer/Matter/SourceArtifact scope, authorization fingerprint, budget, timeout, attempts, model/connector references and output references. No Agent becomes a second truth source: read-only and draft jobs have no formal write capability, and candidate jobs can only finish with a verified ReviewBatch reference that still passes current tenant/scope/sensitive-ACL checks.

## Non-goals and hard boundaries

- Do not implement `post_meeting_extract`, `pre_meeting_brief` or `relationship_radar` business logic. Those belong to SAAS-202, SAAS-205 and SAAS-212.
- Do not package the legacy `EnrichJob` queue as the new Agent authority, rename it, migrate its rows or relax its existing compatibility behavior. It remains a frozen legacy adapter.
- Do not add a chat surface, arbitrary script/tool execution, tenant-authored jobs, custom Agent Builder, general scheduler/event dispatcher, mailbox/calendar crawling, autonomous network access or automatic external messages.
- Do not allow a caller or database row to choose or widen `actionMode`, triggers, scope manifest, source kinds, evidence policy, output kinds, model/connector references, budget, timeout or retries. The fixed server registry is authoritative; tenant state defaults disabled and may only narrow it.
- Do not let any executor receive Prisma/formal mutation APIs. Preparation is side-effect free and time-bounded; a policy-checked commit adapter is invoked only after current authorization, budget and output validation pass.
- Do not write Customer, Matter, Person, Relation, Commitment, Interaction, Evidence, stage, Forecast, key-person state or external messages. Candidate mode may only publish through a future narrow adapter and must finish with a tenant-local ReviewBatch whose Candidate rows and SourceArtifact anchor remain valid.
- Do not store prompts, model responses, Note/Transcript bodies, Candidate evidence, source excerpts, file blobs, credentials, tokens or failure stack traces in JobDefinition, AgentRun, CommandRun or AuditEvent.
- Do not change the Action contract, App code, product permission allocation, App package/lock/Vite/dist, Docker Compose, public navigation, generic Nginx, public CI or any self-cultivation path. Stop and request approval if one becomes unavoidable.
- Do not deploy production, merge main or start SAAS-202 before CORE-206 business and governance exact-SHA CI gates are green.

## Authority and lifecycle contract

1. The code registry contains exactly three built-in keys: `pre_meeting_brief`, `post_meeting_extract` and `relationship_radar`. Each immutable version declares purpose, `manual | event | schedule` triggers, scope manifest, `read_only | draft | candidate`, evidence policy, allowed body-free output reference kinds, model/connector references, budget, timeout, attempts and availability.
2. `AgentJobDefinition` is a tenant-scoped control/audit snapshot of one exact registry version. Missing rows and new versions are disabled by default. A row whose canonical JSON/hash diverges from the registry fails closed; tenant state can disable or reduce limits but never add triggers, source kinds, outputs or authority.
3. Only a current owner/admin may enable or disable a Job version, with expected-version CAS, transport idempotency and body-free AuditEvent. Enabling an unavailable/unregistered production handler is rejected. Disabling is always allowed and takes effect at the next authorization boundary.
4. A manual run request never accepts `actionMode`, handler, model, connector, output kind, budget, timeout or retry parameters. It supplies only an exact Job key/version, Customer/Matter/SourceArtifact anchors and bounded body-free input references.
5. Viewer writes are rejected before CommandRun/AgentRun/AuditEvent side effects. Other callers must pass current database role, `sales.workspace`, EffectiveResourceScope, parent closure and sensitive SourceArtifact ACL before a run row is created; hidden and missing anchors use the same shape.
6. An authorized run uses a hashed idempotency key and request hash. Same canonical replay reauthorizes and returns the existing receipt; changed input conflicts. An active lease returns in-progress; an expired lease may be reclaimed only after definition, role, capability, scope and ACL revalidation.
7. Every attempt rechecks the enabled Job Card and current authorization before preparation. Preparation receives only a bounded context and AbortSignal, never database/formal writers. Timeout, budget exhaustion and retry exhaustion persist stable safe reason codes without raw provider errors.
8. Before committing outputs, the runner rechecks definition version/enabled state, role, capability, EffectiveResourceScope, parent revisions and sensitive ACL generation. Revocation or Job disablement discards prepared output and closes the run without invoking the commit adapter.
9. `read_only` permits only registered derived read-model references; `draft` permits only registered draft/derived references; `candidate` permits only a `review_batch` reference and verifies the batch, SourceArtifact, Candidate attachment and caller's current review scope. Formal entity or external-message output kinds are rejected and audited.
10. AgentRun stores only canonical body-free refs and safe counters. Historical runs remain readable only inside current tenant/resource/sensitive scope; revoked source access hides current detail while retaining minimum internal audit identity.

## Portable data model

Use no native enum, JSON or array fields.

- `AgentJobDefinition`: tenant/job key/version identity, canonical definition JSON/hash, enabled flag, tenant limit JSON, optimistic version, creator/updater IDs and timestamps. Unique by tenant + jobKey + jobVersion, with tenant-first enabled/key indexes.
- `AgentRun`: tenant/definition/job snapshot, action/trigger/status, Customer/Matter/SourceArtifact anchors, actor, hashed idempotency and request identity, attempt/lease/version fields, budget/cost/timeout, authorization fingerprint, canonical body-free input/evidence/output refs, safe model/connector refs, stable failure code, timestamps and tenant-first status/resource indexes.
- `DataMigrationState`: marker `CORE-206-agent-job-run-v1`, written last only after exact schema and semantic verification. Runtime growth does not rewrite the marker receipt.

The versioned PostgreSQL migration is `20260825030000_expand_agent_job_run`. SQLite receives the same portable models through the guarded cumulative upgrader. New tables are expand-only; no Agent definition or run is automatically created by migration.

## Backend API and internal contract

All authenticated routes remain under the existing `sales.workspace` service boundary:

- `GET /api/agent-jobs` — fixed body-free Job Cards plus current tenant enabled/version/availability state; read creates no rows.
- `PUT /api/agent-jobs/:jobKey/control` — owner/admin enable/disable with expected definition version and Idempotency-Key; unavailable versions cannot be enabled.
- `POST /api/agent-jobs/:jobKey/runs` — manual trigger with exact body-free scope/input refs and Idempotency-Key; viewer, disabled, unavailable, out-of-scope or malformed requests fail before execution.
- `GET /api/agent-runs` — bounded cursor pagination filtered by tenant, current resource scope and sensitive ACL; metadata only.
- `GET /api/agent-runs/:id` — same-shape hidden/missing detail with no source body, prompt or model output.

Production starts with no business handler registered in CORE-206, so all three Job Cards remain unavailable/disabled until their owning SAAS task registers a fixed handler. Tests exercise the runner through explicit dependency injection; test handlers cannot be selected by HTTP input or production configuration.

## Task 1: Lock contracts and failure behavior with RED tests

**Files:**
- Add: `packages/domain-contracts/src/agents.ts`
- Add: `packages/domain-contracts/tests/agents.test.ts`
- Add: `server/tests/agent-job-policy.test.ts`
- Add: `server/tests/agent-job-routes.test.ts`
- Add: `server/tests/agent-job-migration.test.ts`
- Modify: schema/static/SQLite/PostgreSQL operation tests

- [x] Prove strict versioned Job Cards accept only the three built-in keys, fixed trigger/action modes, bounded scope/evidence/output references, safe cost/timeout/attempt limits and no body/token fields.
- [x] Prove missing rows default disabled; a DB row cannot widen registry authority; unavailable handlers cannot be enabled or triggered; viewer and out-of-scope callers produce zero AgentRun/CommandRun/AuditEvent side effects.
- [x] Prove Job disablement, role/capability/scope revocation, Matter transfer and sensitive ACL/tombstone changes are effective before every attempt and before output commit.
- [x] Prove timeout aborts without commit, budget overrun aborts without commit, only declared retryable failures retry, max attempts is bounded, stale leases reauthorize and concurrent/idempotent replays do not duplicate runs.
- [x] Prove read_only/draft reject formal/candidate/external outputs, candidate rejects direct Candidate/formal refs and accepts only a currently valid ReviewBatch trace.
- [x] Prove list/detail are tenant/resource/ACL filtered, cursor bounded, body-free and hidden/missing same-shape.

## Task 2: Publish the shared Agent contract and fixed server registry

**Files:**
- Add: `packages/domain-contracts/src/agents.ts`
- Modify: `packages/domain-contracts/src/index.ts`
- Add: `packages/domain-contracts/tests/agents.test.ts`
- Add: `server/src/agents/registry.ts`
- Add/modify: focused tests from Task 1

- [x] Define strict shared Job Card, scope manifest, evidence policy, input/evidence/output reference and AgentRun view schemas without changing Action.
- [x] Register exactly the three approved Job keys with immutable version/hash, triggers, modes, safe output kinds, default-disabled availability and bounded execution policy.
- [x] Canonicalize and hash only body-free contract metadata; reject unknown keys/fields, secret-looking references, oversized identities and non-integer/unsafe budget/time values.
- [x] Make database snapshots provably equal to or narrower than the registry; never use DB JSON as executable policy.

## Task 3: Add portable schema, versioned migration and recovery gates

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Add: `server/prisma/postgres/legacy/20260825_pre_core206.prisma`
- Add: `server/prisma/postgres/migrations/20260825030000_expand_agent_job_run/migration.sql`
- Add: `server/src/agents/migration.ts`
- Add: `server/scripts/migrate-agent-jobs.ts`
- Add: `server/scripts/postgres-agent-job-schema-state.ts`
- Modify: predecessor schema inspectors, `server/scripts/upgrade-sqlite-schema.ts`, `server/scripts/deploy-postgres-migrations.sh`, `server/package.json`, `scripts/test-postgres-ops-integration.sh`
- Modify: migration/schema tests from Task 1

- [x] Add only portable expand tables/indexes and retain EnrichJob, Candidate, ReviewBatch, SourceArtifact, CommandRun, AuditEvent and every formal table unchanged.
- [x] Make predecessor inspectors accept only the exact registered CORE-206 successor shape and reject partial/unknown drift before any DDL/data write.
- [x] Implement `--dry-run | --apply | --verify` with tenant-first enumeration, strict canonical row validation, marker-last contract receipt and no body reads/logging.
- [x] Cover SQLite pre-DDL report-before-backup/db-push and PostgreSQL migrate-deploy interruption, committed-DDL adoption, partial schema, semantic/hash conflict, marker drift, authenticated restore and fresh install/update.

## Task 4: Implement the control repository, policy runner and routes

**Files:**
- Add: `server/src/agents/model.ts`
- Add: `server/src/agents/repository.ts`
- Add: `server/src/agents/authorization.ts`
- Add: `server/src/agents/runner.ts`
- Add: `server/src/agents/routes.ts`
- Modify: `server/src/app.ts`
- Add/modify: focused tests from Task 1

- [x] List cards without writes; create/update tenant control snapshots only through current owner/admin CAS, idempotency and body-free audit.
- [x] Resolve current role, deployment capability, EffectiveResourceScope, Customer/Matter revisions and SourceArtifact sensitive ACL in one authorization snapshot at trigger, every attempt, replay and pre-commit.
- [x] Create/reclaim exactly one tenant/actor/idempotency AgentRun with lease/CAS; store hashed request identity and safe metadata only.
- [x] Execute injected preparation with AbortSignal, timeout, integer budget and bounded retry policy; never expose Prisma or formal mutation functions to preparation.
- [x] Validate final action-mode outputs against registry, reauthorize, then invoke only the injected mode-specific commit adapter. Persist final body-free refs/cost/status and AuditEvent atomically where database writes are involved.
- [x] Filter run history by current scope/ACL and preserve same-shape hidden/missing behavior.

## Task 5: Verify recovery and close CORE-206

**Files:**
- Add: `docs/CORE-206-AgentJob与AgentRun迁移回滚说明.md`
- Modify: this plan
- Modify: `docs/商业版开发待办清单v1.md`

- [x] Refresh `file:` package copies with `npm ci --install-links` in App and Server after domain-contract changes.
- [x] Run Domain contract, focused Agent/policy/route/migration tests, then Server generate/schema check/typecheck/full tests and PostgreSQL operations integration.
- [x] Run G64111, PDE kernel and App typecheck/tests. Do not run a local App production build because it writes shared `app/dist/**`; exact-SHA CI retains that isolated gate.
- [x] Run static registry/route/legacy-queue/formal-writer inventory, `git diff --check`, protected-path check, high-confidence secret scan and inline security/API/performance/migration/red-team review.
- [x] Assert no Action/App/product-allocation/shared/self-cultivation/production change, no arbitrary handler/network path, no body-bearing Agent table and no Agent formal write.
- [x] Commit business code independently, push and require every exact-head CI job green.
- [x] In a separate governance commit, document migration/apply/verify/rollback, mark CORE-206 DONE and only SAAS-202 READY, then require exact-head CI green before SAAS-202 starts.

## Local verification commands

```bash
cd packages/domain-contracts
npm run typecheck
npm test

cd ../../server
npm ci --install-links
npm run generate
npm run schema:postgres:check
npm run typecheck
DATABASE_URL=file:./test.db npx vitest run \
  tests/agent-job-policy.test.ts \
  tests/agent-job-routes.test.ts \
  tests/agent-job-migration.test.ts \
  tests/schema-render.test.ts \
  tests/postgres-ops-scripts.test.ts \
  tests/sqlite-matter-upgrade.test.ts
npm test

cd ..
bash scripts/test-postgres-ops-integration.sh

cd packages/g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npm ci --install-links && npx tsc --noEmit && npm test
```

## Stop conditions

Stop and request project-owner approval before any Action/App/product permission allocation, App package/lock/Vite/dist, Docker Compose, public navigation/Nginx/CI, self-cultivation path, production access, arbitrary/tenant-authored handler, autonomous network or external-message capability, formal object writer, relaxed tenant/viewer/scope/ACL rule, body/prompt/model-output persistence, unbounded budget/retry/timeout, destructive migration or expansion into SAAS-202+ business behavior.
