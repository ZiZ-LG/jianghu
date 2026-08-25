# SAAS-606 Daily Candidate Draft PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天北京时间 07:30、16:30 从 SAAS-605 报告生成同日可复用的 GitHub Draft PR，让项目所有者在合并前删除不合格候选并完成人工审核。

**Architecture:** 新增纯 TypeScript 审核契约，将 SAAS-605 的扫描报告转换为非公开 `review-candidates` manifest、发现 ledger 和有界 PR Markdown；AI 字段只作为文案草稿，风险、审核状态和发布状态由确定性代码固定为人工待审与未发布。GitHub Actions 使用同日稳定分支、全局互斥、最小 `contents: write` / `pull-requests: write` 权限和 `gh` CLI 创建或更新 Draft PR；fixture 验收 PR 以功能分支为 base，不触碰 `main` 或公开内容。

**Tech Stack:** TypeScript、Node.js 22 strip-types、Vitest、GitHub Actions、GitHub CLI、Git。

## Global Constraints

- 只执行 `SAAS-606`，从 `origin/main@558d22a5971626eedd1cae42cddd45bccc10cb14` 的独立 worktree 开始。
- 允许修改 `app/stephen/**`、Stephen 专属测试/文档和新增 `.github/workflows/stephen-*.yml`。
- 不修改 `main`、现有 `.github/workflows/ci.yml`、CRM、server、共享 packages、Nginx、DNS 或自动发布开关。
- runner 固定 `ubuntu-latest`；定时 UTC 必须表达北京时间 `07:30` 和 `16:30`；同时支持 `workflow_dispatch`。
- AI 只能产生六个候选文案字段，不能产生或覆盖风险、证据、审核、批准或发布状态。
- GitHub 权限只使用 `contents: write` 与 `pull-requests: write`；模型配置只能来自 GitHub Secrets，不写入日志、PR、artifact 或源码。
- live 模式只能从默认分支运行；复用可编辑候选分支前，只允许其相对 base 修改当天的 manifest 与 ledger，禁止从该分支带入脚本、依赖或 workflow 变化。
- 没有拟发布条目且没有同日既有 PR 时正常成功，不创建空 PR。
- 测试 Draft PR 使用 fixture 模式、`codex/stephen-daily-test-YYYY-MM-DD` 分支，并以当前功能分支为 base。

---

### Task 1: Daily review contract and Beijing-day identity

**Files:**
- Create: `app/stephen/scripts/stephen-daily-review.ts`
- Create: `app/stephen/src/content/daily-review.test.ts`

**Interfaces:**
- Consumes: SAAS-605 report records, governance decisions and pipeline controls.
- Produces: `beijingEditorialDate(instant)`, `dailyReviewContext(input)`, `buildDailyReviewArtifacts(input)` and `resolveDraftPrAction(prs)`.

- [x] **Step 1: Write failing tests for Beijing date and stable branch identity**

```ts
expect(beijingEditorialDate(new Date('2026-08-24T23:30:00Z'))).toBe('2026-08-25');
expect(dailyReviewContext({ editorialDate: '2026-08-25', mode: 'live' }).branchName)
  .toBe('codex/stephen-daily-2026-08-25');
expect(dailyReviewContext({ editorialDate: '2026-08-25', mode: 'fixture' }).branchName)
  .toBe('codex/stephen-daily-test-2026-08-25');
```

- [x] **Step 2: Run the focused test and record the expected missing-module failure**

Run: `cd app && npx vitest run --root stephen src/content/daily-review.test.ts`

- [x] **Step 3: Implement date/ref validation and stable paths**

The context must reject invalid dates and produce only literal `codex/stephen-daily[-test]-YYYY-MM-DD` branches plus `app/stephen/review-candidates/YYYY-MM-DD/{review-manifest.json,discovery-ledger.json}` paths.

- [x] **Step 4: Add failing tests for AI/status separation and summary counts**

The fixture report must prove that AI-supplied `riskLevel`, `editorialStatus` or `publicationState` fields are ignored; output candidates are always `pending_owner_review` and `not_published`, while risk comes from the matching deterministic pipeline decision.

- [x] **Step 5: Implement report validation and artifact construction**

Reject reports unless `task=SAAS-605`, `autoPublishingEnabled=false`, `stopSwitchEngaged=true`, every proposed URL is HTTPS, and every proposed record has a matching `manual_review` governance decision. Aggregate unique new, duplicate, rejected and manual-review IDs rather than double-counting intake and governance layers.

- [x] **Step 6: Run the focused test to green**

Run: `cd app && npx vitest run --root stephen src/content/daily-review.test.ts`

### Task 2: Idempotent same-day review manifest and Draft PR body

**Files:**
- Modify: `app/stephen/scripts/stephen-daily-review.ts`
- Modify: `app/stephen/src/content/daily-review.test.ts`

**Interfaces:**
- Consumes: optional existing review manifest and discovery ledger from the same candidate branch.
- Produces: merged manifest, append-only same-day run ledger, bounded Markdown body and PR action (`create`, `update`, `skip_closed`).

- [x] **Step 1: Write failing tests for two same-day runs and owner deletion preservation**

First run adds A; the owner-edited existing manifest removes A while the ledger retains A; the second run sees A and B and must add only B. A must never reappear.

- [x] **Step 2: Run focused test and confirm the intended failure**

- [x] **Step 3: Implement ledger-backed merge and deterministic ordering**

Persist all seen candidate IDs in the ledger; preserve the current manifest exactly except for adding never-seen proposals; never infer approval from presence in a branch.

- [x] **Step 4: Write failing tests for create/update/closed/non-draft PR states**

No PR returns `create`; one open Draft returns `update` with its number; a closed/merged same-head PR returns `skip_closed`; an open non-Draft or multiple matching PRs fails closed.

- [x] **Step 5: Implement Markdown escaping and the required audit summary**

Body must show scanned sources, new discoveries, duplicates, rejects, manual review, proposed items, original HTTPS links, deterministic risk warnings, fixture warning, deletion instructions and an explicit no-publication statement.

- [x] **Step 6: Run focused test to green**

### Task 3: Fixture CLI dry-run

**Files:**
- Create: `app/stephen/scripts/fixtures/saas-606-intake-report.json`
- Create: `app/stephen/scripts/stephen-daily-review-cli.ts`
- Modify: `app/stephen/scripts/node-runtime.d.ts`
- Modify: `app/stephen/tsconfig.editorial.json` only if the new TypeScript files are not already covered.

**Interfaces:**
- `context --date YYYY-MM-DD --mode fixture|live` prints safe JSON containing branch, title and paths.
- `generate --report FILE --date YYYY-MM-DD --mode fixture|live --output-root DIR --body-file FILE` writes only the two bounded candidate files plus the PR body and prints a secret-free result JSON.
- `resolve-pr --prs-file FILE` prints the tested Draft PR action.

- [x] **Step 1: Write a failing CLI behavior test through the pure command parser**

Unknown commands, missing files, invalid dates and unsafe output paths must fail without writing files.

- [x] **Step 2: Implement minimal file I/O and exact argument parsing**

Use `node:fs/promises` plus a pure, segment-level path guard that remains compatible with both Stephen TypeScript configurations; forbid output paths outside an absolute non-root `output-root`; never print environment variables or model configuration.

- [x] **Step 3: Run a fixture dry-run in a temporary directory**

Run: `node --experimental-strip-types stephen/scripts/stephen-daily-review-cli.ts generate --report stephen/scripts/fixtures/saas-606-intake-report.json --date 2026-08-24 --mode fixture --output-root "$TMPDIR" --body-file .saas-606/pr-body.md`

- [x] **Step 4: Inspect the generated manifest/body and prove no public file changed**

Run: `git status --short` and verify only intentional SAAS-606 source/doc/workflow files are present in the worktree.

### Task 4: Minimal-permission daily GitHub workflow

**Files:**
- Create: `.github/workflows/stephen-daily-intake.yml`
- Modify: `app/stephen/src/content/daily-review.test.ts`

**Interfaces:**
- Scheduled runs use live SAAS-605 intake and default branch as base.
- Dispatch fixture runs accept an optional safe base ref and never use AI secrets.
- Candidate branches are updated by regular push; PR operations use `gh` with `GITHUB_TOKEN`.
- Existing candidate branches are treated as untrusted input until their diff is proven to contain only that day's manifest and ledger.

- [x] **Step 1: Write failing workflow contract tests**

The executable contract check must reject non-ubuntu runners, missing dispatch, cron values other than `30 23 * * *` / `30 8 * * *`, `pull_request_target`, permissions beyond contents/pull-requests, missing timeout/concurrency, or commands that print secret variables.

- [x] **Step 2: Add the workflow and run the contract test to green**

Use `actions/checkout@v4` and `actions/setup-node@v4` only. Run install, Stephen site/editorial type checks, all Stephen tests and `build:stephen` before commit/push/PR mutation.

- [x] **Step 3: Prove no-empty-PR and same-day-reuse branches in the workflow**

The workflow queries PRs for the exact head/base pair, calls `resolve-pr`, skips creation when proposals are zero, updates an existing Draft, and fails closed on a non-Draft review PR.

### Task 5: Runbook, fresh verification, commit and push

**Files:**
- Modify: `docs/content/stephen-daily-editorial-runbook.md`

- [x] **Step 1: Document SAAS-606 operation and owner deletion flow**

Document schedules, manual dispatch, same-day reuse, fixture safety, Secrets names, permissions, no-empty behavior, the non-public candidate directory, owner deletion and the fact that merge/publish remain separate until later authorized stages.

- [x] **Step 2: Run fresh complete verification**

Run:

```bash
cd app
npx tsc --noEmit -p stephen/tsconfig.json
npx tsc --noEmit -p stephen/tsconfig.editorial.json
npx vitest run --root stephen
npm run build:stephen
git diff --check
```

- [x] **Step 3: Audit exact scope and secrets**

Diff must contain only `app/stephen/**`, `docs/content/stephen-*`, this plan and `.github/workflows/stephen-daily-intake.yml`; search added lines for private keys, tokens, credential literals, `pull_request_target`, public allowlist edits and automatic publishing enablement.

- [x] **Step 4: Create one independent commit and push normally**

Commit message: `feat(SAAS-606): add daily candidate Draft PR gate`.

- [ ] **Step 5: Wait for exact-head remote CI**

Both `CI` and `Stephen checks` triggered for the feature branch must be successful before fixture dispatch.

### Task 6: Real fixture Draft PR acceptance

- [ ] **Step 1: Confirm the test head branch and PR do not already exist**

Check `codex/stephen-daily-test-2026-08-24` and exact head/base PR state without deleting or overwriting anything.

- [ ] **Step 2: Dispatch the workflow from the feature branch**

```bash
gh workflow run stephen-daily-intake.yml \
  --ref codex/stephen-daily-candidate-pr \
  -f mode=fixture \
  -f editorial_date=2026-08-24 \
  -f target_base=codex/stephen-daily-candidate-pr
```

- [ ] **Step 3: Wait for workflow success and inspect the Draft PR**

Verify Draft state, exact base/head, required statistics, every proposed source link/risk warning, fixture/no-publication warning, editable manifest and absence of secrets/artifacts.

- [ ] **Step 4: Stop at the owner review gate**

Leave the test Draft PR open for project-owner review. Do not merge `main`, deploy, change traffic, or start SAAS-607.
