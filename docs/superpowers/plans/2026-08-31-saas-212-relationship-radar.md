# SAAS-212 Relationship Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline task-by-task. This thread may not delegate unless the project owner explicitly requests sub-agents.

**Goal:** Turn the built-in `relationship_radar` draft Job into a tenant-scoped, deterministic and explainable relationship-health read model that emits six independent RelationshipSignals, traceable InterventionItems and uncommitted action drafts without changing any formal CRM authority.

**Architecture:** A standalone shared contract defines the six fixed dimensions, body-free exact source references, severity/status rules, immutable radar snapshot, derived InterventionItems and action drafts. The existing controlled Agent runner receives one new narrow `relationship_radar` commit port; its deterministic handler reads only currently authorized formal CRM metadata and commits one immutable, portable snapshot in the same serializable transaction as AgentRun completion. Radar reads, Today projection and source drill always rebuild visibility from the current database role, `sales.workspace`, EffectiveResourceScope and exact source revisions; revoked or drifted sources fail closed or downgrade the affected signal to `unknown/low`. The relationship workspace displays the latest radar and explicit run controls, while Today consumes only revalidated InterventionItems and retains its three existing sections.

**Tech Stack:** TypeScript, React, Vite, Fastify, Prisma, Zod, SQLite development migration, deterministically rendered PostgreSQL schema, versioned PostgreSQL `migrate deploy` migration, Vitest.

## Global constraints

- **Task:** `SAAS-212`; **branch:** `codex/g4-candidate-review-intelligence`; **worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`; **base:** `a4308a39b698b5314900bcac7b4155de0778f46b`.
- `SAAS-212` is the only CRM `IN_PROGRESS` task. Do not start portfolio ordering (`SAAS-209`), optional G64111 installation (`SAAS-210`) or later stage-gate work until this task is independently committed, pushed and green for its exact SHA.
- The project owner explicitly approved SAAS-212 changes to shared root file `scripts/test-postgres-ops-integration.sh`. The approval is limited to this task's marker, interruption, semantic/partial-drift, authenticated-recovery and fresh-install proof; no other shared/high-conflict file is approved.
- Do not modify App package/lock/Vite/dist, Docker Compose, navigation or cross-site entry, common Nginx/CI, any self-cultivation path, production, Aliyun, Mac mini or `main`.
- Every read, Job run, commit, replay, latest-snapshot query, Today projection and source drill reloads the current database role, requires `sales.workspace`, resolves EffectiveResourceScope and validates exact tenant/Customer/Matter/source closure. Viewer writes fail before AgentRun/Audit creation; viewer reads retain Customer ownership isolation.
- The Job is deterministic and method-neutral. It must not call a model/provider, read or write `primaryDPersonId`, ADURC, G64111, pipeline legacy fields, forecast/stage or methodology roles, and it must not invent a hidden total score.
- RelationshipSignal, InterventionItem and action draft are expiring derived projections only. They never create, accept, update or infer a formal Person, Relation, Evidence, Interaction, IntelligenceItem, StakeholderFocus, SalesHypothesis, Commitment, stage, forecast or key-person state.
- Every signal and intervention carries a stable reason code, generic visible explanation, exact body-free source refs, observation time, deterministic rule version and explicit suggested action. Source bodies, prompts, model text, secrets and provider errors never enter the snapshot, AgentRun, CommandRun or AuditEvent.
- Source revocation, archival, version drift, parent drift or ACL loss is evaluated at read time. A signal with a lost source becomes `unknown` and no higher than `low`; an intervention whose target or required source cannot be drilled into is omitted. Source unavailability can never increase severity.
- SQLite and PostgreSQL use portable scalar/text fields only. Migration is expand-only, marker-last and versioned; production remains `migrate deploy`, never `db push`.

## Fixed derived contract

The radar always returns exactly these dimensions in this order:

1. `interaction_freshness`
2. `single_threaded_contact`
3. `role_coverage`
4. `visible_warm_paths`
5. `evidence_freshness`
6. `next_step_completeness`

Each `RelationshipSignal` contains `id`, `dimension`, `status` (`healthy | attention | gap | unknown`), `severity` (`info | low | medium | high`), `reasonCode`, `explanation`, one to eight exact body-free source refs, `observedAtUtc`, `ruleVersion`, `expiresAtUtc` and one explicit suggested action. No aggregate score, weighted score, rank or methodology value is allowed.

Deterministic generic V1 rules use only visible formal metadata:

- **Interaction freshness:** latest confirmed Interaction for the Matter; `<=14` days is healthy/info, `15–30` attention/low, `>30` gap/medium, and no current visible Interaction is unknown/low.
- **Single-threaded contact:** distinct current Matter participants referenced by visible completed or planned person-targeted Commitments, reviewed Evidence or active Intelligence targets in the last 60 days; one visible thread is attention/medium, two or more is healthy/info, and insufficient person-linked facts is unknown/low. The rule describes only visible formal indicators, never an inferred contact graph.
- **Role coverage:** generic V1 may prove only participant and current StakeholderFocus coverage. Two or more current participants plus a current Focus is healthy/info; participants without a current Focus is attention/low; fewer than two participants is gap/medium; any request for methodology-specific role coverage remains unknown/low until an optional method pack is installed in a later task.
- **Visible warm paths:** a current formal Relation path of at most two edges from any person with a recent visible activity indicator to the current Focus person is healthy/info; participants with no such formal path is gap/medium; missing Focus or qualifying anchors is unknown/low. Candidates and hypothesis overlays never count as formal paths.
- **Evidence freshness:** latest approved Evidence for the Matter; `<=30` days is healthy/info, `31–60` attention/low, `>60` gap/medium, and no approved visible Evidence is unknown/low.
- **Next-step completeness:** one or more current planned Commitment rows is healthy/info; none is gap/medium and produces a `CREATE_COMMITMENT` draft. It is deduplicated against the existing core `matter_without_next_commitment` Today item.

V1 emits no `high` signals. The contract and read-time downgrade logic still test that any future high/medium signal requires every source and target to resolve under current authority. All snapshots expire 24 hours after generation; expired snapshots remain body-free audit history but are not projected as current signals or Today items.

## Fixed persistence boundary

Add one immutable portable model:

```prisma
model RelationshipRadarSnapshot {
  id                String   @id
  tenantId          String
  tenant            Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customerId        String
  matterId          String
  createdByUserId   String
  agentRunId        String
  generationKey     String
  payloadJson       String
  payloadFingerprint String
  sourceSetHash     String
  signalCount       Int
  interventionCount Int
  draftCount        Int
  ruleVersion       String
  generatedAt       DateTime
  expiresAt         DateTime
  version           Int      @default(1)
  createdAt         DateTime @default(now())

  @@unique([tenantId, agentRunId])
  @@unique([tenantId, createdByUserId, generationKey])
  @@index([tenantId, customerId, matterId, generatedAt])
  @@index([tenantId, matterId, expiresAt])
}
```

`payloadJson` is strict canonical JSON containing only validated generic signal explanations, exact revision refs, InterventionItems and uncommitted action-draft fields; it contains no source body, free-form CRM text, customer/person name, prompt, model output or secret. `payloadFingerprint` and `sourceSetHash` are SHA-256 digests. `agentRunId` binds the snapshot to exactly one successful run. Existing `relationship_radar@core-206.v1` controls are not silently migrated or enabled: the built-in card advances to `relationship_radar@saas-212.v1`, starts missing/disabled, and requires an explicit owner/admin enable action.

## Task 1: Lock strict radar contracts with RED tests

**Files:**
- Create: `packages/domain-contracts/src/relationshipRadar.ts`
- Create: `packages/domain-contracts/tests/relationshipRadar.test.ts`
- Modify: `packages/domain-contracts/src/agents.ts`
- Modify: `packages/domain-contracts/src/index.ts`
- Modify: focused Agent and Intervention contract tests

- [ ] Write failing tests for the exact six dimensions/order, status/severity matrix, source revision shape, 24-hour expiry, no total score, bounded generic explanations, interventions and uncommitted drafts.
- [ ] Confirm RED is caused by missing contracts, then implement minimal strict Zod schemas and canonical source-set validation.
- [ ] Prove malformed/duplicate dimensions, free-form bodies, unknown keys, missing exact target revisions, impossible severity/source combinations and committed-action claims fail closed.
- [ ] Version only `relationship_radar` to `saas-212.v1`, set SourceArtifact evidence to optional/minimum zero, preserve `draft` mode and all three body-free output kinds, and prove old orphaned control cannot enable the new definition.
- [ ] Run focused and full domain type/test gates.

## Task 2: Add guarded dual-database snapshot expansion

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Create: `server/prisma/postgres/legacy/20260831_pre_saas212.prisma`
- Create: `server/prisma/postgres/migrations/20260831235900_expand_relationship_radar/migration.sql`
- Create: `server/src/relationshipRadar/migration.ts`
- Create: `server/scripts/migrate-relationship-radar.ts`
- Create: `server/scripts/postgres-relationship-radar-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify under explicit owner approval: `scripts/test-postgres-ops-integration.sh`
- Create/modify focused migration, schema-render, SQLite-upgrade and PostgreSQL-operations tests

- [ ] Write RED tests for exact predecessor/successor schemas, immutable defaults, marker-last adoption, interrupted creation, semantic/marker/partial drift, authenticated restore and fresh install/second update.
- [ ] Add the portable table/indexes and marker `SAAS-212-relationship-radar-v1`; never backfill, rewrite or delete CRM/Agent rows.
- [ ] Wire backup-first SQLite report/apply/verify and versioned PostgreSQL `migrate deploy`; reject an unprovable non-empty or malformed pre-existing table.
- [ ] Extend only the approved root operations script and preserve every prior migration marker plus `POSTGRES_OPS_INTEGRATION_OK=1`.

## Task 3: Implement deterministic six-dimension rule preparation

**Files:**
- Create: `server/src/relationshipRadar/model.ts`
- Create: `server/src/relationshipRadar/rules.ts`
- Create: `server/src/relationshipRadar/handler.ts`
- Create/modify focused rule, scope, corruption and no-formal-write tests

- [ ] Write RED tests for every threshold boundary, exact source revision, deterministic ordering/fingerprint, missing sources, archived/drifted parents, single-thread/coverage/warm-path edge cases and no aggregate score.
- [ ] Load one current Customer/Matter under tenant, current role, `sales.workspace` and EffectiveResourceScope; read only current formal Interaction, MatterParticipant, Edge, approved Evidence, active IntelligenceItem, current StakeholderFocus and planned/completed Commitment metadata.
- [ ] Build exactly six signals, zero or more unified InterventionItems and bounded action drafts using server-owned generic prose. Do not parse source bodies, use Candidate/Hypothesis overlays as formal facts or call an LLM/provider.
- [ ] Prove handler preparation performs zero writes and remains deterministic for the same input revisions and observation time.

## Task 4: Add one narrow radar Agent commit port

**Files:**
- Modify: `server/src/agents/model.ts`
- Modify: `server/src/agents/runner.ts`
- Modify: `server/src/agents/registry.ts`
- Create: `server/src/relationshipRadar/adapter.ts`
- Modify: `server/src/app.ts`
- Create/modify focused registry, runner, adapter, idempotency and failure-rollback tests

- [ ] Write RED tests proving exactly one radar port call, output-ref/snapshot parity, one snapshot per AgentRun, canonical fingerprint, current authorization recheck, body-free AgentRun/Audit and full rollback on any validation failure.
- [ ] Add `relationship_radar` to the existing narrow commit-port union without exposing Prisma or a general writer to the handler. Persist the immutable snapshot inside the runner's serializable transaction only after commit-time scope/source reauthorization.
- [ ] Validate that every `relationship_signal`, `intervention_item` and `draft_action` output ref corresponds to the committed snapshot and budget; reject missing, duplicate, foreign or handler-authored refs.
- [ ] Register the deterministic production handler/adapter. Viewer manual runs and owner/admin/member runs after role downgrade fail before AgentRun/Audit; enable/disable remains owner/admin only and the new version defaults disabled.

## Task 5: Project current radar and traceable sources

**Files:**
- Create: `server/src/relationshipRadar/service.ts`
- Create: `server/src/relationshipRadar/routes.ts`
- Modify: `server/src/today.ts`
- Modify: `server/src/app.ts`
- Create/modify focused snapshot, route, current-role, viewer-scope, source-drill and Today provider tests

- [ ] Write RED tests for latest unexpired snapshot selection, tenant/customer/matter closure, creator-independent authorized read, viewer ownership scope, source drift/revocation downgrade, expired snapshot omission and no read-side writes.
- [ ] Add a strict current radar read route and source resolver. Resolve Matter, Interaction, Relation, Evidence, IntelligenceItem, StakeholderFocus and Commitment metadata only after current authority/revision checks; return bounded metadata, never Evidence/source body or secret fields.
- [ ] Rebuild visible explanations and intervention targets from current formal metadata. Missing or stale sources downgrade the signal to `unknown/low`; interventions without exact current drillable refs are omitted.
- [ ] Feed only current revalidated radar interventions into Today, preserve `待确认 / 待跟进 / 已完成`, existing core ordering and provider isolation, and deduplicate the no-next-step radar item against `matter_without_next_commitment`.
- [ ] Prove `/api/today/source` returns 404 after revocation/drift and that Today/radar reads create no AgentRun, AuditEvent, CommandRun or formal CRM writes.

## Task 6: Add relationship-radar workspace UI

**Files:**
- Create: `app/src/lib/relationshipRadar.ts`
- Create: `app/src/components/RelationshipRadarPanel.tsx`
- Modify: `app/src/components/RelationshipWorkspacePanel.tsx`
- Modify: `app/src/api.ts`
- Modify: `app/src/styles.css`
- Create/modify focused domain, transport, panel, workspace and Today tests

- [ ] Write RED tests for the six independent cards, status/severity copy, reason/source/time/ruleVersion/action, source drill, expiry state, disabled Job state, run lifecycle and absence of any aggregate score.
- [ ] Load relationship workspace, radar Job card/history and latest radar in parallel; use stable primitive effect dependencies and functional state updates, with no inline component definitions or duplicated derived state.
- [ ] Let owner/admin explicitly enable/disable and owner/admin/member run the Job; viewer sees only the current authorized projection and no write controls. A draft can prefill the existing Commitment editor only after an explicit click and is never auto-submitted.
- [ ] Render source-loss downgrade and expired/missing states without presenting unknowns as facts. Preserve responsive/dark-theme semantic variables and do not change navigation, App package/lock/Vite or generated `dist`.

## Task 7: Lock authority, recovery and scope evidence

**Files:**
- Modify: `packages/domain-contracts/src/authority.ts`
- Create: `docs/SAAS-212-关系雷达迁移与回滚说明.md`
- Create/modify static authority, production-boundary, demo and rollback tests

- [ ] Register `sales.relationship_signal` as the derived snapshot authority and exact SAAS-212 producers/consumers; keep Relation, Evidence, Focus, Commitment, stage, forecast and methodology authorities unchanged.
- [ ] Document backup-first SQLite and authenticated isolated PostgreSQL recovery. Rollback may disable the new Job and hide projections but must retain snapshots, marker, AgentRun/AuditEvent and migration history; no destructive drop or reinterpretation.
- [ ] Static tests reject total scores, Candidate/Hypothesis-to-formal promotion, `primaryDPersonId`, ADURC/G64111/pipeline fallbacks, automatic formal writes, sensitive text persistence, unapproved shared files and self-cultivation paths.

## Task 8: Verify, commit, push and wait for exact-SHA CI

- [ ] After package changes, run `npm ci --install-links` in `app/` and `server/` before downstream checks.
- [ ] Run focused RED→GREEN suites, then Domain typecheck/tests, Server generate/typecheck/full tests/schema render-check/migration operations, App typecheck/tests/build, G64111 typecheck/tests and PDE typecheck/tests.
- [ ] Inspect `git diff --check`, exact changed-file inventory, self-cultivation denylist and shared-file allowlist. Stage no generated `app/dist`, local database, logs, backups or artifacts.
- [ ] Create one independent business commit containing `SAAS-212`, push only `codex/g4-candidate-review-intelligence`, and wait until all required jobs for that exact SHA are green. Do not rerun a still-running suite and do not create/merge a PR or deploy.

## Task 9: Close governance only after the business gate

**Files:**
- Modify: `docs/商业版开发待办清单v1.md`
- Modify: this plan's task checkboxes/evidence only

- [ ] Record exact business SHA, test counts, 12/12 Actions run, migration marker and rollback document; mark `SAAS-212` `DONE` and `SAAS-209` `READY` only if every acceptance condition passes.
- [ ] Commit/push governance separately and wait for its exact SHA CI before reporting completion or starting SAAS-209.

## Acceptance gate

- [ ] Exactly six method-neutral RelationshipSignals appear independently with status, severity, reason, exact current source refs, observation/expiry time, rule version and suggested action; no total score exists.
- [ ] Every medium/high projected signal and every InterventionItem has sources and a target that drill down under the reader's current authority. Revoked, archived, drifted or inaccessible sources never leak and never increase severity.
- [ ] `relationship_radar@saas-212.v1` remains fail-closed until explicitly enabled, runs deterministically through one narrow draft port, persists one immutable body-free snapshot and performs zero formal CRM writes.
- [ ] Today retains exactly three top-level sections and core behavior while consuming only current revalidated radar items; no-next-step duplicates are suppressed.
- [ ] Viewer ownership isolation, write denial before audit, role-downgrade replay checks, tenant/parent closure and source ACL/revision checks pass for all new routes and runner paths.
- [ ] SQLite/PostgreSQL migration, interruption/adoption/drift/recovery/fresh-install gates, all local suites and exact-SHA remote CI are green.
- [ ] `SELF-CULTIVATION FILES TOUCHED` is `NONE`; `PRODUCTION TOUCHED` is `NO`; only approved shared file `scripts/test-postgres-ops-integration.sh` is changed.

## Out of scope

- Portfolio ordering, 4–5 Matter aggregation, cross-Matter attention ranking or team portfolio views (`SAAS-209`/later).
- G64111 or another methodology pack installation, scoring, role inference, ADURC or primary-D compatibility fallback (`SAAS-210`/later).
- Automatic Commitment creation/submission, Relation acceptance, Evidence creation, Focus/stage/forecast/key-person updates, AI-provider calls or source-body analysis.
- Production, Aliyun, Mac mini deployment, root homepage/public-site work, navigation/shared build configuration, PR/main merge or self-cultivation changes.
