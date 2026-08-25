# CORE-205 ReviewBatch and Interaction Acceptance Transaction Implementation Plan

> **Task:** CORE-205
> **Branch:** `codex/g4-candidate-review-intelligence`
> **Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
> **Base:** `60ee5384121864ac271e5df49be8120e5a913cab`
> **Business commit:** `ea9dd7c1bd75335f3fc586b2875f2fb3fe4e3634`
> **Remote gate:** [GitHub Actions 32900762234](https://github.com/ZiZ-LG/jianghu/actions/runs/32900762234), attempt 2, 12/12 jobs successful
> **Status:** DONE

## Goal

Add the portable ReviewBatch and formal Interaction foundations around the existing single Candidate table. A SourceArtifact can anchor one or more explicitly created review batches; candidates are attached to a batch without changing formal CRM state. A human reviewer can later accept, edit-and-accept or reject selected items in one idempotent transaction that confirms activity kind, time and Customer/Matter ownership, creates or links one formal Interaction only when at least one formal item is accepted, and records body-free audit evidence.

## Non-goals and hard boundaries

- Do not add a second ReviewCandidate table. `Candidate` remains the only physical candidate authority and `ReviewCandidate` is its product/domain name.
- Do not extract candidates from transcripts/files, implement the meeting-review UI, connect Feishu/OAuth/upload ingestion to ReviewBatch, or start any Agent Job. Those belong to CORE-206 and SAAS-202/203.
- Do not copy Note content, Transcript ciphertext/plaintext, source excerpts or Candidate evidence into ReviewBatch, Interaction, command receipts or audit metadata. SourceArtifact remains the source pointer and existing backing tables remain body authorities.
- Do not create an Interaction when a batch is merely created/read, while candidates remain pending, when all submitted decisions are rejections, or when any selected item conflicts.
- Do not silently apply a non-conflicting subset. All selected items are validated first; any selected-item conflict aborts every formal write and returns deterministic per-item results for reconfirmation.
- Do not let AI, connectors, Jobs or a viewer call the formal acceptance path. Every formal transition requires an authenticated human writer and current role/scope/ACL revalidation inside the transaction.
- Do not add another customer classification field, bypass `Customer.categoryKey`, duplicate Commitment semantics, or bypass existing Person/Relation/field/Evidence/Commitment authorities.
- Do not change Action/domain-contract/App code, product permission allocation, App package/lock/Vite/dist, Docker Compose, public navigation, generic Nginx, public CI or any self-cultivation path. If any becomes unavoidable, stop and request project-owner approval.
- Do not delete or weaken legacy candidate compatibility tables, SourceArtifact tombstones, migration markers or audit history. Do not deploy production or merge main.

## Authority and state contract

1. `ReviewBatch` is a tenant-scoped, creator/visibility/ACL-aware review envelope anchored to exactly one valid SourceArtifact. It stores only metadata, current activity classification/occurred time/Customer/Matter assignment, version and the last non-sensitive acceptance receipt.
2. Every batch candidate must match the batch tenant, SourceArtifact, Customer/Matter closure, creator visibility domain and ACL generation. Candidate IDs supplied by a caller cannot be used to import arbitrary or cross-batch items.
3. `Interaction` is user-confirmed activity metadata only: activity kind, occurred time, Customer/Matter, SourceArtifact and creator/audit identity. It never stores a transcript, note body, excerpt or AI evidence.
4. Batch creation/attachment and rejection affect only review metadata, Candidate review state and audit. They create no Person, Edge, EvidenceEvent, Commitment or Interaction.
5. Acceptance locks and reloads the actor role, effective resource scope, SourceArtifact, batch, candidate rows, sensitive ACL generation, parent rows and target CAS/old values. It validates every requested decision before any formal write.
6. A successful acceptance creates or validates one Interaction for the batch if and only if at least one formal item is accepted. The accepted Candidate rows, formal-object receipts and audit entries all carry a stable Interaction/batch trace without copying sensitive content.
7. The acceptance CAS is the pair `reviewBatchId + acceptanceVersion`. Replaying the same canonical request returns the stored result; reusing that version with different input or processing a stale version fails closed. Command-run idempotency remains an additional transport-level guard, not the business identity.
8. A batch may remain open while candidates are still pending. When no pending candidate remains it closes as `accepted` if it owns/links an Interaction, otherwise as `rejected`. A closed all-rejected batch has no Interaction.
9. Existing `person_create`, `relation_create`, `field_change` and `evidence_create` acceptance authorities are reused in the same transaction. `commitment_create` uses the existing generic Commitment command authority and schema; `reminder` is not silently converted into a Commitment.
10. Any unsupported/malformed candidate kind, stale Candidate/batch/ACL version, changed old value, duplicate or ambiguous formal target, parent/scope loss, archived parent or partial legacy projection fails the whole selected set with explicit per-item reason codes.

## Portable data model

Use no native enum, JSON or array fields.

- `ReviewBatch`: tenant/source/customer/matter anchor, creator/visibility/ACL, `status`, `activityKind`, nullable `occurredAt`, nullable `interactionId`, integer `acceptanceVersion` and row `version`, last canonical request hash/result summary, reviewer/timestamps and tenant-first indexes.
- `Interaction`: tenant/customer/matter anchor, SourceArtifact reference, stable activity kind/time/title metadata, creator/reviewer identity, created/updated timestamps and tenant-first source/customer/matter indexes.
- `Candidate`: retain the existing nullable `sourceArtifactId` and `reviewBatchId`; batch attachment is CAS-protected and cannot detach or reparent a processed candidate.
- Durable trace: batch/candidate/Interaction IDs and formal result IDs are stored in non-body receipt/audit metadata. Existing formal authorities keep their own schema and lifecycle.

The versioned PostgreSQL migration is `20260825020000_expand_review_batch_interaction`; SQLite receives the same portable models through the guarded schema upgrader. The data marker is `CORE-205-review-batch-interaction-v1` and is written only after schema and semantic verification.

## Backend API and internal contract

All public routes are authenticated and remain under the existing `sales.workspace` service boundary:

- `POST /api/review-batches` — create/idempotently replay a batch for one readable/manageable SourceArtifact and attach an exact set of pending candidates after closure/ACL checks.
- `GET /api/review-batches` — bounded metadata-first, ACL-filtered list; no body/evidence projection.
- `GET /api/review-batches/:id` — batch metadata plus authorized Candidate review DTOs and per-item versions; hidden and missing share one 404 shape.
- `POST /api/review-batches/:id/accept` — submit explicit per-item accept/edit-and-accept/reject decisions with expected batch/acceptance/candidate/ACL versions, confirmed activity metadata and optional existing Interaction ID.

The acceptance response contains batch/acceptance versions, Interaction ID if created/linked, and deterministic per-item status/reason/formal IDs. It never returns or persists source bodies. No broad batch mutation endpoint may infer acceptance from omission; every decision is explicit.

## Task 1: Lock model, zero-formal-write and failure behavior with RED tests

**Files:**
- Add: `server/tests/review-batch-acceptance.test.ts`
- Add: `server/tests/review-batch-routes.test.ts`
- Add: `server/tests/review-batch-migration.test.ts`
- Modify: relevant candidate/SourceArtifact/schema/SQLite/PostgreSQL operation tests

- [x] Prove creating, listing and reading a batch does not create Interaction or formal CRM rows and never exposes body/evidence text.
- [x] Prove tenant, Customer/Matter closure, EffectiveResourceScope, SourceArtifact sensitive ACL, Candidate creator/reviewer ACL and viewer denial for batch attach/read/review.
- [x] Prove arbitrary Candidate IDs, mixed sources/parents/creators, already-batched/terminal rows, stale candidate or ACL generation and malformed metadata fail closed.
- [x] Prove all-reject creates no Interaction; one or more accepts creates/links exactly one metadata-only Interaction and durable body-free trace.
- [x] Prove one conflicting selected item returns per-item conflicts with zero Person/Edge/Evidence/Commitment/Interaction/Candidate partial transition.
- [x] Prove same batch/version canonical replay returns the original receipt while changed input, stale versions and concurrent winners cannot duplicate formal rows.

## Task 2: Add portable schema, versioned migration and recovery gates

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Add: `server/prisma/postgres/legacy/20260825_pre_core205.prisma`
- Add: `server/prisma/postgres/migrations/20260825020000_expand_review_batch_interaction/migration.sql`
- Add: `server/src/reviewBatches/migration.ts`
- Add: `server/scripts/migrate-review-batches.ts`
- Add: `server/scripts/postgres-review-batch-schema-state.ts`
- Modify: predecessor schema inspectors, `server/scripts/upgrade-sqlite-schema.ts`, `server/scripts/deploy-postgres-migrations.sh`, `server/package.json`, `scripts/test-postgres-ops-integration.sh`
- Modify: migration/schema tests from Task 1

- [x] Add only portable expand tables/columns/indexes; retain Candidate, SourceArtifact and every legacy/formal table unchanged.
- [x] Make predecessor inspectors accept only their exact registered CORE-205 successor shape, never arbitrary drift.
- [x] Implement `--dry-run | --apply | --verify` with tenant-first enumeration, exact marker receipt/checksum, no body reads/logging and marker-last semantics.
- [x] Verify every batch/source/candidate/Interaction parent closure, ACL generation, status/version and identity rule in both directions; reject partial schema, orphan, cross-tenant and malformed rows.
- [x] Cover SQLite write-before-backup upgrade and PostgreSQL migrate-deploy with interruption, rerun, semantic conflict, marker drift, authenticated restore and fresh-install evidence.

## Task 3: Implement the single batch service and candidate attachment authority

**Files:**
- Add: `server/src/reviewBatches/model.ts`
- Add: `server/src/reviewBatches/service.ts`
- Modify: Candidate helpers only where required to centralize attach/review CAS
- Add/modify: focused tests from Task 1

- [x] Create deterministic identities and strict metadata validators without hashing or persisting bodies.
- [x] Create/replay a batch and attach exact pending Candidate rows in one Serializable transaction, inheriting the SourceArtifact creator/visibility/ACL generation.
- [x] Re-resolve current actor role, scope, parent closure and sensitive ACL inside every write transaction; owner/admin status alone never bypasses known private content.
- [x] Return metadata-only batch/Candidate views with bounded pagination and same-shape hidden/missing behavior.
- [x] Keep unclassified SourceArtifact and mismatched Customer/Matter batches unavailable for formal review until explicitly mounted through the SAAS-201 authority.

## Task 4: Implement all-or-nothing acceptance and Interaction creation/linking

**Files:**
- Add: `server/src/reviewBatches/acceptance.ts`
- Reuse/modify: `server/src/candidates/personRelation.ts`, `server/src/candidates/reviewItems.ts`, `server/src/proposals.ts`, `server/src/suggest.ts`, `server/src/mutation/commitments.ts` only through narrow transaction-safe authorities
- Add: `server/src/reviewBatches/routes.ts`
- Modify: `server/src/app.ts`
- Add/modify: focused acceptance/route tests

- [x] Canonicalize explicit decisions and preflight every selected item before any formal write; collect deterministic item results and abort the entire selection on any conflict.
- [x] Reuse current Person/Relation/field/Evidence authorities and the generic Commitment command executor so tenant, old-value, CAS, viewer, owner assignment and audit rules are not reimplemented inconsistently.
- [x] Create deterministic Person/Edge/Commitment/Interaction identities or otherwise persist exact acceptance receipts before terminalizing candidates so retry cannot duplicate results.
- [x] Create or validate one body-free Interaction only after all selected accepts can succeed; link Candidate/formal receipts/audit to batch and Interaction.
- [x] Apply all explicit rejections in the same transaction. If every decision is rejection, close without an Interaction; if candidates remain pending, preserve an open batch.
- [x] Persist the acceptance receipt and increment versions atomically; same `reviewBatchId + acceptanceVersion` replay is stable independent of transport retries.

## Task 5: Verify recovery and close CORE-205

**Files:**
- Add: `docs/CORE-205-ReviewBatch与Interaction迁移回滚说明.md`
- Modify: this plan
- Modify: `docs/商业版开发待办清单v1.md`

- [x] Run focused batch/acceptance/candidate/SourceArtifact/migration tests, then Server generate/schema check/typecheck/full tests and PostgreSQL operations integration.
- [x] Run Domain contracts, G64111, PDE kernel and App typecheck/tests. Do not run a local App production build because it writes shared `app/dist/**`; exact-SHA CI retains that isolated gate.
- [x] Run schema/static route/producer inventory, `git diff --check`, protected-path check and high-confidence secret scan.
- [x] Assert no Action/domain-contract/App/shared/self-cultivation/production change, no second Candidate/body table and no pre-review formal-state write.
- [x] Commit business code independently, push and require every exact-head CI job green.
- [x] In a separate governance commit, document migration/apply/verify/rollback, mark CORE-205 DONE and only CORE-206 READY, then require exact-head CI green before CORE-206 starts.

## Local verification commands

```bash
cd server
npm run generate
npm run schema:postgres:check
npm run typecheck
DATABASE_URL=file:./test.db npx vitest run \
  tests/review-batch-acceptance.test.ts \
  tests/review-batch-routes.test.ts \
  tests/review-batch-migration.test.ts \
  tests/candidate-review-items.test.ts \
  tests/candidate-person-relation.test.ts \
  tests/source-artifact-projection.test.ts \
  tests/source-artifact-routes.test.ts \
  tests/schema-render.test.ts \
  tests/postgres-ops-scripts.test.ts \
  tests/sqlite-matter-upgrade.test.ts
npm test

cd ..
bash scripts/test-postgres-ops-integration.sh

cd packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npx tsc --noEmit && npm test
```

## Stop conditions

Stop and request project-owner approval before any shared file, Action/domain-contract/App change, product permission allocation, new body/ReviewCandidate table, public navigation/Nginx/CI change, self-cultivation path, production access, destructive migration, relaxed tenant/viewer/creator ACL, private-body owner/admin override, silent partial acceptance or expansion into CORE-206/SAAS-202.
