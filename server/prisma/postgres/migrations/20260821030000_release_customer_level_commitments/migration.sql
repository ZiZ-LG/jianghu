BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "PlanAction", "DataMigrationState", "Tenant", "Account", "Opportunity", "Person", "User"
  IN SHARE ROW EXCLUSIVE MODE;

-- CORE-108 contracts the consumer graph only after CORE-106 completed the
-- same-row expansion. Fail before DDL if that prerequisite or current generic
-- parentage/state is invalid. A nullable Matter never permits a nullable
-- Customer, cross-tenant parent, or fabricated fallback Matter.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "DataMigrationState"
    WHERE "key" = 'CORE-106-commitment-backfill-v1'
  ) OR EXISTS (
    SELECT 1
    FROM "PlanAction" AS commitment
    LEFT JOIN "Tenant" AS tenant
      ON tenant."id" = commitment."tenantId"
    LEFT JOIN "Account" AS account
      ON account."id" = commitment."accountId"
     AND account."tenantId" = commitment."tenantId"
    LEFT JOIN "Opportunity" AS matter
      ON matter."id" = commitment."opportunityId"
     AND matter."tenantId" = commitment."tenantId"
     AND matter."accountId" = commitment."accountId"
    LEFT JOIN "Person" AS person
      ON person."id" = commitment."personId"
     AND person."tenantId" = commitment."tenantId"
     AND person."accountId" = commitment."accountId"
    LEFT JOIN "User" AS owner_user
      ON owner_user."id" = commitment."ownerUserId"
     AND owner_user."tenantId" = commitment."tenantId"
    LEFT JOIN "User" AS confirming_user
      ON confirming_user."id" = commitment."confirmedByUserId"
     AND confirming_user."tenantId" = commitment."tenantId"
    LEFT JOIN "PlanAction" AS next_commitment
      ON next_commitment."id" = commitment."nextCommitmentId"
     AND next_commitment."tenantId" = commitment."tenantId"
     AND next_commitment."accountId" = commitment."accountId"
    WHERE tenant."id" IS NULL
       OR account."id" IS NULL
       OR (commitment."opportunityId" IS NOT NULL AND matter."id" IS NULL)
       OR (commitment."personId" IS NOT NULL AND person."id" IS NULL)
       OR (commitment."ownerUserId" IS NOT NULL AND owner_user."id" IS NULL)
       OR (commitment."confirmedByUserId" IS NOT NULL AND confirming_user."id" IS NULL)
       OR (commitment."nextCommitmentId" IS NOT NULL AND next_commitment."id" IS NULL)
       OR BTRIM(commitment."title") = ''
       OR BTRIM(commitment."kind") = ''
       OR BTRIM(commitment."source") = ''
       OR (commitment."sourceRef" IS NOT NULL AND BTRIM(commitment."sourceRef") = '')
       OR BTRIM(commitment."timeZone") = ''
       OR commitment."executionStatus" NOT IN ('planned', 'completed', 'canceled', 'missed')
       OR commitment."confirmationStatus" NOT IN ('not_required', 'pending', 'confirmed', 'declined')
       OR commitment."version" < 0
       OR commitment."scheduleVersion" < 0
       OR (commitment."isAllDay" AND (
         commitment."localDate" IS NULL
         OR commitment."scheduledAtUtc" IS NOT NULL
         OR commitment."dueAtUtc" IS NOT NULL
       ))
       OR (NOT commitment."isAllDay" AND (
         (commitment."scheduledAtUtc" IS NULL AND commitment."dueAtUtc" IS NULL)
         OR commitment."localDate" IS NOT NULL
       ))
       OR (commitment."confirmationStatus" = 'not_required' AND commitment."confirmationDueAtUtc" IS NOT NULL)
       OR (commitment."confirmationStatus" = 'pending' AND commitment."confirmationDueAtUtc" IS NULL)
       OR (commitment."confirmationStatus" = 'confirmed' AND (
         commitment."confirmedAtUtc" IS NULL OR commitment."confirmedByUserId" IS NULL
       ))
       OR (commitment."confirmationStatus" <> 'confirmed' AND (
         commitment."confirmedAtUtc" IS NOT NULL OR commitment."confirmedByUserId" IS NOT NULL
       ))
  ) THEN
    RAISE EXCEPTION 'Commitment cutover preflight failed';
  END IF;
END $$;

ALTER TABLE "PlanAction" ALTER COLUMN "opportunityId" DROP NOT NULL;

INSERT INTO "DataMigrationState" ("key", "completedAt", "details")
VALUES (
  'CORE-108-commitment-consumer-cutover-v1',
  CURRENT_TIMESTAMP,
  '{"authority":"generic same-row Commitment fields","matter":"nullable","legacyPlanAction":"matter-required adapter"}'
)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
