-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'active',
    "seatLimit" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QccConfig" (
    "tenantId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT 'https://api.qichacha.com',
    "appKey" TEXT NOT NULL DEFAULT '',
    "secretKeyEnc" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QccConfig_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "AiConfig" (
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "apiKeyEnc" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConfig_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "tokenHash" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL DEFAULT '',
    "scopes" TEXT NOT NULL DEFAULT '["read"]',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerType" INTEGER NOT NULL,
    "unifiedCreditCode" TEXT,
    "externalRef" TEXT,
    "region" TEXT NOT NULL DEFAULT '',
    "group" TEXT NOT NULL DEFAULT '',
    "primaryOwner" TEXT NOT NULL DEFAULT '',
    "primaryOwnerUserId" TEXT,
    "profile" TEXT NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "archiveReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "orgLevel" INTEGER NOT NULL DEFAULT 3,
    "isCompetitor" BOOLEAN NOT NULL DEFAULT false,
    "avatarUrl" TEXT,
    "coachLevel" INTEGER,
    "color" TEXT,
    "x" DOUBLE PRECISION NOT NULL DEFAULT 300,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 240,
    "form" TEXT NOT NULL DEFAULT '{}',
    "logs" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "archiveReason" TEXT NOT NULL DEFAULT '',
    "mergedIntoPersonId" TEXT,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerType" INTEGER NOT NULL,
    "pipelineStage" TEXT NOT NULL,
    "engageStage" TEXT NOT NULL,
    "changeMode" TEXT,
    "singleSalesGoal" TEXT NOT NULL DEFAULT '',
    "customerBusinessGoal" TEXT,
    "buyingMotivation" TEXT,
    "primaryDPersonId" TEXT,
    "externalRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "productSolution" TEXT NOT NULL DEFAULT '',
    "competitor" TEXT NOT NULL DEFAULT '',
    "competitiveSituation" TEXT NOT NULL DEFAULT '',
    "winProbability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedSignDate" TEXT NOT NULL DEFAULT '',
    "expectedAmountW" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "meta" TEXT NOT NULL DEFAULT '{}',
    "c3Items" TEXT NOT NULL DEFAULT '{}',
    "c5Items" TEXT NOT NULL DEFAULT '{}',
    "memberScoped" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "archiveReason" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
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

-- CreateTable
CREATE TABLE "CommandRun" (
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

-- CreateTable
CREATE TABLE "SyncRun" (
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

-- CreateTable
CREATE TABLE "RelSuggestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "sourcePersonId" TEXT NOT NULL,
    "targetPersonId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'person',
    "targetKind" TEXT NOT NULL DEFAULT 'person',
    "layer" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "origin" TEXT NOT NULL DEFAULT 'graph',
    "evidence" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonSuggestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "orgLevel" INTEGER NOT NULL DEFAULT 3,
    "origin" TEXT NOT NULL DEFAULT 'mcp',
    "evidence" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposedBy" TEXT NOT NULL DEFAULT '',
    "resolvedPersonId" TEXT,
    "suggestedRole" TEXT,
    "suggestedSentiment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OppRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "sentimentValue" INTEGER,
    "confidence" TEXT NOT NULL,
    "isKeyInfluencer" BOOLEAN NOT NULL DEFAULT false,
    "procurementType" TEXT,
    "procurementStatus" TEXT,
    "assessedAt" TIMESTAMP(3),
    "sourceQuality" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "OppRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,

    CONSTRAINT "OpportunityMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "style" TEXT,
    "width" DOUBLE PRECISION,
    "directed" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "shape" TEXT,
    "bend" DOUBLE PRECISION,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BurningIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "confidence" TEXT NOT NULL,

    CONSTRAINT "BurningIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UCV" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "targetBiId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "competitorCannot" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "UCV_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "externalRef" TEXT,
    "date" TEXT NOT NULL DEFAULT '',
    "topic" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "participants" TEXT NOT NULL DEFAULT '[]',
    "origin" TEXT NOT NULL DEFAULT 'workbuddy',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT,
    "opportunityId" TEXT,
    "personId" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "gapItem" TEXT NOT NULL DEFAULT '',
    "personId" TEXT,
    "title" TEXT NOT NULL,
    "scene" TEXT NOT NULL DEFAULT '',
    "scripts" TEXT NOT NULL DEFAULT '',
    "target" TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT NOT NULL DEFAULT '',
    "startDate" TEXT NOT NULL DEFAULT '',
    "endDate" TEXT NOT NULL DEFAULT '',
    "half" TEXT NOT NULL DEFAULT 'am',
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TEXT,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "review" TEXT NOT NULL DEFAULT '',
    "resources" TEXT NOT NULL DEFAULT '',
    "cautions" TEXT NOT NULL DEFAULT '',
    "props" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OppMilestone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" TEXT NOT NULL DEFAULT '',
    "endDate" TEXT NOT NULL DEFAULT '',
    "half" TEXT NOT NULL DEFAULT 'am',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OppMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OppStage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "startDate" TEXT NOT NULL DEFAULT '',
    "endDate" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OppStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyCard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "gapItem" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "basis" TEXT NOT NULL DEFAULT '',
    "alternatives" TEXT NOT NULL DEFAULT '',
    "personId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "dispatchedActionIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyRisk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'risk',
    "text" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'mid',
    "mitigation" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyRisk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyResource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "signalKey" TEXT NOT NULL,
    "direction" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'mid',
    "rawContent" TEXT NOT NULL DEFAULT '',
    "occurredAt" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'approved',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "reviewedBy" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeProposal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "entityKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL DEFAULT '',
    "newValue" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'voice',
    "evidence" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dedupeKey" TEXT,
    "proposedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrichJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "enqueueToken" TEXT,
    "type" TEXT NOT NULL DEFAULT 'enrich_account',
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT NOT NULL DEFAULT '',
    "leaseToken" TEXT NOT NULL DEFAULT '',
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT,
    "opportunityId" TEXT,
    "personId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'mock',
    "externalRef" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "contentEnc" TEXT NOT NULL DEFAULT '',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "extractedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingProviderConfig" (
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "appId" TEXT NOT NULL DEFAULT '',
    "appSecretEnc" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingProviderConfig_pkey" PRIMARY KEY ("tenantId","provider")
);

-- CreateTable
CREATE TABLE "RecordingCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL DEFAULT '',
    "refreshTokenEnc" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "meta" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuratedSummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "basedOnAt" TIMESTAMP(3),
    "editedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "editedBy" TEXT NOT NULL DEFAULT '',
    "aclVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuratedSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "opportunityId" TEXT,
    "oppName" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "entityId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvisorMsg" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvisorMsg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeComConfig" (
    "tenantId" TEXT NOT NULL,
    "corpId" TEXT NOT NULL DEFAULT '',
    "agentId" TEXT NOT NULL DEFAULT '',
    "secretEnc" TEXT NOT NULL DEFAULT '',
    "callbackToken" TEXT NOT NULL DEFAULT '',
    "callbackAesKeyEnc" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeComConfig_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "WeComUserBind" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wecomUserid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeComUserBind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeComOAuthState" (
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

-- CreateTable
CREATE TABLE "ScheduleSync" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "wecomScheduleId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'synced',
    "lastError" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringItemState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "subItemKey" TEXT NOT NULL DEFAULT '',
    "known" BOOLEAN NOT NULL DEFAULT false,
    "confidence" TEXT NOT NULL DEFAULT '不清',
    "sourceQuality" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "collectedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ScoringItemState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealPdeConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "potValue" DOUBLE PRECISION,
    "plannedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sunkCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cComp" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "industryPackKey" TEXT NOT NULL DEFAULT 'digital-energy',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealPdeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndustryPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packKey" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndustryPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionCatalog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "effectJson" TEXT NOT NULL DEFAULT '{}',
    "costTier" TEXT NOT NULL DEFAULT 'mid',
    "costWan" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stageWindow" TEXT NOT NULL DEFAULT 'any',
    "targetSlots" TEXT NOT NULL DEFAULT '[]',
    "gist" TEXT NOT NULL DEFAULT '',
    "scriptRef" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ActionCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalCatalog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "signalKey" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "groupKey" TEXT NOT NULL DEFAULT '',
    "direction" INTEGER NOT NULL DEFAULT 1,
    "tier" TEXT NOT NULL DEFAULT 'mid',
    "behavioral" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SignalCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EVSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "inputsJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "schemaId" TEXT NOT NULL DEFAULT '',
    "schemaVersion" TEXT NOT NULL DEFAULT '',
    "confidenceFlag" TEXT NOT NULL DEFAULT '',
    "aclVersion" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EVSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_phone_key" ON "User"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_tokenHash_key" ON "AccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccessToken_tenantId_idx" ON "AccessToken"("tenantId");

-- CreateIndex
CREATE INDEX "AccessToken_userId_idx" ON "AccessToken"("userId");

-- CreateIndex
CREATE INDEX "Account_tenantId_idx" ON "Account"("tenantId");

-- CreateIndex
CREATE INDEX "Account_tenantId_primaryOwnerUserId_idx" ON "Account"("tenantId", "primaryOwnerUserId");

-- CreateIndex
CREATE INDEX "Account_tenantId_archivedAt_idx" ON "Account"("tenantId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Account_tenantId_id_key" ON "Account"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Account_tenantId_externalRef_key" ON "Account"("tenantId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Account_tenantId_unifiedCreditCode_key" ON "Account"("tenantId", "unifiedCreditCode");

-- CreateIndex
CREATE INDEX "Person_accountId_idx" ON "Person"("accountId");

-- CreateIndex
CREATE INDEX "Person_tenantId_accountId_idx" ON "Person"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "Person_tenantId_accountId_archivedAt_idx" ON "Person"("tenantId", "accountId", "archivedAt");

-- CreateIndex
CREATE INDEX "Person_tenantId_mergedIntoPersonId_idx" ON "Person"("tenantId", "mergedIntoPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_tenantId_id_key" ON "Person"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Opportunity_accountId_idx" ON "Opportunity"("accountId");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_accountId_idx" ON "Opportunity"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_archivedAt_idx" ON "Opportunity"("tenantId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_tenantId_id_key" ON "Opportunity"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_tenantId_accountId_externalRef_key" ON "Opportunity"("tenantId", "accountId", "externalRef");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_entityKind_entityId_idx" ON "AuditEvent"("tenantId", "entityKind", "entityId");

-- CreateIndex
CREATE INDEX "CommandRun_tenantId_createdAt_idx" ON "CommandRun"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommandRun_tenantId_actorId_kind_idempotencyKey_key" ON "CommandRun"("tenantId", "actorId", "kind", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SyncRun_tenantId_createdAt_idx" ON "SyncRun"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncRun_tenantId_idempotencyKey_key" ON "SyncRun"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RelSuggestion_opportunityId_idx" ON "RelSuggestion"("opportunityId");

-- CreateIndex
CREATE INDEX "PersonSuggestion_accountId_idx" ON "PersonSuggestion"("accountId");

-- CreateIndex
CREATE INDEX "PersonSuggestion_opportunityId_idx" ON "PersonSuggestion"("opportunityId");

-- CreateIndex
CREATE INDEX "OppRole_tenantId_opportunityId_idx" ON "OppRole"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "OppRole_tenantId_personId_idx" ON "OppRole"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "OppRole_tenantId_opportunityId_personId_key" ON "OppRole"("tenantId", "opportunityId", "personId");

-- CreateIndex
CREATE INDEX "OpportunityMember_opportunityId_idx" ON "OpportunityMember"("opportunityId");

-- CreateIndex
CREATE INDEX "OpportunityMember_tenantId_opportunityId_idx" ON "OpportunityMember"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "OpportunityMember_tenantId_personId_idx" ON "OpportunityMember"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityMember_tenantId_opportunityId_personId_key" ON "OpportunityMember"("tenantId", "opportunityId", "personId");

-- CreateIndex
CREATE INDEX "Edge_accountId_idx" ON "Edge"("accountId");

-- CreateIndex
CREATE INDEX "Edge_tenantId_accountId_idx" ON "Edge"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "Edge_tenantId_opportunityId_idx" ON "Edge"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "Edge_tenantId_source_idx" ON "Edge"("tenantId", "source");

-- CreateIndex
CREATE INDEX "Edge_tenantId_target_idx" ON "Edge"("tenantId", "target");

-- CreateIndex
CREATE INDEX "BurningIssue_tenantId_opportunityId_personId_idx" ON "BurningIssue"("tenantId", "opportunityId", "personId");

-- CreateIndex
CREATE INDEX "BurningIssue_tenantId_personId_idx" ON "BurningIssue"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "UCV_tenantId_opportunityId_targetBiId_idx" ON "UCV"("tenantId", "opportunityId", "targetBiId");

-- CreateIndex
CREATE INDEX "UCV_tenantId_targetBiId_idx" ON "UCV"("tenantId", "targetBiId");

-- CreateIndex
CREATE INDEX "VisitNote_accountId_idx" ON "VisitNote"("accountId");

-- CreateIndex
CREATE INDEX "VisitNote_opportunityId_idx" ON "VisitNote"("opportunityId");

-- CreateIndex
CREATE INDEX "VisitNote_tenantId_accountId_idx" ON "VisitNote"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "VisitNote_tenantId_opportunityId_idx" ON "VisitNote"("tenantId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitNote_tenantId_accountId_externalRef_key" ON "VisitNote"("tenantId", "accountId", "externalRef");

-- CreateIndex
CREATE INDEX "Note_accountId_idx" ON "Note"("accountId");

-- CreateIndex
CREATE INDEX "Note_opportunityId_idx" ON "Note"("opportunityId");

-- CreateIndex
CREATE INDEX "Note_personId_idx" ON "Note"("personId");

-- CreateIndex
CREATE INDEX "Note_tenantId_accountId_idx" ON "Note"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "Note_tenantId_opportunityId_idx" ON "Note"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "Note_tenantId_personId_idx" ON "Note"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "PlanAction_accountId_idx" ON "PlanAction"("accountId");

-- CreateIndex
CREATE INDEX "PlanAction_opportunityId_idx" ON "PlanAction"("opportunityId");

-- CreateIndex
CREATE INDEX "PlanAction_tenantId_accountId_idx" ON "PlanAction"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "PlanAction_tenantId_opportunityId_idx" ON "PlanAction"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "PlanAction_tenantId_personId_idx" ON "PlanAction"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "OppMilestone_accountId_idx" ON "OppMilestone"("accountId");

-- CreateIndex
CREATE INDEX "OppMilestone_opportunityId_idx" ON "OppMilestone"("opportunityId");

-- CreateIndex
CREATE INDEX "OppMilestone_tenantId_accountId_idx" ON "OppMilestone"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "OppMilestone_tenantId_opportunityId_idx" ON "OppMilestone"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "OppStage_accountId_idx" ON "OppStage"("accountId");

-- CreateIndex
CREATE INDEX "OppStage_opportunityId_idx" ON "OppStage"("opportunityId");

-- CreateIndex
CREATE INDEX "OppStage_tenantId_accountId_idx" ON "OppStage"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "OppStage_tenantId_opportunityId_idx" ON "OppStage"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "StrategyCard_accountId_idx" ON "StrategyCard"("accountId");

-- CreateIndex
CREATE INDEX "StrategyCard_opportunityId_idx" ON "StrategyCard"("opportunityId");

-- CreateIndex
CREATE INDEX "StrategyCard_tenantId_accountId_idx" ON "StrategyCard"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "StrategyCard_tenantId_opportunityId_idx" ON "StrategyCard"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "StrategyCard_tenantId_personId_idx" ON "StrategyCard"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "StrategyRisk_accountId_idx" ON "StrategyRisk"("accountId");

-- CreateIndex
CREATE INDEX "StrategyRisk_opportunityId_idx" ON "StrategyRisk"("opportunityId");

-- CreateIndex
CREATE INDEX "StrategyRisk_tenantId_accountId_idx" ON "StrategyRisk"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "StrategyRisk_tenantId_opportunityId_idx" ON "StrategyRisk"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "StrategyResource_accountId_idx" ON "StrategyResource"("accountId");

-- CreateIndex
CREATE INDEX "StrategyResource_opportunityId_idx" ON "StrategyResource"("opportunityId");

-- CreateIndex
CREATE INDEX "StrategyResource_tenantId_accountId_idx" ON "StrategyResource"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "StrategyResource_tenantId_opportunityId_idx" ON "StrategyResource"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "EvidenceEvent_accountId_idx" ON "EvidenceEvent"("accountId");

-- CreateIndex
CREATE INDEX "EvidenceEvent_opportunityId_idx" ON "EvidenceEvent"("opportunityId");

-- CreateIndex
CREATE INDEX "EvidenceEvent_tenantId_accountId_idx" ON "EvidenceEvent"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "EvidenceEvent_tenantId_opportunityId_idx" ON "EvidenceEvent"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "EvidenceEvent_tenantId_personId_idx" ON "EvidenceEvent"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeProposal_dedupeKey_key" ON "ChangeProposal"("dedupeKey");

-- CreateIndex
CREATE INDEX "ChangeProposal_accountId_idx" ON "ChangeProposal"("accountId");

-- CreateIndex
CREATE INDEX "ChangeProposal_tenantId_status_idx" ON "ChangeProposal"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EnrichJob_status_nextAttemptAt_idx" ON "EnrichJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EnrichJob_tenantId_status_idx" ON "EnrichJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EnrichJob_accountId_idx" ON "EnrichJob"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichJob_tenantId_dedupeKey_key" ON "EnrichJob"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Transcript_tenantId_status_idx" ON "Transcript"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Transcript_accountId_idx" ON "Transcript"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_tenantId_source_externalRef_key" ON "Transcript"("tenantId", "source", "externalRef");

-- CreateIndex
CREATE INDEX "RecordingCredential_tenantId_userId_idx" ON "RecordingCredential"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingCredential_tenantId_userId_source_key" ON "RecordingCredential"("tenantId", "userId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "CuratedSummary_tenantId_entityKind_entityId_key" ON "CuratedSummary"("tenantId", "entityKind", "entityId");

-- CreateIndex
CREATE INDEX "Reminder_tenantId_status_idx" ON "Reminder"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_tenantId_dedupeKey_key" ON "Reminder"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "AdvisorMsg_tenantId_opportunityId_personId_createdAt_idx" ON "AdvisorMsg"("tenantId", "opportunityId", "personId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeComUserBind_tenantId_userId_key" ON "WeComUserBind"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WeComUserBind_tenantId_wecomUserid_key" ON "WeComUserBind"("tenantId", "wecomUserid");

-- CreateIndex
CREATE UNIQUE INDEX "WeComOAuthState_requestId_key" ON "WeComOAuthState"("requestId");

-- CreateIndex
CREATE INDEX "WeComOAuthState_tenantId_userId_expiresAt_idx" ON "WeComOAuthState"("tenantId", "userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleSync_tenantId_kind_refId_key" ON "ScheduleSync"("tenantId", "kind", "refId");

-- CreateIndex
CREATE INDEX "ScoringItemState_tenantId_opportunityId_idx" ON "ScoringItemState"("tenantId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringItemState_tenantId_opportunityId_itemKey_subItemKey_key" ON "ScoringItemState"("tenantId", "opportunityId", "itemKey", "subItemKey");

-- CreateIndex
CREATE UNIQUE INDEX "DealPdeConfig_opportunityId_key" ON "DealPdeConfig"("opportunityId");

-- CreateIndex
CREATE INDEX "DealPdeConfig_tenantId_idx" ON "DealPdeConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IndustryPack_tenantId_packKey_schemaVersion_key" ON "IndustryPack"("tenantId", "packKey", "schemaVersion");

-- CreateIndex
CREATE INDEX "ActionCatalog_tenantId_idx" ON "ActionCatalog"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionCatalog_tenantId_packId_actionKey_key" ON "ActionCatalog"("tenantId", "packId", "actionKey");

-- CreateIndex
CREATE INDEX "SignalCatalog_tenantId_idx" ON "SignalCatalog"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SignalCatalog_tenantId_packId_signalKey_key" ON "SignalCatalog"("tenantId", "packId", "signalKey");

-- CreateIndex
CREATE INDEX "EVSnapshot_tenantId_opportunityId_createdAt_idx" ON "EVSnapshot"("tenantId", "opportunityId", "createdAt");

-- AddForeignKey
ALTER TABLE "QccConfig" ADD CONSTRAINT "QccConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConfig" ADD CONSTRAINT "AiConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelSuggestion" ADD CONSTRAINT "RelSuggestion_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OppRole" ADD CONSTRAINT "OppRole_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityMember" ADD CONSTRAINT "OpportunityMember_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BurningIssue" ADD CONSTRAINT "BurningIssue_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UCV" ADD CONSTRAINT "UCV_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeComConfig" ADD CONSTRAINT "WeComConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
