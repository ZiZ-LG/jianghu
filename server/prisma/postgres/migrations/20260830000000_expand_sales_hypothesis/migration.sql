BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."DataMigrationState"') IS NULL
     OR to_regclass('public."IntelligenceItem"') IS NULL
     OR to_regclass('public."StakeholderFocus"') IS NULL
     OR to_regclass('public."StrategyRisk"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-207 SalesHypothesis requires tenant, migration, intelligence/focus, and StrategyRisk foundations';
  END IF;
  IF to_regclass('public."SalesHypothesis"') IS NOT NULL
     OR to_regclass('public."SalesHypothesisRevision"') IS NOT NULL
     OR to_regclass('public."HypothesisEvidenceLink"') IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS-207 SalesHypothesis tables already exist; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Tenant", "StrategyRisk" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "SalesHypothesis" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "matterId" TEXT NOT NULL,
  "personId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'untested',
  "ownerUserId" TEXT,
  "nextReviewAt" TIMESTAMP(3),
  "currentRevisionId" TEXT NOT NULL,
  "legacyStrategyRiskId" TEXT,
  "createdByUserId" TEXT,
  "statusConfirmedByUserId" TEXT,
  "statusConfirmedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesHypothesis_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesHypothesis_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SalesHypothesis_tenantId_id_key"
  ON "SalesHypothesis"("tenantId", "id");
CREATE UNIQUE INDEX "SalesHypothesis_tenantId_legacyStrategyRiskId_key"
  ON "SalesHypothesis"("tenantId", "legacyStrategyRiskId");
CREATE INDEX "SalesHypothesis_tenantId_customerId_updatedAt_idx"
  ON "SalesHypothesis"("tenantId", "customerId", "updatedAt");
CREATE INDEX "SalesHypothesis_tenantId_matterId_updatedAt_idx"
  ON "SalesHypothesis"("tenantId", "matterId", "updatedAt");
CREATE INDEX "SalesHypothesis_tenantId_personId_updatedAt_idx"
  ON "SalesHypothesis"("tenantId", "personId", "updatedAt");
CREATE INDEX "SalesHypothesis_tenantId_ownerUserId_nextReviewAt_idx"
  ON "SalesHypothesis"("tenantId", "ownerUserId", "nextReviewAt");
CREATE INDEX "SalesHypothesis_tenantId_status_nextReviewAt_idx"
  ON "SalesHypothesis"("tenantId", "status", "nextReviewAt");

CREATE TABLE "SalesHypothesisRevision" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "hypothesisId" TEXT NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "claim" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "expectedSignals" TEXT NOT NULL DEFAULT '[]',
  "falsificationConditions" TEXT NOT NULL DEFAULT '[]',
  "origin" TEXT NOT NULL DEFAULT 'user',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesHypothesisRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesHypothesisRevision_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SalesHypothesisRevision_tenantId_id_key"
  ON "SalesHypothesisRevision"("tenantId", "id");
CREATE UNIQUE INDEX "SalesHypothesisRevision_tenantId_hypothesisId_revisionNumbe_key"
  ON "SalesHypothesisRevision"("tenantId", "hypothesisId", "revisionNumber");
CREATE INDEX "SalesHypothesisRevision_tenantId_hypothesisId_createdAt_idx"
  ON "SalesHypothesisRevision"("tenantId", "hypothesisId", "createdAt");

CREATE TABLE "HypothesisEvidenceLink" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "hypothesisId" TEXT NOT NULL,
  "hypothesisRevisionId" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "evidenceVersion" INTEGER NOT NULL DEFAULT 0,
  "direction" TEXT NOT NULL,
  "linkedByUserId" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HypothesisEvidenceLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HypothesisEvidenceLink_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HypothesisEvidenceLink_tenantId_id_key"
  ON "HypothesisEvidenceLink"("tenantId", "id");
CREATE UNIQUE INDEX "HypothesisEvidenceLink_tenantId_hypothesisRevisionId_eviden_key"
  ON "HypothesisEvidenceLink"("tenantId", "hypothesisRevisionId", "evidenceId");
CREATE INDEX "HypothesisEvidenceLink_tenantId_hypothesisId_linkedAt_idx"
  ON "HypothesisEvidenceLink"("tenantId", "hypothesisId", "linkedAt");
CREATE INDEX "HypothesisEvidenceLink_tenantId_evidenceId_idx"
  ON "HypothesisEvidenceLink"("tenantId", "evidenceId");

DO $$
DECLARE
  hypothesis_column_count INTEGER;
  hypothesis_index_count INTEGER;
  revision_column_count INTEGER;
  revision_index_count INTEGER;
  link_column_count INTEGER;
  link_index_count INTEGER;
BEGIN
  SELECT count(*) INTO hypothesis_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'SalesHypothesis';
  IF hypothesis_column_count <> 16 THEN
    RAISE EXCEPTION 'SAAS-207 SalesHypothesis table expansion parity failed';
  END IF;
  SELECT count(*) INTO hypothesis_index_count
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'SalesHypothesis';
  IF hypothesis_index_count <> 8 THEN
    RAISE EXCEPTION 'SAAS-207 SalesHypothesis index expansion parity failed';
  END IF;

  SELECT count(*) INTO revision_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'SalesHypothesisRevision';
  IF revision_column_count <> 11 THEN
    RAISE EXCEPTION 'SAAS-207 SalesHypothesisRevision table expansion parity failed';
  END IF;
  SELECT count(*) INTO revision_index_count
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'SalesHypothesisRevision';
  IF revision_index_count <> 4 THEN
    RAISE EXCEPTION 'SAAS-207 SalesHypothesisRevision index expansion parity failed';
  END IF;

  SELECT count(*) INTO link_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'HypothesisEvidenceLink';
  IF link_column_count <> 9 THEN
    RAISE EXCEPTION 'SAAS-207 HypothesisEvidenceLink table expansion parity failed';
  END IF;
  SELECT count(*) INTO link_index_count
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'HypothesisEvidenceLink';
  IF link_index_count <> 5 THEN
    RAISE EXCEPTION 'SAAS-207 HypothesisEvidenceLink index expansion parity failed';
  END IF;
END
$$;

COMMIT;
