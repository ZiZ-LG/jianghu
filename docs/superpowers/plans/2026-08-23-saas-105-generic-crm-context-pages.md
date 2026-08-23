# SAAS-105 Generic CRM Context Pages Implementation Plan

> **Execution rule:** Implement only after the SAAS-104 documentation checkpoint `5dc9fe6c793d2a1464caf670a3da9e06fbaaef7f` has passed its exact remote CI run. Follow the tasks in order, preserve RED evidence before production changes, and run the full verification matrix before committing.

**Goal:** Replace the commercial Customer and Matter placeholders with usable, methodology-neutral Customer/Matter/Relation context pages backed by a strict scoped DTO projection. `general`, `sales_opportunity`, and unknown open kinds must remain readable; the relation context must never block Quick Capture or the rest of the page.

**Architecture:** Add strict `PersonSummaryV2`, `MatterParticipantV2`, `RelationV2`, and `CrmContextSnapshot` contracts beside the existing `CustomerV2` and `MatterV2` contracts. A new authenticated `crm.core` read route selects only generic fields through `resolveEffectiveResourceScope`; it does not call the legacy full-state assembler and therefore does not read or serialize `customerType`, `pipelineStage`, `engageStage`, `primaryDPersonId`, ADURC, L1-L4, G64111, PDE, notes, logs, evidence, or source bodies. The commercial shell loads this snapshot at the Customer or Matter entry and renders list/detail/relation views with an always-available Quick Capture action. Existing internal `CustomerHub` and `Canvas` remain unchanged.

**Tech stack:** TypeScript, Zod domain contracts, Fastify/Prisma read model, React/Vite, Vitest, existing semantic CSS variables.

---

## Scope and hard boundaries

- Worktree: `/Volumes/PowerData/江湖APP/.worktrees/g3-lightweight-personal-crm`
- Branch: `codex/g3-lightweight-personal-crm`
- Do not reset, checkout, rebase, switch branches, merge `main`, deploy, or modify production data.
- Do not modify `app/package.json`, `app/package-lock.json`, `app/vite.config.*`, `app/dist/**`, `docker-compose.yml`, main-site navigation, cross-site entry points, or any owner-reserved “自我修养” path.
- Do not add or alter Prisma schema or migrations. Existing `Account`, `Opportunity`, `Person`, `MatterParticipant`, and `Edge.kind` rows remain the only physical sources.
- Do not add Customer/Matter/Relation write commands. Customer creation and follow-up creation continue through the existing audited Quick Capture/CRM command paths.
- Do not make `Edge.layer`, roles, sales stages, G64111, PDE, WorkBuddy, or methodology bindings generic page dependencies.
- Do not change the four commercial Free navigation entries. Relation context is entered from Customer/Matter detail, not a fifth top-level navigation item.
- Do not implement SAAS-106 validation artifacts or any G4 capability.

## DTO and visibility invariants

1. `CustomerV2`, `MatterV2`, `PersonSummaryV2`, `MatterParticipantV2`, and `RelationV2` use stable physical IDs but expose only neutral fields.
2. `RelationV2.kind` is an open non-empty string. Unknown values are preserved and displayed with a neutral fallback; `layer` is not part of the DTO.
3. `CrmContextSnapshot` is strict and referentially closed: every Matter/Person belongs to a returned Customer; every participant and relation points to returned parents/endpoints; relation endpoints belong to the same Customer; Matter-scoped relations point to a returned Matter under that Customer.
4. Every query is filtered by `tenantId`, active parent rows, and the current database-backed `EffectiveResourceScope`.
5. Full-Customer scope may include all active people and Customer-level relations. A container-only Customer reached through a visible Matter includes only visible Matters plus people/participants/relations referenced by those Matters; Customer-level relations and unrelated people remain hidden.
6. Viewer/member role or ownership changes take effect on the next request. JWT role is not trusted for scope.
7. The endpoint returns `Cache-Control: private, no-store`. The client parses the strict schema before rendering and shows a recoverable error on malformed responses.
8. Empty or filtered relation data renders an empty relation context while Customer/Matter detail and Quick Capture remain available.

---

### Task 1: Publish the strict generic CRM context contract

**Files:**
- Modify: `packages/domain-contracts/src/crm.ts`
- Modify: `packages/domain-contracts/tests/crm.test.ts`
- Modify: `packages/domain-contracts/tests/g64111-off.compile.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that require:

- `RelationV2Schema` to accept an unknown open kind and reject `layer`, role, sentiment, or other sales-only fields;
- `CrmContextSnapshotSchema` to accept one Customer containing both `general` and `sales_opportunity` Matters;
- strict rejection of unknown top-level/row fields;
- rejection of duplicate IDs, missing Customer/Matter/Person references, cross-Customer endpoints, and a Matter-scoped relation whose Matter belongs to another Customer;
- the G64111-off compile fixture to construct the full snapshot without any 1..4 classification, ADURC, L1-L4, stage, `engageStage`, or primary-D value.

Run and preserve RED:

```bash
cd packages/domain-contracts
npx vitest run tests/crm.test.ts
npx tsc --noEmit --pretty false
```

Expected: missing schemas/types fail before production changes.

- [ ] **Step 2: Implement neutral schemas and referential validation**

Add and export:

- `PersonSummaryV2Schema` / `PersonSummaryV2`;
- `MatterParticipantV2Schema` / `MatterParticipantV2`;
- `RelationV2Schema` / `RelationV2`;
- `CrmContextSnapshotSchema` / `CrmContextSnapshot`.

Use the existing canonical UTC/open key/version helpers. Keep every object strict. Validate uniqueness and complete parent/reference integrity in `superRefine` without importing any sales or methodology enum.

- [ ] **Step 3: Run focused GREEN**

```bash
cd packages/domain-contracts
npx vitest run tests/crm.test.ts
npx tsc --noEmit --pretty false
```

Expected: contract tests and compile fixture pass.

---

### Task 2: Build the tenant-scoped generic read model and route

**Files:**
- Create: `server/src/crmContext.ts`
- Create: `server/tests/crm-context.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/product-capabilities.test.ts`

- [ ] **Step 1: Write failing server tests**

Cover at minimum:

1. unauthenticated `GET /api/crm/context` returns 401;
2. authenticated commercial Free returns 200, `private, no-store`, and a valid strict snapshot;
3. a Customer with `general`, `sales_opportunity`, and an unknown Matter kind preserves all three while the JSON contains none of `customerType`, `pipelineStage`, `engageStage`, `primaryDPersonId`, `roles`, `layer`, `G64111`, or `PDE`;
4. an unknown Relation kind round-trips while `layer` and sales styling are absent;
5. a scoped member with only Matter ownership sees the Customer container, visible Matter, referenced people, participants, and Matter relation, but not Customer-level relations, unrelated people, or sibling Matters;
6. owner/admin and viewer positive cases follow the live resolver; a role/ownership change immediately narrows the next response;
7. cross-tenant, wrong-Customer, dangling endpoint, archived parent, and out-of-scope rows never appear;
8. malformed runtime product configuration denies the route, while internal remains allowed.

Run and preserve RED:

```bash
cd server
npx vitest run tests/crm-context.test.ts tests/product-capabilities.test.ts
```

Expected: missing route/read model fails.

- [ ] **Step 2: Implement `buildCrmContextSnapshot`**

Use injectable `DbClient` for tests and `resolveEffectiveResourceScope` as the only Customer/Matter set authority. Select only:

- Account: `id`, `name`, `categoryKey`, `primaryOwnerUserId`, `version`;
- Opportunity: `id`, `accountId`, `name`, `kind`, `lifecycleStatus`, `outcomeKey`, `priority`, `targetDate`, `primaryOwnerUserId`, `version`;
- Person: `id`, `accountId`, `name`, `title`, `version`;
- MatterParticipant: `accountId`, `opportunityId`, `personId`;
- Edge: `id`, `accountId`, `opportunityId`, `source`, `target`, `kind`, `label`, `directed`, `version`.

Do not select legacy sales/methodology columns. Filter every row against the returned parent maps before schema parsing. For container-only Customers, null the Customer owner and exclude Customer-level relations/unrelated people.

- [ ] **Step 3: Register the route and capability ownership**

Add `GET /api/crm/context` with `app.authenticate`, no-store caching, and `crm.core` service classification. Register it before the `/api/state` routes without broadening any other URL pattern.

- [ ] **Step 4: Run focused GREEN**

```bash
cd server
npx tsc --noEmit --pretty false
npx vitest run tests/crm-context.test.ts tests/product-capabilities.test.ts
```

Expected: all new route, scope, redaction, and capability tests pass.

---

### Task 3: Add fail-closed client loading and neutral presentation helpers

**Files:**
- Modify: `app/src/api.ts`
- Modify: `app/src/api.test.ts`
- Create: `app/src/lib/crmContext.ts`
- Create: `app/src/lib/crmContext.test.ts`

- [ ] **Step 1: Write failing client tests**

Require:

- `api.crmContext()` to accept a valid strict snapshot and reject extra sales fields, dangling references, cross-Customer relations, or malformed kinds;
- neutral labels for known `general`, `sales_opportunity`, lifecycle states, and known relation kinds;
- unknown Matter/Relation/category keys to return a stable neutral label that preserves the raw key;
- selectors for Customer-level and Matter-level context to include the correct relations/people without reading legacy Account/Opportunity fields;
- an empty relation set to remain a valid context.

Run and preserve RED:

```bash
cd app
npx vitest run src/api.test.ts src/lib/crmContext.test.ts
```

Expected: missing API method/helpers fail.

- [ ] **Step 2: Implement strict parsing and pure selectors**

Parse the unknown response with `CrmContextSnapshotSchema.parse`. Add pure, deterministic helpers for display labels, Customer/Matter lookup, scoped people/relations, and relation graph ordering. Do not accept `Account`, `Opportunity`, `Edge.layer`, roles, or methodology data as input types.

- [ ] **Step 3: Run focused GREEN**

```bash
cd app
npx tsc --noEmit --pretty false
npx vitest run src/api.test.ts src/lib/crmContext.test.ts
```

Expected: client contract and helper tests pass.

---

### Task 4: Replace Customer/Matter placeholders with usable generic pages

**Files:**
- Create: `app/src/components/CrmContextPages.tsx`
- Create: `app/src/components/CrmContextPages.test.tsx`
- Modify: `app/src/components/CommercialShell.tsx`
- Modify: `app/src/components/CommercialShell.test.ts`
- Modify: `app/src/styles.css`

- [ ] **Step 1: Write failing component tests**

Test supplied valid snapshots without network timing:

- Customer list and detail show neutral Customer fields, people and Matters;
- Matter list renders `general`, `sales_opportunity`, and unknown kinds together, and Matter detail never requires a stage or methodology binding;
- Customer relation context shows only Customer relations; Matter relation context shows Customer plus selected-Matter relations with clear scope labels;
- unknown Relation kind is visible with a neutral fallback and no L1-L4 rendering;
- no-relations and no-people states preserve detail content and a “快速记录” action;
- commercial Free markup contains none of `G64111`, `趋赢力`, `ADURC`, `拍板人`, `主D`, `L1`, `L2`, `L3`, `L4`, `pipelineStage`, or `engageStage`;
- loading, strict parse/load failure, retry, empty snapshot, and focus refresh states are usable;
- top-level navigation remains exactly `今日 / 客户 / 事项 / 快速记录`;
- relation list/graph have accessible names and interactive controls meet the existing 44px target convention.

Run and preserve RED:

```bash
cd app
npx vitest run src/components/CrmContextPages.test.tsx src/components/CommercialShell.test.ts
```

Expected: missing pages fail.

- [ ] **Step 2: Implement the read-only page flow**

Build:

- one loader used by both Customer and Matter entries;
- list/detail navigation held inside the commercial page so it does not enter the legacy `/account/...` sales workspace;
- overview cards using only strict DTOs;
- a lightweight deterministic SVG relation context plus an always-visible accessible relation list;
- a Quick Capture button in every detail/empty relation state;
- retry and focus/visibility refresh without wiping an already valid snapshot on transient failure.

Keep the old `CustomerHub` and `Canvas` unchanged for internal/sales compatibility. Use semantic CSS variables and responsive grid/list behavior; no hard-coded theme colors.

- [ ] **Step 3: Run focused GREEN**

```bash
cd app
npx tsc --noEmit --pretty false
npx vitest run src/components/CrmContextPages.test.tsx src/components/CommercialShell.test.ts src/api.test.ts src/lib/crmContext.test.ts
```

Expected: component, route surface, API, and helper tests pass.

---

### Task 5: Cross-package and browser verification

**Files:**
- No additional production files unless a failing verification exposes an in-scope SAAS-105 defect.

- [ ] **Step 1: Refresh copied local package dependencies**

Because `packages/domain-contracts` uses `file:` copies, run without modifying package/lock files:

```bash
cd app
npm ci --install-links
cd ../server
npm ci --install-links
```

Immediately verify `git status --short`. If either package or lockfile changed, stop and report instead of staging it.

- [ ] **Step 2: Run the full local matrix**

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npx tsc --noEmit && npm test
cd ../server && npx tsc --noEmit && npm test
cd ../server && npm run schema:postgres:check
cd ../server && env DATABASE_URL=file:./validate.db npx prisma validate --schema prisma/schema.prisma
```

Build App into a disposable `/private/tmp` directory so `app/dist/**` remains untouched.

- [ ] **Step 3: Run browser QA against disposable local data**

Use a disposable SQLite database and verify at 390px mobile plus desktop, light plus dark:

1. Customer list → detail → Customer relation context → Quick Capture;
2. Matter list containing `general`, `sales_opportunity`, and an unknown kind → detail;
3. unknown Relation kind and both Customer/Matter relation scopes;
4. empty relation context does not block Customer/Matter detail or Quick Capture;
5. commercial Free has no G64111/ADURC/L1-L4/stage terminology;
6. viewer sees the read-only context but no write control beyond the existing read-only Quick Capture behavior;
7. keyboard focus, visible focus indicators, accessible relation list, 44px targets, no horizontal overflow, and no unexpected console/network errors;
8. force one context refresh failure and verify retained data plus explicit retry/recovery.

Save ignored screenshots/report under `.gstack/qa-reports/`; do not stage them.

- [ ] **Step 4: Review scope and placeholders**

Run `git diff --check`, inspect every changed path, scan for TODO/FIXME/placeholders and secrets, and confirm zero changes to protected/shared-conflict paths, schema, migrations, package/lock/Vite, self-cultivation paths, SAAS-106, and G4.

---

### Task 6: Independent commit, push, exact-SHA CI, and checklist closure

- [ ] **Step 1: Commit only the SAAS-105 implementation**

Stage the reviewed production/test/plan-excluded files only and commit:

```bash
git commit -m "feat(SAAS-105): add generic CRM context pages"
git push origin codex/g3-lightweight-personal-crm
```

Do not include the plan/checklist start checkpoint in this business commit. Record the full implementation SHA and wait for its exact GitHub Actions run to finish with every job successful.

- [ ] **Step 2: Close the checklist in a separate docs commit**

Only after implementation CI is green, change `SAAS-105` to DONE and `SAAS-106` to READY, append exact local/browser/remote evidence and rollback instructions, then commit and push:

```bash
git add docs/商业版开发待办清单v1.md
git commit -m "docs(SAAS-105): close generic CRM context gate"
git push origin codex/g3-lightweight-personal-crm
```

Wait for the docs commit’s exact SHA CI to finish successfully before starting SAAS-106.

---

## Rollback

- Before deployment, revert the SAAS-105 implementation commit to restore the commercial Customer/Matter placeholders; existing Today, Quick Capture, Commitment, internal `CustomerHub`, internal `Canvas`, and all business data remain intact.
- After deployment, the new endpoint/pages are read-only. Disable the commercial Customer/Matter context surface or forward-fix the projection; do not delete Account/Opportunity/Person/MatterParticipant/Edge rows or roll back CORE-105 fields/migrations.
- No schema, migration, audit, command, or business-row reversal is part of this task.

## Self-review

- **Spec coverage:** Covers general/sales/unknown Matter kinds, unknown Relation kinds, strict generic DTOs, scope/tenant/viewer behavior, relation context, no-graph continuity, no G64111 wording/dependency, mobile/dark/accessibility, and rollback.
- **Scope containment:** Adds a read-only core projection and commercial pages only; no shared build file, navigation registry, schema, migration, write command, internal page rewrite, SAAS-106, or G4 change.
- **Authority:** Account/Opportunity/Person/MatterParticipant/Edge remain the only sources. The endpoint uses the existing effective scope resolver and never establishes a second store or fallback read authority.
- **Placeholder scan:** Every planned production change names exact files, tests, commands, and expected behavior; no deferred implementation placeholder is accepted.
