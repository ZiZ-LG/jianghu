BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Tenant', 'User', 'Account', 'Opportunity', 'Person', 'Candidate', 'Note', 'Transcript']
  LOOP
    IF to_regclass('public."' || table_name || '"') IS NULL THEN
      RAISE EXCEPTION 'CORE-204 sensitive ACL expansion requires %', table_name;
    END IF;
  END LOOP;
  IF to_regclass('public."SourceArtifact"') IS NOT NULL
     OR to_regclass('public."SensitiveResourceGrant"') IS NOT NULL THEN
    RAISE EXCEPTION 'CORE-204 sensitive ACL tables already exist; use guarded adoption instead of replay';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns AS c
     WHERE c.table_schema = 'public'
       AND (
         (c.table_name = 'Candidate' AND c.column_name = 'aclVersion')
         OR (c.table_name = 'Note' AND c.column_name IN ('aclVersion', 'createdByUserId', 'visibility'))
         OR (c.table_name = 'Transcript' AND c.column_name IN ('aclVersion', 'createdByUserId', 'visibility', 'idempotencyDomain'))
       )
  ) THEN
    RAISE EXCEPTION 'CORE-204 sensitive ACL columns partially exist; restore an authenticated backup';
  END IF;
END
$$;

LOCK TABLE "Candidate", "Note", "Transcript" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "Candidate"
  ADD COLUMN "aclVersion" INTEGER NOT NULL DEFAULT 1,
  ALTER COLUMN "visibility" SET DEFAULT 'owner_admin_only';

ALTER TABLE "Note"
  ADD COLUMN "aclVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'owner_admin_only';

ALTER TABLE "Transcript"
  ADD COLUMN "aclVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "idempotencyDomain" TEXT NOT NULL DEFAULT 'system-quarantine-v1',
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'owner_admin_only';

DROP INDEX "Transcript_tenantId_source_externalRef_key";
CREATE UNIQUE INDEX "Transcript_tenantId_idempotencyDomain_source_externalRef_key"
  ON "Transcript"("tenantId", "idempotencyDomain", "source", "externalRef");

CREATE TABLE "SourceArtifact" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT,
  "matterId" TEXT,
  "personId" TEXT,
  "backingKind" TEXT NOT NULL,
  "backingId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'owner_admin_only',
  "aclVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SourceArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SensitiveResourceGrant" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "granteeUserId" TEXT NOT NULL,
  "grantedByUserId" TEXT NOT NULL,
  "grantKind" TEXT NOT NULL,
  "resourceAclVersion" INTEGER NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokedByUserId" TEXT,
  CONSTRAINT "SensitiveResourceGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SourceArtifact_tenantId_accountId_idx" ON "SourceArtifact"("tenantId", "accountId");
CREATE INDEX "SourceArtifact_tenantId_matterId_idx" ON "SourceArtifact"("tenantId", "matterId");
CREATE INDEX "SourceArtifact_tenantId_personId_idx" ON "SourceArtifact"("tenantId", "personId");
CREATE INDEX "SourceArtifact_tenantId_createdByUserId_visibility_idx"
  ON "SourceArtifact"("tenantId", "createdByUserId", "visibility");
CREATE INDEX "SourceArtifact_tenantId_visibility_aclVersion_idx"
  ON "SourceArtifact"("tenantId", "visibility", "aclVersion");
CREATE UNIQUE INDEX "SourceArtifact_tenantId_backingKind_backingId_key"
  ON "SourceArtifact"("tenantId", "backingKind", "backingId");

CREATE INDEX "SensitiveResourceGrant_tenantId_resourceKind_resourceId_res_idx"
  ON "SensitiveResourceGrant"("tenantId", "resourceKind", "resourceId", "resourceAclVersion");
CREATE INDEX "SensitiveResourceGrant_tenantId_granteeUserId_grantKind_rev_idx"
  ON "SensitiveResourceGrant"("tenantId", "granteeUserId", "grantKind", "revokedAt");
CREATE UNIQUE INDEX "SensitiveResourceGrant_tenantId_resourceKind_resourceId_gra_key"
  ON "SensitiveResourceGrant"("tenantId", "resourceKind", "resourceId", "granteeUserId", "grantKind");

ALTER TABLE "SourceArtifact"
  ADD CONSTRAINT "SourceArtifact_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SensitiveResourceGrant"
  ADD CONSTRAINT "SensitiveResourceGrant_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Candidate_tenantId_visibility_aclVersion_idx"
  ON "Candidate"("tenantId", "visibility", "aclVersion");
CREATE INDEX "Note_tenantId_createdByUserId_visibility_idx"
  ON "Note"("tenantId", "createdByUserId", "visibility");
CREATE INDEX "Note_tenantId_visibility_aclVersion_idx"
  ON "Note"("tenantId", "visibility", "aclVersion");
CREATE INDEX "Transcript_tenantId_createdByUserId_visibility_idx"
  ON "Transcript"("tenantId", "createdByUserId", "visibility");
CREATE INDEX "Transcript_tenantId_visibility_aclVersion_idx"
  ON "Transcript"("tenantId", "visibility", "aclVersion");

DO $$
DECLARE
  candidate_acl_columns INTEGER;
  note_acl_columns INTEGER;
  transcript_acl_columns INTEGER;
BEGIN
  SELECT count(*) INTO candidate_acl_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Candidate' AND column_name = 'aclVersion';
  SELECT count(*) INTO note_acl_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Note'
     AND column_name IN ('aclVersion', 'createdByUserId', 'visibility');
  SELECT count(*) INTO transcript_acl_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Transcript'
     AND column_name IN ('aclVersion', 'createdByUserId', 'visibility', 'idempotencyDomain');
  IF candidate_acl_columns <> 1 OR note_acl_columns <> 3 OR transcript_acl_columns <> 4 THEN
    RAISE EXCEPTION 'CORE-204 sensitive ACL expansion parity failed';
  END IF;
  IF to_regclass('public."Transcript_tenantId_source_externalRef_key"') IS NOT NULL
     OR to_regclass('public."Transcript_tenantId_idempotencyDomain_source_externalRef_key"') IS NULL THEN
    RAISE EXCEPTION 'CORE-204 Transcript idempotency-domain index parity failed';
  END IF;
END
$$;

COMMIT;
