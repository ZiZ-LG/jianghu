BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "Account" IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE "_core115_account_legacy" ON COMMIT DROP AS
SELECT id, "tenantId", "customerType"
  FROM "Account";

ALTER TABLE "Account"
  ADD COLUMN "categoryKey" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ALTER COLUMN "customerType" DROP NOT NULL;

DO $$
DECLARE conflict_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO conflict_count
    FROM "_core115_account_legacy" AS legacy
    FULL OUTER JOIN "Account" AS current
      ON current.id = legacy.id
   WHERE current.id IS NULL
      OR legacy.id IS NULL
      OR current."tenantId" IS DISTINCT FROM legacy."tenantId"
      OR current."customerType" IS DISTINCT FROM legacy."customerType"
      OR current."categoryKey" IS NOT NULL
      OR current."version" <> 0;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Customer expansion parity failed: % row(s)', conflict_count;
  END IF;
END $$;

COMMIT;
