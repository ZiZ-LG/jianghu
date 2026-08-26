# SAAS-607 Stephen Static Release Pipeline Implementation Plan

> **Execution mode:** implement in this isolated worktree with test-driven changes and fresh verification. First production enablement remains separately gated.

**Goal:** Build the Stephen static site from an exact green `main` SHA, produce a checksummed release bundle, stage it on Aliyun, and provide a fail-closed atomic activation/rollback path without changing the current production runtime during SAAS-607 acceptance.

**Architecture:** A dedicated GitHub `workflow_run` pipeline follows a successful `CI` run for an exact `main` SHA, independently confirms `Stephen checks`, relevant-path scope, repository identity, and that the SHA is still the current `origin/main`. A repository variable keeps the production job disabled by default; once separately enabled, environment-scoped SSH credentials use a forced-command dispatcher to upload a versioned archive. A root-owned, fixed-path remote helper validates an immutable copy, then performs a leased two-phase activation: persist the exact restore state, arm a server-side expiry rollback, atomically switch `current`, and expose exact release identity. External smoke and a fresh authorization check must pass before `finalize`; explicit rollback, timer expiry, and boot recovery close runner-loss paths.

**Tech stack:** GitHub Actions (`ubuntu-latest`), Node.js 22/TypeScript, Vitest, Bash, OpenSSH, GNU tar, SHA-256, existing Dockerized Nginx.

## Confirmed baseline and non-negotiable boundaries

- Source baseline: `origin/main@dab9c6e3e05a5dac7fdbac28db1778cafcef2cb5`.
- Worktree: `.worktrees/stephen-release-pipeline`; branch: `codex/stephen-release-pipeline`.
- Existing production image: `zizai-site:public-security-filing-corrected-81da993`; Stephen files are embedded at `/usr/share/nginx/jianghu/stephen` and no host `current` pointer is consumed.
- Existing version root is `/home/admin/jianghu/deployments`, but `/home/admin` is mode `0700`; it cannot be reused safely by a dedicated deploy user.
- Proposed future runtime root is `/srv/jianghu/stephen`, mounted as the parent directory into the Nginx container so the container resolves `current` after every atomic switch. Creating that mount and switching the live Nginx root are **not** authorized in SAAS-607.
- No CRM, server, shared package, lockfile, `app/package.json`, `docker-compose.yml`, `ci.yml`, DNS, Nginx runtime, schedule enablement, or production traffic mutation.
- `STEPHEN_RELEASE_ENABLED` remains absent/off. `production-stephen` secrets, including the fine-grained read-only release-control token required by GitHub's Variables API, are documented but not created by code.
- A non-`current` version-directory upload dry-run is authorized; no `current` or `previous` link may be created or changed.
- SAAS-606 review manifests are not yet equivalent to the public content contract: they remain `pending_owner_review / not_published` and do not contain the full two-fact approval payload. SAAS-607 must not silently promote them or claim candidate-only merges publish content.

## Task 1: Release artifact contract

**Files:**

- Create `app/stephen/scripts/stephen-release.ts`
- Create `app/stephen/src/content/release.test.ts`
- Modify `app/stephen/scripts/node-runtime.d.ts` only for Node APIs actually used

Steps:

1. Write failing tests that name the observable breaks: wrong SHA, missing required files, symlinked artifact members, missing ICP/public-security markers, candidate-state leakage, missing item detail routes, and nondeterministic directory checksum.
2. Run the focused test and record the expected missing-module failure.
3. Implement bounded artifact traversal, exact SHA validation, required marker checks, sitemap-derived smoke paths, and deterministic per-file SHA-256 metadata.
4. Add a CLI that validates the built directory and writes `.stephen-release.json` plus a secret-free JSON summary.
5. Run focused tests to green and mutation-check the validation branches.

## Task 2: Remote stage, activation, and rollback helper

**Files:**

- Create `deploy/stephen-remote-release.sh`
- Extend `app/stephen/src/content/release.test.ts`

Steps:

1. Write failing black-box tests for missing uploads, checksum mismatch, unsafe tar members, idempotent staging, Nginx precheck failure preserving `current`, atomic activation, and rollback restoring `previous`.
2. Implement a strict command surface: `stage`, leased `activate`, `finalize`, `rollback`, internal `expire`/`recover`, and `status`; accept only a 40-character lowercase SHA, 64-character lowercase checksum, and 32-character lowercase lease as applicable.
3. Fix the production root to `/srv/jianghu/stephen`; allow an explicit non-root temporary test root only in test mode, and reject test mode as root.
4. Serialize mutations with `flock`; copy uploads with `O_NOFOLLOW` into a bounded root-owned archive; stream-preflight tar count/size/type against the client artifact limits; enforce incoming/release-store/free-space quotas; extract through a same-filesystem temporary directory; never overwrite an existing mismatched release.
5. Require the installed production helper and forced SSH dispatcher to be root-owned and non-writable by the deploy user. Before switching, prove the edge container sees the mounted parent, its Nginx root is `/srv/stephen/current`, and exact release identity is served.
6. Arm a 30-minute server timer before persisting pending restore state and link switching; only `finalize` after external smoke, with explicit rollback, expiry, and retrying boot recovery paths.
7. Run focused tests plus a disposable GitHub-hosted production-root stage probe to green.

## Task 3: Exact-green-SHA GitHub release workflow

**Files:**

- Create `.github/workflows/stephen-release.yml`
- Extend `app/stephen/src/content/release.test.ts`

Steps:

1. Write failing executable workflow-contract tests for `ubuntu-latest`, `workflow_run` after `CI`, exact repository/main/SHA checks, independent `Stephen checks` success, relevant paths, minimal `actions: read` and `contents: read`, concurrency, timeout, environment use, opt-in variable, known-host verification, and forbidden unsafe SSH settings.
2. Implement an eligibility job that never reads production secrets and skips stale or irrelevant SHAs.
3. Revalidate the repository variable and current `origin/main` with an Environment-scoped, fine-grained read-only control token after Environment wait, before activation, and before finalize so approvals or queued runs cannot release a stale SHA. The built-in `GITHUB_TOKEN` cannot read the repository Variables API and must not be treated as proof of this permission.
4. Implement the environment-scoped release job: `npm ci --install-links`, both Stephen TypeScript checks, Stephen Vitest, `build:stephen`, artifact validation, archive/checksum creation, forced-command SSH upload/stage, leased activation, exact `/release-id.json` verification, and required public/shared-host smoke checks.
5. On any post-activation smoke or authorization failure, call the fixed leased rollback command and verify the restored Stephen and shared-host surfaces before failing the run. If the runner disappears, rely on the armed server timer rather than treating SSH response loss as success.
6. Do not upload GitHub artifacts or print secrets; remove temporary private-key files with a trap.

## Task 4: Runbook and manual first-enable prerequisites

**Files:**

- Modify `docs/content/stephen-daily-editorial-runbook.md`
- Create `docs/content/stephen-release-runbook.md`

Steps:

1. Document the exact GitHub variable and `production-stephen` secret names without values.
2. Document generation of a dedicated Actions SSH key, known-host capture from a trusted console, forced-command authorized key, dedicated user creation, root-owned helper/dispatcher/recovery-service installation, narrow sudoers rule, directory ownership, and parent bind-mount/Nginx-root migration.
3. Keep the first production gate explicit: repository variable off, no live mount/root change, no `current` switch, and no automatic release until the owner says `批准首次生产启用`.
4. Record the candidate-to-public-content gap as a separate prerequisite rather than weakening the two-fact content gate.

## Task 5: Verification, non-current Aliyun dry-run, commit, and push

1. Run all focused release tests and prove the intentional RED-to-GREEN transitions.
2. Run fresh complete Stephen verification:

   ```bash
   cd app
   npx tsc --noEmit -p stephen/tsconfig.json
   npx tsc --noEmit -p stephen/tsconfig.editorial.json
   npx vitest run --root stephen
   npm run build:stephen
   ```

3. Build an exact-SHA archive and checksum locally. Stage it to a unique non-`current` dry-run directory on `47.95.13.214`; verify checksum, metadata, required files, and read-only public URLs. Do not install the helper, create links, reload Nginx, or touch the running container.
4. Run `git diff --check`, scope/secret scans, and confirm the root worktree/user files are unchanged.
5. Commit with `SAAS-607`, push normally, and wait for exact-head `CI` and `Stephen checks` to pass.
6. Report the branch, commit, changed files, tests, remote CI links, dry-run evidence, required manual configuration, and the next production gate. Do not create or merge a PR unless separately requested.
