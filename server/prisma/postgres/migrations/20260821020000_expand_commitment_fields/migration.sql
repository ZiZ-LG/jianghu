BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "PlanAction", "Tenant", "Account", "Opportunity", "Person", "User" IN SHARE ROW EXCLUSIVE MODE;

-- Fail before DDL when a legacy action is outside its exact tenant/customer
-- tree or claims a non-tenant-local stable owner id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PlanAction" AS action
    LEFT JOIN "Tenant" AS tenant
      ON tenant."id" = action."tenantId"
    LEFT JOIN "Account" AS account
      ON account."id" = action."accountId"
     AND account."tenantId" = action."tenantId"
    LEFT JOIN "Opportunity" AS matter
      ON matter."id" = action."opportunityId"
     AND matter."tenantId" = action."tenantId"
     AND matter."accountId" = action."accountId"
    LEFT JOIN "Person" AS person
      ON person."id" = action."personId"
     AND person."tenantId" = action."tenantId"
     AND person."accountId" = action."accountId"
    LEFT JOIN "User" AS owner_user
      ON owner_user."id" = NULLIF(action."ownerId", '')
     AND owner_user."tenantId" = action."tenantId"
    WHERE tenant."id" IS NULL
       OR account."id" IS NULL
       OR matter."id" IS NULL
       OR (action."personId" IS NOT NULL AND person."id" IS NULL)
       OR (action."ownerId" <> '' AND owner_user."id" IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid legacy PlanAction parentage';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PlanAction"
    WHERE BTRIM("title") = ''
       OR ("startDate" = '' AND "endDate" = '')
       OR ("startDate" <> '' AND (
         "startDate" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         OR TO_CHAR(TO_DATE("startDate", 'YYYY-MM-DD'), 'YYYY-MM-DD') <> "startDate"
       ))
       OR ("endDate" <> '' AND (
         "endDate" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         OR TO_CHAR(TO_DATE("endDate", 'YYYY-MM-DD'), 'YYYY-MM-DD') <> "endDate"
       ))
  ) THEN
    RAISE EXCEPTION 'invalid legacy PlanAction business date or title';
  END IF;
END $$;

ALTER TABLE "PlanAction" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'task';
ALTER TABLE "PlanAction" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "PlanAction" ADD COLUMN "executionStatus" TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE "PlanAction" ADD COLUMN "confirmationStatus" TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE "PlanAction" ADD COLUMN "scheduledAtUtc" TIMESTAMP(3);
ALTER TABLE "PlanAction" ADD COLUMN "dueAtUtc" TIMESTAMP(3);
ALTER TABLE "PlanAction" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE "PlanAction" ADD COLUMN "isAllDay" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PlanAction" ADD COLUMN "localDate" TEXT;
ALTER TABLE "PlanAction" ADD COLUMN "confirmationDueAtUtc" TIMESTAMP(3);
ALTER TABLE "PlanAction" ADD COLUMN "confirmedAtUtc" TIMESTAMP(3);
ALTER TABLE "PlanAction" ADD COLUMN "confirmedByUserId" TEXT;
ALTER TABLE "PlanAction" ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlanAction" ADD COLUMN "nextCommitmentId" TEXT;
ALTER TABLE "PlanAction" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "PlanAction" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "PlanAction" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "PlanAction" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

UPDATE "PlanAction" AS action
SET
  "kind" = 'task',
  "ownerUserId" = NULLIF(action."ownerId", ''),
  "executionStatus" = CASE WHEN action."done" THEN 'completed' ELSE 'planned' END,
  "confirmationStatus" = 'not_required',
  "scheduledAtUtc" = NULL,
  "dueAtUtc" = NULL,
  "timeZone" = 'Asia/Shanghai',
  "isAllDay" = true,
  "localDate" = COALESCE(NULLIF(action."endDate", ''), NULLIF(action."startDate", '')),
  "confirmationDueAtUtc" = NULL,
  "confirmedAtUtc" = NULL,
  "confirmedByUserId" = NULL,
  "scheduleVersion" = 0,
  "nextCommitmentId" = NULL,
  "source" = COALESCE(NULLIF(BTRIM(action."origin"), ''), 'manual'),
  "sourceRef" = NULL,
  "archivedAt" = NULL,
  "version" = 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PlanAction" AS action
    WHERE action."kind" <> 'task'
       OR action."ownerUserId" IS DISTINCT FROM NULLIF(action."ownerId", '')
       OR action."executionStatus" <> CASE WHEN action."done" THEN 'completed' ELSE 'planned' END
       OR action."confirmationStatus" <> 'not_required'
       OR action."scheduledAtUtc" IS NOT NULL
       OR action."dueAtUtc" IS NOT NULL
       OR action."timeZone" <> 'Asia/Shanghai'
       OR action."isAllDay" IS NOT true
       OR action."localDate" IS DISTINCT FROM COALESCE(NULLIF(action."endDate", ''), NULLIF(action."startDate", ''))
       OR action."confirmationDueAtUtc" IS NOT NULL
       OR action."confirmedAtUtc" IS NOT NULL
       OR action."confirmedByUserId" IS NOT NULL
       OR action."scheduleVersion" <> 0
       OR action."nextCommitmentId" IS NOT NULL
       OR action."source" <> COALESCE(NULLIF(BTRIM(action."origin"), ''), 'manual')
       OR action."sourceRef" IS NOT NULL
       OR action."archivedAt" IS NOT NULL
       OR action."version" <> 0
  ) THEN
    RAISE EXCEPTION 'Commitment backfill parity failed';
  END IF;
END $$;

CREATE INDEX "PlanAction_tenantId_ownerUserId_executionStatus_idx"
  ON "PlanAction"("tenantId", "ownerUserId", "executionStatus");
CREATE INDEX "PlanAction_tenantId_confirmationStatus_confirmationDueAtUtc_idx"
  ON "PlanAction"("tenantId", "confirmationStatus", "confirmationDueAtUtc");
CREATE INDEX "PlanAction_tenantId_executionStatus_dueAtUtc_idx"
  ON "PlanAction"("tenantId", "executionStatus", "dueAtUtc");
CREATE INDEX "PlanAction_tenantId_executionStatus_localDate_idx"
  ON "PlanAction"("tenantId", "executionStatus", "localDate");
CREATE INDEX "PlanAction_tenantId_nextCommitmentId_idx"
  ON "PlanAction"("tenantId", "nextCommitmentId");

INSERT INTO "DataMigrationState" ("key", "completedAt", "details")
VALUES (
  'CORE-106-commitment-backfill-v1',
  CURRENT_TIMESTAMP,
  '{"source":"PlanAction legacy fields","authority":"legacy PlanAction until CORE-107","timeZone":"Asia/Shanghai","allDay":true}'
);

COMMIT;
