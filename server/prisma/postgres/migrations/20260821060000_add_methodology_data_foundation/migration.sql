BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

-- Freeze every referenced parent while the expand-only child tables and composite FKs are installed.
LOCK TABLE "MethodologyPackVersion" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "MethodologyBinding" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Opportunity" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Person" IN SHARE ROW EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE "MethodologyFieldDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "valueDomainJson" TEXT NOT NULL DEFAULT '{}',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "missingValuePolicy" TEXT NOT NULL,
    "storageBindingKind" TEXT NOT NULL,
    "storageBindingPath" TEXT NOT NULL,
    "legacyStopDate" TEXT,
    "legacyConsumersJson" TEXT NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MethodologyFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyStageDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "entryConditionsJson" TEXT NOT NULL DEFAULT '[]',
    "exitConditionsJson" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "MethodologyStageDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyRoleDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appliesTo" TEXT NOT NULL DEFAULT 'person',
    "constraintsJson" TEXT NOT NULL DEFAULT '{}',
    "minimumAssignments" INTEGER NOT NULL DEFAULT 0,
    "maximumAssignments" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MethodologyRoleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyRuleDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "inputRefsJson" TEXT NOT NULL DEFAULT '[]',
    "weightsJson" TEXT NOT NULL DEFAULT '{}',
    "thresholdsJson" TEXT NOT NULL DEFAULT '{}',
    "outputKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MethodologyRuleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyActionTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "gapKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "script" TEXT NOT NULL DEFAULT '',
    "evidenceRequirementsJson" TEXT NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MethodologyActionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyStageState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "humanOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "evidenceIdsJson" TEXT NOT NULL DEFAULT '[]',
    "updatedByUserId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MethodologyStageState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyRoleAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "evidenceIdsJson" TEXT NOT NULL DEFAULT '[]',
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MethodologyRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyValue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "normalizedValueJson" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "evidenceIdsJson" TEXT NOT NULL DEFAULT '[]',
    "updatedByUserId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MethodologyValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyEvaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "inputsJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceIdsJson" TEXT NOT NULL DEFAULT '[]',
    "aclVersion" INTEGER NOT NULL DEFAULT 0,
    "packVersionKey" TEXT NOT NULL,
    "engineRef" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "resultHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MethodologyEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodologyMigrationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "sourceBindingId" TEXT NOT NULL,
    "sourcePackId" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "targetPackId" TEXT NOT NULL,
    "targetVersionId" TEXT NOT NULL,
    "matterVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "dryRunJson" TEXT NOT NULL DEFAULT '{}',
    "mappingJson" TEXT NOT NULL DEFAULT '{}',
    "conflictsJson" TEXT NOT NULL DEFAULT '[]',
    "confirmationJson" TEXT NOT NULL DEFAULT '{}',
    "executionJson" TEXT NOT NULL DEFAULT '{}',
    "rollbackJson" TEXT NOT NULL DEFAULT '{}',
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "executedByUserId" TEXT,
    "executedAt" TIMESTAMP(3),
    "rolledBackByUserId" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MethodologyMigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MethodologyFieldDefinition_tenantId_packId_versionId_positi_idx" ON "MethodologyFieldDefinition"("tenantId", "packId", "versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyFieldDefinition_tenantId_id_key" ON "MethodologyFieldDefinition"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyFieldDefinition_tenantId_packId_versionId_key_key" ON "MethodologyFieldDefinition"("tenantId", "packId", "versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyFieldDefinition_tenantId_packId_versionId_storag_key" ON "MethodologyFieldDefinition"("tenantId", "packId", "versionId", "storageBindingKind", "storageBindingPath");

-- CreateIndex
CREATE INDEX "MethodologyStageDefinition_tenantId_packId_versionId_positi_idx" ON "MethodologyStageDefinition"("tenantId", "packId", "versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyStageDefinition_tenantId_id_key" ON "MethodologyStageDefinition"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyStageDefinition_tenantId_packId_versionId_key_key" ON "MethodologyStageDefinition"("tenantId", "packId", "versionId", "key");

-- CreateIndex
CREATE INDEX "MethodologyRoleDefinition_tenantId_packId_versionId_positio_idx" ON "MethodologyRoleDefinition"("tenantId", "packId", "versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyRoleDefinition_tenantId_id_key" ON "MethodologyRoleDefinition"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyRoleDefinition_tenantId_packId_versionId_key_key" ON "MethodologyRoleDefinition"("tenantId", "packId", "versionId", "key");

-- CreateIndex
CREATE INDEX "MethodologyRuleDefinition_tenantId_packId_versionId_positio_idx" ON "MethodologyRuleDefinition"("tenantId", "packId", "versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyRuleDefinition_tenantId_id_key" ON "MethodologyRuleDefinition"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyRuleDefinition_tenantId_packId_versionId_key_key" ON "MethodologyRuleDefinition"("tenantId", "packId", "versionId", "key");

-- CreateIndex
CREATE INDEX "MethodologyActionTemplate_tenantId_packId_versionId_positio_idx" ON "MethodologyActionTemplate"("tenantId", "packId", "versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyActionTemplate_tenantId_id_key" ON "MethodologyActionTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyActionTemplate_tenantId_packId_versionId_key_key" ON "MethodologyActionTemplate"("tenantId", "packId", "versionId", "key");

-- CreateIndex
CREATE INDEX "MethodologyStageState_tenantId_bindingId_idx" ON "MethodologyStageState"("tenantId", "bindingId");

-- CreateIndex
CREATE INDEX "MethodologyStageState_tenantId_opportunityId_versionId_idx" ON "MethodologyStageState"("tenantId", "opportunityId", "versionId");

-- CreateIndex
CREATE INDEX "MethodologyStageState_tenantId_packId_versionId_stageKey_idx" ON "MethodologyStageState"("tenantId", "packId", "versionId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyStageState_tenantId_id_key" ON "MethodologyStageState"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyStageState_tenantId_opportunityId_bindingId_pack_key" ON "MethodologyStageState"("tenantId", "opportunityId", "bindingId", "packId", "versionId");

-- CreateIndex
CREATE INDEX "MethodologyRoleAssignment_tenantId_opportunityId_versionId_idx" ON "MethodologyRoleAssignment"("tenantId", "opportunityId", "versionId");

-- CreateIndex
CREATE INDEX "MethodologyRoleAssignment_tenantId_packId_versionId_roleKey_idx" ON "MethodologyRoleAssignment"("tenantId", "packId", "versionId", "roleKey");

-- CreateIndex
CREATE INDEX "MethodologyRoleAssignment_tenantId_personId_idx" ON "MethodologyRoleAssignment"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyRoleAssignment_tenantId_id_key" ON "MethodologyRoleAssignment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyRoleAssignment_tenantId_bindingId_roleKey_person_key" ON "MethodologyRoleAssignment"("tenantId", "bindingId", "roleKey", "personId");

-- CreateIndex
CREATE INDEX "MethodologyValue_tenantId_opportunityId_versionId_idx" ON "MethodologyValue"("tenantId", "opportunityId", "versionId");

-- CreateIndex
CREATE INDEX "MethodologyValue_tenantId_packId_versionId_fieldKey_idx" ON "MethodologyValue"("tenantId", "packId", "versionId", "fieldKey");

-- CreateIndex
CREATE INDEX "MethodologyValue_tenantId_targetKind_targetId_idx" ON "MethodologyValue"("tenantId", "targetKind", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyValue_tenantId_id_key" ON "MethodologyValue"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyValue_tenantId_bindingId_fieldKey_targetKind_tar_key" ON "MethodologyValue"("tenantId", "bindingId", "fieldKey", "targetKind", "targetId");

-- CreateIndex
CREATE INDEX "MethodologyEvaluation_tenantId_opportunityId_bindingId_crea_idx" ON "MethodologyEvaluation"("tenantId", "opportunityId", "bindingId", "createdAt");

-- CreateIndex
CREATE INDEX "MethodologyEvaluation_tenantId_packId_versionId_createdAt_idx" ON "MethodologyEvaluation"("tenantId", "packId", "versionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyEvaluation_tenantId_id_key" ON "MethodologyEvaluation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MethodologyMigrationRun_tenantId_opportunityId_createdAt_idx" ON "MethodologyMigrationRun"("tenantId", "opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "MethodologyMigrationRun_tenantId_sourceBindingId_idx" ON "MethodologyMigrationRun"("tenantId", "sourceBindingId");

-- CreateIndex
CREATE INDEX "MethodologyMigrationRun_tenantId_targetPackId_targetVersion_idx" ON "MethodologyMigrationRun"("tenantId", "targetPackId", "targetVersionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyMigrationRun_tenantId_id_key" ON "MethodologyMigrationRun"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MethodologyBinding_tenantId_opportunityId_id_packId_version_key" ON "MethodologyBinding"("tenantId", "opportunityId", "id", "packId", "versionId");

-- AddForeignKey
ALTER TABLE "MethodologyFieldDefinition" ADD CONSTRAINT "MethodologyFieldDefinition_tenantId_packId_versionId_fkey" FOREIGN KEY ("tenantId", "packId", "versionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyStageDefinition" ADD CONSTRAINT "MethodologyStageDefinition_tenantId_packId_versionId_fkey" FOREIGN KEY ("tenantId", "packId", "versionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyRoleDefinition" ADD CONSTRAINT "MethodologyRoleDefinition_tenantId_packId_versionId_fkey" FOREIGN KEY ("tenantId", "packId", "versionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyRuleDefinition" ADD CONSTRAINT "MethodologyRuleDefinition_tenantId_packId_versionId_fkey" FOREIGN KEY ("tenantId", "packId", "versionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyActionTemplate" ADD CONSTRAINT "MethodologyActionTemplate_tenantId_packId_versionId_fkey" FOREIGN KEY ("tenantId", "packId", "versionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyStageState" ADD CONSTRAINT "MethodologyStageState_tenantId_opportunityId_fkey" FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyStageState" ADD CONSTRAINT "MethodologyStageState_tenantId_opportunityId_bindingId_pac_fkey" FOREIGN KEY ("tenantId", "opportunityId", "bindingId", "packId", "versionId") REFERENCES "MethodologyBinding"("tenantId", "opportunityId", "id", "packId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyStageState" ADD CONSTRAINT "MethodologyStageState_tenantId_packId_versionId_stageKey_fkey" FOREIGN KEY ("tenantId", "packId", "versionId", "stageKey") REFERENCES "MethodologyStageDefinition"("tenantId", "packId", "versionId", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyRoleAssignment" ADD CONSTRAINT "MethodologyRoleAssignment_tenantId_opportunityId_fkey" FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyRoleAssignment" ADD CONSTRAINT "MethodologyRoleAssignment_tenantId_opportunityId_bindingId_fkey" FOREIGN KEY ("tenantId", "opportunityId", "bindingId", "packId", "versionId") REFERENCES "MethodologyBinding"("tenantId", "opportunityId", "id", "packId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyRoleAssignment" ADD CONSTRAINT "MethodologyRoleAssignment_tenantId_packId_versionId_roleKe_fkey" FOREIGN KEY ("tenantId", "packId", "versionId", "roleKey") REFERENCES "MethodologyRoleDefinition"("tenantId", "packId", "versionId", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyRoleAssignment" ADD CONSTRAINT "MethodologyRoleAssignment_tenantId_personId_fkey" FOREIGN KEY ("tenantId", "personId") REFERENCES "Person"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyValue" ADD CONSTRAINT "MethodologyValue_tenantId_opportunityId_fkey" FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyValue" ADD CONSTRAINT "MethodologyValue_tenantId_opportunityId_bindingId_packId_v_fkey" FOREIGN KEY ("tenantId", "opportunityId", "bindingId", "packId", "versionId") REFERENCES "MethodologyBinding"("tenantId", "opportunityId", "id", "packId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyValue" ADD CONSTRAINT "MethodologyValue_tenantId_packId_versionId_fieldKey_fkey" FOREIGN KEY ("tenantId", "packId", "versionId", "fieldKey") REFERENCES "MethodologyFieldDefinition"("tenantId", "packId", "versionId", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyEvaluation" ADD CONSTRAINT "MethodologyEvaluation_tenantId_opportunityId_fkey" FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyEvaluation" ADD CONSTRAINT "MethodologyEvaluation_tenantId_opportunityId_bindingId_pac_fkey" FOREIGN KEY ("tenantId", "opportunityId", "bindingId", "packId", "versionId") REFERENCES "MethodologyBinding"("tenantId", "opportunityId", "id", "packId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyMigrationRun" ADD CONSTRAINT "MethodologyMigrationRun_tenantId_opportunityId_fkey" FOREIGN KEY ("tenantId", "opportunityId") REFERENCES "Opportunity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyMigrationRun" ADD CONSTRAINT "MethodologyMigrationRun_tenantId_opportunityId_sourceBindi_fkey" FOREIGN KEY ("tenantId", "opportunityId", "sourceBindingId", "sourcePackId", "sourceVersionId") REFERENCES "MethodologyBinding"("tenantId", "opportunityId", "id", "packId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodologyMigrationRun" ADD CONSTRAINT "MethodologyMigrationRun_tenantId_targetPackId_targetVersio_fkey" FOREIGN KEY ("tenantId", "targetPackId", "targetVersionId") REFERENCES "MethodologyPackVersion"("tenantId", "packId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
