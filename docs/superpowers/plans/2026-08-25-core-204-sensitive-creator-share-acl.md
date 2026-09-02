# CORE-204 Sensitive Creator/Share ACL Implementation Plan

> **Task:** CORE-204
> **Branch:** `codex/g4-candidate-review-intelligence`
> **Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
> **Base:** `40b199006dedb455c02c17bf7f9c741f6d519612`
> **Status:** DONE

## Goal

Add the fail-closed sensitive-resource foundation required before SourceArtifact product APIs and ReviewBatch workflows. SourceArtifact, Transcript, private Note and Candidate must intersect current tenant/RBAC/product capability and EffectiveResourceScope with creator/share ACL on every request. New resources are creator-private; creatorless legacy rows are quarantined for current tenant owner/admin handling; `matter_shared` permits reading only with Matter scope plus `source.read_shared`; shared Candidate review additionally requires an active explicit reviewer grant, `candidate.review_shared`, target write scope and a non-viewer actor.

## Non-goals and hard boundaries

- Do not add the SAAS-201 SourceArtifact import/list/mount/re-mount/public sharing API, projection backfill, retention UI or external-source workflow.
- Do not add ReviewBatch, Interaction acceptance, AgentJobDefinition/AgentRun, Team membership, ResourceAccessGrant or any later G4/G5 capability.
- Do not change Action/domain contracts, App code, App package/lock/Vite/dist, Docker Compose, public navigation, generic Nginx, public CI or any self-cultivation path.
- Do not grant commercial editions new permissions or infer manager access from role, name, region or portfolio capability. Existing `source.read_shared` and `candidate.review_shared` keys are consumed but their product allocation is unchanged.
- Do not auto-share legacy rows. An unresolvable creator becomes `owner_admin_only`; known private content stays inaccessible to other owner/admin users unless the row is the explicit quarantine case.
- Do not expose, copy into audit, log or migration output any Note content, Transcript ciphertext/plaintext, Candidate payload/evidence, credential or secret.
- Do not deploy production or merge main.

## Authority and access model

1. Sensitive resource kinds are `source_artifact | transcript | note | candidate`.
2. Resource visibility is `private | matter_shared | owner_admin_only`; the last value is migration/system quarantine only.
3. Access is always `tenant ∩ current actor role/product capability ∩ EffectiveResourceScope/parent closure ∩ sensitive ACL`.
4. Creator read/manage/review still requires current parent scope. Viewer remains read-only and cannot manage or review.
5. `matter_shared` is valid only with a current Matter parent. A reader also needs `source.read_shared`; sharing never expands Customer/Matter scope.
6. Candidate review by a non-creator requires an active tenant-local `reviewer` grant, `candidate.review_shared`, current target scope and formal-write authorization. Read access alone never permits review.
7. Missing/invalid actor, parent, creator, visibility, grant kind or ACL version fails closed. Role downgrade, Matter transfer, visibility change or grant revocation applies on the next request; review decisions recheck in the write transaction.
8. Share, reviewer grant and revocation use `aclVersion` CAS and write content-free AuditEvent metadata in the same transaction.

## Target schema

- Add an ACL-ready `SourceArtifact` foundation with tenant and optional Customer/Matter/Person parents, stable backing kind/id, nullable stable creator, visibility and `aclVersion`. CORE-204 creates no product projection rows.
- Add tenant-scoped `SensitiveResourceGrant` for explicit Candidate reviewer grants, with resource kind/id, grantee, grantor, grant kind, resource ACL version, grant/revoke timestamps and tenant-first indexes.
- Add `createdByUserId`, visibility and `aclVersion` to Transcript and Note while retaining legacy `createdBy` for rollback.
- Add `aclVersion` and ACL query index to Candidate while retaining all CORE-203 authority and compatibility projections.
- Keep fields as portable String/Int/DateTime values; no native enum/json.

## Task 1: Lock the ACL and no-leak behavior with RED tests

**Files:**
- Add: `server/tests/sensitive-resource-acl.test.ts`
- Add: `server/tests/sensitive-acl-routes.test.ts`
- Add: `server/tests/sensitive-aggregate-boundary.test.ts`
- Modify: `server/tests/resource-scope.test.ts`
- Modify: `server/tests/effective-scope-routes.test.ts`
- Modify: `server/tests/candidate-inbox-cutover.test.ts`
- Modify: `server/tests/actions.test.ts`
- Modify: `server/tests/repair.test.ts`
- Modify: `server/tests/person-merge.test.ts`

- [x] Cover creator, ordinary member, manager-shaped member, viewer, tenant owner/admin quarantine, shared reader and explicit reviewer across private/shared/revoked states.
- [x] Prove tenant/scope denial, archived or mismatched parents, cross-tenant grants, unknown visibility/grant kind and `aclVersion < 1` fail closed without loading or returning sensitive bodies.
- [x] Prove role downgrade, Matter transfer and share/grant revocation take effect on the next request, while an in-flight review rechecks inside the transaction.
- [x] Prove Note/Transcript/Candidate producer defaults, rebind, extract, redact, delete, merge and batch review use the same ACL helper.
- [x] Add a production-source inventory proving team/shared aggregate repositories do not query SourceArtifact, Transcript, Note, Candidate or SensitiveResourceGrant bodies.

## Task 2: Add portable schema and versioned migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Add: `server/prisma/postgres/legacy/20260825_pre_core204.prisma`
- Add: `server/prisma/postgres/migrations/20260825000000_expand_sensitive_resource_acl/migration.sql`
- Add: `server/src/sensitiveAcl/migration.ts`
- Add: `server/scripts/migrate-sensitive-acl.ts`
- Add: `server/scripts/postgres-sensitive-acl-schema-state.ts`
- Modify: `server/src/candidates/migration.ts`
- Modify: `server/scripts/postgres-candidate-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify: `scripts/test-postgres-ops-integration.sh`
- Add: `server/tests/sensitive-acl-migration.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`

- [x] Add only expand fields/tables/indexes and preserve old columns/tables; PostgreSQL uses one transactional, lock-bounded, fail-closed DDL migration.
- [x] Implement `--dry-run | --apply | --verify` with marker `CORE-204-sensitive-acl-v1`; report only IDs/counts/reason codes/non-sensitive checksums.
- [x] Map a same-tenant stable legacy `createdBy` to `createdByUserId + private`; quarantine blank/unknown/cross-tenant creators as `owner_admin_only`. Validate Note/Transcript/Candidate parent closure before marker commit.
- [x] Make apply serializable, idempotent and marker-last; verify marker receipt/checksum plus bidirectional row semantics. Missing marker is recoverable; semantic drift fails closed.
- [x] Make Candidate foundation inspectors accept exactly the pre-ACL and post-ACL known shapes while still rejecting arbitrary extra/missing columns or indexes.
- [x] Run report/apply/verify within the SQLite pre-write-backup upgrade and after PostgreSQL `migrate deploy`; failure-inject interruption, rerun, partial schema, marker drift, semantic conflict and authenticated backup/restore.

## Task 3: Centralize access decisions and audited CAS mutations

**Files:**
- Modify: `server/src/resourceScope.ts`
- Add: `server/src/sensitiveAccess.ts`
- Add: `server/src/sensitiveAcl/service.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/sensitive-resource-acl.test.ts`

- [x] Define one strict descriptor and access decision for read/manage/review across all four sensitive kinds.
- [x] Reload current tenant policy, actor role, parent scope and active reviewer grant on every decision; never trust JWT role or cached ACL.
- [x] Implement content-free, Serializable `set visibility`, `grant reviewer` and `revoke reviewer` services with expected `aclVersion`, tenant-local users, creator/quarantine authority and same-transaction AuditEvent.
- [x] Keep `owner_admin_only` unavailable to normal share commands and reject `matter_shared` without a valid current Matter parent.
- [x] Expose reusable Prisma where predicates/batched checks so list routes filter before selecting sensitive body fields where practical.

## Task 4: Cut every existing sensitive path to the helper

**Files:**
- Modify: `server/src/recording.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/mutation/actionScope.ts`
- Modify: `server/src/repair.ts`
- Modify: `server/src/personMerge.ts`
- Modify: `server/src/state.ts`
- Modify: `server/src/curated.ts`
- Modify: `server/src/suggest.ts`
- Modify: `server/src/proposals.ts`
- Modify: `server/src/mutation/compoundCommands.ts`
- Modify: `server/src/candidates/personRelation.ts`
- Modify: `server/src/candidates/reviewItems.ts`
- Modify: `server/src/candidates/migration.ts`
- Modify: `server/src/jobs.ts`
- Modify: corresponding tests from Task 1

- [x] Write explicit creator/private/ACL-version metadata on every Note, Transcript and Candidate producer; system rows without a reliable user are quarantined.
- [x] Enforce manage ACL for Transcript decrypt/extract/rebind/redact/delete and Note update/delete/repair/rebind/person-merge. A shared reader cannot mutate.
- [x] Filter state Notes, Transcript lists, legacy candidate lists and Candidate-only Inbox by the same helper without fallback or response-layer-only filtering.
- [x] Recheck Candidate review ACL inside accept/reject/dismiss/evidence/proposal/person/relation and mixed-batch transactions; preserve all-or-nothing semantics and formal-write scope checks.
- [x] Remove private Note reads from shared CuratedSummary generation and keep team/aggregate inventories on an explicit formal-data whitelist.
- [x] Preserve CORE-203 Candidate authority, DTO order, AI human-review boundary, viewer rejection, audit privacy and legacy compatibility projections.

## Task 5: Verify recovery and close CORE-204

**Files:**
- Add: `docs/CORE-204-敏感资源ACL迁移与回滚说明.md`
- Modify: this plan
- Modify: `docs/商业版开发待办清单v1.md`

- [x] Run focused ACL/migration/recording/state/Candidate/batch/repair/merge tests, then full Server generate/schema check/typecheck/test and PostgreSQL operations integration.
- [x] Run Domain contracts, G64111, PDE kernel and App typecheck/tests. Do not run a local App production build because it writes shared `app/dist/**`; exact-SHA CI retains that isolated gate.
- [x] Run schema diff, migration SQL/static state checks, old-path inventory, `git diff --check`, protected-path check and high-confidence secret scan.
- [x] Assert no Action/domain-contract/App/shared/self-cultivation/production file changed and SourceArtifact has no public product API or backfill.
- [x] Commit business code independently, push and require every exact-head CI job green.
- [x] In a separate governance commit, document migration/apply/verify/rollback, mark CORE-204 DONE and only SAAS-201 READY, then require exact-head CI green before SAAS-201 starts.

## Completion evidence

- Business commit: `4bf28579a0ad265faf05e5a2bdb1bbd32eb27b29`.
- SQLite cumulative-upgrade timeout stabilization: `e67c3373f1a1b2e5dd28dd83235ff806902a3dec`.
- Exact-head remote gate: [GitHub Actions 32856055702](https://github.com/ZiZ-LG/jianghu/actions/runs/32856055702), 12/12 jobs successful.
- Local gate: Server 74 files / 601 tests; Domain 8/87; G64111 2/32; PDE 3/25; App 42/326; all required typechecks, generated PostgreSQL schema check, SQLite upgrade and PostgreSQL operations integration successful.
- Recovery evidence and production procedure: `docs/CORE-204-敏感资源ACL迁移与回滚说明.md`.
- No Action/domain-contract/App/shared/self-cultivation/production file changed; no SourceArtifact product API or backfill was opened.

## Local verification commands

```bash
cd server
npm run generate
npm run schema:postgres:check
npm run typecheck
DATABASE_URL=file:./test.db npx vitest run \
  tests/sensitive-resource-acl.test.ts \
  tests/sensitive-acl-routes.test.ts \
  tests/sensitive-aggregate-boundary.test.ts \
  tests/sensitive-acl-migration.test.ts \
  tests/resource-scope.test.ts \
  tests/effective-scope-routes.test.ts \
  tests/candidate-inbox-cutover.test.ts \
  tests/actions.test.ts \
  tests/repair.test.ts \
  tests/person-merge.test.ts \
  tests/compound-commands.test.ts
npm test

cd ..
bash scripts/test-postgres-ops-integration.sh

cd packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npx tsc --noEmit && npm test
```

## Stop conditions

Stop and request project-owner approval before any Action/domain-contract/App change, product permission allocation change, shared file, public navigation/Nginx/CI change, self-cultivation path, production access, destructive legacy cleanup, owner/admin override of known private content, relaxed tenant/viewer/AI-human-review boundary, or expansion into SAAS-201/CORE-205.
