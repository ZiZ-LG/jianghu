# SAAS-205 Pre-meeting Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Make `pre_meeting_brief@core-206.v1` the controlled, read-only producer of the existing immutable ResearchBriefSnapshot and expose one authoritative visit-preparation UI while retaining human CuratedSummary as an attributable input and demoting legacy AI CuratedSummary to a compatibility cache.

**Architecture:** Preparation runs outside the database transaction against one explicitly selected, currently authorized SourceArtifact plus exact Customer/optional Matter and current CuratedSummary inputs. The tenant BYO model returns only bounded sections, citations and unknowns; server code owns subject/source metadata and validates every citation. A new narrow ResearchBrief commit port reauthorizes the Agent request and all snapshot sources inside the existing AgentRun serializable transaction, creates only the encrypted immutable snapshot and body-free audit references, then atomically completes the run. The commercial sales workspace renders that snapshot as the sole default brief authority. Legacy CuratedSummary stops generating AI summaries, preserves human edits, and is presented only as a collapsed compatibility input.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod, existing AgentJob/AgentRun runner, existing AES-256-GCM ResearchBriefSnapshot authority, React/Vite, Vitest.

## Global constraints

- **Task:** `SAAS-205`; **branch:** `codex/g4-candidate-review-intelligence`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`; **base:** `03378c845e10b4ec130a5fbab47931a6cd6e340f`; **status:** `DONE` after the independent business and governance gates.
- `SAAS-205` remained the only CRM `IN_PROGRESS` item through implementation. `SAAS-206` moves to `READY` only after the SAAS-205 business SHA `93b5057b517a8b6f382d8b6df9d6fa4c31b08124` passed 12/12 jobs and this governance close is independently verified.
- `origin/main` advanced from the G4 merge base only through the parallel self-cultivation line (`SAAS-606/607`, PR #41/#42). Do not merge or rebase those forbidden paths into this CRM branch.
- No schema, migration, marker, package, lockfile or build-config change is required. Do not touch `scripts/test-postgres-ops-integration.sh`, root Compose, Nginx, public CI, App package/lock/Vite/dist, public navigation, cross-site entry or any self-cultivation path.
- All preparation, commit, replay, list and detail operations remain tenant-scoped and recheck current database role, `sales.workspace`, EffectiveResourceScope, active Customer/Matter closure and SourceArtifact creator/share ACL. Viewer cannot control or run a Job; a downgraded viewer may read only a creator-owned snapshot that remains inside Customer ownership/effective scope and current source ACL.
- The UI requires one explicit, body-available Transcript/uploaded file/Note for a new manual run. The existing Job definition remains fixed and may support future authorized event triggers, but SAAS-205 does not scan sources, pull Feishu, call QCC or register arbitrary connectors.
- AI output is a derived read model only. It may write only ResearchBriefSnapshot through the reviewed narrow port; it must not write Customer/Matter/Person/Relation/Evidence/Commitment/Interaction, Candidate/ReviewBatch, stage, forecast, key-person state or CuratedSummary.
- Every displayed section cites one or more exact snapshot sources and shows its `asOf` time. The UI exposes source provider/kind/status, observed/retrieved/fresh-until times, unknowns and bounded failure codes. Missing coverage becomes explicit unknowns; the model cannot invent an uncited section.
- Preparation may decrypt an authorized source body and call the tenant BYO model, but raw body, prompt, model response, credentials and provider errors stay request-local. AgentRun, CommandRun and AuditEvent remain body-free; the snapshot payload remains encrypted at rest.
- Human CuratedSummary stays editable and attributable and may be used as a labeled snapshot source. Existing unedited AI CuratedSummary remains readable only as `curated_ai_cache`; SAAS-205 stops lazy/forced creation of new legacy AI summaries and never overwrites a human edit.
- ResearchBriefSnapshot is the only default visit-preparation display. Legacy CuratedSummary is collapsed and labeled as a compatibility input, never another “current brief” authority.
- No production, Mac mini, `main` merge or deployment action is authorized.

## File map

- `server/src/preMeeting/model.ts` — strict model-response parser, deterministic source/section/unknown construction and cost calculation.
- `server/src/preMeeting/source.ts` — current tenant/scope/ACL-safe preparation inputs, reusing the established encrypted SourceArtifact body loader.
- `server/src/preMeeting/handler.ts` — production `pre_meeting_brief@core-206.v1` handler using tenant BYO AI and request-local private state.
- `server/src/preMeeting/commit.ts` — narrow transaction adapter that may create only one ResearchBriefSnapshot.
- `server/src/agents/model.ts`, `runner.ts`, `routes.ts`, `server/src/app.ts` — one-shot ResearchBrief commit port wiring and exact persisted-output validation without exposing Prisma to handlers.
- `server/src/curated.ts` — human-source preservation and legacy AI cache retirement; no new AI generation.
- `app/src/lib/preMeetingBrief.ts`, `app/src/components/PreMeetingBriefPanel.tsx` — exact response parsing, stable idempotent run input and authoritative brief view.
- `app/src/api.ts`, `app/src/components/CommercialShell.tsx`, `app/src/components/CuratedSummary.tsx`, `app/src/styles.css` — CRM-only API/UI integration and compatibility labeling.
- Focused Server/App tests plus existing Agent, scope, sensitive-ACL, ResearchBrief and shell regressions.

## Fixed product behavior

1. The user selects a currently visible Customer, Matter and one body-available authorized source. Owner/admin may enable or disable the Job; owner/admin/member may run it; viewer sees no mutation controls.
2. Server-owned sources always include exact current Customer and Matter facts, the selected SourceArtifact and any non-empty current Customer/Matter CuratedSummary. Human and AI-cache summaries use different source kinds and labels.
3. The BYO model receives only the authorized, bounded preparation context and returns strict JSON sections/unknowns that cite server-issued source IDs. Unknown keys, dangling citations, duplicate section keys, unsupported sections, oversized text or uncited conclusions fail closed.
4. Omitted visit-preparation dimensions become deterministic unknowns, capped by the existing contract. The model cannot set subject anchors, source fingerprints, freshness, generator identity, snapshot metadata or database IDs.
5. The handler prepares exactly one body-free `research_brief` output ref. During commit, the runner exposes one one-shot ResearchBrief port only to this read-only Job. The adapter commits the prepared payload with generation key bound to the AgentRun, and the runner verifies the exact tenant/creator/Customer/Matter/version row before completing AgentRun in the same serializable transaction.
6. The UI defaults to the latest currently authorized snapshot and shows history, status, generation time, cited sections, source details, unknowns and partial failures. It never treats a stale or unavailable source as current.
7. `/api/curated` GET no longer performs lazy AI generation. PUT continues to save a human-authored input. `/api/curated/regenerate` returns an explicit retired contract without calling a model or writing a cache. The legacy component is collapsed and labeled “兼容资料输入”; it is not the visit brief.

## Task 1: Lock preparation semantics with RED tests

**Files:**
- Create: `server/src/preMeeting/model.ts`
- Create: `server/src/preMeeting/source.ts`
- Create: `server/tests/pre-meeting-model.test.ts`
- Create: `server/tests/pre-meeting-source.test.ts`

- [x] **Step 1: Write RED parser/source tests.** Cover exact tenant/actor/Customer/Matter/source anchors, current source ACL generation, encrypted Transcript/Note body loading, Customer/Matter CRM fact sources, human CuratedSummary attribution, legacy AI cache labeling, empty/unsafe CuratedSummary exclusion, and no cross-tenant/hidden/degraded/deleted/stale source body.
- [x] **Step 2: Prove strict model output.** Accept only known section keys, bounded content and server-issued source IDs; reject Markdown wrappers, unknown fields, dangling/duplicate citations, duplicate sections, timestamps/subject/source metadata supplied by the model, excessive sections/unknowns and oversized UTF-8 output.
- [x] **Step 3: Build the canonical payload.** Server code owns exact CRM subject selection, source fingerprints/versions/times/status, fixed titles, section `asOf`, deterministic unknowns for omitted dimensions and `generator.version='saas-204.v1'`. AI cache sources are always visibly labeled compatibility input.
- [x] **Step 4: Run RED then GREEN focused tests.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/pre-meeting-model.test.ts \
  tests/pre-meeting-source.test.ts
```

## Task 2: Add the one-shot ResearchBrief commit port and production handler

**Files:**
- Modify: `server/src/agents/model.ts`
- Modify: `server/src/agents/runner.ts`
- Modify: `server/src/agents/routes.ts`
- Create: `server/src/preMeeting/commit.ts`
- Create: `server/src/preMeeting/handler.ts`
- Modify: `server/src/app.ts`
- Create: `server/tests/pre-meeting-handler.test.ts`
- Modify: `server/tests/agent-job-routes.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/sensitive-aggregate-boundary.test.ts`

- [x] **Step 1: Write RED runner/handler integration tests.** Production card becomes available but remains default-disabled. Prove control RBAC, member run, viewer preflight denial before writes, exact idempotent replay, bounded retry/budget/timeout, current role/scope/source reauthorization, model/config failure codes and no plaintext in AgentRun/CommandRun/AuditEvent.
- [x] **Step 2: Add a narrow one-shot port.** Handler commit context receives no Prisma client or generic writer. Only `pre_meeting_brief@core-206.v1` in read-only mode may call the ResearchBrief port, exactly once. Missing, duplicate or mismatched calls fail and roll back. Other read-only/draft/candidate jobs cannot use the port.
- [x] **Step 3: Implement the transaction adapter.** Bind generation identity to tenant/actor/run, call `commitResearchBriefSnapshot` on the runner transaction, map safe service failures, and return the exact `{kind:'research_brief', id, version}`. Validate the persisted snapshot is current creator/Customer/Matter scoped before AgentRun success.
- [x] **Step 4: Register the production handler.** Preparation uses one explicit authorized source, current CRM/CuratedSummary inputs and tenant BYO AI. No QCC/Feishu fetch, external scan, formal writer or CuratedSummary writer is reachable.
- [x] **Step 5: Prove formal-state zero.** Snapshot formal Customer/Matter/Person/Relation/Evidence/Commitment/Interaction/Candidate/ReviewBatch/CuratedSummary rows and versions before/after a successful run and assert equality except for the permitted ResearchBriefSnapshot, AgentRun, CommandRun and body-free audit records.
- [x] **Step 6: Run focused Agent/security suites.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/pre-meeting-handler.test.ts \
  tests/agent-job-policy.test.ts \
  tests/agent-job-routes.test.ts \
  tests/research-brief-service.test.ts \
  tests/research-brief-routes.test.ts \
  tests/sensitive-aggregate-boundary.test.ts \
  tests/schema-render.test.ts
```

## Task 3: Retire legacy AI summary generation without losing human input

**Files:**
- Modify: `server/src/curated.ts`
- Modify: `server/tests/effective-scope-routes.test.ts`
- Modify: `server/tests/visibility-acl.test.ts`
- Modify: `server/tests/sensitive-aggregate-boundary.test.ts`

- [x] **Step 1: Write RED authority tests.** GET must not call AI or write CuratedSummary; human content returns as `human`; a current legacy AI row returns as `compatibility_cache`; unsafe historical cache fails closed; viewer ownership/scope behavior remains unchanged; PUT rejects viewer and preserves human-wins.
- [x] **Step 2: Stop new AI cache creation.** Remove lazy and forced model calls/upserts from the route. Keep the existing regenerate endpoint only as an explicit retired response (`410`, stable safe code) so old clients fail clearly without a write.
- [x] **Step 3: Preserve ResearchBrief input semantics.** Existing human/AI cache rows remain available to the pre-meeting source collector with exact fingerprint and labels. ResearchBrief refresh never updates or deletes CuratedSummary.
- [x] **Step 4: Run focused authority/scope tests.**

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/effective-scope-routes.test.ts \
  tests/visibility-acl.test.ts \
  tests/pre-meeting-source.test.ts \
  tests/sensitive-aggregate-boundary.test.ts
```

## Task 4: Build the one-authority pre-meeting UI

**Files:**
- Create: `app/src/lib/preMeetingBrief.ts`
- Create: `app/src/lib/preMeetingBrief.test.ts`
- Create: `app/src/components/PreMeetingBriefPanel.tsx`
- Create: `app/src/components/PreMeetingBriefPanel.test.ts`
- Modify: `app/src/api.ts`
- Modify: `app/src/api.test.ts`
- Modify: `app/src/components/CommercialShell.tsx`
- Modify: `app/src/components/CommercialShell.test.ts`
- Modify: `app/src/components/CuratedSummary.tsx`
- Create: `app/src/components/CuratedSummary.test.ts`
- Modify: `app/src/styles.css`

- [x] **Step 1: Write RED API/domain tests.** Strictly parse Job cards/runs, one eligible source, ResearchBrief list/detail and exact run/control receipts. Build an Agent request from current Customer/Matter/source versions; reject archived/mismatched/stale anchors and reuse the same idempotency key only for the identical canonical request.
- [x] **Step 2: Write RED view tests.** Render one authoritative “拜访前简报” surface before会后速审/legacy entry; display source/time/status/citations/unknowns/failures and history; suppress control for member, suppress run/control for viewer but allow creator-authorized snapshot reading; never render ciphertext, prompt or raw model response.
- [x] **Step 3: Implement the panel.** Default to the first visible active Customer/Matter, load eligible source/history/latest detail, permit owner/admin control and owner/admin/member generation, safely retry failed runs, and refresh only the resulting immutable snapshot. Do not add a new navigation item or modify App.tsx.
- [x] **Step 4: Demote the legacy component.** Render CuratedSummary as collapsed “兼容资料输入”; human content remains editable, AI cache is explicitly non-authoritative, and no regenerate button remains.
- [x] **Step 5: Run focused App suites.**

```bash
cd app
npx vitest run \
  src/lib/preMeetingBrief.test.ts \
  src/components/PreMeetingBriefPanel.test.ts \
  src/components/CuratedSummary.test.ts \
  src/components/CommercialShell.test.ts \
  src/api.test.ts
npx tsc --noEmit
```

## Task 5: Full verification and exact-SHA delivery

- [x] **Step 1: Inspect scope before commit.** `git diff --name-only` must contain no schema/migration/package/lock/Vite/dist/root shared script, public navigation, Nginx/Compose/CI or self-cultivation path. `app/src/store.ts` and Action contracts must remain unchanged.
- [x] **Step 2: Run the complete local matrix.** Because no package contract changes are planned, no `npm ci --install-links` refresh is required; if implementation unexpectedly changes `packages/*`, stop and add the mandatory refresh/gates before continuing.

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd ../../server && npm run generate && npm run schema:postgres:render && npm run schema:postgres:check && npx tsc --noEmit && npm test
cd ../app && npx tsc --noEmit && npm run test
cd ../packages/g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm run test
```

- [x] **Step 3: Commit business code only.** Use an independent commit such as `feat(crm): implement SAAS-205 pre-meeting brief`, push the feature branch, and wait for all 12 exact-head GitHub Actions jobs to succeed. Do not merge or deploy.
- [x] **Step 4: Close governance separately.** Only after exact business SHA CI is green, update this plan’s checkboxes and `docs/商业版开发待办清单v1.md` from `SAAS-205 IN_PROGRESS→DONE` and `SAAS-206 PENDING→READY`. Commit/push separately and require its exact SHA CI 12/12 green.
- [x] **Step 5: Report the required atomic-task template.** `SELF-CULTIVATION FILES TOUCHED=NONE`, `PRODUCTION TOUCHED=NO`, `HOMEPAGE CHECK=NOT RUN (no deployment)` and the next gate must name SAAS-206.

## Completion evidence

- Business commit `93b5057b517a8b6f382d8b6df9d6fa4c31b08124` is pushed and [GitHub Actions 33097832299](https://github.com/ZiZ-LG/jianghu/actions/runs/33097832299) completed successfully with 12/12 jobs on that exact SHA.
- Final local matrix: Domain Contracts 12 files / 112 tests; Server 97 files / 841 tests; App 49 files / 362 tests; G64111 2 files / 32 tests; PDE kernel 3 files / 25 tests. All required typechecks, Prisma generation and deterministic PostgreSQL schema checks passed.
- Scope remained CRM-only: no schema/migration/package/lock/Vite/dist/root shared script, public navigation, Nginx/Compose/CI, `app/src/store.ts`, Action contract, self-cultivation, production, Mac mini or `main` change.

## Rollback

- Disable `pre_meeting_brief` through the existing tenant Job control and revert the SAAS-205 application commit. Preserve all ResearchBriefSnapshot rows/ciphertext, AgentRun/CommandRun/AuditEvent records, SAAS-204 marker and migration history; never delete or rewrite snapshots.
- Legacy CuratedSummary rows remain intact throughout. If the compatibility UI/API change is reverted, do not allow a rollback to overwrite human-edited rows or treat legacy AI cache as ResearchBrief authority.
- A rollback must not change production, Mac mini, public homepage, self-cultivation or the frozen legacy CRM deployment. Production rollout remains a separate owner-approved task.
