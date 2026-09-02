BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  existing_tables INTEGER;
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."User"') IS NULL
     OR to_regclass('public."Account"') IS NULL
     OR to_regclass('public."Opportunity"') IS NULL
     OR to_regclass('public."SourceArtifact"') IS NULL
     OR to_regclass('public."ReviewBatch"') IS NULL THEN
    RAISE EXCEPTION 'CORE-206 Agent Job requires tenant, scope, source, and review foundations';
  END IF;
  SELECT count(*) INTO existing_tables
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('AgentJobDefinition', 'AgentRun');
  IF existing_tables <> 0 THEN
    RAISE EXCEPTION 'CORE-206 Agent Job tables partially exist; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Tenant", "User", "Account", "Opportunity", "SourceArtifact", "ReviewBatch" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "AgentJobDefinition" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "jobKey" TEXT NOT NULL,
  "jobVersion" TEXT NOT NULL,
  "definitionJson" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "tenantLimitsJson" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentJobDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentJobDefinition_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "definitionId" TEXT NOT NULL,
  "jobKey" TEXT NOT NULL,
  "jobVersion" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "definitionControlVersion" INTEGER NOT NULL,
  "actionMode" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "customerId" TEXT NOT NULL,
  "matterId" TEXT,
  "sourceArtifactId" TEXT,
  "actorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL,
  "leaseToken" TEXT NOT NULL DEFAULT '',
  "leaseExpiresAt" TIMESTAMP(3),
  "budgetLimit" INTEGER NOT NULL,
  "costUsed" INTEGER NOT NULL DEFAULT 0,
  "timeoutMs" INTEGER NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "inputRefs" TEXT NOT NULL,
  "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
  "outputRefs" TEXT NOT NULL DEFAULT '[]',
  "modelRef" TEXT NOT NULL,
  "connectorRefs" TEXT NOT NULL DEFAULT '[]',
  "failureCode" TEXT NOT NULL DEFAULT '',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentRun_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentJobDefinition_tenantId_jobKey_jobVersion_key"
  ON "AgentJobDefinition"("tenantId", "jobKey", "jobVersion");
CREATE INDEX "AgentJobDefinition_tenantId_enabled_jobKey_idx"
  ON "AgentJobDefinition"("tenantId", "enabled", "jobKey");
CREATE INDEX "AgentJobDefinition_tenantId_updatedAt_idx"
  ON "AgentJobDefinition"("tenantId", "updatedAt");

CREATE UNIQUE INDEX "AgentRun_tenantId_actorId_jobKey_jobVersion_idempotencyKey_key"
  ON "AgentRun"("tenantId", "actorId", "jobKey", "jobVersion", "idempotencyKey");
CREATE INDEX "AgentRun_tenantId_status_createdAt_idx"
  ON "AgentRun"("tenantId", "status", "createdAt");
CREATE INDEX "AgentRun_tenantId_customerId_createdAt_idx"
  ON "AgentRun"("tenantId", "customerId", "createdAt");
CREATE INDEX "AgentRun_tenantId_matterId_createdAt_idx"
  ON "AgentRun"("tenantId", "matterId", "createdAt");
CREATE INDEX "AgentRun_tenantId_sourceArtifactId_createdAt_idx"
  ON "AgentRun"("tenantId", "sourceArtifactId", "createdAt");
CREATE INDEX "AgentRun_tenantId_actorId_createdAt_idx"
  ON "AgentRun"("tenantId", "actorId", "createdAt");
CREATE INDEX "AgentRun_tenantId_definitionId_idx"
  ON "AgentRun"("tenantId", "definitionId");

DO $$
DECLARE
  table_count INTEGER;
  index_count INTEGER;
BEGIN
  SELECT count(*) INTO table_count
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('AgentJobDefinition', 'AgentRun');
  IF table_count <> 2 THEN
    RAISE EXCEPTION 'CORE-206 Agent Job table expansion parity failed';
  END IF;
  SELECT count(*) INTO index_count
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname IN (
       'AgentJobDefinition_tenantId_jobKey_jobVersion_key',
       'AgentJobDefinition_tenantId_enabled_jobKey_idx',
       'AgentJobDefinition_tenantId_updatedAt_idx',
       'AgentRun_tenantId_actorId_jobKey_jobVersion_idempotencyKey_key',
       'AgentRun_tenantId_status_createdAt_idx',
       'AgentRun_tenantId_customerId_createdAt_idx',
       'AgentRun_tenantId_matterId_createdAt_idx',
       'AgentRun_tenantId_sourceArtifactId_createdAt_idx',
       'AgentRun_tenantId_actorId_createdAt_idx',
       'AgentRun_tenantId_definitionId_idx'
     );
  IF index_count <> 10 THEN
    RAISE EXCEPTION 'CORE-206 Agent Job index expansion parity failed';
  END IF;
END
$$;

COMMIT;
