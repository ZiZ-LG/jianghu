BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  existing_tables INTEGER;
BEGIN
  IF to_regclass('public."Candidate"') IS NULL
     OR to_regclass('public."SourceArtifact"') IS NULL THEN
    RAISE EXCEPTION 'CORE-205 ReviewBatch requires Candidate and SourceArtifact';
  END IF;
  SELECT count(*) INTO existing_tables
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('ReviewBatch', 'Interaction');
  IF existing_tables <> 0 THEN
    RAISE EXCEPTION 'CORE-205 ReviewBatch tables partially exist; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Candidate", "SourceArtifact" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  attached_candidates BIGINT;
BEGIN
  SELECT count(*) INTO attached_candidates
    FROM "Candidate"
   WHERE "sourceArtifactId" IS NOT NULL OR "reviewBatchId" IS NOT NULL;
  IF attached_candidates <> 0 THEN
    RAISE EXCEPTION 'CORE-205 pre-expansion Candidate attachment drift detected';
  END IF;
END
$$;

CREATE TABLE "ReviewBatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceArtifactId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "matterId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "activityKind" TEXT NOT NULL DEFAULT '',
  "occurredAt" TIMESTAMP(3),
  "interactionId" TEXT,
  "createdByUserId" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'owner_admin_only',
  "aclVersion" INTEGER NOT NULL DEFAULT 1,
  "acceptanceVersion" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "lastAcceptanceVersion" INTEGER,
  "lastAcceptanceHash" TEXT NOT NULL DEFAULT '',
  "lastAcceptanceResult" TEXT NOT NULL DEFAULT '{}',
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReviewBatch_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Interaction" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "matterId" TEXT,
  "sourceArtifactId" TEXT NOT NULL,
  "activityKind" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "createdByUserId" TEXT,
  "confirmedByUserId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Interaction_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReviewBatch_tenantId_sourceArtifactId_status_idx"
  ON "ReviewBatch"("tenantId", "sourceArtifactId", "status");
CREATE INDEX "ReviewBatch_tenantId_accountId_status_createdAt_idx"
  ON "ReviewBatch"("tenantId", "accountId", "status", "createdAt");
CREATE INDEX "ReviewBatch_tenantId_matterId_status_createdAt_idx"
  ON "ReviewBatch"("tenantId", "matterId", "status", "createdAt");
CREATE INDEX "ReviewBatch_tenantId_createdByUserId_visibility_idx"
  ON "ReviewBatch"("tenantId", "createdByUserId", "visibility");
CREATE INDEX "ReviewBatch_tenantId_interactionId_idx"
  ON "ReviewBatch"("tenantId", "interactionId");

CREATE INDEX "Interaction_tenantId_sourceArtifactId_idx"
  ON "Interaction"("tenantId", "sourceArtifactId");
CREATE INDEX "Interaction_tenantId_accountId_occurredAt_idx"
  ON "Interaction"("tenantId", "accountId", "occurredAt");
CREATE INDEX "Interaction_tenantId_matterId_occurredAt_idx"
  ON "Interaction"("tenantId", "matterId", "occurredAt");
CREATE INDEX "Interaction_tenantId_createdByUserId_idx"
  ON "Interaction"("tenantId", "createdByUserId");

DO $$
DECLARE
  table_count INTEGER;
  index_count INTEGER;
BEGIN
  SELECT count(*) INTO table_count
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('ReviewBatch', 'Interaction');
  IF table_count <> 2 THEN
    RAISE EXCEPTION 'CORE-205 ReviewBatch table expansion parity failed';
  END IF;
  SELECT count(*) INTO index_count
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname IN (
       'ReviewBatch_tenantId_sourceArtifactId_status_idx',
       'ReviewBatch_tenantId_accountId_status_createdAt_idx',
       'ReviewBatch_tenantId_matterId_status_createdAt_idx',
       'ReviewBatch_tenantId_createdByUserId_visibility_idx',
       'ReviewBatch_tenantId_interactionId_idx',
       'Interaction_tenantId_sourceArtifactId_idx',
       'Interaction_tenantId_accountId_occurredAt_idx',
       'Interaction_tenantId_matterId_occurredAt_idx',
       'Interaction_tenantId_createdByUserId_idx'
     );
  IF index_count <> 9 THEN
    RAISE EXCEPTION 'CORE-205 ReviewBatch index expansion parity failed';
  END IF;
END
$$;

COMMIT;
