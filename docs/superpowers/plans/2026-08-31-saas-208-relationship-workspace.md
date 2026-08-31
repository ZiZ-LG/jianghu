# SAAS-208 Relationship Workspace and Hypothesis Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Give the lightweight complex-sales workspace one tenant-scoped relationship view that visibly separates confirmed relations, authorized machine candidates, intelligence and human-owned hypothesis overlays, then closes each hypothesis-verification Commitment through an explicit result or reviewed Evidence and a human keep/revise/retire decision.

**Architecture:** A standalone shared contract defines the bounded relationship-workspace projection and one human-only verification-review command outside the frozen legacy App `Action` union. The projection is assembled server-side from the existing formal Relation, unified Candidate/ReviewBatch, IntelligenceItem, StakeholderFocus, SalesHypothesis/Revision/EvidenceLink and same-row Commitment authorities after current-role, `sales.workspace`, EffectiveResourceScope and sensitive-candidate ACL checks. `PlanAction` receives only nullable hypothesis/revision links plus bounded completion-result and one-time review-disposition fields; `HypothesisEvidenceLink` receives an optional exact verification-Commitment reference. The lightweight React workspace reuses an extracted generic relation graph, renders solid/dashed/dotted layers with independent toggles, and invokes existing formal command routes plus the new atomic review route only after explicit user confirmation.

**Tech Stack:** TypeScript, React, Vite, Fastify, Prisma, Zod, SQLite development migration, deterministically rendered PostgreSQL schema, versioned PostgreSQL `migrate deploy` migration, Vitest.

## Global constraints

- **Task:** `SAAS-208`; **branch:** `codex/g4-candidate-review-intelligence`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`; **base:** `1d7f06950a7d1a2f4444f35c85bb5fcda37a9160`.
- `SAAS-208` was the only CRM `IN_PROGRESS` item during implementation. Its exact business SHA passed 12/12 CI; this governance close marks it `DONE` and moves only dependent `SAAS-212` to `READY`. RelationshipSignal/InterventionItem scoring, portfolio ordering, G64111 optional-install work and G4 final journey remain out of this task's scope.
- The project owner explicitly approved SAAS-208 changes to shared root file `scripts/test-postgres-ops-integration.sh`. That approval is limited to this task's interruption, semantic/marker/partial-drift, authenticated-recovery and fresh-install proof; no other shared/high-conflict file is approved.
- Do not modify App package/lock/Vite/dist, Docker Compose, navigation or cross-site entry, common Nginx/CI, any self-cultivation path, production, Aliyun, Mac mini or `main`.
- Every read, command, replay and projection reloads the current database role, requires `sales.workspace`, resolves EffectiveResourceScope and validates exact tenant/Customer/Matter/Person/Relation/Hypothesis/Revision/Commitment/Evidence closure. Viewer writes fail before `CommandRun`/`AuditEvent`; viewer reads retain Customer ownership isolation and never gain candidate/source access from role alone.
- Formal Relation is always solid. Only currently pending, currently authorized Candidate relation rows may render as gray dashed `?`; viewing a candidate never accepts it. Hypotheses render as dotted annotations anchored only to their explicit `personId`; Matter-level hypotheses stay in the list and never invent an edge or Person.
- Intelligence keeps its authoritative `observed | reported | inferred`, source description/reference, occurred/learned times and confidence. Freshness is an exact age display derived from those timestamps, not a new risk score. `reported`/`inferred` cannot be relabeled into Evidence.
- Stakeholder highlight reads only current `StakeholderFocus`; it never reads, writes or falls back to `Opportunity.primaryDPersonId`, ADURC, a G64111 score or methodology role.
- Verification Commitments stay in the existing `PlanAction` row and generic Commitment command authority. No second task table, fallback field or long-term dual write is allowed. A linked Commitment pins the exact current hypothesis Revision at creation and never silently follows a later revision.
- Completion alone never changes a hypothesis. A completed verification Commitment must have a bounded human result or an approved Evidence link tied to that exact Commitment and Revision before a keep/revise/retire review command is allowed. The review command is `user_asserted`, one-time and atomic; formal status/revision changes remain explicit human decisions.
- SQLite and PostgreSQL use portable scalar/text fields only. Migration is expand-only, marker-last and versioned; production remains `migrate deploy`, never `db push`.

## Fixed same-row expansion

Add nullable/defaulted columns to `PlanAction`:

```prisma
hypothesisId                       String?
hypothesisRevisionId               String?
completionResult                   String    @default("")
completionResultRecordedAtUtc      DateTime?
completionResultRecordedByUserId   String?
verificationReviewDisposition      String    @default("") // kept | revised | retired
verificationReviewedAtUtc          DateTime?
verificationReviewedByUserId       String?
```

Add one nullable column to `HypothesisEvidenceLink`:

```prisma
verificationCommitmentId String?
```

The two hypothesis pointers are both null or both present. A linked Commitment must have a Matter and exact tenant/customer/matter/hypothesis/current-revision closure. Result metadata is all-empty or complete and is frozen after review. Review metadata is all-empty or complete, uses only `kept | revised | retired`, and is written once. A verification Evidence link must target the same completed Commitment, hypothesis and pinned revision. Existing Commitments and Evidence links remain valid with null/empty expansion defaults; there is no legacy inference or backfill.

## Fixed command and projection boundaries

- Extend `CREATE_COMMITMENT` with an optional strict `hypothesisRef: { hypothesisId; hypothesisRevisionId }`. Quick Capture and unrelated Commitment writers always emit `null`; no caller can pass only one pointer.
- Add `RECORD_COMMITMENT_RESULT` with exact Customer/Commitment, expected entity/schedule versions and a trimmed result of 1–2,000 characters. It is allowed only for a completed, linked verification Commitment that has not been reviewed.
- Extend `LINK_HYPOTHESIS_EVIDENCE` with optional `verificationCommitmentId`. When present, the Commitment must already be completed and pin the exact hypothesis/current revision; when absent, SAAS-207 behavior is unchanged.
- Add standalone `REVIEW_HYPOTHESIS_VERIFICATION` with exact Commitment and hypothesis versions/current revision, one of:
  - `keep`: preserve claim/status, keep owner, require a future `nextReviewAt`;
  - `revise`: append one complete new immutable revision and future `nextReviewAt`, resetting status through the existing SAAS-207 rule;
  - `retire`: set formal status to `retired` through the existing human status rule.
- The review transaction first proves completed Commitment plus exact result or exact approved Evidence, then applies the existing hypothesis authority operation and writes the one-time disposition on the same Commitment. Receipts contain IDs, versions, disposition and replay state only; no result, claim, source quote or Evidence body enters `CommandRun.result` or AuditEvent metadata.
- The relationship-workspace response is bounded and strict: exact Customer/Matter; active Matter participants plus formal relation endpoints; formal Customer/current-Matter relations; authorized pending relation candidates with endpoint labels, source locator/quote and confidence; active IntelligenceItems; current/expired StakeholderFocus projection; active hypotheses with current revision, falsification conditions, body-free link/suggestion metadata, linked verification Commitments and deterministic review readiness.
- Candidate projection is fail-closed. A batch/source/candidate authority mismatch, malformed payload, missing endpoint or revoked ACL omits the candidate rather than leaking partial content. Formal graph, hypotheses and other authorized data remain available.
- Review readiness is deterministic and non-writing: `planned`, `awaiting_result_or_evidence`, `ready_for_review`, `reviewed`, or `superseded_revision`. No black-box score, severity or InterventionItem is created.

## Task 1: Lock strict contracts with RED tests

**Files:**
- Create: `packages/domain-contracts/src/relationshipWorkspace.ts`
- Create: `packages/domain-contracts/tests/relationshipWorkspace.test.ts`
- Modify: `packages/domain-contracts/src/crm.ts`
- Modify: `packages/domain-contracts/src/hypotheses.ts`
- Modify: `packages/domain-contracts/src/index.ts`
- Modify: focused CRM/hypothesis contract tests

- [x] Write failing tests for bounded projection layers, endpoint variants, exact falsification/source/time/confidence fields, readiness states, viewer-safe body boundaries, linked Commitment/result commands, Evidence-link reference and the keep/revise/retire union.
- [x] Confirm RED is caused by missing schemas/fields, then implement minimal strict Zod contracts outside the legacy `Action` union.
- [x] Prove Quick Capture and all old Commitment/Hypothesis payloads remain valid with explicit null/default linkage, while partial pairs, unknown keys, overlong text and caller-supplied audit metadata fail closed.
- [x] Run focused and full domain type/test gates.

## Task 2: Add guarded dual-database expansion

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260831_pre_saas208.prisma`
- Create: `server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql`
- Create: `server/src/relationshipWorkspace/migration.ts`
- Create: `server/scripts/migrate-hypothesis-commitment-review.ts`
- Create: `server/scripts/postgres-hypothesis-commitment-review-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify under explicit owner approval: `scripts/test-postgres-ops-integration.sh`
- Create/modify focused migration, schema-render, SQLite-upgrade and PostgreSQL-operations tests

- [x] Write RED tests for exact predecessor/successor schemas, defaults, paired metadata, no backfill, marker-last adoption, interruption, semantic/marker/partial drift, authenticated restore and fresh install/second update.
- [x] Add portable columns/indexes and marker `SAAS-208-hypothesis-commitment-review-v1`; reject any non-empty pre-existing expansion state that cannot be proven canonical.
- [x] Wire backup-first SQLite report/apply/verify and versioned PostgreSQL `migrate deploy`; never delete or rewrite existing PlanAction, SalesHypothesis, Revision or EvidenceLink rows.
- [x] Extend only the approved root operations script and preserve every prior marker plus `POSTGRES_OPS_INTEGRATION_OK=1`.

## Task 3: Enforce linked Commitment creation and result capture

**Files:**
- Modify: `server/src/mutation/commitments.ts`
- Modify: `server/src/commitment/view.ts`
- Modify: focused Commitment service/route/view tests

- [x] Write RED tests for current-role downgrade, viewer denial before CommandRun/Audit, tenant/customer/matter/current-revision closure, stale revision, non-Matter Commitment rejection, idempotent replay reauthorization and old unlinked Commitment parity.
- [x] Persist exact hypothesis/revision pointers only through `CREATE_COMMITMENT`; snapshot formal Relation/Stage/Forecast/Focus/G64111/methodology rows and prove zero mutation.
- [x] Implement `RECORD_COMMITMENT_RESULT` with completed-state, CAS, one linked verification authority, bounded result, pre-review mutability and body-free receipt/audit. Reject result writes after review.
- [x] Keep Today/Quick Capture/legacy PlanAction semantics unchanged and prove no fallback to `sourceRef`, `review`, `gapItem` or G64111 fields.

## Task 4: Bind approved Evidence to exact verification cycles

**Files:**
- Modify: `server/src/hypotheses/model.ts`
- Modify: `server/src/hypotheses/service.ts`
- Modify: focused hypothesis model/service/route tests

- [x] Write RED tests for optional verification Commitment linkage, exact tenant/customer/matter/hypothesis/current-revision closure, completed state, approved Evidence version `0`, append-only behavior and stale/reviewed commitment conflicts.
- [x] Preserve all SAAS-207 links with null commitment. New linked Evidence remains immutable and blocks Evidence deletion exactly as before.
- [x] Reauthorize idempotent replay against the current role/scope/ACL and keep receipt/audit body-free.

## Task 5: Assemble the current-scope relationship workspace

**Files:**
- Create: `server/src/relationshipWorkspace/model.ts`
- Create: `server/src/relationshipWorkspace/service.ts`
- Create: `server/src/relationshipWorkspace/routes.ts`
- Modify: `server/src/app.ts`
- Create: focused model/service/route/scope/ACL tests

- [x] Write RED tests for formal solid relations, authorized pending-candidate dashed relations, explicit-person dotted hypotheses, Intelligence badges, Focus highlight, linked Commitment readiness and deterministic ordering/bounds.
- [x] Assemble one serializable snapshot after current role, capability, EffectiveResourceScope and exact parent closure checks. Candidate quote/body projection additionally requires current candidate/source review ACL; revoked/malformed candidate branches fail closed without broadening other reads.
- [x] Validate every returned Person/Relation/Intelligence target/Focus/Hypothesis/Revision/Commitment/Evidence reference. Corrupt storage or cross-parent formal authorities fail the request rather than returning mixed-tenant data.
- [x] Prove the read route creates no AuditEvent, CommandRun, Candidate, Relation, Evidence, Focus, hypothesis change, Commitment change, methodology value or AgentRun.

## Task 6: Implement one-time human verification review

**Files:**
- Modify: `server/src/relationshipWorkspace/service.ts`
- Modify: `server/src/relationshipWorkspace/routes.ts`
- Create/modify focused review command and replay tests

- [x] Write RED tests for result-or-linked-Evidence prerequisite, exact current revision, CAS, one-time disposition, keep/revise/retire semantics, failure rollback, current-role downgrade, viewer denial and body-free idempotent replay.
- [x] Implement one serializable command transaction that reuses the SAAS-207 hypothesis authority operation, records the matching disposition on PlanAction and emits bounded separate audits without copying result/claim/Evidence/source text.
- [x] Prove keep cannot revise/retire, revise cannot overwrite old Revision or links, retire cannot be inferred from contradictory Evidence, and no AI/Agent/methodology path can call the human writer.

## Task 7: Build the lightweight relationship workspace UI

**Files:**
- Create: `app/src/components/CrmRelationshipGraph.tsx`
- Modify: `app/src/components/CrmContextPages.tsx`
- Create: `app/src/components/RelationshipWorkspacePanel.tsx`
- Create: `app/src/lib/relationshipWorkspace.ts`
- Modify: `app/src/api.ts`
- Modify: `app/src/components/CommercialShell.tsx`
- Modify: `app/src/styles.css`
- Create/modify focused graph, domain, transport, panel and shell tests

- [x] Extract the existing lightweight relation graph without changing generic Customer/Matter behavior. Formal relations remain solid; candidate edges are gray dashed with `?`; hypothesis annotations are dotted and can be hidden independently without mutating data.
- [x] Add Customer/Matter selection, source/time/confidence/freshness Intelligence badges, explicit falsification conditions, current Focus highlight, linked verification Commitments and readiness copy. Matter-level hypotheses remain visible outside the graph.
- [x] Add explicit, typed user flows to create a pinned verification Commitment, complete it, record a result/link approved Evidence, then keep/revise/retire. Stable idempotency keys survive same-session retry; conflicts retain form data and require refresh/rebase.
- [x] Viewer sees only authorized read projection and no write controls. G64111-disabled product fixtures complete the full workflow; no UI reads `primaryDPersonId`, ADURC, L1–L4 as a generic requirement, pipeline stage, G64111 score or legacy assumption.
- [x] Mount the panel in the existing `sales-workspace` capability surface before the frozen legacy entry. Do not add navigation, package, Vite or build-output changes.

## Task 8: Lock authority, migration recovery and no-scope-expansion evidence

**Files:**
- Modify: `packages/domain-contracts/src/authority.ts`
- Create: `docs/SAAS-208-关系工作台与假设验证迁移回滚说明.md`
- Create/modify static authority, production-boundary, demo and rollback tests

- [x] Update `stakeholder.focus`, `sales.hypothesis` and `commitment.record` consumers from planned to exact SAAS-208 files; record the candidate/intelligence read-only projection without creating a competing authority.
- [x] Document backup-first SQLite and authenticated isolated PostgreSQL recovery. Rollback keeps all new columns, links, results, dispositions, marker, AuditEvent, CommandRun and migration history; application rollback may hide the panel but cannot reinterpret or delete completed review evidence.
- [x] Static tests reject `primaryDPersonId`, StrategyRisk assumption fallback, automatic formal writes, relationship-radar/InterventionItem code, sensitive body logging and unapproved shared/self-cultivation paths.

## Task 9: Verify, commit, push and wait for exact-SHA CI

- [x] After package changes, run `npm ci --install-links` in `app/` and `server/` before downstream checks.
- [x] Run focused RED→GREEN suites, then Domain typecheck/tests, Server generate/typecheck/full tests/schema render-check/migration operations, App typecheck/tests/build, G64111 typecheck/tests and PDE typecheck/tests.
- [x] Inspect `git diff --check`, exact changed-file inventory, self-cultivation denylist and shared-file allowlist. Stage no generated `app/dist` or local database/artifact.
- [x] Create one independent business commit containing `SAAS-208`, push only `codex/g4-candidate-review-intelligence`, and wait until all required jobs for that exact SHA are green. Do not rerun a still-running suite and do not create/merge a PR or deploy.

## Task 10: Close governance only after the business gate

**Files:**
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: this plan's task checkboxes/evidence only

- [x] Record exact business SHA, test counts, 12/12 Actions run, migration marker and rollback document; mark `SAAS-208` `DONE` and `SAAS-212` `READY` only if every acceptance condition passes.
- [x] Commit/push governance separately and wait for its exact SHA CI before reporting completion or starting SAAS-212.

## Acceptance gate

- [x] One authorized Matter view visibly distinguishes formal solid relations, pending machine dashed `?` candidates and toggleable dotted hypothesis annotations; no overlay changes formal Relation.
- [x] Intelligence shows assertion type, source, confidence and exact time/freshness; Focus comes only from StakeholderFocus; every hypothesis displays expected signals and falsification conditions.
- [x] A user can create an exact-revision verification Commitment, complete it, add a human result or exact approved Evidence, then explicitly keep/revise/retire. No step automatically changes hypothesis, Relation, Focus, stage, forecast or key-person status.
- [x] Tenant, viewer ownership, current-role, capability, parent closure, sensitive ACL, idempotency, audit/body-minimization and corruption tests pass for list, direct route, commands and replays.
- [x] SQLite and PostgreSQL fresh/update/interruption/drift/recovery gates pass with marker `SAAS-208-hypothesis-commitment-review-v1`; production deploy path remains versioned `migrate deploy`.
- [x] G64111 disabled fixtures pass the full workflow, while G64111 and PDE regression suites remain green.
- [x] Only the explicitly approved shared root operations script is touched; self-cultivation files, production, Aliyun, Mac mini, `main` and public-site routing remain untouched.

## Completion evidence

- Business commit `e5503e37f8d1ec0ad5fee1f263efc586f0b96b44` is pushed and [GitHub Actions 33429254792](https://github.com/ZiZ-LG/jianghu/actions/runs/33429254792) completed successfully with 12/12 jobs on that exact SHA.
- Final local matrix: Domain Contracts 15 files / 142 tests; Server 114 files / 919 tests; App 53 files / 372 tests; G64111 2 files / 32 tests; PDE kernel 3 files / 25 tests. All required typechecks, Prisma generation, deterministic PostgreSQL schema checks, dependency audits, App build and production image gates passed.
- Local PostgreSQL operations emitted SAAS-208 committed-DDL adoption, semantic/marker/partial-drift fail-closed, authenticated restore, `SAAS_208_HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_OK=1`, fresh-install first/second-update and `POSTGRES_OPS_INTEGRATION_OK=1`; the remote `postgres-operations` job also succeeded.
- Scope remained CRM-only. The only shared/high-conflict file touched was the project-owner-approved `scripts/test-postgres-ops-integration.sh`; no self-cultivation, public routing, production, Aliyun, Mac mini or `main` change occurred.
