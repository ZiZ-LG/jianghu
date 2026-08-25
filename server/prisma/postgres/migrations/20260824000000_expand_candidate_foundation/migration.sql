BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL THEN
    RAISE EXCEPTION 'CORE-201 Candidate expansion requires Tenant';
  END IF;
  IF to_regclass('public."Candidate"') IS NOT NULL THEN
    RAISE EXCEPTION 'CORE-201 Candidate table already exists; use guarded adoption instead of replay';
  END IF;
END
$$;

LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "accountId" TEXT NOT NULL,
    "matterId" TEXT,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT,
    "fieldKey" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sourceArtifactId" TEXT,
    "reviewBatchId" TEXT,
    "createdByUserId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "dedupeKey" TEXT NOT NULL,
    "legacySourceKind" TEXT,
    "legacySourceId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Candidate_tenantId_status_createdAt_idx"
  ON "Candidate"("tenantId", "status", "createdAt");
CREATE INDEX "Candidate_tenantId_accountId_status_createdAt_idx"
  ON "Candidate"("tenantId", "accountId", "status", "createdAt");
CREATE INDEX "Candidate_tenantId_matterId_status_createdAt_idx"
  ON "Candidate"("tenantId", "matterId", "status", "createdAt");
CREATE INDEX "Candidate_tenantId_sourceArtifactId_idx"
  ON "Candidate"("tenantId", "sourceArtifactId");
CREATE INDEX "Candidate_tenantId_reviewBatchId_idx"
  ON "Candidate"("tenantId", "reviewBatchId");
CREATE INDEX "Candidate_tenantId_createdByUserId_visibility_idx"
  ON "Candidate"("tenantId", "createdByUserId", "visibility");
CREATE UNIQUE INDEX "Candidate_tenantId_dedupeKey_key"
  ON "Candidate"("tenantId", "dedupeKey");
CREATE UNIQUE INDEX "Candidate_tenantId_legacySourceKind_legacySourceId_key"
  ON "Candidate"("tenantId", "legacySourceKind", "legacySourceId");

ALTER TABLE "Candidate"
  ADD CONSTRAINT "Candidate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE
  candidate_column_count INTEGER;
BEGIN
  SELECT count(*) INTO candidate_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'Candidate';

  IF candidate_column_count <> 26 THEN
    RAISE EXCEPTION 'CORE-201 Candidate expansion parity failed: expected 26 columns, found %',
      candidate_column_count;
  END IF;
END
$$;

COMMIT;
