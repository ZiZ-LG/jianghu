# SAAS-201 SourceArtifact Projection and Lifecycle API Implementation Plan

> **Task:** SAAS-201
> **Branch:** `codex/g4-candidate-review-intelligence`
> **Worktree:** `/Volumes/PowerData/江湖APP/.worktrees/g4-candidate-review-intelligence`
> **Base:** `a5ef723d7d7d7653b44c5d9cf8d8aa339e36e5e9`
> **Status:** DONE

## Goal

Turn the CORE-204 ACL-ready `SourceArtifact` shell into the single metadata projection for Transcript, uploaded-file transcripts, external references and Note sources. Keep every original body in its existing physical authority, preserve Transcript encryption, support unclassified/mounted/re-mounted sources, and expose tenant/scope/ACL-safe metadata and lifecycle APIs. External references must be creator-domain idempotent, fingerprints and retention state must remain explainable, and deletion must retain a metadata tombstone instead of silently pretending the original still exists.

## Non-goals and hard boundaries

- Do not create a second transcript, file-body, note-body or generic blob table. `Transcript.contentEnc` and `Note.content` remain the physical body authorities; `SourceArtifact` never copies or returns either body.
- Do not create ReviewBatch, ReviewCandidate, Interaction acceptance, AgentJobDefinition/AgentRun, ResearchBrief, Intelligence, Hypothesis or any CORE-205+/SAAS-202+ capability.
- Do not set Candidate `sourceArtifactId`, create formal Interaction/Evidence, run extraction automatically or change any formal CRM fact. Those transitions remain human-reviewed later tasks.
- Do not change Action/domain contracts, App code, product permission allocation, App package/lock/Vite/dist, Docker Compose, public navigation, generic Nginx, public CI or any self-cultivation path. If implementation proves one of these unavoidable, stop and request project-owner approval.
- Do not expose SourceArtifact metadata to a user who cannot read the current parent and sensitive ACL. Shared reading still requires the existing `source.read_shared`; this task does not grant it to another edition or role.
- Do not make known private bodies visible to owner/admin, infer manager access, auto-share legacy rows, log fingerprints/external refs/titles as audit metadata, or return Note/Transcript bodies from SourceArtifact endpoints.
- Do not deploy production or merge main.

## Authority and lifecycle contract

1. `SourceArtifact` is the unique metadata projection; the backing kind is exactly `transcript | note | external_reference`.
2. Transcript and Note rows remain content, encryption and creator/visibility authorities. Their projection must mirror tenant, parent IDs, stable creator, visibility and `aclVersion`; all producer, mount, visibility, degradation and deletion changes update backing plus projection in one transaction.
3. An `external_reference` has no local body. Its SourceArtifact row is its metadata authority and remains `reference_only` until an exact same creator-domain/source/externalRef import atomically adopts it into a Transcript backing.
4. Artifact kinds are `transcript | uploaded_file | note | external_reference`. Transcript `source=upload` maps to `uploaded_file`; other Transcript sources map to `transcript`.
5. Retention states are `available | degraded | reference_only | deleted`. `deleted` keeps the artifact ID, fingerprint, ACL and non-body metadata as a tombstone while the local backing is absent. It is never reported as content-available.
6. Fingerprint kinds are `content_sha256_v1 | reference_sha256_v1`. Available Note/Transcript/import content uses a SHA-256 digest computed before projection without logging the input or digest; external references and pre-existing degraded rows use canonical reference metadata. The fingerprint survives degradation/deletion.
7. External idempotency is `(tenantId, immutable creator idempotencyDomain, source, externalRef)`. It must not reveal whether another creator has the same private source. Tombstones continue to occupy the identity unless a future explicit restore task is approved.
8. All writes use current database role, product policy, EffectiveResourceScope, creator/share ACL, expected `aclVersion`, an `Idempotency-Key`, a Serializable transaction and content-free audit. Viewer writes remain rejected.
9. Unclassified means `accountId/matterId/personId` are all null. Matter/person mounts derive and verify the tenant-local Customer; re-mount checks both old manage access and new target scope. A `matter_shared` artifact cannot be unmounted from its Matter until made private.

## Target SourceArtifact expansion

Keep all CORE-204 columns and add portable String/DateTime metadata:

- `artifactKind`, `source`, nullable `externalRef`, immutable `idempotencyDomain`;
- `title`, nullable `occurredAt`;
- `fingerprintKind`, `sourceFingerprint`;
- `retentionState`, `retentionUpdatedAt`;
- exact creator-domain external-ref unique index and tenant-first kind/retention list indexes.

Use no native enum, JSON or array. The versioned PostgreSQL migration is `20260825010000_expand_source_artifact_projection`; the data marker is `SAAS-201-source-artifact-projection-v1`.

## Public API contract

All routes are authenticated and remain under the existing `sales.workspace` service boundary:

- `GET /api/source-artifacts` — cursor-paginated ACL-filtered metadata list; optional account/matter/unclassified filters; no body/backing ciphertext.
- `GET /api/source-artifacts/:id` — same metadata for one authorized artifact; unauthorized and missing are the same 404 shape.
- `POST /api/source-artifacts/external` — idempotently register an external reference with optional mount/title/time; never accepts credentials or raw body.
- `PATCH /api/source-artifacts/:id/mount` — attach, unclassify or re-mount with `expectedAclVersion` and target closure validation.
- `PUT /api/source-artifacts/:id/visibility` — creator-managed `private | matter_shared` CAS, synchronizing a local backing when present.
- `POST /api/source-artifacts/:id/degrade` — remove Transcript original ciphertext and mark the projection degraded; unsupported backing kinds fail with an explicit capability response.
- `DELETE /api/source-artifacts/:id` — delete a local backing or retire an external reference, retain a `deleted` tombstone and return an accurate receipt.

Every mutation requires an `Idempotency-Key`; replay returns the original non-sensitive receipt and cannot bypass current tenant identity. Responses explain `contentAvailable`, `canDegrade`, `canDelete`, backing presence and retention state without decrypting or returning original content.

## Task 1: Lock projection, lifecycle and API behavior with RED tests

**Files:**
- Add: `server/tests/source-artifact-projection.test.ts`
- Add: `server/tests/source-artifact-routes.test.ts`
- Add: `server/tests/source-artifact-migration.test.ts`
- Modify: `server/tests/sensitive-resource-acl.test.ts`
- Modify: `server/tests/sensitive-acl-routes.test.ts`
- Modify: `server/tests/schema-render.test.ts`
- Modify: `server/tests/postgres-ops-scripts.test.ts`
- Modify: `server/tests/sqlite-matter-upgrade.test.ts`

- [x] Prove new and existing Transcript/Note projections are one-to-one, body-free and exact mirrors of tenant/parent/creator/visibility/ACL generation.
- [x] Prove upload/provider external refs are idempotent only inside the immutable creator domain; cross-creator and cross-tenant existence is not disclosed.
- [x] Prove unclassified, attach and re-mount paths validate old and new scope, parent closure, archive state and `matter_shared` constraints in the write transaction.
- [x] Prove list/detail select metadata before ACL evaluation and never select/return Note content or Transcript ciphertext/plaintext.
- [x] Prove degradation, physical deletion, external retirement and tombstones report content availability/capabilities accurately and are idempotent.
- [x] Prove viewer, role downgrade, Matter transfer, ACL change, stale CAS, malformed kind/state/fingerprint and command replay fail closed with zero partial writes/audit leaks.
- [x] Prove SourceArtifact import alone creates no Candidate, ReviewBatch, Interaction, Evidence, Person, Relation, Commitment or other formal write.

## Task 2: Add the portable expansion and deterministic projection migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Render: `server/prisma/postgres/schema.prisma`
- Add: `server/prisma/postgres/legacy/20260825_pre_saas201.prisma`
- Add: `server/prisma/postgres/migrations/20260825010000_expand_source_artifact_projection/migration.sql`
- Add: `server/src/sourceArtifacts/migration.ts`
- Add: `server/scripts/migrate-source-artifacts.ts`
- Add: `server/scripts/postgres-source-artifact-schema-state.ts`
- Modify: `server/src/sensitiveAcl/migration.ts`
- Modify: `server/scripts/postgres-sensitive-acl-schema-state.ts`
- Modify: `server/scripts/upgrade-sqlite-schema.ts`
- Modify: `server/scripts/deploy-postgres-migrations.sh`
- Modify: `server/package.json`
- Modify: `scripts/test-postgres-ops-integration.sh`
- Modify: migration/schema tests from Task 1

- [x] Add only expand fields/indexes and retain all CORE-204 columns, grants and markers. Make CORE-204 inspectors accept exactly its own shape or the registered SAAS-201 successor shape, not arbitrary drift.
- [x] Implement `--dry-run | --apply | --verify` with marker `SAAS-201-source-artifact-projection-v1`; enumerate tenants first and output only IDs, counts, reason codes and non-body contract checksums.
- [x] Backfill every Transcript and Note to one deterministic artifact. Preserve current creator/visibility/ACL/parents; map upload/provider/note kinds, fingerprint available content, and map already-redacted Transcript to `degraded` without inventing a body.
- [x] Validate both directions: every live Transcript/Note has one exact projection; every local projection has its exact backing unless it is a valid `deleted` tombstone; external-reference rows are reference-only and creator-domain unique.
- [x] Make apply Serializable, deterministic, idempotent and marker-last. Exact prewritten rows can be adopted; projection identity/fingerprint/parent/ACL conflicts, partial schema or marker drift fail closed. Transcript ciphertext remains opaque and is never decrypted by migration.
- [x] Integrate report/apply/verify after CORE-204 in SQLite write-before-backup upgrade and PostgreSQL `migrate deploy`; cover interrupted commits, rerun, semantic conflict, partial state, authenticated restore and fresh install.

## Task 3: Centralize projection synchronization without duplicating bodies

**Files:**
- Add: `server/src/sourceArtifacts/model.ts`
- Add: `server/src/sourceArtifacts/service.ts`
- Modify: `server/src/recording.ts`
- Modify: `server/src/mutate.ts`
- Modify: `server/src/jobs.ts`
- Modify: `server/src/repair.ts`
- Modify: `server/src/personMerge.ts`
- Modify: corresponding tests from Task 1

- [x] Provide one strict metadata/fingerprint/retention validator and deterministic artifact identity helper.
- [x] Create or verify a projection in the same transaction for every Transcript and Note producer; lazily adopt only provably exact pre-marker backing rows and reject conflicting projections.
- [x] Update fingerprint metadata for Note content changes without copying content; synchronize Note/Transcript rebind and `aclVersion` changes with the projection.
- [x] Make uploaded files use a stable creator-domain upload ref/fingerprint while retaining parsed encrypted text only in Transcript; preserve provider Transcript external-ref behavior.
- [x] Synchronize Transcript degradation/deletion and Note deletion to a projection tombstone; never delete the artifact history or expose content in audit.
- [x] Allow exact reference-only external artifacts to be adopted by a matching Transcript import without changing artifact ID or crossing creator domains.

## Task 4: Expose the fail-closed lifecycle API

**Files:**
- Add: `server/src/sourceArtifacts/routes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/sensitiveAcl/service.ts` only if needed to reuse internal audited CAS primitives without weakening CORE-204
- Modify: `server/tests/source-artifact-routes.test.ts`
- Modify: `server/tests/product-capabilities.test.ts`

- [x] Implement list/detail with bounded pagination, metadata-first Prisma predicates, batched ACL checks and same-shape 404 for hidden/missing IDs.
- [x] Implement external registration, mount/re-mount, visibility, degradation and deletion through the command runner with strict schemas, replay receipts and same-transaction non-body audit.
- [x] Reload current role, product policy, scope, backing, projection and ACL in every mutation transaction; stale projection/backing pairs fail closed.
- [x] Keep creator private access usable in commercial sales mode, shared access gated by existing permissions, viewer read-only, and Free/unconfigured product policies denied before handlers.
- [x] Return an explicit lifecycle explanation derived from validated backing/retention state; never infer available content from a stale projection flag alone.

## Task 5: Verify recovery and close SAAS-201

**Files:**
- Add: `docs/SAAS-201-SourceArtifact迁移与回滚说明.md`
- Modify: this plan
- Modify: `docs/商业版开发待办清单v1.md`

- [x] Run focused projection/API/migration/recording/Note/repair/merge tests, then Server generate/schema check/typecheck/full tests and PostgreSQL operations integration.
- [x] Run Domain contracts, G64111, PDE kernel and App typecheck/tests. Do not run a local App production build because it writes shared `app/dist/**`; exact-SHA CI retains that isolated gate.
- [x] Run producer/delete/rebind inventory, schema/static migration checks, `git diff --check`, protected-path check and high-confidence secret scan.
- [x] Assert no Action/domain-contract/App/shared/self-cultivation/production change, no second body table and no Candidate/ReviewBatch/formal-state write.
- [x] Commit business code independently, push and require every exact-head CI job green.
- [x] In a separate governance commit, document migration/apply/verify/rollback, mark SAAS-201 DONE and only CORE-205 READY, then require exact-head CI green before CORE-205 starts.

## Completion evidence

- Business commit: `c454fbb751817f0480e7257ab1a2fd74a2e8cb09`.
- Exact-head remote gate: [GitHub Actions 32877939477](https://github.com/ZiZ-LG/jianghu/actions/runs/32877939477), 12/12 jobs successful.
- Local gate: Server 77 files / 621 tests; Domain 8/87; G64111 2/32; PDE 3/25; App 42/326; all required typechecks, PostgreSQL schema check, SQLite upgrade and PostgreSQL operations integration successful.
- Recovery evidence and production procedure: `docs/SAAS-201-SourceArtifact迁移与回滚说明.md`.
- No Action/domain-contract/App/shared/self-cultivation/production file changed; no second body table or Candidate/ReviewBatch/formal-state write was opened.

## Local verification commands

```bash
cd server
npm run generate
npm run schema:postgres:check
npm run typecheck
DATABASE_URL=file:./test.db npx vitest run \
  tests/source-artifact-projection.test.ts \
  tests/source-artifact-routes.test.ts \
  tests/source-artifact-migration.test.ts \
  tests/sensitive-resource-acl.test.ts \
  tests/sensitive-acl-routes.test.ts \
  tests/schema-render.test.ts \
  tests/postgres-ops-scripts.test.ts \
  tests/sqlite-matter-upgrade.test.ts
npm test

cd ..
bash scripts/test-postgres-ops-integration.sh

cd packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npx tsc --noEmit && npm test
```

## Stop conditions

Stop and request project-owner approval before any shared file, Action/domain-contract/App change, product permission allocation, new raw-body/blob table, public navigation/Nginx/CI change, self-cultivation path, production access, destructive migration, relaxed tenant/viewer/creator ACL, private-body owner/admin override, or expansion into CORE-205/SAAS-202.
