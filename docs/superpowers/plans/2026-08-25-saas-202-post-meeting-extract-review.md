# SAAS-202 Post-meeting Extract and Review Sheet Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming completion. Execute inline because the project owner already authorized serial automatic G4 progression and this thread may not delegate unless explicitly requested.

**Task:** SAAS-202
**Branch:** `codex/g4-candidate-review-intelligence`
**Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
**Base:** `5ce44f9884a8bbec0a77401711c297a154b538de`
**Status:** DONE

**Goal:** Turn the fixed `post_meeting_extract@core-206.v1` candidate Job into a production handler that reads one currently authorized SourceArtifact, produces strict evidence-backed candidates, commits exactly one ReviewBatch without touching formal CRM state, and gives a human reviewer one usable sheet for source quotes, before→after edits, explicit selection, atomic acceptance and retry.

**Architecture:** Keep provider/body work outside database transactions and keep AgentRun/audit body-free. The handler returns a validated public audit plus request-local private preparation state; the runner never persists or logs that private state and gives candidate mode only a narrow transaction-bound ReviewBatch commit port. That port revalidates tenant, current actor, Customer/Matter closure, SourceArtifact fingerprint/ACL and every candidate target, writes through the existing Candidate helpers/compatibility projections, then attaches the candidates to a deterministic ReviewBatch in the same Serializable transaction as AgentRun success. The detailed ReviewBatch API projects only authorized review fields and source excerpts from Candidate evidence; formal Person/Relation/field/Evidence/Commitment/Interaction changes remain exclusively behind the existing human acceptance transaction.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod, React 18, Vite/Vitest, SQLite development verification and generated PostgreSQL schema parity.

## Non-goals and hard boundaries

- Do not add a table, column, migration, blob/body store, second ReviewCandidate model or a parallel candidate mechanism. Candidate remains the only physical candidate authority.
- Do not connect Feishu links/OAuth, add new upload ingestion or modify recording provider behavior; that is SAAS-203.
- Do not automatically accept a candidate or write formal Customer, Matter, Person, Relation, Evidence, Commitment, Interaction, stage, Forecast or key-person status. Candidate/ReviewBatch creation is the only Job side effect.
- Do not let model output choose a tenant, handler, actionMode, Customer/Matter/SourceArtifact anchor, formal ID, database operation, connector, model, cost limit or arbitrary field. Unknown kinds, fields, IDs, source locators and malformed values fail closed.
- Preserve `Customer.categoryKey` as the only commercial classification authority. Never emit or accept a new `customerType` candidate.
- Identity, relation and sensitive field candidates default unselected. Every submitted decision remains explicit; omission never means acceptance.
- Keep viewer writes denied and viewer reads subject to existing owner-row scope plus SourceArtifact/Candidate ACL. Job controls remain owner/admin only and runs remain owner/admin/member only.
- Do not modify `app/package.json`, lockfiles, Vite config, `app/dist/**`, Docker Compose, public navigation/cross-site entry, generic Nginx, public CI or any self-cultivation path. Do not merge main or deploy production.

## Authority and state contract

1. One run is anchored to exactly one current Customer, optional Matter and one available local SourceArtifact. Only `transcript`, `uploaded_file` and `note` bodies are readable; degraded/deleted/reference-only or mismatched backing state fails closed.
2. The source body is decrypted/read only after tenant, current actor, effective scope, creator/share ACL, mount, ACL version and fingerprint checks. It is passed only to the configured tenant BYO model and never stored in AgentRun, ReviewBatch, Interaction, command receipts, audit metadata or logs.
3. Preparation may carry strict request-local private state between `prepare` and `commit`. The runner persists only `AgentPreparedAudit`; invalid preparation, timeout, budget exhaustion, authorization change or output mismatch creates no Candidate or ReviewBatch.
4. Candidate commit accepts one strict `PostMeetingCandidateBatch` union with at most 20 items. Deterministic IDs use tenant + run + source + item reference; retries cannot duplicate candidates, compatibility rows or ReviewBatch.
5. Every candidate carries the exact SourceArtifact ID, creator, visibility, ACL generation, source locator, source quote and confidence. Relation/evidence endpoints must resolve to an exact in-scope existing Person or a person candidate in the same batch.
6. Customer field candidates use only `name` or `categoryKey`; Matter field candidates use only the portable universal fields admitted by `CrmCommandSchema`. Current formal values are re-read and encoded server-side; model-supplied “before” values are never authoritative.
7. Commitment candidates reuse `CreateCommitmentCommandSchema` and deterministic ReviewBatch identities. Any edit is re-parsed through that schema before formal acceptance.
8. ReviewBatch creation and reading leave all formal-table counts and versions unchanged. Atomic human acceptance creates one Interaction only when at least one selected item is accepted; all-reject creates none; any selected conflict causes zero partial formal writes.
9. Review detail returns typed, bounded authorized projections: source label/fingerprint, quote, confidence, target, before/after and editable values. It never returns source body, ciphertext, arbitrary Candidate payload, provider response or secret.
10. Same transport idempotency key and same batch acceptance version replay exactly. Changed payload, stale versions, current ACL/scope loss and concurrent winners fail closed; UI retains the user's draft decisions for refresh/retry.

## Task 1: Lock shared extraction/review contracts with RED tests

**Files:**
- Add: `packages/domain-contracts/src/postMeeting.ts`
- Add: `packages/domain-contracts/src/postMeeting.test.ts`
- Modify: `packages/domain-contracts/src/index.ts`

- [x] Write failing schema tests for the five allowed candidate kinds, maximum 20 items, unique item refs, exact SourceArtifact/Customer/Matter anchors and evidence/confidence requirements.
- [x] Write failing tests that reject unknown keys, `customerType`, stage/Forecast/key-person writes, arbitrary target IDs, invalid relation endpoints, malformed schedules and body/provider fields.
- [x] Define strict `PostMeetingCandidateBatch`, detailed ReviewBatch view, explicit review decision/request/receipt, SourceArtifact option and Job/Run UI response schemas.
- [x] Keep transport contracts content-bounded and make every output safe to parse independently in App and Server.

## Task 2: Add a body-safe two-phase Agent seam with RED tests

**Files:**
- Modify: `server/src/agents/model.ts`
- Modify: `server/src/agents/runner.ts`
- Modify: `server/tests/agent-job-policy.test.ts`
- Modify: `server/tests/agent-job-routes.test.ts`

- [x] Write a failing test proving request-local private preparation state reaches commit but never appears in AgentRun, response, audit or logs.
- [x] Write a failing test proving candidate output existence is checked only after the narrow commit port, while read-only/draft outputs retain pre-commit validation.
- [x] Write failing tests for malformed private envelopes, missing/extra candidate output, port misuse, commit mutation of audit, timeout, authorization/ACL change and exact idempotent replay.
- [x] Add a backward-compatible preparation envelope (`audit` + private state) and a candidate-only commit callback; never expose Prisma or a formal writer to handlers.
- [x] Preserve cost, evidence, actionMode, attempt, timeout, lease, stop-control and final output validation from CORE-206.

## Task 3: Read and extract one authorized source with RED tests

**Files:**
- Add: `server/src/postMeeting/source.ts`
- Add: `server/src/postMeeting/extractor.ts`
- Add: `server/src/postMeeting/handler.ts`
- Add: `server/tests/post-meeting-extract.test.ts`
- Modify: `server/src/app.ts`

- [x] Write failing tests for current tenant/actor/effective-scope/creator ACL, exact mount and ACL version, transcript ciphertext fingerprint, Note content fingerprint, degraded/deleted/reference-only sources and viewer denial.
- [x] Write failing parser tests using hand-derived fixtures for source quotes, confidence, field values, new people, relations, evidence and commitments; reject markdown leakage, unknown fields, invented IDs and more than 20 outputs.
- [x] Load/decrypt the source only after authorization; cap body size and never return/log it.
- [x] Load exact in-scope Customer/Matter/Person context, call only the tenant BYO model outside the transaction, and normalize its response through the shared strict schema.
- [x] Register only `post_meeting_extract@core-206.v1` as the production handler. No AI config becomes a stable retryable/non-retryable failure as appropriate; there is no mock-to-formal fallback.

## Task 4: Commit candidates and one ReviewBatch through the narrow port

**Files:**
- Add: `server/src/postMeeting/commit.ts`
- Modify: `server/src/candidates/personRelation.ts`
- Modify: `server/src/candidates/reviewItems.ts`
- Modify: `server/src/reviewBatches/model.ts`
- Modify: `server/src/reviewBatches/service.ts`
- Modify: `server/src/proposals.ts`
- Add: `server/src/mutation/reviewedFields.ts`
- Modify: `server/tests/post-meeting-extract.test.ts`
- Modify: `server/tests/candidate-person-relation.test.ts`
- Modify: `server/tests/candidate-review-items.test.ts`
- Modify: `server/tests/review-batch-acceptance.test.ts`

- [x] Write failing integration tests that a successful run creates only Candidate compatibility rows + one ReviewBatch + AgentRun/audit, with zero formal Customer/Matter/Person/Edge/Evidence/Commitment/Interaction change.
- [x] Write failing tests for deterministic replay, cross-tenant/parent/creator/ACL mismatch, ambiguous person resolution, stale formal before-value, duplicate item ref, partial candidate conflict and injected failure rollback.
- [x] Extend existing Candidate helpers with one reviewed SourceArtifact binding input so candidate creation and source/visibility/ACL metadata are atomic and replay-validated; do not add a bypass writer.
- [x] Resolve exact endpoints, derive current field values server-side, create all five allowed candidate kinds through existing authorities, and attach them to one deterministic batch in the AgentRun transaction.
- [x] Add narrow universal Customer/Matter reviewed-field application for the approved allowlist, parsed through `CrmCommandSchema`, tenant/version scoped and audited. Never use `customerType`.
- [x] Revalidate edited Commitment drafts through `CreateCommitmentCommandSchema` during human acceptance.

## Task 5: Expose the authorized review sheet contract with RED tests

**Files:**
- Modify: `server/src/reviewBatches/service.ts`
- Modify: `server/src/reviewBatches/routes.ts`
- Modify: `server/src/reviewBatches/acceptance.ts`
- Modify: `server/tests/review-batch-routes.test.ts`
- Modify: `server/tests/review-batch-acceptance.test.ts`

- [x] Write failing route tests for typed source metadata, grouped candidate detail, quote/confidence, before→after, identity/relation default-unselected flags and safe editable fields.
- [x] Prove list/history stay metadata-first, hidden/missing stay same-shape 404, viewer cannot accept and unauthorized users receive no quote or existence leak.
- [x] Parse payloads server-side into a bounded discriminated projection; never return arbitrary payload JSON, source body or ciphertext.
- [x] Use the shared acceptance schema, support typed edits, return deterministic per-item conflict/results and retain CORE-205 all-or-nothing semantics.

## Task 6: Build the human review and Job/Run surface with RED tests

**Files:**
- Modify: `app/src/api.ts`
- Add: `app/src/lib/postMeetingReview.ts`
- Add: `app/src/lib/postMeetingReview.test.ts`
- Add: `app/src/components/PostMeetingReviewPanel.tsx`
- Add: `app/src/components/PostMeetingReviewPanel.test.ts`
- Modify: `app/src/components/CommercialShell.tsx`
- Modify: `app/src/components/CommercialShell.test.ts`
- Modify: `app/src/App.tsx`
- Modify: `app/src/styles.css`

- [x] Write failing API/parser tests for malformed cards/runs/sources/batches/receipts and exact-session idempotent command retries.
- [x] Write failing pure-state tests for grouped items, default selection, edit preservation, stable request keys, atomic conflict refresh and failed-item retry without silently selecting new identity/relation candidates.
- [x] Write failing component tests for source selection + run, disabled/enabled Job Card, visible run status, source quote, before→after, typed editing, explicit checkboxes, batch result and readonly suppression.
- [x] Add a self-contained “会后速审” section inside the existing `sales-workspace` capability surface, followed by the frozen legacy account entry; do not change public or product navigation.
- [x] Use current CrmContext versions to build exact Agent input refs, list only mounted available sources, expose owner/admin enable/disable controls, and refresh runs/batches after a run.
- [x] Keep identity/relation/sensitive fields unselected, require an explicit activity kind/time and at least one explicit decision, retain drafts on 409, and refresh exact versions before retry.

## Task 7: Verify, commit, push and close SAAS-202

**Files:**
- Modify: this plan
- Modify: `docs/商业版开发待办清单v1.md`

- [x] Refresh local file dependencies with `npm ci --install-links` in Server and App after changing `packages/domain-contracts`.
- [x] Run focused Domain/Agent/PostMeeting/Candidate/ReviewBatch/App tests after every RED→GREEN cycle.
- [x] Run Domain, G64111 and PDE typecheck/tests; Server generate, PostgreSQL schema check, typecheck and full tests; App typecheck/full tests. Do not run local App production build because it writes shared `app/dist/**`; exact-SHA CI owns that isolated gate.
- [x] Run static producer/route/authority inventory, formal-write-zero assertions, `git diff --check`, protected/shared/self-cultivation path checks and high-confidence secret scan.
- [x] Confirm there is no schema drift and therefore no SQLite/PostgreSQL migration for SAAS-202; run existing schema/ops regression gates.
- [x] Commit business code independently with SAAS-202 in the message, push and require all jobs green on the exact business SHA.
- [x] In a separate governance commit, record evidence, mark SAAS-202 DONE and only SAAS-203 READY, push and require exact governance SHA CI green before starting SAAS-203.

## Completion evidence (2026-08-26)

- Business commit: `a068b0a9101f760b9b38a445978f01a54b1a0519`; [GitHub Actions 32953078282](https://github.com/ZiZ-LG/jianghu/actions/runs/32953078282) completed with 12/12 jobs successful on that exact SHA.
- Local verification: Domain 10 files / 100 tests; Server 84 files / 705 tests plus focused 9 files / 130 tests; App 44 files / 337 tests plus focused 4 files / 45 tests; G64111 2 files / 32 tests; PDE kernel 3 files / 25 tests. All required typechecks, Prisma generate and PostgreSQL schema render checks passed.
- PostgreSQL operations integration completed with `FRESH_INSTALL_SECOND_UPDATE_OK=1` and `POSTGRES_OPS_INTEGRATION_OK=1`; SAAS-202 introduced no schema or migration.
- Static authority, formal-write-zero, protected/shared/self-cultivation path, navigation and high-confidence secret checks passed. No shared high-conflict file, self-cultivation file, main merge or production deployment was involved.

## Focused verification commands

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
  tests/post-meeting-extract.test.ts \
  tests/agent-job-policy.test.ts \
  tests/agent-job-routes.test.ts \
  tests/candidate-person-relation.test.ts \
  tests/candidate-review-items.test.ts \
  tests/review-batch-routes.test.ts \
  tests/review-batch-acceptance.test.ts \
  tests/schema-render.test.ts \
  tests/postgres-ops-scripts.test.ts
npm test

cd ../app
npm ci --install-links
npx tsc --noEmit
npm test

cd ../packages/g64111
npm run typecheck
npm test

cd ../pde-kernel
npx tsc --noEmit
npm test

cd ../..
bash scripts/test-postgres-ops-integration.sh
git diff --check
```

## Stop conditions

Stop and request project-owner approval before touching any shared/high-conflict file, self-cultivation path, product/public navigation, generic Nginx/CI, package dependency declaration, schema/migration, production host or main merge; before adding a generic DB/formal writer to Agent handlers; before allowing model-selected arbitrary fields/IDs/connectors; or before weakening tenant/viewer/effective-scope/creator ACL, human review, atomic acceptance, Candidate single-authority, `Customer.categoryKey`, BYO-key or body-free audit rules.
