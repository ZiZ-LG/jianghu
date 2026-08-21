BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

-- The supported production update path stops server/web writers before this
-- transaction. Bound the maintenance window rather than waiting forever.
LOCK TABLE "Opportunity" IN SHARE ROW EXCLUSIVE MODE;

-- Fail before changing the schema if the open legacy status column contains a
-- value that cannot be mapped without guessing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Opportunity"
    WHERE "status" NOT IN ('active', 'paused', 'won', 'lost')
  ) THEN
    RAISE EXCEPTION 'unsupported legacy Opportunity status';
  END IF;
END $$;

ALTER TABLE "Opportunity"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'sales_opportunity',
  ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "outcomeKey" TEXT,
  ADD COLUMN "priority" TEXT,
  ADD COLUMN "targetDate" TEXT,
  ADD COLUMN "primaryOwnerUserId" TEXT,
  ADD COLUMN "activeMethodologyBindingId" TEXT;

UPDATE "Opportunity"
SET
  "kind" = 'sales_opportunity',
  "lifecycleStatus" = CASE "status"
    WHEN 'active' THEN 'active'
    WHEN 'paused' THEN 'paused'
    WHEN 'won' THEN 'completed'
    WHEN 'lost' THEN 'completed'
  END,
  "outcomeKey" = CASE "status"
    WHEN 'won' THEN 'won'
    WHEN 'lost' THEN 'lost'
    ELSE NULL
  END
WHERE "status" <> 'active';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Opportunity"
    WHERE "kind" <> 'sales_opportunity'
      OR ("status" = 'active' AND ("lifecycleStatus" <> 'active' OR "outcomeKey" IS NOT NULL))
      OR ("status" = 'paused' AND ("lifecycleStatus" <> 'paused' OR "outcomeKey" IS NOT NULL))
      OR ("status" = 'won' AND ("lifecycleStatus" <> 'completed' OR "outcomeKey" IS DISTINCT FROM 'won'))
      OR ("status" = 'lost' AND ("lifecycleStatus" <> 'completed' OR "outcomeKey" IS DISTINCT FROM 'lost'))
  ) THEN
    RAISE EXCEPTION 'matter lifecycle backfill parity failed';
  END IF;
END $$;

CREATE INDEX "Opportunity_tenantId_kind_lifecycleStatus_idx"
  ON "Opportunity"("tenantId", "kind", "lifecycleStatus");
CREATE INDEX "Opportunity_tenantId_primaryOwnerUserId_idx"
  ON "Opportunity"("tenantId", "primaryOwnerUserId");
CREATE INDEX "Opportunity_tenantId_targetDate_idx"
  ON "Opportunity"("tenantId", "targetDate");
CREATE INDEX "Opportunity_tenantId_activeMethodologyBindingId_idx"
  ON "Opportunity"("tenantId", "activeMethodologyBindingId");

COMMIT;
