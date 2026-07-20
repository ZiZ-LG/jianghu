-- INT-502: one-time, idempotent bridge from the last company pre-migration
-- schema (2026-07-12) to the current managed schema. The entrypoint only
-- reaches this migration after the live schema exactly matches either the
-- committed legacy snapshot or the current datamodel.
BEGIN;

LOCK TABLE "AccessToken", "Account", "Person", "Opportunity", "ChangeProposal",
  "EnrichJob", "CuratedSummary", "EVSnapshot", "VisitNote", "WeComUserBind"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "AccessToken"
  ADD COLUMN IF NOT EXISTS "scopes" TEXT NOT NULL DEFAULT '["read"]',
  ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "archiveReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "primaryOwnerUserId" TEXT;

ALTER TABLE "Person"
  ADD COLUMN IF NOT EXISTS "archiveReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "mergedIntoPersonId" TEXT;

ALTER TABLE "Opportunity"
  ADD COLUMN IF NOT EXISTS "archiveReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "primaryDPersonId" TEXT;

ALTER TABLE "ChangeProposal" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

ALTER TABLE "EnrichJob"
  ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "enqueueToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CuratedSummary" ADD COLUMN IF NOT EXISTS "aclVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EVSnapshot" ADD COLUMN IF NOT EXISTS "aclVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "AuditEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityKind" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "requestId" TEXT,
  "sourceRef" TEXT,
  "changedFields" TEXT NOT NULL DEFAULT '[]',
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CommandRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'running',
  "leaseToken" TEXT NOT NULL DEFAULT '',
  "leaseExpiresAt" TIMESTAMP(3),
  "resultSummary" TEXT NOT NULL DEFAULT '{}',
  "errorCode" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommandRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SyncRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "receipt" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WeComOAuthState" (
  "id" TEXT NOT NULL,
  "requestId" TEXT,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "pendingWecomUserid" TEXT NOT NULL DEFAULT '',
  "pendingAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WeComOAuthState_pkey" PRIMARY KEY ("id")
);

-- The earlier data-only migration cannot be replayed after a baseline resolve.
-- Normalize only still-raw ordinary keys, while preserving already-hashed keys.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CommandRun"
    WHERE "kind" = 'person-merge' AND "idempotencyKey" !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'CommandRun contains an unexpected unhashed person-merge idempotency key';
  END IF;
END $$;

UPDATE "CommandRun"
SET "idempotencyKey" = encode(sha256(convert_to("idempotencyKey", 'UTF8')), 'hex')
WHERE "kind" <> 'person-merge' AND "idempotencyKey" !~ '^[0-9a-f]{64}$';

CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_entityKind_entityId_idx" ON "AuditEvent"("tenantId", "entityKind", "entityId");
CREATE INDEX IF NOT EXISTS "CommandRun_tenantId_createdAt_idx" ON "CommandRun"("tenantId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "CommandRun_tenantId_actorId_kind_idempotencyKey_key" ON "CommandRun"("tenantId", "actorId", "kind", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "SyncRun_tenantId_createdAt_idx" ON "SyncRun"("tenantId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SyncRun_tenantId_idempotencyKey_key" ON "SyncRun"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "WeComOAuthState_requestId_key" ON "WeComOAuthState"("requestId");
CREATE INDEX IF NOT EXISTS "WeComOAuthState_tenantId_userId_expiresAt_idx" ON "WeComOAuthState"("tenantId", "userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "Account_tenantId_primaryOwnerUserId_idx" ON "Account"("tenantId", "primaryOwnerUserId");
CREATE INDEX IF NOT EXISTS "Account_tenantId_archivedAt_idx" ON "Account"("tenantId", "archivedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Account_tenantId_externalRef_key" ON "Account"("tenantId", "externalRef");
CREATE UNIQUE INDEX IF NOT EXISTS "Account_tenantId_unifiedCreditCode_key" ON "Account"("tenantId", "unifiedCreditCode");
CREATE INDEX IF NOT EXISTS "Person_tenantId_accountId_archivedAt_idx" ON "Person"("tenantId", "accountId", "archivedAt");
CREATE INDEX IF NOT EXISTS "Person_tenantId_mergedIntoPersonId_idx" ON "Person"("tenantId", "mergedIntoPersonId");
CREATE INDEX IF NOT EXISTS "Person_tenantId_createdAt_idx" ON "Person"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "Opportunity_tenantId_archivedAt_idx" ON "Opportunity"("tenantId", "archivedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Opportunity_tenantId_accountId_externalRef_key" ON "Opportunity"("tenantId", "accountId", "externalRef");
CREATE UNIQUE INDEX IF NOT EXISTS "VisitNote_tenantId_accountId_externalRef_key" ON "VisitNote"("tenantId", "accountId", "externalRef");
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeProposal_dedupeKey_key" ON "ChangeProposal"("dedupeKey");
CREATE INDEX IF NOT EXISTS "EnrichJob_status_nextAttemptAt_idx" ON "EnrichJob"("status", "nextAttemptAt");
CREATE UNIQUE INDEX IF NOT EXISTS "EnrichJob_tenantId_dedupeKey_key" ON "EnrichJob"("tenantId", "dedupeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "WeComUserBind_tenantId_wecomUserid_key" ON "WeComUserBind"("tenantId", "wecomUserid");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditEvent_tenantId_fkey') THEN
    ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
