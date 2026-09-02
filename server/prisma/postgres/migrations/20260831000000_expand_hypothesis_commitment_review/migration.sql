BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  present_count INTEGER;
BEGIN
  IF to_regclass('public."DataMigrationState"') IS NULL
     OR to_regclass('public."PlanAction"') IS NULL
     OR to_regclass('public."SalesHypothesis"') IS NULL
     OR to_regclass('public."SalesHypothesisRevision"') IS NULL
     OR to_regclass('public."HypothesisEvidenceLink"') IS NULL THEN
    RAISE EXCEPTION 'SAAS-208 hypothesis Commitment review requires migration, Commitment, and SalesHypothesis foundations';
  END IF;

  SELECT count(*) INTO present_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'PlanAction' AND column_name IN (
       'hypothesisId', 'hypothesisRevisionId', 'completionResult',
       'completionResultRecordedAtUtc', 'completionResultRecordedByUserId',
       'verificationReviewDisposition', 'verificationReviewedAtUtc',
       'verificationReviewedByUserId'
     )) OR (table_name = 'HypothesisEvidenceLink' AND column_name = 'verificationCommitmentId'));
  IF present_count <> 0 THEN
    RAISE EXCEPTION 'SAAS-208 hypothesis Commitment review columns already exist; use guarded adoption or restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "PlanAction", "SalesHypothesis", "SalesHypothesisRevision", "HypothesisEvidenceLink"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "PlanAction"
  ADD COLUMN "hypothesisId" TEXT,
  ADD COLUMN "hypothesisRevisionId" TEXT,
  ADD COLUMN "completionResult" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "completionResultRecordedAtUtc" TIMESTAMP(3),
  ADD COLUMN "completionResultRecordedByUserId" TEXT,
  ADD COLUMN "verificationReviewDisposition" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "verificationReviewedAtUtc" TIMESTAMP(3),
  ADD COLUMN "verificationReviewedByUserId" TEXT;

ALTER TABLE "HypothesisEvidenceLink"
  ADD COLUMN "verificationCommitmentId" TEXT;

CREATE INDEX "PlanAction_tenantId_hypothesisId_hypothesisRevisionId_idx"
  ON "PlanAction"("tenantId", "hypothesisId", "hypothesisRevisionId");
CREATE INDEX "HypothesisEvidenceLink_tenantId_verificationCommitmentId_idx"
  ON "HypothesisEvidenceLink"("tenantId", "verificationCommitmentId");

DO $$
DECLARE
  exact_columns INTEGER;
  exact_indexes INTEGER;
  nonempty_rows INTEGER;
BEGIN
  SELECT count(*) INTO exact_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'PlanAction'
       AND ((column_name IN ('hypothesisId', 'hypothesisRevisionId',
          'completionResultRecordedByUserId', 'verificationReviewedByUserId')
          AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL)
         OR (column_name IN ('completionResultRecordedAtUtc', 'verificationReviewedAtUtc')
          AND data_type = 'timestamp without time zone' AND is_nullable = 'YES'
          AND column_default IS NULL)
         OR (column_name IN ('completionResult', 'verificationReviewDisposition')
          AND data_type = 'text' AND is_nullable = 'NO'
          AND column_default = (quote_literal('') || '::text'))))
       OR (table_name = 'HypothesisEvidenceLink' AND column_name = 'verificationCommitmentId'
          AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL));
  IF exact_columns <> 9 THEN
    RAISE EXCEPTION 'SAAS-208 hypothesis Commitment review column parity failed';
  END IF;

  SELECT count(*) INTO exact_indexes
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND ((tablename = 'PlanAction'
       AND indexname = 'PlanAction_tenantId_hypothesisId_hypothesisRevisionId_idx')
       OR (tablename = 'HypothesisEvidenceLink'
       AND indexname = 'HypothesisEvidenceLink_tenantId_verificationCommitmentId_idx'));
  IF exact_indexes <> 2 THEN
    RAISE EXCEPTION 'SAAS-208 hypothesis Commitment review index parity failed';
  END IF;

  SELECT count(*) INTO nonempty_rows FROM "PlanAction"
   WHERE "hypothesisId" IS NOT NULL OR "hypothesisRevisionId" IS NOT NULL
      OR "completionResult" <> '' OR "completionResultRecordedAtUtc" IS NOT NULL
      OR "completionResultRecordedByUserId" IS NOT NULL
      OR "verificationReviewDisposition" <> '' OR "verificationReviewedAtUtc" IS NOT NULL
      OR "verificationReviewedByUserId" IS NOT NULL;
  IF nonempty_rows <> 0 THEN
    RAISE EXCEPTION 'SAAS-208 expansion must not infer or backfill Commitment verification data';
  END IF;

  SELECT count(*) INTO nonempty_rows FROM "HypothesisEvidenceLink"
   WHERE "verificationCommitmentId" IS NOT NULL;
  IF nonempty_rows <> 0 THEN
    RAISE EXCEPTION 'SAAS-208 expansion must not infer or backfill Evidence verification data';
  END IF;
END
$$;

COMMIT;
