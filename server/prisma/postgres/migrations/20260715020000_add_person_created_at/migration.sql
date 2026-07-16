-- INT-502: establish the denominator for duplicate formal-person observations.
ALTER TABLE "Person"
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Person_tenantId_createdAt_idx" ON "Person"("tenantId", "createdAt");
