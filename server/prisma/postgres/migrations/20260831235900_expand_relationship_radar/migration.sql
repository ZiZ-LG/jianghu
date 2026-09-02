BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."DataMigrationState"') IS NULL
     OR to_regclass('public."AgentRun"') IS NULL
     OR to_regclass('public."PlanAction"') IS NULL
     OR to_regclass('public."IntelligenceItem"') IS NULL
     OR to_regclass('public."StakeholderFocus"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-212 RelationshipRadarSnapshot requires migration, Agent, and relationship workspace foundations';
  END IF;
  IF to_regclass('public."RelationshipRadarSnapshot"') IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS-212 RelationshipRadarSnapshot already exists; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "RelationshipRadarSnapshot" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "matterId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "agentRunId" TEXT NOT NULL,
  "generationKey" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "payloadFingerprint" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "signalCount" INTEGER NOT NULL,
  "interventionCount" INTEGER NOT NULL,
  "draftCount" INTEGER NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RelationshipRadarSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RelationshipRadarSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "rrs_tenant_customer_matter_generated_idx"
  ON "RelationshipRadarSnapshot"("tenantId", "customerId", "matterId", "generatedAt");
CREATE INDEX "rrs_tenant_matter_expires_idx"
  ON "RelationshipRadarSnapshot"("tenantId", "matterId", "expiresAt");
CREATE UNIQUE INDEX "rrs_tenant_run_key"
  ON "RelationshipRadarSnapshot"("tenantId", "agentRunId");
CREATE UNIQUE INDEX "rrs_tenant_creator_generation_key"
  ON "RelationshipRadarSnapshot"("tenantId", "createdByUserId", "generationKey");

DO $$
DECLARE
  column_count INTEGER;
  index_count INTEGER;
  row_count BIGINT;
BEGIN
  SELECT count(*) INTO column_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'RelationshipRadarSnapshot';
  IF column_count <> 18 THEN
    RAISE EXCEPTION 'SAAS-212 RelationshipRadarSnapshot column parity failed';
  END IF;
  SELECT count(*) INTO index_count
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'RelationshipRadarSnapshot'
     AND indexname IN (
       'RelationshipRadarSnapshot_pkey',
       'rrs_tenant_customer_matter_generated_idx',
       'rrs_tenant_matter_expires_idx',
       'rrs_tenant_run_key',
       'rrs_tenant_creator_generation_key'
     );
  IF index_count <> 5 THEN
    RAISE EXCEPTION 'SAAS-212 RelationshipRadarSnapshot index parity failed';
  END IF;
  SELECT count(*) INTO row_count FROM "RelationshipRadarSnapshot";
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'SAAS-212 expansion must not infer or backfill radar snapshots';
  END IF;
END
$$;

COMMIT;
