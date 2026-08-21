BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "OppRole", "OpportunityMember", "Opportunity", "Person", "Edge" IN SHARE ROW EXCLUSIVE MODE;

-- Fail before any DDL if either legacy source points outside its exact tenant/customer tree.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "tenantId", "opportunityId", "personId" FROM "OppRole"
      UNION ALL
      SELECT "tenantId", "opportunityId", "personId" FROM "OpportunityMember"
    ) AS source
    LEFT JOIN "Tenant" AS tenant ON tenant."id" = source."tenantId"
    LEFT JOIN "Opportunity" AS matter ON matter."id" = source."opportunityId"
    LEFT JOIN "Person" AS person ON person."id" = source."personId"
    WHERE tenant."id" IS NULL
       OR matter."id" IS NULL
       OR person."id" IS NULL
       OR matter."tenantId" <> source."tenantId"
       OR person."tenantId" <> source."tenantId"
       OR matter."accountId" <> person."accountId"
  ) THEN
    RAISE EXCEPTION 'invalid MatterParticipant legacy parentage';
  END IF;
END $$;

CREATE TABLE "DataMigrationState" (
  "key" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "details" TEXT NOT NULL DEFAULT '{}',

  CONSTRAINT "DataMigrationState_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "MatterParticipant" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "opportunityId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MatterParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatterParticipant_tenantId_opportunityId_personId_key"
  ON "MatterParticipant"("tenantId", "opportunityId", "personId");
CREATE INDEX "MatterParticipant_tenantId_accountId_opportunityId_idx"
  ON "MatterParticipant"("tenantId", "accountId", "opportunityId");
CREATE INDEX "MatterParticipant_tenantId_accountId_personId_idx"
  ON "MatterParticipant"("tenantId", "accountId", "personId");
CREATE INDEX "MatterParticipant_tenantId_personId_idx"
  ON "MatterParticipant"("tenantId", "personId");

ALTER TABLE "MatterParticipant"
  ADD CONSTRAINT "MatterParticipant_tenantId_accountId_fkey"
  FOREIGN KEY ("tenantId", "accountId")
  REFERENCES "Account"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatterParticipant"
  ADD CONSTRAINT "MatterParticipant_tenantId_opportunityId_fkey"
  FOREIGN KEY ("tenantId", "opportunityId")
  REFERENCES "Opportunity"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatterParticipant"
  ADD CONSTRAINT "MatterParticipant_tenantId_personId_fkey"
  FOREIGN KEY ("tenantId", "personId")
  REFERENCES "Person"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Edge" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'related';

-- A methodology role implies generic participation. When both sources contain a person,
-- the role-derived row wins deterministically and the visibility row remains untouched.
INSERT INTO "MatterParticipant" (
  "id", "tenantId", "accountId", "opportunityId", "personId", "createdAt"
)
SELECT
  'mp_role_' || MIN(role."id"),
  role."tenantId",
  matter."accountId",
  role."opportunityId",
  role."personId",
  CURRENT_TIMESTAMP
FROM "OppRole" AS role
JOIN "Opportunity" AS matter
  ON matter."id" = role."opportunityId" AND matter."tenantId" = role."tenantId"
JOIN "Person" AS person
  ON person."id" = role."personId"
 AND person."tenantId" = role."tenantId"
 AND person."accountId" = matter."accountId"
GROUP BY role."tenantId", matter."accountId", role."opportunityId", role."personId";

INSERT INTO "MatterParticipant" (
  "id", "tenantId", "accountId", "opportunityId", "personId", "createdAt"
)
SELECT
  'mp_member_' || MIN(member."id"),
  member."tenantId",
  matter."accountId",
  member."opportunityId",
  member."personId",
  CURRENT_TIMESTAMP
FROM "OpportunityMember" AS member
JOIN "Opportunity" AS matter
  ON matter."id" = member."opportunityId" AND matter."tenantId" = member."tenantId"
JOIN "Person" AS person
  ON person."id" = member."personId"
 AND person."tenantId" = member."tenantId"
 AND person."accountId" = matter."accountId"
WHERE NOT EXISTS (
  SELECT 1
  FROM "MatterParticipant" AS participant
  WHERE participant."tenantId" = member."tenantId"
    AND participant."opportunityId" = member."opportunityId"
    AND participant."personId" = member."personId"
)
GROUP BY member."tenantId", matter."accountId", member."opportunityId", member."personId";

DO $$
BEGIN
  IF EXISTS (
    SELECT source."tenantId", source."opportunityId", source."personId"
    FROM (
      SELECT "tenantId", "opportunityId", "personId" FROM "OppRole"
      UNION
      SELECT "tenantId", "opportunityId", "personId" FROM "OpportunityMember"
    ) AS source
    LEFT JOIN "MatterParticipant" AS participant
      ON participant."tenantId" = source."tenantId"
     AND participant."opportunityId" = source."opportunityId"
     AND participant."personId" = source."personId"
    WHERE participant."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'MatterParticipant backfill parity failed';
  END IF;
END $$;

INSERT INTO "DataMigrationState" ("key", "completedAt", "details")
VALUES (
  'CORE-105-matter-participant-backfill-v1',
  CURRENT_TIMESTAMP,
  '{"source":"OppRole+OpportunityMember","authority":"MatterParticipant"}'
);

COMMIT;
