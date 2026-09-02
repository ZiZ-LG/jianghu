BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  projection_columns INTEGER;
BEGIN
  IF to_regclass('public."SourceArtifact"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-201 SourceArtifact projection requires CORE-204 SourceArtifact';
  END IF;
  SELECT count(*) INTO projection_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'SourceArtifact'
     AND column_name IN (
       'artifactKind', 'source', 'externalRef', 'idempotencyDomain', 'title',
       'occurredAt', 'fingerprintKind', 'sourceFingerprint', 'retentionState',
       'retentionUpdatedAt'
     );
  IF projection_columns <> 0 THEN
    RAISE EXCEPTION 'SAAS-201 SourceArtifact projection columns partially exist; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "SourceArtifact" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "SourceArtifact"
  ADD COLUMN "artifactKind" TEXT NOT NULL DEFAULT 'external_reference',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "externalRef" TEXT,
  ADD COLUMN "idempotencyDomain" TEXT NOT NULL DEFAULT 'system-quarantine-v1',
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "occurredAt" TIMESTAMP(3),
  ADD COLUMN "fingerprintKind" TEXT NOT NULL DEFAULT 'reference_sha256_v1',
  ADD COLUMN "sourceFingerprint" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "retentionState" TEXT NOT NULL DEFAULT 'reference_only',
  ADD COLUMN "retentionUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "SourceArtifact_tenantId_domain_source_externalRef_key"
  ON "SourceArtifact"("tenantId", "idempotencyDomain", "source", "externalRef");
CREATE INDEX "SourceArtifact_tenantId_artifactKind_createdAt_idx"
  ON "SourceArtifact"("tenantId", "artifactKind", "createdAt");
CREATE INDEX "SourceArtifact_tenantId_retentionState_updatedAt_idx"
  ON "SourceArtifact"("tenantId", "retentionState", "updatedAt");

DO $$
DECLARE
  projection_columns INTEGER;
BEGIN
  SELECT count(*) INTO projection_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'SourceArtifact'
     AND column_name IN (
       'artifactKind', 'source', 'externalRef', 'idempotencyDomain', 'title',
       'occurredAt', 'fingerprintKind', 'sourceFingerprint', 'retentionState',
       'retentionUpdatedAt'
     );
  IF projection_columns <> 10 THEN
    RAISE EXCEPTION 'SAAS-201 SourceArtifact projection expansion parity failed';
  END IF;
  IF to_regclass('public."SourceArtifact_tenantId_domain_source_externalRef_key"') IS NULL
     OR to_regclass('public."SourceArtifact_tenantId_artifactKind_createdAt_idx"') IS NULL
     OR to_regclass('public."SourceArtifact_tenantId_retentionState_updatedAt_idx"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-201 SourceArtifact projection index parity failed';
  END IF;
END
$$;

COMMIT;
