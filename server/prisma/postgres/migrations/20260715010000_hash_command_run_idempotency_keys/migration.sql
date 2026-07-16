-- INT-502: CommandRun keys are sensitive caller-provided values. Persist only SHA-256 digests.
-- person-merge already hashed its keys before the central runner; preserve those legacy rows.
-- Any unexpected legacy shape or unique collision aborts rather than discarding replay history.
BEGIN;

LOCK TABLE "CommandRun" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CommandRun"
    WHERE "kind" = 'person-merge'
      AND "idempotencyKey" !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'CommandRun contains an unexpected unhashed person-merge idempotency key';
  END IF;
END $$;

UPDATE "CommandRun"
SET "idempotencyKey" = encode(sha256(convert_to("idempotencyKey", 'UTF8')), 'hex')
WHERE "kind" <> 'person-merge';

COMMIT;
