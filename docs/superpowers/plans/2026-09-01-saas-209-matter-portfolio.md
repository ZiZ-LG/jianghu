# SAAS-209 Personal Matter Portfolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Add a tenant-scoped personal Matter portfolio that consumes the unified `InterventionItem` contract, deterministically orders current attention gaps across the user's visible active Matters, exposes why-now/source/rule details, and prepares only uncommitted action drafts.

**Architecture:** A standalone shared contract defines a read-only portfolio response made of current Customer/Matter anchors, optional active methodology-stage projection, sales-only explicit estimate fields, ordered `InterventionItem` rows and one uncommitted draft derived from the top intervention. A Fastify service composes the existing core Today projection, currently revalidated Relationship Radar items, currently readable IntelligenceItem freshness and due Focus-related/Matter-level SalesHypothesis reviews under one serializable transaction. Every source drill re-runs current role, `sales.workspace`, EffectiveResourceScope, sensitive-source ACL and exact-revision checks. The existing `/matters` surface gains a list/portfolio toggle without changing shared `App.tsx`, navigation, schema or any formal writer.

**Tech Stack:** TypeScript, React, Vite, Fastify, Prisma read projections, Zod and Vitest. No schema or migration change.

## Global constraints

- **Task:** `SAAS-209`; **branch:** `codex/saas-209-matter-portfolio`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/saas-209-matter-portfolio`; **base:** `origin/main@802018eb06e6398975745d18d754121d36269cbc`.
- `SAAS-209` is complete after independent business and governance-close commits pass their exact-SHA CI gates. `SAAS-210` is the next `READY` task and must not start from an unmerged dependency branch; use the separately approved main-integration gate first.
- Do not modify `app/src/App.tsx`, App package/lock/Vite/dist, Docker Compose, root deployment/test scripts, navigation/cross-site entry, common Nginx/CI, any self-cultivation path, production, Aliyun, Mac mini or `main`. If investigation proves one of those files unavoidable, stop and request the file-specific approval.
- The portfolio is a derived read consumer. It creates no table, migration, snapshot, score, second task model or writer and cannot change Relation, Evidence, Intelligence, Focus, Hypothesis, Commitment, stage, forecast or key-person authority.
- Every read and source drill reloads the current database role, requires `sales.workspace`, resolves EffectiveResourceScope and validates exact tenant/Customer/Matter/source closure. Viewer reads retain Customer ownership isolation; viewer gets no action-draft control.
- AI/Agent/candidate output is never treated as formal state. Only current, source-revalidated Radar `InterventionItem` rows may enter; expired, source-changed, inaccessible or malformed inputs are omitted and can never raise urgency.
- No black-box total score. Ordering is a visible categorical rule followed by current observation time, manual Matter priority and stable identity.
- The portfolio must never read `Opportunity.primaryDPersonId`, `pipelineStage`, `engageStage`, ADURC, a G64111 score or a fixed stage enum. Stage comes only from the exact active `MethodologyBinding` plus its `MethodologyStageState`; no binding displays `未配置`.
- `4–5` is the acceptance fixture and comfortable personal operating scale, not a response cap. All visible active Matters remain in the response.
- Existing explicit sales estimates (`expectedAmountW`, `winProbability`, `expectedSignDate`) may be projected only when `Matter.kind === 'sales_opportunity'`, with sales-entered wording and no implied ForecastEntry, signed revenue or probability-weighted amount. Generic Matter rows receive `salesEstimate: null`.

## Fixed ordering and derived-provider rules

Each portfolio row gets the first matching attention bucket; the UI shows the bucket label and every underlying item:

1. `urgent`: overdue items and `pending_confirmation` items;
2. `next_step`: `matter_without_next_commitment` or `next_step_completeness.gap`;
3. `relationship`: current Radar contact/coverage/warm-path/interaction gaps;
4. `intelligence`: the latest currently readable active IntelligenceItem is older than 30 days;
5. `hypothesis`: an `untested | testing` hypothesis is due within seven days and is Matter-level or explicitly attached to the current StakeholderFocus person;
6. `manual`: no attention item, then current `Matter.priority` ordering;
7. `clear`: no attention item and no recognized manual priority.

Known manual priorities sort `critical/urgent/high`, `medium/normal`, then `low`; unknown open keys remain visible and sort after known keys without reinterpretation. Ties use observation time then stable Matter ID. Portfolio intelligence/hypothesis rows are still strict `InterventionItem` values with server-owned generic prose, exact body-free source refs, deterministic `reasonCode`, observation time, rule version and suggested action. No source quote, Intelligence statement, hypothesis claim, prompt or model text enters the portfolio response.

An action draft has `state: uncommitted`, the exact top `InterventionItem` identity/target/source revisions and its suggested action. It is a prefill/navigation hint only: the UI requires an explicit user click, never invokes a writer automatically, and reuses existing Quick Capture or relationship-workspace routes. Source or target drift invalidates the draft with the read model.

## Baseline evidence

- Domain Contracts: 16 files / 147 tests PASS plus typecheck.
- Server: 119 files / 946 tests PASS plus typecheck and PostgreSQL schema render check.
- App: 55 files / 380 tests PASS plus typecheck.
- G64111: 2 files / 32 tests PASS plus typecheck.
- PDE: 3 files / 25 tests PASS plus typecheck.
- Worktree was clean at `802018eb06e6398975745d18d754121d36269cbc`; dependency installs and `server/prisma/test.db` are ignored local artifacts.

## Task 1: Lock strict portfolio contracts with RED tests

**Files:**
- Create: `packages/domain-contracts/src/matterPortfolio.ts`
- Create: `packages/domain-contracts/tests/matterPortfolio.test.ts`
- Modify: `packages/domain-contracts/src/index.ts`

- [x] Write failing contract tests for the response anchors, categorical attention bucket, ordered strict InterventionItems, active-stage/null semantics, sales-only estimate union, uncommitted draft/source closure, no aggregate score and no 4–5 cap.
- [x] Confirm RED is caused by missing exports/contracts, then add minimal strict Zod schemas and inferred types.
- [x] Reject duplicate Matter/item identities, parent mismatches, item/source/target drift, generic-Matter estimate fields, committed-action claims, unknown keys and impossible bucket/item combinations.
- [x] Run focused and full Domain type/test gates.

## Task 2: Build deterministic attention composition with RED tests

**Files:**
- Create: `server/src/matterPortfolio/model.ts`
- Create: `server/tests/matter-portfolio-model.test.ts`
- Modify only if reuse requires a narrow exported helper: `server/src/today.ts`, `server/src/relationshipRadar/service.ts`

- [x] Write failing pure-model tests for all seven ordering buckets, overdue/pending precedence, no-next dedupe, radar relationship ordering, stale-intelligence threshold boundaries, Focus-related/Matter-level due hypotheses, manual-priority ties, six visible Matters and stable ordering.
- [x] Implement pure builders that accept only already-authorized structured facts and emit server-owned body-free InterventionItems and one uncommitted top-action draft.
- [x] Prove missing Intelligence is unknown rather than stale; non-Focus person hypotheses are not promoted as high-impact; retired/supported/contradicted hypotheses do not enter; no score or legacy stage/key-person field is accepted.

## Task 3: Assemble the current-scope portfolio and source drill

**Files:**
- Create: `server/src/matterPortfolio/service.ts`
- Create: `server/src/matterPortfolio/routes.ts`
- Modify: `server/src/app.ts`
- Modify: `packages/domain-contracts/src/authority.ts`
- Create: `server/tests/matter-portfolio.test.ts`
- Modify: `server/tests/product-capabilities.test.ts`

- [x] Write failing integration tests for authentication, `sales.workspace`, tenant isolation, scoped member/viewer ownership, archived/revoked Matter omission, current-role downgrade, exact parent closure and `private, no-store` headers.
- [x] In one serializable transaction, resolve current visible active Matters; compose core Today and current Radar interventions; validate Intelligence/Hypothesis/Focus through their existing authorities; load only exact active methodology-stage state; emit no hard 4–5 cap.
- [x] Implement provider-aware source drill: delegate core Today/Radar sources and revalidate portfolio Intelligence/Hypothesis/Focus exact revisions through current scope and sensitive ACL. Stale/revoked sources return scoped 404/409 without body leakage.
- [x] Snapshot every formal table/write-side count before and after reads and prove zero AgentRun, CommandRun, AuditEvent or formal CRM mutation.
- [x] Update the authority inventory so portfolio is a read consumer only and remove completed `SAAS-209 portfolio` planned placeholders.

## Task 4: Add strict App transport/parser boundaries

**Files:**
- Create: `app/src/lib/matterPortfolio.ts`
- Create: `app/src/lib/matterPortfolio.test.ts`
- Modify: `app/src/api.ts`
- Modify focused API tests if needed

- [x] Write failing tests for strict response/source parsing, parent identity preservation, stale source error mapping and no acceptance of aggregate score or provider-authored extra fields.
- [x] Add `api.matterPortfolio()` and `api.matterPortfolioSource(...)` using the shared schemas and provider/customer/matter/source anchors.
- [x] Keep error bodies bounded and ensure no response parser falls back to legacy `Account`/Opportunity state.

## Task 5: Add the `/matters` list/portfolio toggle and read-only UX

**Files:**
- Create: `app/src/components/MatterPortfolioPanel.tsx`
- Create: `app/src/components/MatterPortfolioPanel.test.ts`
- Modify: `app/src/components/CrmContextPages.tsx`
- Modify: `app/src/components/CrmContextPages.test.ts`
- Modify: `app/src/components/CommercialShell.tsx`
- Modify: `app/src/components/CommercialShell.test.ts`
- Modify: `app/src/styles.css`

- [x] Write failing render tests for the list/portfolio toggle, 4–5 fixture, visible categorical ordering, why-now copy, exact source/rule/time details, methodology `未配置`, sales-only estimate columns and generic-Matter omission.
- [x] Render loading/error/empty/refresh states and preserve the existing Matter detail/list behavior. Do not add navigation or modify `App.tsx`.
- [x] Open source drill only after an explicit click. Render the uncommitted draft clearly; non-viewers may explicitly open existing Quick Capture/relationship workspace, while viewer sees no draft action control.
- [x] Use semantic CSS variables and responsive controls; never auto-submit, mutate formal state, show a total score or present missing/stale sources as fact.

## Task 6: Lock no-methodology and authority boundaries

**Files:**
- Create/modify focused Domain, Server and App fixtures only

- [x] Run a G64111-disabled fixture with poisoned `primaryDPersonId`, `pipelineStage`, `engageStage`, ADURC-like metadata and legacy status values; assert the portfolio remains functional and displays `未配置` without exposing poisoned values.
- [x] Add a bound-methodology fixture proving only the exact active binding's current StageState/StageDefinition is read; stale/inactive binding state cannot appear.
- [x] Prove Candidate/AI/Radar drafts never change formal Relation, Focus, Hypothesis, Commitment, stage, forecast or key-person state, and that inaccessible source loss only removes/downgrades attention.

## Task 7: Verify and create one independent business commit

- [x] After Domain package changes, rerun `npm ci --install-links` in `app/` and `server/`.
- [x] Run focused RED→GREEN suites, then Domain typecheck/tests, Server generate/typecheck/full tests/PostgreSQL schema render check, App typecheck/tests and a production build to a temporary directory outside `app/dist`, G64111 typecheck/tests and PDE typecheck/tests.
- [x] Inspect `git diff --check`, exact changed-file inventory, forbidden self-cultivation paths, shared/high-conflict denylist, generated/local artifacts and source text for legacy-field fallback.
- [x] Commit the business implementation independently with `SAAS-209` in the message, push only `codex/saas-209-matter-portfolio`, and wait for all required jobs on that exact SHA. Do not create/merge a PR or deploy unless separately requested.

## Task 8: Close governance only after the business exact-SHA gate

**Files:**
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: this plan's checkboxes/evidence only

- [x] Record exact business SHA, test counts, CI run, no-schema/no-migration decision and rollback boundary; mark `SAAS-209` `DONE` and only then move `SAAS-210` to `READY`.
- [x] Commit/push governance separately and wait for its exact SHA CI before reporting completion or starting `SAAS-210`; the exact governance SHA/run is reported outside this self-referential commit.

## Acceptance gate

- [x] One authorized portfolio shows at least a 4–5 Matter fixture but does not truncate a sixth visible active Matter.
- [x] Ordering reliably surfaces overdue/pending confirmation, no next step, relationship/Focus gaps, stale readable intelligence and due high-impact unverified hypotheses before manual priority, with no hidden total score.
- [x] Every attention item explains why now and exposes observation time, rule version, suggested action and exact currently authorized source drill; stale/revoked sources fail closed.
- [x] Action drafts are visibly uncommitted and require an explicit user action; reads/drafts cause zero formal CRM, AgentRun, CommandRun or AuditEvent changes.
- [x] Stage reads only the active MethodologyStageState or displays `未配置`; no `pipelineStage`, OppStage, `primaryDPersonId`, ADURC, G64111 score or fixed-stage fallback exists.
- [x] Sales estimates appear only for `sales_opportunity` and are labeled explicit sales inputs; generic Matters expose no sales estimate fields.
- [x] Tenant/current-role/EffectiveResourceScope/sensitive ACL and viewer Customer ownership isolation pass across list and source drill.
- [x] Domain, Server, App, G64111 and PDE gates pass locally and exact-SHA CI is green; self-cultivation/shared/deployment/production files remain untouched.

## Completion evidence

- Business commit: `7073f416a8e89fc9a747669b556fc7633b2fc61e`; [GitHub Actions run 33605977787](https://github.com/ZiZ-LG/jianghu/actions/runs/33605977787) completed with 12/12 jobs successful for that exact SHA.
- Local gates: Domain Contracts 17 files / 156 tests; Server 121 files / 957 tests plus Prisma generate, typecheck and PostgreSQL schema render check; App 57 files / 390 tests plus typecheck and production build outside `app/dist`; G64111 2 files / 32 tests; PDE 3 files / 25 tests.
- Scope: 24 business files in App, Server and Domain Contracts; no schema, migration, package/lock/Vite, `App.tsx`, Docker Compose, root script, workflow, deployment, shared high-conflict or self-cultivation change. Production, Aliyun, Mac mini and `main` were not touched.
- Rollback: hide the `/matters` portfolio toggle and revert the business commit. Preserve all pre-existing radar, intelligence, focus, hypothesis, commitment, agent/audit and migration history; never restore legacy stage/key-person fallbacks or delete data.

## Pre-PR hardening (reopened 2026-09-02)

- [ ] Reproduce the legacy sales-estimate poisoning path and add an explicit body-free unavailable projection that never fabricates or rewrites formal values.
- [ ] Replace per-candidate Intelligence/Focus/Hypothesis authority calls with one request-local, tenant-scoped batch authorization pass whose query count does not grow with candidate count.
- [ ] Restrict source drill composition to the exact Customer/Matter while preserving current-role, `sales.workspace`, EffectiveResourceScope, sensitive ACL and exact-revision checks.
- [ ] Rerun focused and full Domain/Server/App/G64111/PDE gates, create a separate hardening business commit, push it and wait for exact-SHA CI before re-closing governance.

## Rollback

Hide the `/matters` portfolio toggle and revert the SAAS-209 business commit. Because the task adds no schema, migration, stored snapshot or writer, rollback removes only read/API/UI consumers. Preserve all existing SAAS-212 RelationshipRadarSnapshot, AgentRun/AuditEvent, IntelligenceItem, StakeholderFocus, SalesHypothesis/Revision/EvidenceLink and Commitment data/history. Never delete those rows, rewrite source revisions or restore a legacy-stage/key-person fallback. Production rollback or deployment remains a separately approved operation.
