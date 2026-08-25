# CORE-203 Unified Candidate Inbox Cutover Implementation Plan

> **Task:** CORE-203
> **Branch:** `codex/g4-candidate-review-intelligence`
> **Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
> **Base:** `13ad1465d60b5effaa9327ee86cc90608f154aba`
> **Status:** IN_PROGRESS

## Goal

Make `Candidate` the only online authority for all five review-item kinds without changing the public App/API contract. Backfill and verify all legacy rows before the Inbox cutover, route ChangeProposal, Reminder and pending Evidence writes through one tenant-scoped helper, read `/api/inbox` only from Candidate, and retain the five legacy tables as helper-owned compatibility projections for rollback.

## Non-goals and hard boundaries

- No Prisma schema, PostgreSQL DDL migration, Action/domain-contract or App change is required.
- Do not add ReviewBatch, SourceArtifact, creator-share ACL, sensitive-note handling or any CORE-204/205 capability.
- Do not change `app/package.json`, `app/package-lock.json`, App Vite config/dist, Docker Compose, public navigation, generic Nginx, public CI or any self-cultivation path.
- Do not access or deploy production and do not merge main.
- Pending machine Evidence remains non-formal. Its EvidenceEvent row is only a compatibility projection; approval changes that same row to formal `approved` in the Candidate CAS transaction, while rejection keeps it non-formal.
- Never delete the five legacy tables, their rows, Candidate history, audit rows or migration markers during this cutover.

## Authority and rollback model

1. `Candidate` owns identity, pending/terminal status, version CAS, provenance and review payload.
2. `PersonSuggestion`, `RelSuggestion`, `ChangeProposal`, `Reminder` and pending-review `EvidenceEvent` are compatibility projections. Production code may mutate them only inside Candidate helpers and in the same transaction as Candidate.
3. Existing specific list endpoints may continue reading compatibility projections during the rollback window; `/api/inbox` must not read or fall back to them.
4. `CORE-203-candidate-backfill-v1` in `DataMigrationState` records a verified, idempotent five-source backfill. Candidate-only Inbox fails closed when the marker is absent.
5. Application rollback may restore the legacy consumer code because projections are transactionally current. Database expansion, backfilled Candidate rows and migration history remain in place.

## Task 1: Lock behavior with failing tests

**Files:**
- Add: `server/tests/candidate-review-items.test.ts`
- Add: `server/tests/candidate-inbox-cutover.test.ts`
- Modify: `server/tests/candidate-migration.test.ts`
- Modify: `server/tests/compound-commands.test.ts`
- Modify: `server/tests/candidate-producer-cutover.test.ts`
- Modify: `server/tests/effective-scope-routes.test.ts`
- Modify: `server/tests/tenant-parentage.test.ts`

- [ ] Characterize five-class legacy Inbox DTOs, counts and ordering before changing the reader.
- [ ] Add RED tests for tenant/Customer/Matter/Person/Commitment parent closure, creator quarantine, required provenance/confidence, semantic dedupe and Candidate version conflicts.
- [ ] Add RED tests proving field/reminder/pending-Evidence producers cannot change formal CRM data before review.
- [ ] Add RED tests proving a later conflict rolls back every earlier item in a mixed batch and returns an explicit error.
- [ ] Add a production-source inventory test that permits old-table mutations only in the two Candidate helper modules, with an explicit exception for approved formal Evidence creation/deletion.

## Task 2: Add versioned, idempotent five-source data backfill

**Files:**
- Modify: `server/src/candidates/migration.ts`
- Modify: `server/scripts/migrate-candidates.ts`
- Modify: `server/package.json`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `scripts/test-postgres-ops-integration.sh`
- Modify: `server/tests/candidate-migration.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`

- [ ] Correct the projection validator for all supported ChangeProposal targets (`person`, `personLog`, `oppRole`, `opportunity`, `bi`, `ucv`) and all Reminder targets (Matter, Person or Commitment by kind).
- [ ] Implement `--apply` as one idempotent transaction: validate every tenant-scoped source row, create only missing linked Candidate rows, verify existing rows semantically, normalize legacy created-at ordering, verify counts/checksum and write the migration marker last.
- [ ] Make `--verify` require the marker and validate bidirectional source/Candidate parity without exposing evidence, rawContent or payload text. Keep `--dry-run` read-only for pre-expansion/recovery checks.
- [ ] Run the same data step on SQLite upgrade and PostgreSQL `migrate deploy` wrappers. A missing marker is recoverable by rerunning apply; invalid, partial, cross-tenant or conflicting data fails closed.
- [ ] Failure-inject preflight, apply interruption, rerun, marker drift, semantic conflict and authenticated backup/restore paths on both databases.

## Task 3: Cut ChangeProposal, Reminder and pending Evidence producers to one helper

**Files:**
- Add: `server/src/candidates/reviewItems.ts`
- Modify: `server/src/proposals.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/mcp/syncBundle.ts`
- Modify: `server/src/jobs.ts`
- Modify: `server/src/personMerge.ts`
- Modify: `server/tests/candidate-review-items.test.ts`
- Modify: `server/tests/evidence-trust.test.ts`
- Modify: `server/tests/mcp-sync-idempotency.test.ts`
- Modify: `server/tests/person-merge.test.ts`
- Modify: `server/tests/patrol.test.ts`

- [ ] Implement tenant-scoped create/update/claim/finalize/reject helpers with Candidate CAS and same-transaction compatibility projection writes.
- [ ] Keep ChangeProposal field-value conflict checks and formal Action application in the existing review transaction; release semantic pending dedupe only on terminal review.
- [ ] Keep patrol deterministic and read-only with respect to formal CRM state. It may only upsert/resolve reminder Candidates plus their compatibility projections.
- [ ] Route every machine `pending_review` Evidence producer through the helper. Trusted human Evidence continues to create an approved formal EvidenceEvent directly; pending Evidence deletion fails closed.
- [ ] Redirect person-merge references and resolve semantic-key collisions inside the helper so Candidate and projections cannot diverge.

## Task 4: Switch Inbox and review mutations to Candidate

**Files:**
- Modify: `server/src/suggest.ts`
- Modify: `server/src/proposals.ts`
- Modify: `server/src/mutation/compoundCommands.ts`
- Modify: `server/tests/candidate-inbox-cutover.test.ts`
- Modify: `server/tests/compound-commands.test.ts`
- Modify: `server/tests/effective-scope-routes.test.ts`
- Modify: `server/tests/tenant-parentage.test.ts`

- [ ] Query pending Candidate rows once, enforce EffectiveResourceScope and parent closure, and map the existing five response arrays using Candidate payload plus formal Account/Matter/Person/Signal labels. Do not read old candidate tables or add fallback.
- [ ] Preserve legacy endpoint IDs and DTO shapes. Sort Person/Relation by confidence descending and Change/Reminder/Evidence by legacy createdAt descending.
- [ ] Claim Candidate before formal Person/Edge/field/Evidence writes; finalize Candidate and its compatibility projection in the same transaction.
- [ ] On Evidence approval, apply optional overrides, approve the compatibility EvidenceEvent, write the PDE snapshot and finalize Candidate atomically. Rejection never affects PDE/formal state.
- [ ] Preserve viewer rejection and current member/owner/admin scope. Creator-share ACL remains deferred to CORE-204.
- [ ] Preserve command idempotency and all-or-nothing mixed-batch semantics; stale/partial conflicts must be explicit and leave no earlier item committed.

## Task 5: Verify rollback readiness and close CORE-203

**Files:**
- Modify: `docs/CORE-201-Candidate迁移与回滚说明.md`
- Modify: `docs/商业版开发待办清单v1.md`

- [ ] Run focused Candidate/Inbox/producer/batch/merge/tenant tests, then full Server typecheck/test and PostgreSQL operations integration.
- [ ] Refresh package copies with `npm ci --install-links` before unchanged Domain/G64111/PDE/App gates if a package changes; no package change is currently planned.
- [ ] Run Domain contracts, G64111, PDE kernel and App typecheck/tests. Do not run a local App production build because it writes shared `app/dist/**`; exact-SHA CI retains that isolated build gate.
- [ ] Run `git diff --check`, old-table no-bypass inventory, protected-path diff check and secret-pattern scan. Assert no schema/Action/App/shared/self-cultivation/production file changed.
- [ ] Commit business code independently, push and require every exact-head CI job green.
- [ ] In a separate governance commit, document migration/apply/verify/rollback commands, mark CORE-203 DONE and only CORE-204 READY, push and require exact-head CI green before CORE-204 starts.

## Local verification commands

```bash
cd server
npm run generate
npm run schema:postgres:check
npm run typecheck
DATABASE_URL=file:./test.db npx vitest run \
  tests/candidate-migration.test.ts \
  tests/candidate-review-items.test.ts \
  tests/candidate-inbox-cutover.test.ts \
  tests/candidate-producer-cutover.test.ts \
  tests/compound-commands.test.ts \
  tests/effective-scope-routes.test.ts \
  tests/tenant-parentage.test.ts \
  tests/person-merge.test.ts \
  tests/evidence-trust.test.ts \
  tests/mcp-sync-idempotency.test.ts \
  tests/patrol.test.ts
npm test

cd ..
bash scripts/test-postgres-ops-integration.sh

cd packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npx tsc --noEmit && npm test
```

## Stop conditions

Stop and request project-owner approval before any Prisma schema/DDL migration, Action/domain-contract/App change, shared file, public navigation/Nginx/CI change, self-cultivation path, production access, destructive legacy-table cleanup, relaxed tenant/viewer/AI-human-review boundary, or expansion into CORE-204/205.
