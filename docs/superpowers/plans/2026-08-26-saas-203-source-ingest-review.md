# SAAS-203 Source Ingest to ReviewBatch Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming completion. Execute inline because the project owner already authorized serial automatic G4 progression and this thread may not delegate unless explicitly requested.

**Task:** SAAS-203
**Branch:** `codex/g4-candidate-review-intelligence`
**Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
**Base:** `402e119c2981a6e9547d48ed9f7cd8a8f5ae8abd`
**Approved configuration commit:** `3f387fa8212f74cb9da2f1d2fb1aef06dbb43eb1`
**Business commit:** `9c4887fa72b96516bd4235cbf991b7e3f7d52625`
**Remote evidence:** [GitHub Actions 32977229083](https://github.com/ZiZ-LG/jianghu/actions/runs/32977229083), exact SHA `9c4887fa72b96516bd4235cbf991b7e3f7d52625`, 12/12 jobs successful
**Status:** DONE

**Goal:** Connect one Feishu Minutes link/OAuth authorization or one uploaded text-bearing file to an exact encrypted Transcript-backed SourceArtifact, then run the existing controlled `post_meeting_extract@core-206.v1` Job into a human ReviewBatch while formal CRM state remains unchanged until explicit review acceptance.

**Architecture:** Preserve Transcript as the encrypted body authority and SourceArtifact as its body-free projection. Add one focused two-phase import service: provider/file parsing runs outside a database transaction; a tenant-, creator-, mount- and idempotency-scoped command commits exactly one Transcript plus its deterministic SourceArtifact projection. The receipt contains only the exact authorized SourceArtifact metadata. The lightweight UI passes that receipt to the existing Agent Job route; it never calls the legacy `/api/recording/extract` route. Existing SourceArtifact lifecycle commands remain the only degrade/delete authority. Feishu configuration and per-user OAuth credentials continue using encrypted existing tables, with strict bounded contracts, short-lived authenticated state and injectable providers for tests.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod, `@fastify/multipart`, Mammoth, unpdf, React 18, Vite/Vitest, SQLite development verification and generated PostgreSQL schema parity.

## Completion evidence

- The project owner explicitly approved the only four configuration/shared-file changes: `.env.production.example`, `docker-compose.yml`, `scripts/test-postgres-ops-integration.sh` and `server/.env.example`. They were isolated in `3f387fa8212f74cb9da2f1d2fb1aef06dbb43eb1`; the 29-file implementation/test change was isolated in `9c4887fa72b96516bd4235cbf991b7e3f7d52625`.
- The exact business SHA passed all 12 GitHub Actions jobs in run 32977229083. Local verification passed Domain 11 files / 107 tests, App 46 / 353, Server 89 / 782, G64111 2 / 32 and PDE 3 / 25; the focused SAAS-203 Server set passed 9 / 131, the focused App set 3 / 16, Feishu import 1 / 23 and the dedicated SQLite upgrade gate 1 / 16.
- PostgreSQL operations passed `FRESH_INSTALL_FIRST_RUN_OK=1`, `FRESH_INSTALL_SECOND_UPDATE_OK=1` and `POSTGRES_OPS_INTEGRATION_OK=1`. Prisma PostgreSQL render parity and the existing SQLite upgrade path passed. SAAS-203 changed no schema or migration.
- Static and runtime tests prove tenant/current-role/capability/effective-scope/Customer-Matter closure/creator ACL enforcement, viewer denial, encrypted Transcript authority, body-free SourceArtifact receipts, bounded upload/provider failures, OAuth state TTL/binding, idempotent replay, ReviewBatch-only candidate output and zero formal CRM writes before human acceptance.
- Read-only public checks found `https://lake2ocean.top/` returning 200 as the public homepage without redirect, retaining “首页｜自我修养｜江湖 CRM｜卧虎藏龙”, linking CRM explicitly to `https://crm.lake2ocean.top/`, and showing ICP `京ICP备2026046195号-2` plus `京公网安备11010802049879号`; the CRM login page and `/api/health` both returned 200. These checks were diagnostics only, not a deployment.
- Production remains the `lake2ocean.top` three-site ecosystem. Mac mini is not a release target and is retained only as an optional pre-release test environment. No production or Mac mini deployment, main merge, public navigation change, self-cultivation change, secret exposure or destructive legacy deletion occurred.

## Non-goals and hard boundaries

- Do not add a schema, migration, body/blob table, ReviewCandidate table, dependency or package-script change. Reuse Transcript, SourceArtifact, Candidate, ReviewBatch, AgentRun, RecordingProviderConfig and RecordingCredential.
- Do not build ASR, accept audio/video/image-only PDF, scan a Feishu account, import multiple Minutes records, or invoke inferred Feishu search/list endpoints. Only one user-supplied Minutes link/token is allowed.
- Do not call `POST /api/recording/extract`, `extractTranscript`, `prepareVoiceIngest` or any legacy voice/direct-write path from the new flow. Do not expand the frozen legacy RecordingPanel.
- Do not automatically accept candidates or write formal Customer, Matter, Person, Relation, Evidence, Commitment, Interaction, stage, Forecast or key-person status. Import may write only encrypted Transcript, SourceArtifact, command/audit metadata; Job execution may write only Candidate/ReviewBatch/AgentRun/audit before human review.
- Do not return, audit or log source text, file bytes, ciphertext, provider tokens, App Secret, OAuth code, raw provider response or arbitrary parser errors. Provider failures map to bounded stable codes and safe user messages.
- Keep every read/write tenant-scoped. Require exact active Customer + Matter closure, current `sales.workspace`, EffectiveResourceScope and creator/share ACL. Viewer import, OAuth, config and lifecycle writes remain denied.
- Preserve `Customer.categoryKey` as the only category authority. Do not introduce `customerType` or any new formal-field authority.
- Do not modify public/product navigation, shared package/lock/Vite/dist/Compose/Nginx/CI files, any self-cultivation path, production configuration, main or a production host.
- Feishu production endpoint behavior remains unverified until a separately authorized live credential calibration. Tests use an injected deterministic provider; SAAS-203 must not claim real-provider success from mocks.

## Fixed HTTP and domain contract

### Import commands

```ts
export const PostMeetingFeishuImportRequestSchema = z.object({
  url: z.string().trim().min(1).max(2_000),
  customerId: z.string().trim().min(1).max(500),
  matterId: z.string().trim().min(1).max(500),
}).strict();

export const PostMeetingUploadMetadataSchema = z.object({
  customerId: z.string().trim().min(1).max(500),
  matterId: z.string().trim().min(1).max(500),
  occurredAt: UtcInstantSchema.nullable().optional(),
}).strict();

export const PostMeetingSourceImportReceiptSchema = z.object({
  source: PostMeetingSourceOptionSchema,
  replayed: z.boolean(),
}).strict();
```

- `POST /api/post-meeting/import/feishu` accepts the strict JSON request and an `Idempotency-Key`.
- `POST /api/post-meeting/import/upload?customerId=...&matterId=...&occurredAt=...` accepts exactly one multipart file and an `Idempotency-Key`.
- Both return one exact `PostMeetingSourceImportReceipt`; they never return a count that forces the App to guess which artifact was created.
- The App then calls the existing `POST /api/agent-jobs/post_meeting_extract/runs` with the receipt's exact source ID/version and current Customer/Matter versions. Import success plus Job failure is a safe partial workflow state: the source remains selectable and the same run command can be retried.

### Immutable identity and replay

- Upload identity is `source=upload`, `externalRef=upload:<sha256(file bytes)>`, tenant plus immutable creator idempotency domain.
- Feishu identity is `source=feishu`, `externalRef=feishu:<validated minute token>`, tenant plus immutable creator idempotency domain.
- A duplicate in the same creator domain and exact Customer/Matter mount returns the same Transcript/SourceArtifact and `replayed=true`; different mount, backing, retention state, creator/ACL or payload under the same transport key fails closed without revealing whether another private object exists.
- Provider/file work occurs outside the serializable write transaction. CommandRun reservation owns transport idempotency; the commit transaction revalidates current user role, tenant, capability, EffectiveResourceScope, Customer/Matter closure, creator identity and existing artifact ACL before returning.
- Filenames/titles are normalized to 200 characters; accepted extensions are `.md`, `.txt`, `.docx`, `.pdf`; one file is capped at 10 MiB, extracted UTF-8 text at 500,000 characters, and an empty/image-only/invalid file is rejected without any Transcript/SourceArtifact write.

### Feishu credential and OAuth boundary

- Reuse `/api/recording/provider/feishu`, `/api/recording/credentials`, `/api/recording/oauth/feishu/start` and `/api/recording/oauth/feishu/callback`; add strict shared response parsing and security regression tests rather than a second credential authority.
- Owner/admin may configure App ID and an optional replacement App Secret; member may inspect safe status and connect their own account; viewer is denied. Secret/token values are encrypted at rest and never read back.
- OAuth state parses as a strict `{ tenantId, userId, issuedAt, nonce }` encrypted AES-GCM payload, expires after ten minutes, and is bound to an existing current tenant user before code exchange. Malformed/expired state and provider errors return generic escaped HTML with no raw provider message, code, token or tenant/user detail.
- `PUBLIC_BASE_URL` is the redirect authority. Production startup/config access must fail closed when it cannot produce one HTTPS origin; tests/dev inject an explicit origin. No legacy domain is hard-coded as a silent production fallback.

### Source lifecycle and review bridge

- The new UI uses existing `POST /api/source-artifacts/:id/degrade` and `DELETE /api/source-artifacts/:id` with current ACL version and stable idempotency keys. It never directly edits Transcript.
- Degrade/delete clears or removes the backing Transcript through the existing SourceArtifact service, retains the body-free tombstone/audit contract, refreshes the source list and disables Job execution for unavailable sources.
- A SourceArtifact already anchored by a ReviewBatch remains locked against re-mounting and visibility changes. PIPL degrade/delete remains available: it removes the backing body while preserving the SourceArtifact tombstone, batch metadata and human-review history; the UI refreshes to the unavailable state and never pretends the body is still usable.
- End-to-end acceptance is: import source → exact source receipt → existing candidate Job → one ReviewBatch → explicit human decision. Before the final human decision, formal-table counts and versions remain unchanged.

## Task 1: Lock strict import/provider/lifecycle contracts with RED tests

**Files:**
- Add: `packages/domain-contracts/src/postMeetingImport.ts`
- Add: `packages/domain-contracts/tests/postMeetingImport.test.ts`
- Modify: `packages/domain-contracts/src/index.ts`

1. Write failing tests for strict Feishu request, multipart metadata, exact source receipt, safe credential/provider status, config request/receipt, OAuth start response and SourceArtifact lifecycle receipt.
2. Reject unknown keys, missing exact Customer/Matter, invalid URL/token, secret/token/ciphertext/body fields, oversized titles, malformed timestamps, count-only receipts and mismatched source mount.
3. Implement the schemas and exported inferred types. Reuse `PostMeetingSourceOptionSchema`; do not define a parallel source view.
4. Run `cd packages/domain-contracts && npx vitest run tests/postMeetingImport.test.ts` and confirm RED then GREEN before moving on.

## Task 2: Extract one exact encrypted-ingest primitive with RED tests

**Files:**
- Add: `server/src/postMeeting/importModel.ts`
- Add: `server/src/postMeeting/importService.ts`
- Add: `server/tests/post-meeting-import-service.test.ts`
- Modify: `server/src/recording.ts`
- Modify: `server/src/sourceArtifacts/service.ts`
- Modify: `server/tests/source-artifact-routes.test.ts`

1. Write failing service tests for exact encrypted body, body fingerprint, deterministic upload/Feishu identities, SourceArtifact receipt, same-mount replay, mismatched-mount failure, tenant/creator isolation and injected transaction rollback.
2. Write failing tests that invalid Customer/Matter closure, archived parent, revoked scope, viewer, hidden duplicate, degraded/deleted duplicate and backing/projection drift produce no new Transcript or SourceArtifact and no existence leak.
3. Introduce a narrow prepared value and commit signature:

```ts
export interface PreparedPostMeetingSource {
  source: 'upload' | 'feishu';
  externalRef: string;
  title: string;
  text: string;
  durationSec: number;
  recordedAt: Date | null;
  contentFingerprint: string;
}

export async function commitPostMeetingSource(
  db: DbClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  mount: { customerId: string; matterId: string },
  prepared: PreparedPostMeetingSource,
): Promise<{ source: PostMeetingSourceOption; businessReplayed: boolean }>;
```

4. Factor the existing encrypted Transcript create/dedupe + SourceArtifact projection logic into the shared primitive; keep existing recording routes behavior-compatible through a count adapter. Do not copy the encrypt/dedupe implementation.
5. Re-read the exact SourceArtifact inside the commit transaction and build the receipt through the current ACL/scope-aware projection; no body crosses the service boundary after commit.
6. Run the focused service and existing source-artifact tests; inspect database rows to prove plaintext is absent.

## Task 3: Add bounded upload preparation and exact import routes with RED tests

**Files:**
- Add: `server/src/postMeeting/upload.ts`
- Add: `server/src/postMeeting/importRoutes.ts`
- Add: `server/tests/post-meeting-import-routes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/helpers/testApp.ts`

1. Write failing tests for one `.md/.txt/.docx/.pdf`, byte/text/title limits, MIME/extension mismatch, invalid UTF-8, empty/image-only PDF, multiple parts and parser failure; assert zero business rows and no raw parser message in responses/logs.
2. Implement `preparePostMeetingUpload(file): Promise<PreparedPostMeetingSource>` with the existing Mammoth/unpdf dependencies. Hash original bytes before extraction; never accept audio/video or invoke OCR/ASR.
3. Write failing route tests for authentication, current role, viewer denial, `sales.workspace`, tenant/scope/parent closure, required idempotency key, replay, changed payload, transaction retry and exact typed receipt.
4. Reserve the command using a body-free canonical payload containing mount, normalized metadata, source kind, file digest and content fingerprint; parse outside and commit inside the existing serializable command runner.
5. Register only `/api/post-meeting/import/upload` in `server/src/app.ts`; keep `/api/recording/upload` as a frozen compatibility route.
6. Run `DATABASE_URL=file:./test.db npx vitest run tests/post-meeting-import-service.test.ts tests/post-meeting-import-routes.test.ts tests/source-artifact-routes.test.ts`.

## Task 4: Connect one Feishu link and harden OAuth with RED tests

**Files:**
- Add: `server/src/postMeeting/feishuImport.ts`
- Add: `server/src/recordingCredentials.ts`
- Add: `server/tests/post-meeting-feishu-import.test.ts`
- Add: `server/tests/recording-feishu-oauth.test.ts`
- Modify: `server/src/recording.ts`
- Modify: `server/src/postMeeting/importRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/helpers/testApp.ts`

1. Define injectable `FeishuImportProvider` methods for authorization-code exchange, token refresh and exact minute fetch. Production adapts existing `feishu.ts`; tests inject deterministic values and make no network request.
2. Write failing tests for exact link/token parsing, creator-owned encrypted credential lookup/refresh, missing/revoked/expired credential, cross-tenant config, empty transcript, provider timeout/error and retry. Assert raw token/code/secret/transcript/provider response never appears in receipt, CommandRun, AuditEvent or logs.
3. Prepare exactly one `PreparedPostMeetingSource` outside the transaction, then commit it through Task 2. Do not call `searchFeishuMinutes`, `pullFeishuAuto`, legacy extract or any formal writer.
4. Write failing OAuth tests for strict encrypted state, ten-minute TTL, existing tenant/user binding, malformed/tampered/expired state, wrong role, absent HTTPS production base URL, safe callback HTML and encrypted token persistence.
5. Extract credential/config helpers from `recording.ts` into one tenant/user-scoped module, preserving legacy route behavior while making the new route and tests use the same authority.
6. Register `POST /api/post-meeting/import/feishu`; use body-free command reservation and exact source receipt semantics identical to upload.
7. Run the two new Feishu suites plus sensitive ACL/aggregate boundary and existing recording/source-artifact suites.

## Task 5: Prove import → existing Job → ReviewBatch and lifecycle closure

**Files:**
- Modify: `server/tests/post-meeting-import-routes.test.ts`
- Modify: `server/tests/post-meeting-feishu-import.test.ts`
- Modify: `server/tests/post-meeting-extract.test.ts`
- Modify: `server/tests/source-artifact-routes.test.ts`
- Modify: `server/tests/agent-job-routes.test.ts`

1. Add one upload and one injected-Feishu end-to-end test that imports an exact source, invokes `post_meeting_extract@core-206.v1`, receives one ReviewBatch and verifies the imported source ID/fingerprint/mount/ACL version are the Job anchors.
2. Snapshot Customer/Matter/Person/Edge/Evidence/Commitment/Interaction rows and versions before import; prove import plus Job execution changes none of them while creating only allowed Transcript/SourceArtifact/Candidate/ReviewBatch/AgentRun/CommandRun/AuditEvent records.
3. Prove disabled Job, missing BYO model, provider failure or candidate failure leaves an authorized reusable source, creates no formal write and permits a stable retry without duplicate Transcript/SourceArtifact/ReviewBatch.
4. Prove degrade/delete before Job makes the source unavailable; prove an anchored ReviewBatch blocks re-mount/visibility change but still permits body degradation/deletion with its tombstone/review history intact; prove cross-tenant/viewer/revoked-scope requests stay same-shape and body-free.
5. Add a static test that production lightweight import/App files contain no `/api/recording/extract`, `extractTranscript`, `prepareVoiceIngest`, `searchFeishuMinutes` or formal model writer.

## Task 6: Build the lightweight import-and-review UI with RED tests

**Files:**
- Modify: `app/src/api.ts`
- Add: `app/src/lib/postMeetingImport.ts`
- Add: `app/src/lib/postMeetingImport.test.ts`
- Add: `app/src/components/PostMeetingSourceImport.tsx`
- Add: `app/src/components/PostMeetingSourceImport.test.ts`
- Modify: `app/src/components/PostMeetingReviewPanel.tsx`
- Modify: `app/src/components/PostMeetingReviewPanel.test.ts`
- Modify: `app/src/styles.css`

1. Add strict API parsers for import, safe provider/credential status, config/OAuth start and lifecycle receipts; reject malformed/mismatched source IDs/mounts and never use `any` for the new flow.
2. Write pure-state RED tests for stable file/link command keys, exact import receipt selection, import→run input construction, failed Job retry, source refresh after lifecycle changes and no implicit retry with changed content/mount.
3. Write component RED tests for owner/admin config, member self-OAuth, viewer/readonly suppression, one link, one accepted file, exact Customer/Matter selection, upload progress/error, and the explicit `导入并生成候选` sequence.
4. Embed `PostMeetingSourceImport` inside the existing PostMeetingReviewPanel. Do not change public/product navigation or `RecordingPanel.tsx`.
5. On import success, select the exact returned source and invoke the existing controlled Job only when its card is enabled and current Customer/Matter/source versions match. On Job failure, retain the source and offer a retry; never fall back to a legacy route.
6. Add current-source `降解`/`删除` actions with confirmation, ACL-version CAS, stable idempotency and refresh. Surface a ReviewBatch lock conflict without clearing the source or claiming success.
7. Keep all sensitive values write-only: blank App Secret means preserve existing secret; OAuth opens only the returned validated HTTPS URL; UI never renders token, ciphertext, source body or raw provider diagnostics.
8. Run `cd app && npx vitest run src/lib/postMeetingImport.test.ts src/components/PostMeetingSourceImport.test.ts src/components/PostMeetingReviewPanel.test.ts` RED then GREEN.

## Task 7: Full verification, business commit, exact-SHA CI and governance close

**Files:**
- Modify: this plan
- Modify: `docs/商业版开发待办清单v1.md`

1. After domain-contract changes, refresh copied `file:` dependencies with `npm ci --install-links` in Server and App before downstream tests.
2. Run Domain typecheck/tests; Server Prisma generate, PostgreSQL schema render check, typecheck, focused tests and full tests; App typecheck and full tests; G64111 and PDE typecheck/tests.
3. Do not run local App production build because it writes shared `app/dist/**`; exact-SHA CI owns that isolated build gate.
4. Run existing SQLite upgrade and PostgreSQL operations regression gates. Confirm schema render is unchanged and therefore SAAS-203 has no SQLite/PostgreSQL migration.
5. Run static tenant/viewer/effective-scope/ACL/authority, new-vs-legacy route, formal-write-zero, plaintext/secret, shared/protected/self-cultivation path and `git diff --check` gates.
6. Commit business code independently with SAAS-203 in the message, push, and require every GitHub Actions job green on the exact business SHA.
7. In a separate governance commit, record real test counts/evidence, mark SAAS-203 DONE and only SAAS-204 READY, push and require exact governance SHA CI green before starting SAAS-204.

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
  tests/post-meeting-import-service.test.ts \
  tests/post-meeting-import-routes.test.ts \
  tests/post-meeting-feishu-import.test.ts \
  tests/recording-feishu-oauth.test.ts \
  tests/post-meeting-extract.test.ts \
  tests/source-artifact-routes.test.ts \
  tests/sensitive-acl-routes.test.ts \
  tests/sensitive-aggregate-boundary.test.ts \
  tests/agent-job-routes.test.ts
npm test

cd ../app
npm ci --install-links
npx tsc --noEmit
npx vitest run \
  src/lib/postMeetingImport.test.ts \
  src/components/PostMeetingSourceImport.test.ts \
  src/components/PostMeetingReviewPanel.test.ts
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

Stop and request project-owner approval before touching any shared/high-conflict file, self-cultivation path, public/product navigation, generic Nginx/CI, package dependency declaration, schema/migration, production host/configuration or main merge; before introducing a second source/body/credential/candidate authority; before allowing upload/provider content to reach audit/log/receipt; before calling the legacy extract/direct-write path; or before weakening tenant/viewer/effective-scope/creator ACL, human review, exact mount, idempotency, `Customer.categoryKey`, encrypted BYO credentials or formal-write-zero rules.
