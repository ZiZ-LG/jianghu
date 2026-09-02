BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."DataMigrationState"') IS NULL
     OR to_regclass('public."AgentRun"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-204 ResearchBriefSnapshot requires tenant, migration, and AgentRun foundations';
  END IF;
  IF to_regclass('public."ResearchBriefSnapshot"') IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS-204 ResearchBriefSnapshot table already exists; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "ResearchBriefSnapshot" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "matterId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "generationKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "subjectStatus" TEXT NOT NULL,
  "payloadEnc" TEXT NOT NULL,
  "payloadFingerprint" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "sourceCount" INTEGER NOT NULL,
  "sectionCount" INTEGER NOT NULL,
  "unknownCount" INTEGER NOT NULL,
  "failureCount" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "basedOnAt" TIMESTAMP(3),
  "freshUntil" TIMESTAMP(3),
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchBriefSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchBriefSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ResearchBriefSnapshot_tenantId_createdByUserId_generationKe_key"
  ON "ResearchBriefSnapshot"("tenantId", "createdByUserId", "generationKey");
CREATE INDEX "ResearchBriefSnapshot_tenantId_createdByUserId_customerId_g_idx"
  ON "ResearchBriefSnapshot"("tenantId", "createdByUserId", "customerId", "generatedAt");
CREATE INDEX "ResearchBriefSnapshot_tenantId_createdByUserId_matterId_gen_idx"
  ON "ResearchBriefSnapshot"("tenantId", "createdByUserId", "matterId", "generatedAt");

DO $$
DECLARE
  column_count INTEGER;
  index_count INTEGER;
BEGIN
  SELECT count(*) INTO column_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'ResearchBriefSnapshot';
  IF column_count <> 20 THEN
    RAISE EXCEPTION 'SAAS-204 ResearchBriefSnapshot table expansion parity failed';
  END IF;
  SELECT count(*) INTO index_count
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'ResearchBriefSnapshot'
     AND indexname IN (
       'ResearchBriefSnapshot_pkey',
       'ResearchBriefSnapshot_tenantId_createdByUserId_generationKe_key',
       'ResearchBriefSnapshot_tenantId_createdByUserId_customerId_g_idx',
       'ResearchBriefSnapshot_tenantId_createdByUserId_matterId_gen_idx'
     );
  IF index_count <> 4 THEN
    RAISE EXCEPTION 'SAAS-204 ResearchBriefSnapshot index expansion parity failed';
  END IF;
END
$$;

COMMIT;
