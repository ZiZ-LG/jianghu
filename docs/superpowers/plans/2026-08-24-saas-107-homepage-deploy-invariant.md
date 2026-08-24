# SAAS-107 Homepage Deployment Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a legacy-CRM-to-public-root deployment fail closed, record the verified three-site production mapping, and define a versioned/atomic release contract without touching production or the protected self-cultivation source line.

**Architecture:** A committed JSON target registry is the machine authority for site identity and deployment destinations. A dependency-free Node verifier inspects actual artifact contents, referenced assets, source provenance, and a stable checksum; a shell release guard consumes only a successful verifier result and refuses activation while the public-home source or live atomic-pointer authority is unresolved. Human-facing deployment documentation records the incident, current runtime topology, rollback requirements, and the exact future gate for enabling an atomic release.

**Tech Stack:** Node.js ESM with built-in `node:test`, SHA-256, Bash, Git, SSH, Nginx/Docker topology documentation.

## Global Constraints

- Production is read-only for SAAS-107; no Aliyun container, symlink, static file, Nginx config, database, DNS, or certificate may be changed.
- `https://lake2ocean.top/` must identify as the public homepage and must not redirect to or render the legacy CRM.
- `https://crm.lake2ocean.top/` remains the only verified CRM public entry; the legacy CRM is retained for rollback and receives no feature work.
- `https://stephen.lake2ocean.top/` and every protected self-cultivation path remain byte-for-byte outside this task.
- Do not modify `app/package.json`, `app/package-lock.json`, Vite config, `app/dist/**`, `docker-compose.yml`, shared Nginx config, or existing shared CI workflows.
- Do not claim atomic activation is available while the live edge image embeds static files and does not consume an authoritative `current` pointer.
- No schema, migration, tenant data, RBAC, Action contract, AI candidate flow, key, or production database is in scope.
- `CORE-201`/G4 remains `PENDING`; SAAS-107 is deployment governance only.

---

### Task 1: Start SAAS-107 under the commercial checklist gate

**Files:**
- Create: `docs/superpowers/plans/2026-08-24-saas-107-homepage-deploy-invariant.md`
- Modify: `docs/商业版开发待办清单v1.md`

**Interfaces:**
- Consumes: `origin/main` SHA `81da993d76ce422eac89227aa6e8183314812d04`, owner approval in the CRM task, and the rule that only one CRM task may be `IN_PROGRESS`.
- Produces: one `SAAS-107 = IN_PROGRESS` row and an audit entry tied to branch `codex/saas-107-homepage-deploy-invariant`.

- [x] **Step 1: Record the approved scope**

Add SAAS-107 after SAAS-106 with dependency SAAS-106 and state `IN_PROGRESS`; keep CORE-201 `PENDING`.

- [x] **Step 2: Check the single-task invariant**

Run:

```bash
rg -n 'IN_PROGRESS' docs/商业版开发待办清单v1.md
```

Expected: the current-focus line and the SAAS-107 current/history entries describe the same single CRM task; no other current task row is `IN_PROGRESS`.

- [x] **Step 3: Commit the governance start record**

```bash
git add docs/superpowers/plans/2026-08-24-saas-107-homepage-deploy-invariant.md docs/商业版开发待办清单v1.md
git commit -m "docs(SAAS-107): start homepage deployment invariant"
```

### Task 2: RED — specify artifact identity and provenance behavior

**Files:**
- Create: `scripts/verify-public-site-artifact.test.mjs`
- Create later: `deploy/public-site-targets.json`
- Create later: `scripts/verify-public-site-artifact.mjs`

**Interfaces:**
- Consumes: CLI arguments `--site`, `--artifact`, `--source-dir`, `--source-sha`, `--build-command`, and optional `--for-deploy`.
- Produces: JSON on stdout with `siteId`, `sourceSha`, `buildCommand`, `artifactPath`, `artifactChecksum`, `destinationHost`, `destinationPath`, `canonicalUrl`, `title`, and `deployAllowed`; errors use prefix `PUBLIC_SITE_ARTIFACT_ERROR=` and a non-zero exit.

- [ ] **Step 1: Write real CLI integration tests with temporary artifacts**

Use `node:test`, `mkdtempSync`, real files, and `spawnSync(process.execPath, [...])`. Cover these observable breaks:

1. a public-home artifact with the exact title, all four navigation labels, CRM URL, ICP number, police number/icon, and valid referenced assets passes inspection and emits a stable checksum;
2. a legacy CRM artifact targeted at public-home fails because its title/markers identify the wrong product;
3. a missing referenced asset fails closed;
4. a symlink or special file inside the artifact fails closed;
5. an unknown or dirty/mismatched source SHA fails closed;
6. `--for-deploy` fails while the registry says either source authority or atomic runtime authority is unresolved;
7. CRM and self-cultivation targets cannot be deployed by the public-edge guard.

- [ ] **Step 2: Run the test and observe RED**

```bash
node --test scripts/verify-public-site-artifact.test.mjs
```

Expected: FAIL because `deploy/public-site-targets.json` and `scripts/verify-public-site-artifact.mjs` do not exist.

### Task 3: GREEN — implement the machine target registry and verifier

**Files:**
- Create: `deploy/public-site-targets.json`
- Create: `scripts/verify-public-site-artifact.mjs`
- Modify: `scripts/verify-public-site-artifact.test.mjs`

**Interfaces:**
- `deploy/public-site-targets.json` schema version is `1` and has exactly `public-home`, `crm`, and `self-cultivation` targets.
- Each target declares canonical URL, source/build/artifact mapping, exact title, required/forbidden markers, destination host/path, Aliyun version root, Nginx server/location, manager, and deployment authority state.
- `public-home.deployment.sourceAuthority = "unresolved"` and `public-home.deployment.atomicRuntimeAuthority = false` until a separately approved source/Nginx task closes both facts.

- [ ] **Step 1: Add the smallest registry that captures verified reality**

The public target records the current recovery lineage (`f4ef4a93adf4a795428233e4275139c14b2369e4` plus the filing-footer correction) but does not mislabel it as a reproducible main build. CRM maps `app/ → npm run build → app/dist/ → crm.lake2ocean.top`; self-cultivation maps its protected source/build/output and is marked `manager = "self-cultivation-thread"`.

- [ ] **Step 2: Implement strict argument, Git provenance, and artifact-tree checks**

The verifier must:

- require a 40-character lowercase Git SHA and verify `source-dir` HEAD equals it;
- reject tracked or untracked source changes;
- reject symlinks, sockets, devices, and files outside regular directories;
- require `index.html`, exact title, all declared markers/URLs, absence of forbidden markers and meta-refresh/JavaScript auto-navigation indicators;
- parse local `src`/`href` references and require every referenced file;
- hash sorted `relativePath + NUL + size + NUL + fileSha256` entries into one stable directory SHA-256;
- never print file contents, environment values, keys, or secrets;
- make `--for-deploy` fail unless source authority is authoritative, atomic runtime authority is true, and the target is managed by the public-edge release guard.

- [ ] **Step 3: Run GREEN and mutation checks**

```bash
node --test scripts/verify-public-site-artifact.test.mjs
```

Expected: all tests pass. Then temporarily change a fixture title, remove a nav marker, replace an asset with a symlink, and set a mismatched SHA through the existing table-driven cases; each case must remain a non-zero result.

### Task 4: RED/GREEN — add a fail-closed Aliyun release guard

**Files:**
- Create: `deploy/aliyun-edge-release.sh`
- Create: `scripts/aliyun-edge-release.test.sh`

**Interfaces:**
- Consumes the same source/artifact arguments as the verifier plus `--site public-home` and optional `--execute`.
- Produces a preflight block containing source SHA, build command, artifact path/checksum, destination host/path, canonical URL, and title.
- Without `--execute`, it is read-only.
- With `--execute`, it must still fail before SSH while either registry authority gate is closed; no override environment variable or alternate registry argument exists.

- [ ] **Step 1: Write the failing shell integration test**

Run the real guard against the valid temporary public fixture. Assert that plan mode prints all provenance fields, a wrong artifact fails before any fake SSH binary is invoked, and `--execute` fails with `PUBLIC_SITE_RELEASE_BLOCKED` while current authority gates are closed.

```bash
bash scripts/aliyun-edge-release.test.sh
```

Expected: FAIL because `deploy/aliyun-edge-release.sh` does not exist.

- [ ] **Step 2: Implement the minimal guarded launcher**

The launcher calls the Node verifier, prints its JSON-derived provenance, requires the literal confirmation token `HOMEPAGE_DEPLOY_APPROVED=YES` for `--execute`, and then asks the verifier for `--for-deploy`. Because the committed registry is blocked, current execution stops before any `ssh`, `scp`, `tar`, Docker, symlink, Nginx, or curl mutation. The script documents, but does not fake, the future contract: immutable version directory, same-filesystem temporary link plus atomic rename, previous pointer retention, post-switch full three-site smoke, and rollback/re-smoke on any failure.

- [ ] **Step 3: Run GREEN and syntax checks**

```bash
bash scripts/aliyun-edge-release.test.sh
bash -n deploy/aliyun-edge-release.sh scripts/aliyun-edge-release.test.sh
```

Expected: all checks pass and the fake SSH sentinel remains untouched.

### Task 5: Make the deployment guide authoritative for the three-site topology

**Files:**
- Create: `docs/部署-公网三站与主页不变量.md`
- Modify: `docs/部署上线指南.md`

**Interfaces:**
- Consumes: the committed registry and read-only evidence from the active Aliyun edge/CRM containers.
- Produces: one human authority page with the exact product/source/build/artifact/URL/version/Nginx matrix, incident facts, rollback sequence, and enablement gates.

- [ ] **Step 1: Write the incident and invariant record**

Record that `app/dist` from `npm run build` produced the legacy CRM title/bundle and was copied into `/usr/share/nginx/jianghu`, where the root Nginx fallback served it. State explicitly that restoring the homepage did not delete the legacy CRM or data.

- [ ] **Step 2: Write current and target deployment matrices**

Include the three sites, the unresolved public-home source lineage, the active embedded-image fact, CRM Compose release directory, protected self-cultivation mapping, exact Nginx server/location behavior, and the rule that filenames alone never prove identity.

- [ ] **Step 3: Write preflight, switch, smoke, and rollback gates**

Require source SHA/build/artifact/checksum/destination/title confirmation; immutable version directories; no delete-current-first; public root/CRM/self-cultivation/ICP/police/API/login/health checks; immediate rollback and root+self-cultivation re-check on failure. State that enabling the switch requires a separate owner-approved shared Nginx/source task.

- [ ] **Step 4: Replace stale top-level guidance with a pointer to the authority page**

Keep historical generic Compose instructions clearly labeled as CRM-service guidance and make the three-site authority page the first stop for production routing or public-edge releases.

### Task 6: Verify, push, wait for exact-SHA CI, and close SAAS-107

**Files:**
- Modify: `docs/商业版开发待办清单v1.md`

**Interfaces:**
- Consumes: all SAAS-107 tests and the protected/shared-path diff audit.
- Produces: one implementation commit, one CI-backed completion record, a feature branch/PR, and no production mutation.

- [ ] **Step 1: Run the complete local gate**

```bash
node --test scripts/verify-public-site-artifact.test.mjs
bash scripts/aliyun-edge-release.test.sh
node --check scripts/verify-public-site-artifact.mjs
bash -n deploy/aliyun-edge-release.sh scripts/aliyun-edge-release.test.sh
git diff --check
git status --short
```

Additionally verify the diff contains no protected self-cultivation path and none of `app/package.json`, `app/package-lock.json`, Vite config, `app/dist/**`, `docker-compose.yml`, shared Nginx, or common CI.

- [ ] **Step 2: Re-run live read-only homepage smoke**

Confirm public-home title/nav/no redirect, CRM entry/API/login, self-cultivation title/resources, ICP, police number/icon, and health endpoints. No SSH write command is permitted.

- [ ] **Step 3: Commit and push the implementation**

```bash
git add deploy/public-site-targets.json deploy/aliyun-edge-release.sh scripts/verify-public-site-artifact.mjs scripts/verify-public-site-artifact.test.mjs scripts/aliyun-edge-release.test.sh docs/部署上线指南.md docs/部署-公网三站与主页不变量.md
git commit -m "feat(SAAS-107): guard public homepage deployments"
git push -u origin codex/saas-107-homepage-deploy-invariant
```

- [ ] **Step 4: Wait for the implementation commit's exact SHA CI**

Use `gh run list`/`gh run view` and require every job for that exact SHA to succeed. Do not infer success from another branch or parent SHA.

- [ ] **Step 5: Close the checklist in a docs-only commit**

Mark SAAS-107 `DONE`, restore “CRM no IN_PROGRESS”, record the implementation SHA, tests, CI run URL, no-production statement, and next gate. Push the docs-only commit and require its exact SHA CI to succeed before reporting completion or starting anything else.

## Stop Conditions

- If public-home becomes deployable only by editing app/Vite/shared Nginx/CI or any self-cultivation path, stop and request separate owner approval with exact files.
- If a current production check differs from the registry, stop; do not loosen markers or destination checks to make it pass.
- If any test, syntax check, exact-SHA CI job, homepage, CRM, self-cultivation, ICP, police icon, API, login, or health check fails, SAAS-107 stays `IN_PROGRESS` and production remains untouched.
