BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

-- Freeze the legacy authority and every referenced parent while the shadow is materialized.
LOCK TABLE "Opportunity" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "DealPdeConfig" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "IndustryPack" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "DataMigrationState" IN SHARE ROW EXCLUSIVE MODE;

-- The composite key is required so a PDE context cannot reference a profile from another tenant.
CREATE UNIQUE INDEX "IndustryPack_tenantId_id_key" ON "IndustryPack"("tenantId", "id");

CREATE TABLE "PdeDecisionContext" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "decisionProfileRef" TEXT,
    "source" TEXT NOT NULL DEFAULT 'legacy_shadow',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PdeDecisionContext_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PdeDecisionContext_tenantId_opportunityId_fkey"
      FOREIGN KEY ("tenantId", "opportunityId")
      REFERENCES "Opportunity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PdeDecisionContext_tenantId_decisionProfileRef_fkey"
      FOREIGN KEY ("tenantId", "decisionProfileRef")
      REFERENCES "IndustryPack"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PdeDecisionContext_tenantId_id_key"
  ON "PdeDecisionContext"("tenantId", "id");
CREATE UNIQUE INDEX "PdeDecisionContext_tenantId_opportunityId_key"
  ON "PdeDecisionContext"("tenantId", "opportunityId");
CREATE INDEX "PdeDecisionContext_tenantId_decisionProfileRef_idx"
  ON "PdeDecisionContext"("tenantId", "decisionProfileRef");
CREATE INDEX "PdeDecisionContext_tenantId_stageKey_idx"
  ON "PdeDecisionContext"("tenantId", "stageKey");

INSERT INTO "PdeDecisionContext" (
  "id", "tenantId", "opportunityId", "stageKey", "decisionProfileRef",
  "source", "version", "createdAt", "updatedAt"
)
SELECT
  'pdc_' || md5(matter."tenantId" || E'\\x1f' || matter.id),
  matter."tenantId",
  matter.id,
  CASE matter."engageStage"
    WHEN '需求调研立项' THEN 'initiation'
    WHEN '方案可研' THEN 'feasibility'
    WHEN '预算批复' THEN 'budget_approval'
    WHEN '招标论证' THEN 'tender_design'
    WHEN '招采执行' THEN 'tender_execution'
    ELSE 'initiation'
  END,
  profile.id,
  'legacy_shadow',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Opportunity" AS matter
LEFT JOIN "DealPdeConfig" AS config
  ON config."tenantId" = matter."tenantId"
 AND config."opportunityId" = matter.id
LEFT JOIN LATERAL (
  SELECT candidate.id
    FROM "IndustryPack" AS candidate
   WHERE candidate."tenantId" = matter."tenantId"
     AND candidate."packKey" = COALESCE(config."industryPackKey", 'digital-energy')
     AND candidate.active = true
   ORDER BY
     CASE WHEN candidate."schemaVersion" = '1.1' THEN 0 ELSE 1 END,
     candidate."createdAt" DESC,
     candidate.id ASC
   LIMIT 1
) AS profile ON true;

DO $$
DECLARE conflict_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO conflict_count
    FROM "Opportunity" AS matter
    LEFT JOIN "DealPdeConfig" AS config
      ON config."tenantId" = matter."tenantId"
     AND config."opportunityId" = matter.id
    LEFT JOIN LATERAL (
      SELECT candidate.id
        FROM "IndustryPack" AS candidate
       WHERE candidate."tenantId" = matter."tenantId"
         AND candidate."packKey" = COALESCE(config."industryPackKey", 'digital-energy')
         AND candidate.active = true
       ORDER BY
         CASE WHEN candidate."schemaVersion" = '1.1' THEN 0 ELSE 1 END,
         candidate."createdAt" DESC,
         candidate.id ASC
       LIMIT 1
    ) AS profile ON true
    LEFT JOIN "PdeDecisionContext" AS context
      ON context."tenantId" = matter."tenantId"
     AND context."opportunityId" = matter.id
   WHERE context.id IS NULL
      OR context."stageKey" <> CASE matter."engageStage"
           WHEN '需求调研立项' THEN 'initiation'
           WHEN '方案可研' THEN 'feasibility'
           WHEN '预算批复' THEN 'budget_approval'
           WHEN '招标论证' THEN 'tender_design'
           WHEN '招采执行' THEN 'tender_execution'
           ELSE 'initiation'
         END
      OR context."decisionProfileRef" IS DISTINCT FROM profile.id;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'PDE decision context backfill parity failed: % row(s)', conflict_count;
  END IF;
END $$;

INSERT INTO "DataMigrationState" ("key", "completedAt", "details")
SELECT
  'CORE-113-pde-decision-context-shadow-v1',
  CURRENT_TIMESTAMP,
  json_build_object(
    'authority', 'PdeDecisionContext',
    'candidateRows', COUNT(*),
    'missingDecisionProfileRows', COUNT(*) FILTER (WHERE "decisionProfileRef" IS NULL)
  )::text
FROM "PdeDecisionContext"
WHERE source = 'legacy_shadow';

COMMIT;
