BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "Tenant"
  ADD COLUMN "dataScopePolicy" TEXT NOT NULL DEFAULT 'legacy_tenant_shared';

COMMIT;
