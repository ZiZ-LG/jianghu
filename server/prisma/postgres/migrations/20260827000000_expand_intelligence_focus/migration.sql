BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."DataMigrationState"') IS NULL
     OR to_regclass('public."ResearchBriefSnapshot"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-206 Intelligence/Focus requires tenant, migration, and SAAS-204 foundations';
  END IF;
  IF to_regclass('public."IntelligenceItem"') IS NOT NULL
     OR to_regclass('public."StakeholderFocus"') IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS-206 Intelligence/Focus tables already exist; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "IntelligenceItem" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "matterId" TEXT NOT NULL,
  "assertionType" TEXT NOT NULL DEFAULT 'reported',
  "statement" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceDescription" TEXT NOT NULL,
  "sourceRefId" TEXT,
  "sourceRefVersion" INTEGER,
  "occurredAt" TIMESTAMP(3),
  "learnedAt" TIMESTAMP(3) NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "targetRefs" TEXT NOT NULL DEFAULT '[]',
  "createdByUserId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMP(3),
  "archivedByUserId" TEXT,
  "archiveReason" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntelligenceItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntelligenceItem_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "IntelligenceItem_tenantId_customerId_learnedAt_idx"
  ON "IntelligenceItem"("tenantId", "customerId", "learnedAt");
CREATE INDEX "IntelligenceItem_tenantId_matterId_learnedAt_idx"
  ON "IntelligenceItem"("tenantId", "matterId", "learnedAt");
CREATE INDEX "IntelligenceItem_tenantId_assertionType_learnedAt_idx"
  ON "IntelligenceItem"("tenantId", "assertionType", "learnedAt");
CREATE INDEX "IntelligenceItem_tenantId_archivedAt_learnedAt_idx"
  ON "IntelligenceItem"("tenantId", "archivedAt", "learnedAt");
CREATE UNIQUE INDEX "IntelligenceItem_tenantId_id_key"
  ON "IntelligenceItem"("tenantId", "id");

CREATE TABLE "StakeholderFocus" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "matterId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "desiredChange" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "evidenceGap" TEXT,
  "basisRefs" TEXT NOT NULL DEFAULT '[]',
  "validUntil" TIMESTAMP(3) NOT NULL,
  "activeMatterKey" TEXT,
  "confirmedByUserId" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL,
  "retiredByUserId" TEXT,
  "retiredAt" TIMESTAMP(3),
  "retireReason" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StakeholderFocus_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StakeholderFocus_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "StakeholderFocus_tenantId_customerId_updatedAt_idx"
  ON "StakeholderFocus"("tenantId", "customerId", "updatedAt");
CREATE INDEX "StakeholderFocus_tenantId_matterId_updatedAt_idx"
  ON "StakeholderFocus"("tenantId", "matterId", "updatedAt");
CREATE INDEX "StakeholderFocus_tenantId_personId_updatedAt_idx"
  ON "StakeholderFocus"("tenantId", "personId", "updatedAt");
CREATE UNIQUE INDEX "StakeholderFocus_tenantId_id_key"
  ON "StakeholderFocus"("tenantId", "id");
CREATE UNIQUE INDEX "StakeholderFocus_tenantId_activeMatterKey_key"
  ON "StakeholderFocus"("tenantId", "activeMatterKey");

DO $$
DECLARE
  intelligence_column_count INTEGER;
  intelligence_index_count INTEGER;
  focus_column_count INTEGER;
  focus_index_count INTEGER;
BEGIN
  SELECT count(*) INTO intelligence_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'IntelligenceItem';
  IF intelligence_column_count <> 21 THEN
    RAISE EXCEPTION 'SAAS-206 IntelligenceItem table expansion parity failed';
  END IF;
  SELECT count(*) INTO intelligence_index_count
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'IntelligenceItem'
     AND indexname IN (
       'IntelligenceItem_pkey',
       'IntelligenceItem_tenantId_customerId_learnedAt_idx',
       'IntelligenceItem_tenantId_matterId_learnedAt_idx',
       'IntelligenceItem_tenantId_assertionType_learnedAt_idx',
       'IntelligenceItem_tenantId_archivedAt_learnedAt_idx',
       'IntelligenceItem_tenantId_id_key'
     );
  IF intelligence_index_count <> 6 THEN
    RAISE EXCEPTION 'SAAS-206 IntelligenceItem index expansion parity failed';
  END IF;

  SELECT count(*) INTO focus_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'StakeholderFocus';
  IF focus_column_count <> 19 THEN
    RAISE EXCEPTION 'SAAS-206 StakeholderFocus table expansion parity failed';
  END IF;
  SELECT count(*) INTO focus_index_count
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'StakeholderFocus'
     AND indexname IN (
       'StakeholderFocus_pkey',
       'StakeholderFocus_tenantId_customerId_updatedAt_idx',
       'StakeholderFocus_tenantId_matterId_updatedAt_idx',
       'StakeholderFocus_tenantId_personId_updatedAt_idx',
       'StakeholderFocus_tenantId_id_key',
       'StakeholderFocus_tenantId_activeMatterKey_key'
     );
  IF focus_index_count <> 6 THEN
    RAISE EXCEPTION 'SAAS-206 StakeholderFocus index expansion parity failed';
  END IF;
END
$$;

COMMIT;
