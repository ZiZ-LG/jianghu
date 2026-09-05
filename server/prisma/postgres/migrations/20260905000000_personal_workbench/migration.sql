-- CORE-210: additive personal fields; existing data and methodology bindings are not rewritten.
ALTER TABLE "Opportunity" ADD COLUMN "salesProgress" TEXT;
ALTER TABLE "MatterParticipant" ADD COLUMN "decisionRole" TEXT;
ALTER TABLE "MatterParticipant" ADD COLUMN "roleBasisId" TEXT;
ALTER TABLE "MatterParticipant" ADD COLUMN "roleBasisVersion" INTEGER;
ALTER TABLE "MatterParticipant" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
