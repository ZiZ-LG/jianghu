BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "Opportunity" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "IndustryPack" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "Opportunity"
     WHERE "activeMethodologyBindingId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'CORE-110 unmanaged active methodology binding pointer; clear or migrate it through an approved binding snapshot before retrying';
  END IF;
END $$;

CREATE TABLE "MethodologyPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceTemplateRef" TEXT,
    "currentPublishedVersionId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MethodologyPack_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MethodologyPackVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "engineRef" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "learningContentRef" TEXT,
    "sourceTemplateRef" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "MethodologyPackVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MethodologyBinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "decisionProfileRef" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MethodologyBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MethodologyPilotAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "candidatePackId" TEXT NOT NULL,
    "candidateVersionId" TEXT NOT NULL,
    "baselineBindingId" TEXT,
    "matterVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MethodologyPilotAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MethodologyPack_tenantId_currentPublishedVersionId_idx" ON "MethodologyPack"("tenantId", "currentPublishedVersionId");
CREATE INDEX "MethodologyPack_tenantId_archivedAt_idx" ON "MethodologyPack"("tenantId", "archivedAt");
CREATE UNIQUE INDEX "MethodologyPack_tenantId_id_key" ON "MethodologyPack"("tenantId", "id");
CREATE UNIQUE INDEX "MethodologyPack_tenantId_key_key" ON "MethodologyPack"("tenantId", "key");

CREATE INDEX "MethodologyPackVersion_tenantId_packId_status_idx" ON "MethodologyPackVersion"("tenantId", "packId", "status");
CREATE INDEX "MethodologyPackVersion_tenantId_sourceTemplateRef_idx" ON "MethodologyPackVersion"("tenantId", "sourceTemplateRef");
CREATE UNIQUE INDEX "MethodologyPackVersion_tenantId_id_key" ON "MethodologyPackVersion"("tenantId", "id");
CREATE UNIQUE INDEX "MethodologyPackVersion_tenantId_packId_id_key" ON "MethodologyPackVersion"("tenantId", "packId", "id");
CREATE UNIQUE INDEX "MethodologyPackVersion_tenantId_packId_versionKey_key" ON "MethodologyPackVersion"("tenantId", "packId", "versionKey");

CREATE INDEX "MethodologyBinding_tenantId_opportunityId_createdAt_idx" ON "MethodologyBinding"("tenantId", "opportunityId", "createdAt");
CREATE INDEX "MethodologyBinding_tenantId_packId_versionId_idx" ON "MethodologyBinding"("tenantId", "packId", "versionId");
CREATE INDEX "MethodologyBinding_tenantId_decisionProfileRef_idx" ON "MethodologyBinding"("tenantId", "decisionProfileRef");
CREATE UNIQUE INDEX "MethodologyBinding_tenantId_id_key" ON "MethodologyBinding"("tenantId", "id");

CREATE INDEX "MethodologyPilotAssignment_tenantId_opportunityId_status_idx" ON "MethodologyPilotAssignment"("tenantId", "opportunityId", "status");
CREATE INDEX "MethodologyPilotAssignment_tenantId_candidatePackId_candida_idx" ON "MethodologyPilotAssignment"("tenantId", "candidatePackId", "candidateVersionId", "status");
CREATE INDEX "MethodologyPilotAssignment_tenantId_baselineBindingId_idx" ON "MethodologyPilotAssignment"("tenantId", "baselineBindingId");
CREATE UNIQUE INDEX "MethodologyPilotAssignment_tenantId_id_key" ON "MethodologyPilotAssignment"("tenantId", "id");

ALTER TABLE "MethodologyPackVersion"
  ADD CONSTRAINT "MethodologyPackVersion_tenantId_packId_fkey"
  FOREIGN KEY ("tenantId", "packId") REFERENCES "MethodologyPack"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MethodologyBinding"
  ADD CONSTRAINT "MethodologyBinding_tenantId_opportunityId_fkey"
  FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MethodologyBinding"
  ADD CONSTRAINT "MethodologyBinding_tenantId_packId_versionId_fkey"
  FOREIGN KEY ("tenantId", "packId", "versionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MethodologyBinding"
  ADD CONSTRAINT "MethodologyBinding_decisionProfileRef_fkey"
  FOREIGN KEY ("decisionProfileRef") REFERENCES "IndustryPack"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MethodologyPilotAssignment"
  ADD CONSTRAINT "MethodologyPilotAssignment_tenantId_opportunityId_fkey"
  FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MethodologyPilotAssignment"
  ADD CONSTRAINT "MethodologyPilotAssignment_tenantId_candidatePackId_candid_fkey"
  FOREIGN KEY ("tenantId", "candidatePackId", "candidateVersionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MethodologyPilotAssignment"
  ADD CONSTRAINT "MethodologyPilotAssignment_baselineBindingId_fkey"
  FOREIGN KEY ("baselineBindingId") REFERENCES "MethodologyBinding"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
