#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

[[ -f scripts/lib/backup-crypto.sh ]] || { echo "missing backup crypto helper" >&2; exit 1; }
source scripts/lib/backup-crypto.sh
source scripts/lib/deploy-common.sh
source scripts/lib/postgres-db-safety.sh
source scripts/lib/bootstrap-marker.sh

export COMPOSE_PROJECT_NAME="jianghu_int501_ops_${$}"
export POSTGRES_USER=jianghu_ops
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export POSTGRES_DB=jianghu_ops
export JWT_SECRET=$(openssl rand -hex 32)
export AI_KEY_SECRET=$(openssl rand -hex 32)
export OUTBOUND_ALLOWED_HOSTS=example.com
export BACKUP_MASTER_SECRET=$(openssl rand -hex 32)
export BACKUP_DIR="/tmp/jianghu-int501-ops-${$}"
export BACKUP_RETENTION_DAYS=14
export NO_PROXY=127.0.0.1,localhost
export no_proxy=$NO_PROXY
expected_migration_count=$(find server/prisma/postgres/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')

fresh_project=''
fresh_root=''
cleanup() {
  set +e
  POSTGRES_PASSWORD=x JWT_SECRET=x AI_KEY_SECRET=x OUTBOUND_ALLOWED_HOSTS=example.com \
    docker compose -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$BACKUP_DIR"
  if [[ -n "${fresh_project:-}" ]]; then
    POSTGRES_PASSWORD=x JWT_SECRET=x AI_KEY_SECRET=x OUTBOUND_ALLOWED_HOSTS=example.com \
      docker compose -p "$fresh_project" down -v --remove-orphans >/dev/null 2>&1
  fi
  [[ -z "${fresh_root:-}" ]] || rm -rf "$fresh_root" "$fresh_root-backups" "$fresh_root-rollbacks"
}
trap cleanup EXIT

postgres_query_database_presence() {
  local database=$1
  docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$database'"
}
database_exists() {
  postgres_database_exists "$1"
}
assert_database_absent() {
  postgres_assert_database_absent "$1" || exit $?
}
wait_for_postgres_ready() {
  for _ in $(seq 1 60); do
    if docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
        pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL did not become ready within 60 seconds" >&2
  return 1
}

wait_for_server_healthy() {
  local container_name="${COMPOSE_PROJECT_NAME}-server-1"
  local status=''
  local state=''
  for _ in $(seq 1 180); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container_name" 2>/dev/null || true)
    [[ "$status" == healthy ]] && return 0
    state=$(docker inspect -f '{{.State.Status}}' "$container_name" 2>/dev/null || true)
    [[ "$state" == exited || "$state" == dead ]] && break
    sleep 1
  done
  echo "server did not become healthy (state=${state:-missing}, health=${status:-missing})" >&2
  docker compose -p "$COMPOSE_PROJECT_NAME" ps >&2 || true
  docker compose -p "$COMPOSE_PROJECT_NAME" logs --no-color --tail=300 db server >&2 || true
  return 1
}

docker compose -p "$COMPOSE_PROJECT_NAME" build server >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" up -d db >/dev/null
wait_for_postgres_ready
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260712_pre_int501.prisma --skip-generate' >/dev/null
legacy_table_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]')
[[ "$legacy_table_count" == 41 ]]
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('legacy-owner-tenant','Legacy Owner Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name) VALUES ('legacy-owner-user','legacy-owner-tenant','legacy-owner@example.test','unused','Legacy Owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\",\"primaryOwner\") VALUES ('legacy-owner-account','legacy-owner-tenant','Legacy Account',1,'Legacy Owner');
   INSERT INTO \"Opportunity\" (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\",status) VALUES
     ('legacy-matter-active','legacy-owner-tenant','legacy-owner-account','Active Matter',1,'qualify','discover','active'),
     ('legacy-matter-paused','legacy-owner-tenant','legacy-owner-account','Paused Matter',1,'qualify','discover','paused'),
     ('legacy-matter-won','legacy-owner-tenant','legacy-owner-account','Won Matter',1,'qualify','discover','won'),
     ('legacy-matter-lost','legacy-owner-tenant','legacy-owner-account','Lost Matter',1,'qualify','discover','lost');
   INSERT INTO \"PlanAction\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",title,\"ownerId\",\"startDate\",\"endDate\",half,done,origin,\"createdBy\")
     VALUES ('legacy-plan-action','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
       'Legacy customer visit','legacy-owner-user','2026-10-07','2026-10-08','am',false,'workbuddy','legacy-owner-user');
   INSERT INTO \"Person\" (id,\"tenantId\",\"accountId\",name,title) VALUES
     ('legacy-candidate-person-one','legacy-owner-tenant','legacy-owner-account','Candidate Person One','Sponsor'),
     ('legacy-candidate-person-two','legacy-owner-tenant','legacy-owner-account','Candidate Person Two','User');
   INSERT INTO \"PersonSuggestion\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",name,origin,evidence,confidence,status,\"proposedBy\") VALUES
     ('legacy-person-suggestion','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
      'Suggested Person','mcp','legacy person evidence',0.8,'pending','legacy-owner-user');
   INSERT INTO \"RelSuggestion\"
     (id,\"tenantId\",\"opportunityId\",\"sourcePersonId\",\"targetPersonId\",\"sourceKind\",\"targetKind\",layer,label,confidence,origin,evidence,status) VALUES
     ('legacy-rel-suggestion','legacy-owner-tenant','legacy-matter-active','legacy-candidate-person-one',
      'legacy-candidate-person-two','person','person','L2','influences',0.7,'graph','legacy relation evidence','pending');
   INSERT INTO \"ChangeProposal\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",\"entityKind\",\"entityId\",field,\"oldValue\",\"newValue\",origin,evidence,confidence,status,\"proposedBy\") VALUES
     ('legacy-change-proposal','legacy-owner-tenant','legacy-owner-account','legacy-matter-active','person',
      'legacy-candidate-person-one','title','Sponsor','Champion','voice','legacy change evidence',0.75,'pending','legacy-owner-user');
   INSERT INTO \"Reminder\"
     (id,\"tenantId\",\"accountId\",\"accountName\",\"opportunityId\",\"oppName\",kind,title,detail,severity,\"dedupeKey\",status) VALUES
     ('legacy-reminder','legacy-owner-tenant','legacy-owner-account','Legacy Account','legacy-matter-active',
      'Active Matter','stalled','Follow up','legacy reminder detail','warn','legacy-reminder-key','pending');
   INSERT INTO \"EvidenceEvent\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",\"personId\",\"signalKey\",direction,tier,\"rawContent\",\"occurredAt\",status,origin,\"createdBy\") VALUES
     ('legacy-evidence-event','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
      'legacy-candidate-person-one','intro_referral',1,'strong','legacy evidence raw','2026-08-24',
      'pending_review','voice','legacy-owner-user');
   INSERT INTO \"Note\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",\"personId\",content,source,tags,\"createdBy\") VALUES
     ('legacy-note-known','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
      'legacy-candidate-person-one','legacy known private note','manual','[]','legacy-owner-user'),
     ('legacy-note-quarantine','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
      NULL,'legacy unknown note','import','[]','unknown-user');
   INSERT INTO \"Transcript\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",source,\"externalRef\",title,\"contentEnc\",\"createdBy\") VALUES
     ('legacy-transcript-known','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
      'manual','legacy-transcript-known','Known creator','ciphertext-known','legacy-owner-user'),
     ('legacy-transcript-quarantine','legacy-owner-tenant','legacy-owner-account','legacy-matter-active',
      'manual','legacy-transcript-quarantine','Unknown creator','ciphertext-unknown','');" >/dev/null
# Simulate a process kill after the first of the three adoption resolves. The
# next server start must recognize and complete this partial history.
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint npx server \
  prisma migrate resolve --applied 20260715000000_baseline \
  --schema prisma/postgres/schema.prisma >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('interrupted-bridge-fixture', repeat('0', 64), '20260715030000_adopt_pre_int501_schema', CURRENT_TIMESTAMP, 0);" >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" up -d server >/dev/null
wait_for_server_healthy
migration_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')
[[ "$migration_count" == "$expected_migration_count" ]]
rolled_back_bridge_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '20260715030000_adopt_pre_int501_schema' AND rolled_back_at IS NOT NULL" | tr -d '[:space:]')
[[ "$rolled_back_bridge_count" == 1 ]]
legacy_bridge_ready=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT (to_regclass('\''public."AuditEvent"'\'') IS NOT NULL
       AND to_regclass('\''public."CommandRun"'\'') IS NOT NULL
       AND to_regclass('\''public."SyncRun"'\'') IS NOT NULL
       AND to_regclass('\''public."WeComOAuthState"'\'') IS NOT NULL)::int' | tr -d '[:space:]')
[[ "$legacy_bridge_ready" == 1 ]]
legacy_owner_id=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT \"primaryOwnerUserId\" FROM \"Account\" WHERE id = 'legacy-owner-account'" | tr -d '[:space:]')
[[ "$legacy_owner_id" == legacy-owner-user ]]
legacy_customer_expansion=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT ((SELECT count(*) FROM \"Account\"
              WHERE id = 'legacy-owner-account'
                AND \"customerType\" = 1
                AND \"categoryKey\" IS NULL
                AND version = 0) = 1
       AND (SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'Account'
                AND column_name = 'customerType') = 'YES')::int" | tr -d '[:space:]')
[[ "$legacy_customer_expansion" == 1 ]]
legacy_matter_total=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"Opportunity\" WHERE \"tenantId\" = 'legacy-owner-tenant'" | tr -d '[:space:]')
legacy_matter_mapping_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"Opportunity\"
   WHERE \"tenantId\" = 'legacy-owner-tenant'
     AND kind = 'sales_opportunity'
     AND ((status = 'active' AND \"lifecycleStatus\" = 'active' AND \"outcomeKey\" IS NULL)
       OR (status = 'paused' AND \"lifecycleStatus\" = 'paused' AND \"outcomeKey\" IS NULL)
       OR (status = 'won' AND \"lifecycleStatus\" = 'completed' AND \"outcomeKey\" = 'won')
       OR (status = 'lost' AND \"lifecycleStatus\" = 'completed' AND \"outcomeKey\" = 'lost'))" | tr -d '[:space:]')
[[ "$legacy_matter_total" == 4 ]]
[[ "$legacy_matter_mapping_count" == 4 ]]
legacy_commitment_mapping_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"PlanAction\"
   WHERE id = 'legacy-plan-action'
     AND kind = 'task'
     AND \"ownerUserId\" = 'legacy-owner-user'
     AND \"executionStatus\" = 'planned'
     AND \"confirmationStatus\" = 'not_required'
     AND \"scheduledAtUtc\" IS NULL
     AND \"dueAtUtc\" IS NULL
     AND \"timeZone\" = 'Asia/Shanghai'
     AND \"isAllDay\" IS true
     AND \"localDate\" = '2026-10-08'
     AND \"scheduleVersion\" = 0
     AND source = 'workbuddy'
     AND version = 0" | tr -d '[:space:]')
[[ "$legacy_commitment_mapping_count" == 1 ]]
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npm run migrate:candidate-report >/dev/null && npm run migrate:candidate-apply >/dev/null && npm run migrate:candidate-verify >/dev/null'
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npm run migrate:sensitive-acl-report >/dev/null && npm run migrate:sensitive-acl-apply >/dev/null && npm run migrate:sensitive-acl-verify >/dev/null'
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npm run migrate:source-artifact-report >/dev/null && npm run migrate:source-artifact-apply >/dev/null && npm run migrate:source-artifact-verify >/dev/null'
legacy_candidate_source_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT
     (SELECT count(*) FROM "PersonSuggestion")
     + (SELECT count(*) FROM "RelSuggestion")
     + (SELECT count(*) FROM "ChangeProposal")
     + (SELECT count(*) FROM "Reminder")
     + (SELECT count(*) FROM "EvidenceEvent" WHERE status = '\''pending_review'\'')' | tr -d '[:space:]')
legacy_candidate_target_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT count(*) FROM "Candidate"' | tr -d '[:space:]')
candidate_migration_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260824000000_expand_candidate_foundation'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
candidate_backfill_marker_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"DataMigrationState\" WHERE key = 'CORE-203-candidate-backfill-v1'" | tr -d '[:space:]')
sensitive_acl_migration_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260825000000_expand_sensitive_resource_acl'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
sensitive_acl_marker_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"DataMigrationState\" WHERE key = 'CORE-204-sensitive-acl-v1'" | tr -d '[:space:]')
source_artifact_migration_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260825010000_expand_source_artifact_projection'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
source_artifact_marker_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"DataMigrationState\" WHERE key = 'SAAS-201-source-artifact-projection-v1'" | tr -d '[:space:]')
source_artifact_mapping_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM \"SourceArtifact\"
   WHERE \"tenantId\" = 'legacy-owner-tenant'
     AND \"backingKind\" IN ('note','transcript')
     AND \"artifactKind\" IN ('note','transcript')
     AND \"fingerprintKind\" = 'content_sha256_v1'
     AND \"sourceFingerprint\" ~ '^[a-f0-9]{64}$'
     AND \"retentionState\" = 'available'
     AND ((\"createdByUserId\" = 'legacy-owner-user' AND visibility = 'private')
       OR (\"createdByUserId\" IS NULL AND visibility = 'owner_admin_only'))" | tr -d '[:space:]')
sensitive_acl_mapping_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT
     (SELECT count(*) FROM \"Note\"
       WHERE id = 'legacy-note-known' AND \"createdByUserId\" = 'legacy-owner-user'
         AND visibility = 'private' AND \"aclVersion\" = 1)
   + (SELECT count(*) FROM \"Note\"
       WHERE id = 'legacy-note-quarantine' AND \"createdByUserId\" IS NULL
         AND visibility = 'owner_admin_only' AND \"aclVersion\" = 1)
   + (SELECT count(*) FROM \"Transcript\"
       WHERE id = 'legacy-transcript-known' AND \"createdByUserId\" = 'legacy-owner-user'
         AND visibility = 'private' AND \"aclVersion\" = 1
         AND \"idempotencyDomain\" = 'creator-private-v1:\"legacy-owner-user\"')
   + (SELECT count(*) FROM \"Transcript\"
       WHERE id = 'legacy-transcript-quarantine' AND \"createdByUserId\" IS NULL
         AND visibility = 'owner_admin_only' AND \"aclVersion\" = 1
         AND \"idempotencyDomain\" = 'system-quarantine-v1')" | tr -d '[:space:]')
candidate_semantic_mapping_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT
     (SELECT count(*) FROM \"Candidate\"
       WHERE \"legacySourceKind\" = 'PersonSuggestion' AND \"legacySourceId\" = 'legacy-person-suggestion'
         AND \"dedupeKey\" = 'creator-private-v1:[\"legacy-owner-user\",\"person-pending-v1:legacy-owner-account:suggested person\"]')
   + (SELECT count(*) FROM \"Candidate\"
       WHERE \"legacySourceKind\" = 'RelSuggestion' AND \"legacySourceId\" = 'legacy-rel-suggestion'
         AND \"dedupeKey\" = 'relation-pending-v1:legacy-matter-active:person:legacy-candidate-person-one|person:legacy-candidate-person-two')
   + (SELECT count(*) FROM \"Candidate\"
       WHERE \"legacySourceKind\" = 'ChangeProposal' AND \"legacySourceId\" = 'legacy-change-proposal'
         AND \"dedupeKey\" = 'creator-private-v1:'
           || '[\"legacy-owner-user\",'
           || to_json('[\"legacy-owner-tenant\",\"legacy-owner-account\",\"person\",\"legacy-candidate-person-one\",\"title\"]'::text)::text
           || ']'
         AND payload::jsonb ->> 'legacyDedupeKey' = \"dedupeKey\")
   + (SELECT count(*) FROM \"Candidate\"
       WHERE \"legacySourceKind\" = 'Reminder' AND \"legacySourceId\" = 'legacy-reminder'
         AND \"dedupeKey\" = 'reminder-pending-v1:legacy-reminder-key')
   + (SELECT count(*) FROM \"Candidate\"
       WHERE \"legacySourceKind\" = 'EvidenceEvent' AND \"legacySourceId\" = 'legacy-evidence-event'
         AND \"dedupeKey\" = 'creator-private-v1:[\"legacy-owner-user\",\"evidence-source-v1:voice:legacy:EvidenceEvent:legacy-evidence-event\"]')" | tr -d '[:space:]')
[[ "$legacy_candidate_source_count" == 5 ]]
[[ "$legacy_candidate_target_count" == 5 ]]
[[ "$candidate_migration_count" == 1 ]]
[[ "$candidate_backfill_marker_count" == 1 ]]
[[ "$sensitive_acl_migration_count" == 1 ]]
[[ "$sensitive_acl_marker_count" == 1 ]]
[[ "$sensitive_acl_mapping_count" == 4 ]]
[[ "$source_artifact_migration_count" == 1 ]]
[[ "$source_artifact_marker_count" == 1 ]]
[[ "$source_artifact_mapping_count" == 4 ]]
[[ "$candidate_semantic_mapping_count" == 5 ]]
echo "LEGACY_CANDIDATE_REPORT_OK=1"
echo "CANDIDATE_BACKFILL_APPLY_OK=1"
echo "CANDIDATE_SOURCE_ROWS_UNCHANGED_OK=1"
echo "SENSITIVE_ACL_BACKFILL_APPLY_OK=1"
echo "SENSITIVE_ACL_CREATOR_QUARANTINE_OK=1"
echo "SOURCE_ARTIFACT_BACKFILL_APPLY_OK=1"
echo "SOURCE_ARTIFACT_CREATOR_QUARANTINE_OK=1"
echo "LEGACY_ACCOUNT_OWNER_BACKFILL_OK=1"
echo "LEGACY_SCHEMA_MIGRATION_PREFLIGHT_OK=1"
echo "LEGACY_MATTER_STATUS_BACKFILL_OK=1"
echo "LEGACY_COMMITMENT_BACKFILL_OK=1"

# Unknown legacy statuses must fail before the expand migration changes the
# schema. Repairing the source value must make the same database retryable.
unknown_matter_db=jianghu_matter_unknown
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$unknown_matter_db"
POSTGRES_DB="$unknown_matter_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260712_pre_int501.prisma --skip-generate' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$unknown_matter_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('unknown-matter-tenant','Unknown Matter Tenant');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\") VALUES ('unknown-matter-account','unknown-matter-tenant','Unknown Matter Account',1);
   INSERT INTO \"Opportunity\" (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\",status)
     VALUES ('unknown-matter-opportunity','unknown-matter-tenant','unknown-matter-account','Unknown Matter',1,'qualify','discover','future_status');" >/dev/null
if POSTGRES_DB="$unknown_matter_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "unknown legacy Matter status unexpectedly migrated" >&2; exit 1
fi
matter_columns_after_failure=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -tAc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Opportunity'
     AND column_name IN ('kind','lifecycleStatus','outcomeKey','priority','targetDate','primaryOwnerUserId','activeMethodologyBindingId')" | tr -d '[:space:]')
[[ "$matter_columns_after_failure" == 0 ]]
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
     VALUES ('interrupted-matter-before-commit', repeat('0', 64), '20260821000000_expand_matter_fields', CURRENT_TIMESTAMP, 0);
   UPDATE \"Opportunity\" SET status = 'lost' WHERE id = 'unknown-matter-opportunity';" >/dev/null
POSTGRES_DB="$unknown_matter_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
unknown_matter_recovered=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -tAc \
  "SELECT count(*) FROM \"Opportunity\"
   WHERE id = 'unknown-matter-opportunity' AND kind = 'sales_opportunity'
     AND status = 'lost' AND \"lifecycleStatus\" = 'completed' AND \"outcomeKey\" = 'lost'" | tr -d '[:space:]')
[[ "$unknown_matter_recovered" == 1 ]]
matter_rolled_back_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821000000_expand_matter_fields' AND rolled_back_at IS NOT NULL" | tr -d '[:space:]')
[[ "$matter_rolled_back_count" == 1 ]]
echo "INTERRUPTED_MATTER_BEFORE_COMMIT_RETRY_OK=1"

# Simulate PostgreSQL committing the transaction immediately before Prisma can
# mark it finished. The schema/parity-gated recovery must adopt it exactly once.
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260821000000_expand_matter_fields' AND finished_at IS NOT NULL;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
     VALUES ('interrupted-matter-after-commit', repeat('0', 64), '20260821000000_expand_matter_fields', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$unknown_matter_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
matter_applied_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821000000_expand_matter_fields'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
matter_incomplete_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$unknown_matter_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821000000_expand_matter_fields'
     AND finished_at IS NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$matter_applied_after_adoption" == 1 ]]
[[ "$matter_incomplete_after_adoption" == 0 ]]
echo "INTERRUPTED_MATTER_AFTER_COMMIT_ADOPTION_OK=1"
echo "UNKNOWN_MATTER_STATUS_FAIL_CLOSED_RETRY_OK=1"

# Invalid legacy business dates must fail before Commitment DDL. Repairing the
# source date makes the same database retryable; a later commit/registration
# interruption is adopted only after parity and exact-schema checks.
invalid_commitment_db=jianghu_commitment_invalid
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$invalid_commitment_db"
POSTGRES_DB="$invalid_commitment_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260712_pre_int501.prisma --skip-generate' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$invalid_commitment_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('invalid-commitment-tenant','Invalid Commitment Tenant');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('invalid-commitment-account','invalid-commitment-tenant','Invalid Commitment Account',1);
   INSERT INTO \"Opportunity\" (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\",status)
     VALUES ('invalid-commitment-matter','invalid-commitment-tenant','invalid-commitment-account','Matter',1,'qualify','discover','active');
   INSERT INTO \"PlanAction\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",title,\"startDate\",\"endDate\",half,done)
     VALUES ('invalid-commitment-action','invalid-commitment-tenant','invalid-commitment-account',
       'invalid-commitment-matter','Invalid date','2026-02-28','2026-02-31','am',false);" >/dev/null
if POSTGRES_DB="$invalid_commitment_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "invalid legacy Commitment date unexpectedly migrated" >&2; exit 1
fi
commitment_columns_after_failure=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -tAc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'PlanAction'
     AND column_name IN ('kind','ownerUserId','executionStatus','confirmationStatus','scheduledAtUtc','dueAtUtc',
       'timeZone','isAllDay','localDate','confirmationDueAtUtc','confirmedAtUtc','confirmedByUserId',
       'scheduleVersion','nextCommitmentId','source','sourceRef','archivedAt','version')" | tr -d '[:space:]')
[[ "$commitment_columns_after_failure" == 0 ]]
commitment_migration_rows_after_failure=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821020000_expand_commitment_fields'" | tr -d '[:space:]')
[[ "$commitment_migration_rows_after_failure" == 0 ]] || {
  echo "Commitment preflight unexpectedly entered Prisma migration history: $commitment_migration_rows_after_failure row(s)" >&2
  exit 1
}
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -c \
  "UPDATE \"PlanAction\" SET \"endDate\" = '2026-02-28' WHERE id = 'invalid-commitment-action';" >/dev/null
POSTGRES_DB="$invalid_commitment_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
invalid_commitment_recovered=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -tAc \
  "SELECT count(*) FROM \"PlanAction\"
   WHERE id = 'invalid-commitment-action'
     AND \"localDate\" = '2026-02-28'
     AND \"executionStatus\" = 'planned'
     AND \"scheduledAtUtc\" IS NULL
     AND \"dueAtUtc\" IS NULL" | tr -d '[:space:]')
commitment_applied_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821020000_expand_commitment_fields'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$invalid_commitment_recovered" == 1 ]] || {
  echo "Commitment retry did not backfill the repaired row: $invalid_commitment_recovered row(s)" >&2
  exit 1
}
[[ "$commitment_applied_count" == 1 ]] || {
  echo "Commitment retry did not leave one applied migration: $commitment_applied_count row(s)" >&2
  exit 1
}
echo "INVALID_COMMITMENT_FAIL_CLOSED_RETRY_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260821020000_expand_commitment_fields' AND finished_at IS NOT NULL;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
     VALUES ('interrupted-commitment-after-commit', repeat('0', 64), '20260821020000_expand_commitment_fields', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$invalid_commitment_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
commitment_applied_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821020000_expand_commitment_fields'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
commitment_incomplete_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$invalid_commitment_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821020000_expand_commitment_fields'
     AND finished_at IS NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$commitment_applied_after_adoption" == 1 ]]
[[ "$commitment_incomplete_after_adoption" == 0 ]]
echo "INTERRUPTED_COMMITMENT_AFTER_COMMIT_ADOPTION_OK=1"

# A pre-CORE-110 database may contain a reserved active pointer but cannot
# prove the referenced immutable binding because the foundation tables do not
# exist yet. Refuse all DDL until the pointer is repaired, then cover both
# before-commit replay and after-commit migration-history adoption.
methodology_db=jianghu_methodology_pointer
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$methodology_db"
POSTGRES_DB="$methodology_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260821_pre_core110.prisma --skip-generate' >/dev/null
for migration in \
  20260715000000_baseline \
  20260715010000_hash_command_run_idempotency_keys \
  20260715020000_add_person_created_at \
  20260715030000_adopt_pre_int501_schema \
  20260821000000_expand_matter_fields \
  20260821010000_expand_matter_participants_relations \
  20260821020000_expand_commitment_fields \
  20260821030000_release_customer_level_commitments; do
  POSTGRES_DB="$methodology_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint npx server \
    prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
done
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$methodology_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('methodology-tenant','Methodology Tenant');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('methodology-account','methodology-tenant','Methodology Account',1);
   INSERT INTO \"Opportunity\"
     (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\",\"activeMethodologyBindingId\")
     VALUES ('methodology-matter','methodology-tenant','methodology-account','Methodology Matter',1,
       'qualify','discover','unmanaged-binding');" >/dev/null
if POSTGRES_DB="$methodology_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "unmanaged methodology pointer unexpectedly migrated" >&2; exit 1
fi
methodology_tables_after_failure=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('MethodologyPack','MethodologyPackVersion','MethodologyBinding','MethodologyPilotAssignment')" | tr -d '[:space:]')
methodology_rows_after_failure=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821050000_add_methodology_foundation'" | tr -d '[:space:]')
scope_applied_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821040000_add_tenant_data_scope_policy'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$methodology_tables_after_failure" == 0 ]]
[[ "$methodology_rows_after_failure" == 0 ]]
[[ "$scope_applied_after_adoption" == 1 ]]
echo "INTERRUPTED_SCOPE_AFTER_COMMIT_ADOPTION_OK=1"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$methodology_db" -c \
  "UPDATE \"Opportunity\" SET \"activeMethodologyBindingId\" = NULL WHERE id = 'methodology-matter';
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
     VALUES ('int-methodology-before-commit', repeat('0', 64),
       '20260821050000_add_methodology_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$methodology_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
methodology_tables_after_retry=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('MethodologyPack','MethodologyPackVersion','MethodologyBinding','MethodologyPilotAssignment')" | tr -d '[:space:]')
methodology_rolled_back_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821050000_add_methodology_foundation' AND rolled_back_at IS NOT NULL" | tr -d '[:space:]')
[[ "$methodology_tables_after_retry" == 4 ]]
[[ "$methodology_rolled_back_count" == 1 ]]
echo "METHODOLOGY_POINTER_FAIL_CLOSED_RETRY_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$methodology_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260821050000_add_methodology_foundation' AND finished_at IS NOT NULL;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
     VALUES ('int-methodology-after-commit', repeat('0', 64),
       '20260821050000_add_methodology_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$methodology_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
methodology_applied_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821050000_add_methodology_foundation'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
methodology_incomplete_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821050000_add_methodology_foundation'
     AND finished_at IS NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$methodology_applied_after_adoption" == 1 ]]
[[ "$methodology_incomplete_after_adoption" == 0 ]]
echo "INTERRUPTED_METHODOLOGY_AFTER_COMMIT_ADOPTION_OK=1"

# CORE-111 is expand-only, but a kill can still happen before PostgreSQL commits
# or after commit and before Prisma records success. Exercise both states from
# the exact pre-CORE-111 schema so partial adoption can never be guessed.
methodology_data_db=jianghu_methodology_data
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$methodology_data_db"
POSTGRES_DB="$methodology_data_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260821_pre_core111.prisma --skip-generate' >/dev/null
POSTGRES_DB="$methodology_data_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint npx server \
  prisma migrate resolve --applied 20260715000000_baseline \
  --schema prisma/postgres/schema.prisma >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$methodology_data_db" -c \
  "INSERT INTO \"DataMigrationState\" (key, details) VALUES
     ('CORE-105-matter-participant-backfill-v1', '{}'),
     ('CORE-106-commitment-backfill-v1', '{}'),
     ('CORE-108-commitment-consumer-cutover-v1', '{}');
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-methodology-data-before-commit', repeat('0', 64),
     '20260821060000_add_methodology_data_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$methodology_data_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
methodology_data_tables_after_retry=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_data_db" -tAc \
  "SELECT count(*) FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN (
       'MethodologyFieldDefinition','MethodologyStageDefinition','MethodologyRoleDefinition',
       'MethodologyRuleDefinition','MethodologyActionTemplate','MethodologyStageState',
       'MethodologyRoleAssignment','MethodologyValue','MethodologyEvaluation','MethodologyMigrationRun'
     )" | tr -d '[:space:]')
methodology_data_rolled_back_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_data_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821060000_add_methodology_data_foundation' AND rolled_back_at IS NOT NULL" | tr -d '[:space:]')
[[ "$methodology_data_tables_after_retry" == 10 ]]
[[ "$methodology_data_rolled_back_count" == 1 ]]
echo "INTERRUPTED_METHODOLOGY_DATA_BEFORE_COMMIT_RETRY_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$methodology_data_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260821060000_add_methodology_data_foundation' AND finished_at IS NOT NULL;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-methodology-data-after-commit', repeat('0', 64),
     '20260821060000_add_methodology_data_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$methodology_data_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
methodology_data_applied_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_data_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821060000_add_methodology_data_foundation'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
methodology_data_incomplete_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$methodology_data_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821060000_add_methodology_data_foundation'
     AND finished_at IS NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$methodology_data_applied_after_adoption" == 1 ]]
[[ "$methodology_data_incomplete_after_adoption" == 0 ]]
echo "INTERRUPTED_METHODOLOGY_DATA_AFTER_COMMIT_ADOPTION_OK=1"

# CORE-113 materializes the legacy PDE stage shadow in the same PostgreSQL
# transaction as its tenant-scoped context table. Exercise rollback/replay and
# commit-before-history adoption from the exact pre-CORE-113 schema.
pde_context_db=jianghu_pde_context
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$pde_context_db"
POSTGRES_DB="$pde_context_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260821_pre_core113.prisma --skip-generate' >/dev/null
POSTGRES_DB="$pde_context_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint npx server \
  prisma migrate resolve --applied 20260715000000_baseline \
  --schema prisma/postgres/schema.prisma >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$pde_context_db" -c \
  "INSERT INTO \"DataMigrationState\" (key, details) VALUES
     ('CORE-105-matter-participant-backfill-v1', '{}'),
     ('CORE-106-commitment-backfill-v1', '{}'),
     ('CORE-108-commitment-consumer-cutover-v1', '{}');
   INSERT INTO \"Tenant\" (id,name) VALUES
     ('pde-context-tenant','PDE Context Tenant'),
     ('pde-context-foreign','PDE Context Foreign');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\") VALUES
     ('pde-context-account','pde-context-tenant','PDE Account',1),
     ('pde-context-foreign-account','pde-context-foreign','Foreign PDE Account',1);
   INSERT INTO \"Opportunity\"
     (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\") VALUES
     ('pde-context-known','pde-context-tenant','pde-context-account','Known',1,'线索','预算批复'),
     ('pde-context-unknown','pde-context-tenant','pde-context-account','Unknown',1,'legacy','discover'),
     ('pde-context-foreign-matter','pde-context-foreign','pde-context-foreign-account','Foreign',1,'线索','招采执行');
   INSERT INTO \"IndustryPack\"
     (id,\"tenantId\",\"packKey\",\"schemaVersion\",payload,active) VALUES
     ('pde-context-profile','pde-context-tenant','digital-energy','1.1','{}',true);
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-pde-context-before-commit', repeat('0', 64),
     '20260821070000_add_pde_decision_context', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$pde_context_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
pde_context_rows_after_retry=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$pde_context_db" -tAc \
  "SELECT count(*) FROM \"PdeDecisionContext\"" | tr -d '[:space:]')
pde_context_parity_after_retry=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$pde_context_db" -tAc \
  "SELECT count(*) FROM \"PdeDecisionContext\"
    WHERE (\"opportunityId\" = 'pde-context-known' AND \"stageKey\" = 'budget_approval' AND \"decisionProfileRef\" = 'pde-context-profile')
       OR (\"opportunityId\" = 'pde-context-unknown' AND \"stageKey\" = 'initiation' AND \"decisionProfileRef\" = 'pde-context-profile')
       OR (\"opportunityId\" = 'pde-context-foreign-matter' AND \"stageKey\" = 'tender_execution' AND \"decisionProfileRef\" IS NULL)" | tr -d '[:space:]')
pde_context_marker_after_retry=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$pde_context_db" -tAc \
  "SELECT count(*) FROM \"DataMigrationState\" WHERE key = 'CORE-113-pde-decision-context-shadow-v1'" | tr -d '[:space:]')
pde_context_rolled_back_count=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$pde_context_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821070000_add_pde_decision_context' AND rolled_back_at IS NOT NULL" | tr -d '[:space:]')
[[ "$pde_context_rows_after_retry" == 3 ]]
[[ "$pde_context_parity_after_retry" == 3 ]]
[[ "$pde_context_marker_after_retry" == 1 ]]
[[ "$pde_context_rolled_back_count" == 1 ]]
echo "INTERRUPTED_PDE_CONTEXT_BEFORE_COMMIT_RETRY_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$pde_context_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260821070000_add_pde_decision_context' AND finished_at IS NOT NULL;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-pde-context-after-commit', repeat('0', 64),
     '20260821070000_add_pde_decision_context', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$pde_context_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
pde_context_applied_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$pde_context_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821070000_add_pde_decision_context'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
pde_context_incomplete_after_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$pde_context_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260821070000_add_pde_decision_context'
     AND finished_at IS NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$pde_context_applied_after_adoption" == 1 ]]
[[ "$pde_context_incomplete_after_adoption" == 0 ]]
echo "INTERRUPTED_PDE_CONTEXT_AFTER_COMMIT_ADOPTION_OK=1"

# CORE-115 must safely distinguish PostgreSQL rollback-before-commit from an
# already committed expansion whose migration journal write was interrupted.
customer_migration_db=jianghu_customer_migration
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$customer_migration_db"
POSTGRES_DB="$customer_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx tsx scripts/render-pre-customer-schema.ts prisma/postgres/legacy/20260824_pre_core201.prisma /tmp/pre-customer.prisma
   npx prisma db push --schema /tmp/pre-customer.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260823000000_expand_customer_fields ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$customer_migration_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('customer-migration-tenant','Customer Migration Tenant');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('customer-migration-account','customer-migration-tenant','Legacy Customer',4);
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-customer-before-commit', repeat('0', 64),
     '20260823000000_expand_customer_fields', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$customer_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
customer_before_commit_parity=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$customer_migration_db" -tAc \
  "SELECT ((SELECT count(*) FROM \"Account\"
              WHERE id = 'customer-migration-account' AND \"customerType\" = 4
                AND \"categoryKey\" IS NULL AND version = 0) = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260823000000_expand_customer_fields'
                AND rolled_back_at IS NOT NULL) = 1)::int" | tr -d '[:space:]')
[[ "$customer_before_commit_parity" == 1 ]]
echo "INTERRUPTED_CUSTOMER_BEFORE_COMMIT_RETRY_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$customer_migration_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260823000000_expand_customer_fields' AND finished_at IS NOT NULL;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-customer-after-commit', repeat('0', 64),
     '20260823000000_expand_customer_fields', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$customer_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
customer_after_commit_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$customer_migration_db" -tAc \
  "SELECT ((SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260823000000_expand_customer_fields'
                AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260823000000_expand_customer_fields'
                AND finished_at IS NULL AND rolled_back_at IS NULL) = 0)::int" | tr -d '[:space:]')
[[ "$customer_after_commit_adoption" == 1 ]]
echo "INTERRUPTED_CUSTOMER_AFTER_COMMIT_ADOPTION_OK=1"

# CORE-201 expands the Candidate schema and CORE-203 performs a separate,
# idempotent data cutover. Exercise schema recovery, marker recovery,
# semantic-conflict refusal, partial-schema refusal, and authenticated restore.
candidate_migration_db=jianghu_candidate_migration
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$candidate_migration_db"
POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260824_pre_core201.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260824000000_expand_candidate_foundation ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('candidate-migration-tenant','Candidate Migration Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name,role)
     VALUES ('candidate-migration-user','candidate-migration-tenant','candidate-migration@example.test','unused','Owner','owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('candidate-migration-account','candidate-migration-tenant','Candidate Account',1);
   INSERT INTO \"Opportunity\"
     (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\")
     VALUES ('candidate-migration-matter','candidate-migration-tenant','candidate-migration-account',
       'Candidate Matter',1,'qualify','discover');
   INSERT INTO \"PersonSuggestion\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",name,origin,evidence,confidence,status,\"proposedBy\")
     VALUES ('candidate-migration-suggestion','candidate-migration-tenant','candidate-migration-account',
       'candidate-migration-matter','Suggested Person','mcp','pre-candidate evidence',0.8,'pending',
       'candidate-migration-user');" >/dev/null

candidate_backup_root="$BACKUP_DIR/core201-pre"
mkdir -p "$candidate_backup_root"
derive_backup_keys "$BACKUP_MASTER_SECRET"
candidate_backup_work=$(mktemp -d "$candidate_backup_root/.candidate-work.XXXXXX")
candidate_backup="$candidate_backup_root/jianghu-core201-$(openssl rand -hex 8).backup"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$candidate_migration_db" -Fc \
  | backup_encrypt_payload "$candidate_backup_work/payload.enc"
{
  backup_cipher_metadata
  printf 'source_database=%s\n' "$candidate_migration_db"
  printf 'created_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
} > "$candidate_backup_work/metadata"
write_artifact_integrity "$candidate_backup_work"
verify_artifact_auth "$candidate_backup_work"
mv "$candidate_backup_work" "$candidate_backup"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-candidate-before-commit', repeat('0', 64),
     '20260824000000_expand_candidate_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
candidate_before_commit_parity=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$candidate_migration_db" -tAc \
  "SELECT ((to_regclass('public.\"Candidate\"') IS NOT NULL)
       AND (SELECT count(*) FROM \"Candidate\") = 1
       AND (SELECT count(*) FROM \"PersonSuggestion\" WHERE id = 'candidate-migration-suggestion') = 1
       AND (SELECT count(*) FROM \"DataMigrationState\"
              WHERE key = 'CORE-203-candidate-backfill-v1') = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260824000000_expand_candidate_foundation'
                AND rolled_back_at IS NOT NULL) = 1)::int" | tr -d '[:space:]')
[[ "$candidate_before_commit_parity" == 1 ]]
echo "INTERRUPTED_CANDIDATE_BEFORE_COMMIT_RETRY_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "DELETE FROM \"_prisma_migrations\"
    WHERE migration_name = '20260824000000_expand_candidate_foundation' AND finished_at IS NOT NULL;
   DELETE FROM \"DataMigrationState\" WHERE key = 'CORE-203-candidate-backfill-v1';
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-candidate-after-commit', repeat('0', 64),
     '20260824000000_expand_candidate_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
candidate_after_commit_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$candidate_migration_db" -tAc \
  "SELECT ((SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260824000000_expand_candidate_foundation'
                AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260824000000_expand_candidate_foundation'
                AND finished_at IS NULL AND rolled_back_at IS NULL) = 0
       AND (SELECT count(*) FROM \"Candidate\") = 1
       AND (SELECT count(*) FROM \"DataMigrationState\"
              WHERE key = 'CORE-203-candidate-backfill-v1') = 1)::int" | tr -d '[:space:]')
[[ "$candidate_after_commit_adoption" == 1 ]]
echo "INTERRUPTED_CANDIDATE_AFTER_COMMIT_ADOPTION_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "UPDATE \"Candidate\" SET kind = 'tampered' WHERE \"legacySourceId\" = 'candidate-migration-suggestion';" >/dev/null
if POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "Candidate semantic conflict unexpectedly deployed" >&2; exit 1
fi
candidate_conflict_source_unchanged=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$candidate_migration_db" -tAc \
  "SELECT count(*) FROM \"PersonSuggestion\"
   WHERE id = 'candidate-migration-suggestion' AND status = 'pending'" | tr -d '[:space:]')
[[ "$candidate_conflict_source_unchanged" == 1 ]]
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "UPDATE \"Candidate\" SET kind = 'person_create' WHERE \"legacySourceId\" = 'candidate-migration-suggestion';" >/dev/null
POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "CANDIDATE_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "UPDATE \"DataMigrationState\"
      SET details = jsonb_set(details::jsonb, '{markerChecksum}', to_jsonb(repeat('0', 64)))::text
    WHERE key = 'CORE-203-candidate-backfill-v1';" >/dev/null
if POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "Candidate marker checksum drift unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_migration_db" -c \
  "DELETE FROM \"DataMigrationState\" WHERE key = 'CORE-203-candidate-backfill-v1';" >/dev/null
POSTGRES_DB="$candidate_migration_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "CANDIDATE_MARKER_CHECKSUM_FAIL_CLOSED_OK=1"

candidate_partial_db=jianghu_candidate_partial
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$candidate_partial_db"
POSTGRES_DB="$candidate_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260824_pre_core201.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260824000000_expand_candidate_foundation ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$candidate_partial_db" -c \
  "CREATE TABLE \"Candidate\" (id TEXT NOT NULL PRIMARY KEY);
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-candidate-partial', repeat('0', 64),
     '20260824000000_expand_candidate_foundation', CURRENT_TIMESTAMP, 0);" >/dev/null
if POSTGRES_DB="$candidate_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "partial Candidate schema unexpectedly migrated" >&2; exit 1
fi
candidate_partial_columns=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$candidate_partial_db" -tAc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Candidate'" | tr -d '[:space:]')
candidate_partial_applied=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$candidate_partial_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260824000000_expand_candidate_foundation'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$candidate_partial_columns" == 1 ]]
[[ "$candidate_partial_applied" == 0 ]]
echo "PARTIAL_CANDIDATE_SCHEMA_FAIL_CLOSED_OK=1"

candidate_restore_db=jianghu_restore_candidate_core201
bash scripts/restore-postgres.sh "$candidate_backup" --database "$candidate_restore_db" >/dev/null
candidate_restore_parity=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$candidate_restore_db" -tAc \
  "SELECT ((to_regclass('public.\"Candidate\"') IS NULL)
       AND (SELECT count(*) FROM \"PersonSuggestion\" WHERE id = 'candidate-migration-suggestion') = 1)::int" | tr -d '[:space:]')
[[ "$candidate_restore_parity" == 1 ]]
echo "CANDIDATE_RESTORE_ROLLBACK_OK=1"
echo "CORE_203_CANDIDATE_CUTOVER_OK=1"

# CORE-204 expands creator/share ACL columns and performs a separate marker-last
# data cutover. Exercise committed-DDL adoption, semantic and marker drift,
# partial-schema refusal, and authenticated restoration of the pre-ACL schema.
sensitive_acl_db=jianghu_sensitive_acl_migration
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$sensitive_acl_db"
POSTGRES_DB="$sensitive_acl_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_core204.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825000000_expand_sensitive_resource_acl ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('sensitive-acl-tenant','Sensitive ACL Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name,role)
     VALUES ('sensitive-acl-user','sensitive-acl-tenant','sensitive-acl@example.test','unused','Owner','owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('sensitive-acl-account','sensitive-acl-tenant','Sensitive ACL Account',1);
   INSERT INTO \"Opportunity\"
     (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\")
     VALUES ('sensitive-acl-matter','sensitive-acl-tenant','sensitive-acl-account',
       'Sensitive ACL Matter',1,'qualify','discover');
   INSERT INTO \"Person\" (id,\"tenantId\",\"accountId\",name,title)
     VALUES ('sensitive-acl-person','sensitive-acl-tenant','sensitive-acl-account','Sensitive Person','Sponsor');
   INSERT INTO \"Note\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",\"personId\",content,source,tags,\"createdBy\") VALUES
     ('sensitive-note-known','sensitive-acl-tenant','sensitive-acl-account','sensitive-acl-matter',
      'sensitive-acl-person','known note body','manual','[]','sensitive-acl-user'),
     ('sensitive-note-quarantine','sensitive-acl-tenant','sensitive-acl-account','sensitive-acl-matter',
      NULL,'unknown note body','import','[]','foreign-user');
   INSERT INTO \"Transcript\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",source,\"externalRef\",title,\"contentEnc\",\"createdBy\") VALUES
     ('sensitive-transcript-known','sensitive-acl-tenant','sensitive-acl-account','sensitive-acl-matter',
      'manual','sensitive-known','Known transcript','ciphertext-known','sensitive-acl-user'),
     ('sensitive-transcript-quarantine','sensitive-acl-tenant','sensitive-acl-account','sensitive-acl-matter',
      'manual','sensitive-unknown','Unknown transcript','ciphertext-unknown','');
   INSERT INTO \"Candidate\"
     (id,\"tenantId\",kind,\"accountId\",\"matterId\",\"targetKind\",\"targetId\",source,
      \"sourceRef\",evidence,confidence,\"createdByUserId\",visibility,\"dedupeKey\",\"updatedAt\") VALUES
     ('sensitive-candidate-known','sensitive-acl-tenant','field_change','sensitive-acl-account',
      'sensitive-acl-matter','person','sensitive-acl-person','manual','sensitive-known',
      'known candidate evidence',0.8,'sensitive-acl-user','private','sensitive-known',CURRENT_TIMESTAMP),
     ('sensitive-candidate-quarantine','sensitive-acl-tenant','field_change','sensitive-acl-account',
      'sensitive-acl-matter','person','sensitive-acl-person','import','sensitive-unknown',
      'unknown candidate evidence',0.5,NULL,'private','sensitive-unknown',CURRENT_TIMESTAMP);
   INSERT INTO \"ChangeProposal\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",\"entityKind\",\"entityId\",field,
      \"newValue\",origin,evidence,confidence,\"dedupeKey\",\"proposedBy\") VALUES
     ('sensitive-field-proposal','sensitive-acl-tenant','sensitive-acl-account','sensitive-acl-matter',
      'person','sensitive-acl-person','title','Decision maker','mcp','field evidence',0.8,
      'legacy-v1:ChangeProposal:sensitive-field-proposal','sensitive-acl-user');
   INSERT INTO \"Candidate\"
     (id,\"tenantId\",kind,\"accountId\",\"matterId\",\"targetKind\",\"targetId\",\"fieldKey\",
      \"oldValue\",\"newValue\",payload,source,\"sourceRef\",evidence,confidence,\"createdByUserId\",visibility,
      \"dedupeKey\",\"legacySourceKind\",\"legacySourceId\",\"updatedAt\") VALUES
     ('cand_0dda2cb646322f048c369fc11e209ad4','sensitive-acl-tenant','field_change','sensitive-acl-account',
      'sensitive-acl-matter','person','sensitive-acl-person','title','','Decision maker',
      '{\"legacyDedupeKey\":\"legacy-v1:ChangeProposal:sensitive-field-proposal\",\"legacyStatus\":\"pending\"}',
      'mcp','legacy:ChangeProposal:sensitive-field-proposal','field evidence',0.8,'sensitive-acl-user','private',
      'legacy-v1:ChangeProposal:sensitive-field-proposal','ChangeProposal','sensitive-field-proposal',CURRENT_TIMESTAMP);" >/dev/null

sensitive_backup_root="$BACKUP_DIR/core204-pre"
mkdir -p "$sensitive_backup_root"
derive_backup_keys "$BACKUP_MASTER_SECRET"
sensitive_backup_work=$(mktemp -d "$sensitive_backup_root/.sensitive-work.XXXXXX")
sensitive_backup="$sensitive_backup_root/jianghu-core204-$(openssl rand -hex 8).backup"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$sensitive_acl_db" -Fc \
  | backup_encrypt_payload "$sensitive_backup_work/payload.enc"
{
  backup_cipher_metadata
  printf 'source_database=%s\n' "$sensitive_acl_db"
  printf 'created_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
} > "$sensitive_backup_work/metadata"
write_artifact_integrity "$sensitive_backup_work"
verify_artifact_auth "$sensitive_backup_work"
mv "$sensitive_backup_work" "$sensitive_backup"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" \
  < server/prisma/postgres/migrations/20260825000000_expand_sensitive_resource_acl/migration.sql >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-sensitive-after-commit', repeat('0', 64),
     '20260825000000_expand_sensitive_resource_acl', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$sensitive_acl_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
sensitive_after_commit_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$sensitive_acl_db" -tAc \
  "SELECT ((SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260825000000_expand_sensitive_resource_acl'
                AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260825000000_expand_sensitive_resource_acl'
                AND finished_at IS NULL AND rolled_back_at IS NULL) = 0
       AND (SELECT count(*) FROM \"DataMigrationState\"
              WHERE key = 'CORE-204-sensitive-acl-v1') = 1
       AND (SELECT count(*) FROM \"Note\"
              WHERE id = 'sensitive-note-known' AND \"createdByUserId\" = 'sensitive-acl-user'
                AND visibility = 'private' AND \"aclVersion\" = 1) = 1
       AND (SELECT count(*) FROM \"Note\"
              WHERE id = 'sensitive-note-quarantine' AND \"createdByUserId\" IS NULL
                AND visibility = 'owner_admin_only' AND \"aclVersion\" = 1) = 1
       AND (SELECT count(*) FROM \"Transcript\"
              WHERE id = 'sensitive-transcript-known' AND \"createdByUserId\" = 'sensitive-acl-user'
                AND visibility = 'private' AND \"aclVersion\" = 1
                AND \"idempotencyDomain\" = 'creator-private-v1:\"sensitive-acl-user\"') = 1
       AND (SELECT count(*) FROM \"Transcript\"
              WHERE id = 'sensitive-transcript-quarantine' AND \"createdByUserId\" IS NULL
                AND visibility = 'owner_admin_only' AND \"aclVersion\" = 1
                AND \"idempotencyDomain\" = 'system-quarantine-v1') = 1
       AND to_regclass('public.\"Transcript_tenantId_source_externalRef_key\"') IS NULL
       AND to_regclass('public.\"Transcript_tenantId_idempotencyDomain_source_externalRef_key\"') IS NOT NULL
       AND (SELECT count(*) FROM \"Candidate\"
              WHERE id = 'sensitive-candidate-known'
                AND \"dedupeKey\" = 'creator-private-v1:[\"sensitive-acl-user\",\"sensitive-known\"]'
                AND \"createdByUserId\" = 'sensitive-acl-user'
                AND visibility = 'private' AND \"aclVersion\" = 1) = 1
       AND (SELECT count(*) FROM \"Candidate\"
              WHERE id = 'cand_0dda2cb646322f048c369fc11e209ad4'
                AND \"dedupeKey\" = 'creator-private-v1:'
                  || '[\"sensitive-acl-user\",'
                  || to_json('[\"sensitive-acl-tenant\",\"sensitive-acl-account\",\"person\",\"sensitive-acl-person\",\"title\"]'::text)::text
                  || ']'
                AND payload::jsonb ->> 'legacyDedupeKey' = \"dedupeKey\"
                AND payload::jsonb ->> 'legacyStatus' = 'pending') = 1
       AND (SELECT count(*) FROM \"ChangeProposal\"
              WHERE id = 'sensitive-field-proposal'
                AND \"dedupeKey\" = 'creator-private-v1:'
                  || '[\"sensitive-acl-user\",'
                  || to_json('[\"sensitive-acl-tenant\",\"sensitive-acl-account\",\"person\",\"sensitive-acl-person\",\"title\"]'::text)::text
                  || ']') = 1
       AND (SELECT count(*) FROM \"Candidate\"
              WHERE id = 'sensitive-candidate-quarantine' AND \"createdByUserId\" IS NULL
                AND visibility = 'owner_admin_only' AND \"aclVersion\" = 1) = 1)::int" | tr -d '[:space:]')
[[ "$sensitive_after_commit_adoption" == 1 ]]
echo "INTERRUPTED_SENSITIVE_ACL_AFTER_COMMIT_ADOPTION_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" -c \
  "UPDATE \"Note\" SET visibility = 'tampered' WHERE id = 'sensitive-note-known';" >/dev/null
if POSTGRES_DB="$sensitive_acl_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "sensitive ACL semantic conflict unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" -c \
  "UPDATE \"Note\" SET visibility = 'private' WHERE id = 'sensitive-note-known';" >/dev/null
POSTGRES_DB="$sensitive_acl_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "SENSITIVE_ACL_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" -c \
  "UPDATE \"DataMigrationState\"
      SET details = jsonb_set(details::jsonb, '{markerChecksum}', to_jsonb(repeat('0', 64)))::text
    WHERE key = 'CORE-204-sensitive-acl-v1';" >/dev/null
if POSTGRES_DB="$sensitive_acl_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "sensitive ACL marker checksum drift unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_acl_db" -c \
  "DELETE FROM \"DataMigrationState\" WHERE key = 'CORE-204-sensitive-acl-v1';" >/dev/null
POSTGRES_DB="$sensitive_acl_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "SENSITIVE_ACL_MARKER_CHECKSUM_FAIL_CLOSED_OK=1"

sensitive_partial_db=jianghu_sensitive_acl_partial
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$sensitive_partial_db"
POSTGRES_DB="$sensitive_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_core204.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825000000_expand_sensitive_resource_acl ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$sensitive_partial_db" -c \
  "ALTER TABLE \"Candidate\" ADD COLUMN \"aclVersion\" INTEGER NOT NULL DEFAULT 1;
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-sensitive-partial', repeat('0', 64),
     '20260825000000_expand_sensitive_resource_acl', CURRENT_TIMESTAMP, 0);" >/dev/null
if POSTGRES_DB="$sensitive_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "partial sensitive ACL schema unexpectedly migrated" >&2; exit 1
fi
sensitive_partial_columns=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$sensitive_partial_db" -tAc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Candidate' AND column_name = 'aclVersion'" | tr -d '[:space:]')
sensitive_partial_applied=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$sensitive_partial_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260825000000_expand_sensitive_resource_acl'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$sensitive_partial_columns" == 1 ]]
[[ "$sensitive_partial_applied" == 0 ]]
echo "PARTIAL_SENSITIVE_ACL_SCHEMA_FAIL_CLOSED_OK=1"

sensitive_restore_db=jianghu_restore_sensitive_acl_core204
bash scripts/restore-postgres.sh "$sensitive_backup" --database "$sensitive_restore_db" >/dev/null
sensitive_restore_parity=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$sensitive_restore_db" -tAc \
  "SELECT ((to_regclass('public.\"SourceArtifact\"') IS NULL)
       AND (to_regclass('public.\"SensitiveResourceGrant\"') IS NULL)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Note' AND column_name = 'aclVersion')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Transcript' AND column_name = 'idempotencyDomain')
       AND to_regclass('public.\"Transcript_tenantId_source_externalRef_key\"') IS NOT NULL
       AND to_regclass('public.\"Transcript_tenantId_idempotencyDomain_source_externalRef_key\"') IS NULL
       AND (SELECT count(*) FROM \"Note\" WHERE id IN ('sensitive-note-known','sensitive-note-quarantine')) = 2)::int" | tr -d '[:space:]')
[[ "$sensitive_restore_parity" == 1 ]]
echo "SENSITIVE_ACL_RESTORE_ROLLBACK_OK=1"
echo "CORE_204_SENSITIVE_ACL_CUTOVER_OK=1"

# SAAS-201 expands the CORE-204 metadata shell, then projects each Note and
# Transcript authority exactly once. Exercise committed-DDL adoption, semantic
# and marker drift, partial-schema refusal, and authenticated pre-cutover restore.
source_artifact_db=jianghu_source_artifact_migration
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$source_artifact_db"
POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_saas201.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825010000_expand_source_artifact_projection ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('source-artifact-tenant','Source Artifact Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name,role)
     VALUES ('source-artifact-user','source-artifact-tenant','source-artifact@example.test','unused','Owner','owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('source-artifact-account','source-artifact-tenant','Source Artifact Account',1);
   INSERT INTO \"Opportunity\"
     (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\")
     VALUES ('source-artifact-matter','source-artifact-tenant','source-artifact-account',
       'Source Artifact Matter',1,'qualify','discover');
   INSERT INTO \"Note\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",content,source,tags,\"createdBy\",
      \"createdByUserId\",visibility,\"aclVersion\")
     VALUES ('source-artifact-note','source-artifact-tenant','source-artifact-account',
       'source-artifact-matter','private note authority','manual','[]','source-artifact-user',
       'source-artifact-user','private',1);
   INSERT INTO \"Transcript\"
     (id,\"tenantId\",\"accountId\",\"opportunityId\",source,\"externalRef\",
      \"idempotencyDomain\",title,\"contentEnc\",status,\"createdBy\",\"createdByUserId\",
      visibility,\"aclVersion\")
     VALUES ('source-artifact-transcript','source-artifact-tenant','source-artifact-account',
       'source-artifact-matter','manual','source-artifact-external',
       'creator-private-v1:\"source-artifact-user\"','Customer meeting','opaque-ciphertext','active',
       'source-artifact-user','source-artifact-user','private',1);" >/dev/null

source_artifact_backup_root="$BACKUP_DIR/saas201-pre"
mkdir -p "$source_artifact_backup_root"
derive_backup_keys "$BACKUP_MASTER_SECRET"
source_artifact_backup_work=$(mktemp -d "$source_artifact_backup_root/.source-artifact-work.XXXXXX")
source_artifact_backup="$source_artifact_backup_root/jianghu-saas201-$(openssl rand -hex 8).backup"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$source_artifact_db" -Fc \
  | backup_encrypt_payload "$source_artifact_backup_work/payload.enc"
{
  backup_cipher_metadata
  printf 'source_database=%s\n' "$source_artifact_db"
  printf 'created_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
} > "$source_artifact_backup_work/metadata"
write_artifact_integrity "$source_artifact_backup_work"
verify_artifact_auth "$source_artifact_backup_work"
mv "$source_artifact_backup_work" "$source_artifact_backup"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" \
  < server/prisma/postgres/migrations/20260825010000_expand_source_artifact_projection/migration.sql >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-source-artifact-after-commit', repeat('0', 64),
     '20260825010000_expand_source_artifact_projection', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
source_artifact_after_commit_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$source_artifact_db" -tAc \
  "SELECT ((SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260825010000_expand_source_artifact_projection'
                AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260825010000_expand_source_artifact_projection'
                AND finished_at IS NULL AND rolled_back_at IS NULL) = 0
       AND (SELECT count(*) FROM \"DataMigrationState\"
              WHERE key = 'SAAS-201-source-artifact-projection-v1') = 1
       AND (SELECT count(*) FROM \"SourceArtifact\"
              WHERE \"tenantId\" = 'source-artifact-tenant') = 2
       AND (SELECT count(*) FROM \"SourceArtifact\"
              WHERE \"tenantId\" = 'source-artifact-tenant'
                AND \"backingKind\" = 'note' AND \"backingId\" = 'source-artifact-note'
                AND \"artifactKind\" = 'note' AND source = 'manual'
                AND \"externalRef\" IS NULL AND \"fingerprintKind\" = 'content_sha256_v1'
                AND \"sourceFingerprint\" ~ '^[a-f0-9]{64}$'
                AND \"retentionState\" = 'available' AND visibility = 'private') = 1
       AND (SELECT count(*) FROM \"SourceArtifact\"
              WHERE \"tenantId\" = 'source-artifact-tenant'
                AND \"backingKind\" = 'transcript' AND \"backingId\" = 'source-artifact-transcript'
                AND \"artifactKind\" = 'transcript' AND source = 'manual'
                AND \"externalRef\" = 'source-artifact-external'
                AND \"idempotencyDomain\" = 'creator-private-v1:\"source-artifact-user\"'
                AND title = 'Customer meeting' AND \"fingerprintKind\" = 'content_sha256_v1'
                AND \"sourceFingerprint\" ~ '^[a-f0-9]{64}$'
                AND \"retentionState\" = 'available' AND visibility = 'private') = 1
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'SourceArtifact'
                AND column_name IN ('content','contentEnc','body','payload')))::int" | tr -d '[:space:]')
[[ "$source_artifact_after_commit_adoption" == 1 ]]
echo "INTERRUPTED_SOURCE_ARTIFACT_AFTER_COMMIT_ADOPTION_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "UPDATE \"SourceArtifact\" SET \"backingId\" = 'tampered-backing'
    WHERE \"backingKind\" = 'note' AND \"backingId\" = 'source-artifact-note';" >/dev/null
if POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "source artifact semantic conflict unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "UPDATE \"SourceArtifact\" SET \"backingId\" = 'source-artifact-note'
    WHERE \"backingKind\" = 'note' AND \"backingId\" = 'tampered-backing';" >/dev/null
POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "SOURCE_ARTIFACT_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "UPDATE \"SourceArtifact\" SET \"sourceFingerprint\" = repeat('f', 64)
    WHERE \"backingKind\" = 'note' AND \"backingId\" = 'source-artifact-note';" >/dev/null
if POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "post-marker source artifact fingerprint drift unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "DELETE FROM \"DataMigrationState\" WHERE key = 'SAAS-201-source-artifact-projection-v1';" >/dev/null
POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "SOURCE_ARTIFACT_FINGERPRINT_DRIFT_FAIL_CLOSED_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "UPDATE \"DataMigrationState\"
      SET details = jsonb_set(details::jsonb, '{integrityChecksum}', to_jsonb(repeat('0', 64)))::text
    WHERE key = 'SAAS-201-source-artifact-projection-v1';" >/dev/null
if POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "source artifact marker checksum drift unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_db" -c \
  "DELETE FROM \"DataMigrationState\" WHERE key = 'SAAS-201-source-artifact-projection-v1';" >/dev/null
POSTGRES_DB="$source_artifact_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "SOURCE_ARTIFACT_MARKER_CHECKSUM_FAIL_CLOSED_OK=1"

source_artifact_partial_db=jianghu_source_artifact_partial
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$source_artifact_partial_db"
POSTGRES_DB="$source_artifact_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_saas201.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825010000_expand_source_artifact_projection ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$source_artifact_partial_db" -c \
  "ALTER TABLE \"SourceArtifact\" ADD COLUMN \"artifactKind\" TEXT NOT NULL DEFAULT 'external_reference';
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-source-artifact-partial', repeat('0', 64),
     '20260825010000_expand_source_artifact_projection', CURRENT_TIMESTAMP, 0);" >/dev/null
if POSTGRES_DB="$source_artifact_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "partial source artifact schema unexpectedly migrated" >&2; exit 1
fi
source_artifact_partial_columns=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$source_artifact_partial_db" -tAc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'SourceArtifact' AND column_name = 'artifactKind'" | tr -d '[:space:]')
source_artifact_partial_applied=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$source_artifact_partial_db" -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\"
   WHERE migration_name = '20260825010000_expand_source_artifact_projection'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d '[:space:]')
[[ "$source_artifact_partial_columns" == 1 ]]
[[ "$source_artifact_partial_applied" == 0 ]]
echo "PARTIAL_SOURCE_ARTIFACT_SCHEMA_FAIL_CLOSED_OK=1"

source_artifact_restore_db=jianghu_restore_source_artifact_saas201
bash scripts/restore-postgres.sh "$source_artifact_backup" --database "$source_artifact_restore_db" >/dev/null
source_artifact_restore_parity=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$source_artifact_restore_db" -tAc \
  "SELECT ((SELECT count(*) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'SourceArtifact'
                AND column_name IN ('artifactKind','source','externalRef','idempotencyDomain','title',
                  'occurredAt','fingerprintKind','sourceFingerprint','retentionState','retentionUpdatedAt')) = 0
       AND (SELECT count(*) FROM \"SourceArtifact\") = 0
       AND (SELECT count(*) FROM \"Note\" WHERE id = 'source-artifact-note') = 1
       AND (SELECT count(*) FROM \"Transcript\" WHERE id = 'source-artifact-transcript') = 1
       AND NOT EXISTS (SELECT 1 FROM \"DataMigrationState\"
              WHERE key = 'SAAS-201-source-artifact-projection-v1'))::int" | tr -d '[:space:]')
[[ "$source_artifact_restore_parity" == 1 ]]
echo "SOURCE_ARTIFACT_RESTORE_ROLLBACK_OK=1"
echo "SAAS_201_SOURCE_ARTIFACT_CUTOVER_OK=1"

# CORE-205 adds only body-free ReviewBatch/Interaction metadata. Exercise an
# already-committed DDL adoption, semantic and marker drift, pre-DDL Candidate
# attachment refusal, partial-schema refusal, and authenticated pre-cutover restore.
review_batch_db=jianghu_review_batch_migration
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$review_batch_db"
POSTGRES_DB="$review_batch_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_core205.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825020000_expand_review_batch_interaction ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null

review_batch_backup_root="$BACKUP_DIR/core205-pre"
mkdir -p "$review_batch_backup_root"
derive_backup_keys "$BACKUP_MASTER_SECRET"
review_batch_backup_work=$(mktemp -d "$review_batch_backup_root/.review-batch-work.XXXXXX")
review_batch_backup="$review_batch_backup_root/jianghu-core205-$(openssl rand -hex 8).backup"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$review_batch_db" -Fc \
  | backup_encrypt_payload "$review_batch_backup_work/payload.enc"
{
  backup_cipher_metadata
  printf 'source_database=%s\n' "$review_batch_db"
  printf 'created_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
} > "$review_batch_backup_work/metadata"
write_artifact_integrity "$review_batch_backup_work"
verify_artifact_auth "$review_batch_backup_work"
mv "$review_batch_backup_work" "$review_batch_backup"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_db" \
  < server/prisma/postgres/migrations/20260825020000_expand_review_batch_interaction/migration.sql >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_db" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-review-batch-after-commit', repeat('0', 64),
     '20260825020000_expand_review_batch_interaction', CURRENT_TIMESTAMP, 0);" >/dev/null
POSTGRES_DB="$review_batch_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
review_batch_after_commit_adoption=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$review_batch_db" -tAc \
  "SELECT ((SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260825020000_expand_review_batch_interaction'
                AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
       AND (SELECT count(*) FROM \"_prisma_migrations\"
              WHERE migration_name = '20260825020000_expand_review_batch_interaction'
                AND finished_at IS NULL AND rolled_back_at IS NULL) = 0
       AND (SELECT count(*) FROM \"DataMigrationState\"
              WHERE key = 'CORE-205-review-batch-interaction-v1') = 1
       AND to_regclass('public.\"ReviewBatch\"') IS NOT NULL
       AND to_regclass('public.\"Interaction\"') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name IN ('ReviewBatch','Interaction')
                AND column_name IN ('content','contentEnc','body','evidence','payload')))::int" | tr -d '[:space:]')
[[ "$review_batch_after_commit_adoption" == 1 ]]
echo "INTERRUPTED_REVIEW_BATCH_AFTER_COMMIT_ADOPTION_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('review-batch-tenant','Review Batch Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name,role)
     VALUES ('review-batch-user','review-batch-tenant','review-batch@example.test','unused','Owner','owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\")
     VALUES ('review-batch-account','review-batch-tenant','Review Batch Account',1);
   INSERT INTO \"Opportunity\"
     (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\")
     VALUES ('review-batch-matter','review-batch-tenant','review-batch-account',
       'Review Batch Matter',1,'qualify','discover');
   INSERT INTO \"SourceArtifact\"
     (id,\"tenantId\",\"accountId\",\"matterId\",\"backingKind\",\"backingId\",\"artifactKind\",
      source,\"externalRef\",\"idempotencyDomain\",\"fingerprintKind\",\"sourceFingerprint\",
      \"retentionState\",\"createdByUserId\",visibility,\"aclVersion\",\"updatedAt\")
     VALUES ('review-batch-source','review-batch-tenant','review-batch-account','review-batch-matter',
       'external_reference','review-batch-source','external_reference','test','review-batch-source-ref',
       'creator-private-v1:\"review-batch-user\"','reference_sha256_v1',repeat('a',64),'reference_only',
       'review-batch-user','private',1,CURRENT_TIMESTAMP);
   INSERT INTO \"ReviewBatch\"
     (id,\"tenantId\",\"sourceArtifactId\",\"accountId\",\"matterId\",\"createdByUserId\",
      visibility,\"aclVersion\",\"updatedAt\")
     VALUES ('review-batch-orphan','review-batch-tenant','review-batch-source','review-batch-account',
       'review-batch-matter','review-batch-user','private',1,CURRENT_TIMESTAMP);" >/dev/null
if POSTGRES_DB="$review_batch_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "orphan ReviewBatch unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_db" -c \
  "DELETE FROM \"ReviewBatch\" WHERE id = 'review-batch-orphan';" >/dev/null
POSTGRES_DB="$review_batch_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "REVIEW_BATCH_SEMANTIC_CONFLICT_FAIL_CLOSED_OK=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_db" -c \
  "UPDATE \"DataMigrationState\"
      SET details = jsonb_set(details::jsonb, '{integrityChecksum}', to_jsonb(repeat('0', 64)))::text
    WHERE key = 'CORE-205-review-batch-interaction-v1';" >/dev/null
if POSTGRES_DB="$review_batch_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "ReviewBatch marker checksum drift unexpectedly deployed" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_db" -c \
  "DELETE FROM \"DataMigrationState\" WHERE key = 'CORE-205-review-batch-interaction-v1';" >/dev/null
POSTGRES_DB="$review_batch_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
echo "REVIEW_BATCH_MARKER_CHECKSUM_FAIL_CLOSED_OK=1"

review_batch_attachment_db=jianghu_review_batch_attachment_drift
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$review_batch_attachment_db"
POSTGRES_DB="$review_batch_attachment_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_core205.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825020000_expand_review_batch_interaction ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_attachment_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('attachment-tenant','Attachment Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name,role)
     VALUES ('attachment-user','attachment-tenant','attachment@example.test','unused','Owner','owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name) VALUES ('attachment-account','attachment-tenant','Attachment Account');
   INSERT INTO \"SourceArtifact\"
     (id,\"tenantId\",\"accountId\",\"backingKind\",\"backingId\",\"artifactKind\",source,
      \"externalRef\",\"idempotencyDomain\",\"fingerprintKind\",\"sourceFingerprint\",\"retentionState\",
      \"createdByUserId\",visibility,\"aclVersion\",\"updatedAt\")
     VALUES ('attachment-source','attachment-tenant','attachment-account','external_reference','attachment-source',
       'external_reference','test','attachment-source-ref','creator-private-v1:\"attachment-user\"',
       'reference_sha256_v1',repeat('b',64),'reference_only','attachment-user','private',1,CURRENT_TIMESTAMP);
   INSERT INTO \"Candidate\"
     (id,\"tenantId\",kind,status,\"accountId\",\"targetKind\",source,\"sourceRef\",evidence,confidence,
      \"sourceArtifactId\",\"createdByUserId\",visibility,\"aclVersion\",\"dedupeKey\",version,\"updatedAt\")
     VALUES ('attachment-candidate','attachment-tenant','person_create','pending','attachment-account','person',
       'test','test:attachment','private evidence',0.8,'attachment-source','attachment-user','private',1,
       'attachment-candidate',0,CURRENT_TIMESTAMP);" >/dev/null
if POSTGRES_DB="$review_batch_attachment_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "pre-DDL Candidate attachment drift unexpectedly migrated" >&2; exit 1
fi
review_batch_attachment_state=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$review_batch_attachment_db" -tAc \
  "SELECT ((to_regclass('public.\"ReviewBatch\"') IS NULL)
       AND NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\"
         WHERE migration_name = '20260825020000_expand_review_batch_interaction'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL))::int" | tr -d '[:space:]')
[[ "$review_batch_attachment_state" == 1 ]]
echo "REVIEW_BATCH_ATTACHMENT_DRIFT_FAIL_CLOSED_OK=1"

review_batch_partial_db=jianghu_review_batch_partial
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$review_batch_partial_db"
POSTGRES_DB="$review_batch_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260825_pre_core205.prisma --skip-generate >/dev/null
   for path in prisma/postgres/migrations/20*; do
     [ -d "$path" ] || continue
     migration=$(basename "$path")
     [ "$migration" = 20260825020000_expand_review_batch_interaction ] && break
     npx prisma migrate resolve --applied "$migration" --schema prisma/postgres/schema.prisma >/dev/null
   done' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$review_batch_partial_db" -c \
  "CREATE TABLE \"ReviewBatch\" (id TEXT PRIMARY KEY);
   INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('int-review-batch-partial', repeat('0', 64),
     '20260825020000_expand_review_batch_interaction', CURRENT_TIMESTAMP, 0);" >/dev/null
if POSTGRES_DB="$review_batch_partial_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "partial ReviewBatch schema unexpectedly migrated" >&2; exit 1
fi
review_batch_partial_state=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$review_batch_partial_db" -tAc \
  "SELECT ((to_regclass('public.\"ReviewBatch\"') IS NOT NULL)
       AND (to_regclass('public.\"Interaction\"') IS NULL)
       AND NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\"
         WHERE migration_name = '20260825020000_expand_review_batch_interaction'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL))::int" | tr -d '[:space:]')
[[ "$review_batch_partial_state" == 1 ]]
echo "PARTIAL_REVIEW_BATCH_SCHEMA_FAIL_CLOSED_OK=1"

review_batch_restore_db=jianghu_restore_review_batch_core205
bash scripts/restore-postgres.sh "$review_batch_backup" --database "$review_batch_restore_db" >/dev/null
review_batch_restore_parity=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$review_batch_restore_db" -tAc \
  "SELECT ((to_regclass('public.\"ReviewBatch\"') IS NULL)
       AND (to_regclass('public.\"Interaction\"') IS NULL)
       AND NOT EXISTS (SELECT 1 FROM \"DataMigrationState\"
              WHERE key = 'CORE-205-review-batch-interaction-v1'))::int" | tr -d '[:space:]')
[[ "$review_batch_restore_parity" == 1 ]]
echo "REVIEW_BATCH_RESTORE_ROLLBACK_OK=1"
echo "CORE_205_REVIEW_BATCH_MIGRATION_OK=1"

# A duplicate tenant-local owner name must roll the bridge transaction back.
# After data repair, the same database must resume and complete safely.
ambiguous_db=jianghu_owner_ambiguous
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db createdb -U "$POSTGRES_USER" "$ambiguous_db"
POSTGRES_DB="$ambiguous_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint sh server -c \
  'npx prisma db push --schema prisma/postgres/legacy/20260712_pre_int501.prisma --skip-generate' >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$ambiguous_db" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('ambiguous-tenant','Ambiguous Tenant');
   INSERT INTO \"User\" (id,\"tenantId\",email,\"passwordHash\",name) VALUES
     ('ambiguous-user-a','ambiguous-tenant','ambiguous-a@example.test','unused','Duplicate Owner'),
     ('ambiguous-user-b','ambiguous-tenant','ambiguous-b@example.test','unused','Duplicate Owner');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\",\"primaryOwner\") VALUES ('ambiguous-account','ambiguous-tenant','Ambiguous Account',1,'Duplicate Owner');" >/dev/null
if POSTGRES_DB="$ambiguous_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
    --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null 2>&1; then
  echo "ambiguous legacy owner unexpectedly migrated" >&2; exit 1
fi
owner_column_after_failure=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$ambiguous_db" -tAc \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Account' AND column_name = 'primaryOwnerUserId'" | tr -d '[:space:]')
[[ "$owner_column_after_failure" == 0 ]]
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$ambiguous_db" -c \
  "DELETE FROM \"User\" WHERE id = 'ambiguous-user-b';" >/dev/null
POSTGRES_DB="$ambiguous_db" docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps \
  --entrypoint ./scripts/deploy-postgres-migrations.sh server >/dev/null
ambiguous_owner_id=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$ambiguous_db" -tAc \
  "SELECT \"primaryOwnerUserId\" FROM \"Account\" WHERE id = 'ambiguous-account'" | tr -d '[:space:]')
[[ "$ambiguous_owner_id" == ambiguous-user-a ]]
echo "AMBIGUOUS_OWNER_TRANSACTION_RETRY_OK=1"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"Tenant\" (id,name) VALUES ('ops-tenant','Ops Tenant');
   INSERT INTO \"Account\" (id,\"tenantId\",name,\"customerType\") VALUES ('ops-account','ops-tenant','WorkBuddy Customer',1);
   INSERT INTO \"Opportunity\" (id,\"tenantId\",\"accountId\",name,\"customerType\",\"pipelineStage\",\"engageStage\")
     VALUES ('ops-opportunity','ops-tenant','ops-account','WorkBuddy Opportunity',1,'qualify','discover');
   INSERT INTO \"SyncRun\" (id,\"tenantId\",\"actorId\",\"idempotencyKey\",\"requestHash\",status,\"createdAt\",\"updatedAt\")
     VALUES ('ops-sync','ops-tenant','ops-actor','ops-key','ops-hash','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);" >/dev/null

# INT-502 mixed legacy migration: ordinary rows were raw, person-merge rows were already SHA-256.
legacy_key='ops-legacy-command-key'
legacy_hash=$(printf '%s' "$legacy_key" | openssl dgst -sha256 -r | awk '{print $1}')
person_hash=$(printf '%s' 'ops-person-merge-key' | openssl dgst -sha256 -r | awk '{print $1}')
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"CommandRun\" (id,\"tenantId\",\"actorId\",kind,\"idempotencyKey\",\"requestHash\",status,\"createdAt\",\"updatedAt\")
     VALUES ('ops-command-legacy','ops-tenant','ops-actor','action-feedback','$legacy_key','request-a','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('ops-command-person','ops-tenant','ops-actor','person-merge','$person_hash','request-b','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);" >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < server/prisma/postgres/migrations/20260715010000_hash_command_run_idempotency_keys/migration.sql >/dev/null
migrated_keys=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'SELECT "idempotencyKey" FROM "CommandRun" ORDER BY id' | tr -d '\r')
[[ "$migrated_keys" == "$legacy_hash"$'\n'"$person_hash" ]]

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"CommandRun\" (id,\"tenantId\",\"actorId\",kind,\"idempotencyKey\",\"requestHash\",status,\"createdAt\",\"updatedAt\")
     VALUES ('ops-command-invalid-person','ops-tenant','ops-actor','person-merge','raw-invalid-person-key','request-c','completed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);" >/dev/null
if docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    < server/prisma/postgres/migrations/20260715010000_hash_command_run_idempotency_keys/migration.sql >/dev/null 2>&1; then
  echo "invalid legacy person-merge key unexpectedly migrated" >&2; exit 1
fi
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "DELETE FROM \"CommandRun\" WHERE id = 'ops-command-invalid-person';" >/dev/null
echo "COMMAND_KEY_MIXED_MIGRATION_OK=1"

# Exercise the one-time pre-INT501 bridge against the same isolated Compose project.
bootstrap_root=$(mktemp -d "/tmp/jianghu-int501-bootstrap.${$}.XXXXXX")
cp docker-compose.yml "$bootstrap_root/docker-compose.yml"
cp .dockerignore "$bootstrap_root/.dockerignore"
tar -cf - --exclude='node_modules' --exclude='dist' --exclude='*.db' server packages \
  | tar -xf - -C "$bootstrap_root"
cat > "$bootstrap_root/.env" <<EOF
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB
JWT_SECRET=$JWT_SECRET
AI_KEY_SECRET=$AI_KEY_SECRET
OUTBOUND_ALLOWED_HOSTS=$OUTBOUND_ALLOWED_HOSTS
EOF
deployment_git_in_dir "$bootstrap_root" init -q
deployment_git_in_dir "$bootstrap_root" -c user.name=CI -c user.email=ci@example.invalid add .dockerignore docker-compose.yml server packages
deployment_git_in_dir "$bootstrap_root" -c user.name=CI -c user.email=ci@example.invalid commit -qm 'legacy bootstrap fixture'
bootstrap_backups="$bootstrap_root/backups"
if env -u BACKUP_MASTER_SECRET \
  JIANGHU_ROOT="$bootstrap_root" \
  COMPANY_BACKUP_DIR="$bootstrap_backups" \
  INT501_BOOTSTRAP_MARKER="$bootstrap_backups/verified" \
  INT501_BOOTSTRAP_TEST_FAIL_SMOKE=1 \
  bash deploy-company-bootstrap-int501.sh >/dev/null 2>&1; then
  echo "bootstrap smoke failure unexpectedly succeeded" >&2; exit 1
fi
[[ ! -e "$bootstrap_backups/verified" ]]
bootstrap_leftovers=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT count(*) FROM pg_database WHERE datname LIKE 'jianghu_restore_bootstrap_%'" | tr -d '[:space:]')
[[ "$bootstrap_leftovers" == 0 ]]
echo "BOOTSTRAP_SMOKE_FAILURE_CLEANUP=1"

env -u BACKUP_MASTER_SECRET \
  JIANGHU_ROOT="$bootstrap_root" \
  COMPANY_BACKUP_DIR="$bootstrap_backups" \
  INT501_BOOTSTRAP_MARKER="$bootstrap_backups/verified" \
  bash deploy-company-bootstrap-int501.sh >/dev/null
[[ -s "$bootstrap_backups/verified" ]]
bootstrap_master=$(grep '^BACKUP_MASTER_SECRET=' "$bootstrap_root/.env" | tail -n1 | cut -d= -f2)
derive_backup_keys "$bootstrap_master"
bootstrap_commit=$(deployment_git_in_dir "$bootstrap_root" rev-parse HEAD)
verify_bootstrap_marker "$bootstrap_backups/verified" "$COMPOSE_PROJECT_NAME" "$POSTGRES_DB" "$bootstrap_backups" "$bootstrap_commit"
verify_artifact_auth "$VERIFIED_BOOTSTRAP_BACKUP"
rm -rf "$bootstrap_root"
echo "PRE_INT501_BOOTSTRAP_OK=1"

(
  postgres_query_database_presence() { return 42; }
  set +e
  postgres_assert_database_absent jianghu_restore_query_failure
  query_failure_status=$?
  set -e
  [[ "$query_failure_status" == 2 ]]
  cleanup_query_failure() { postgres_assert_database_absent jianghu_restore_query_failure; }
  set +e
  postgres_require_verified_cleanup cleanup_query_failure
  cleanup_failure_status=$?
  set -e
  [[ "$cleanup_failure_status" == 70 ]]
)
echo "DATABASE_QUERY_FAILURE_FAILS_CLOSED=1"

bash scripts/backup-postgres.sh & first_pid=$!
bash scripts/backup-postgres.sh & second_pid=$!
wait "$first_pid"
wait "$second_pid"
backup_count=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'jianghu-*.backup' | wc -l | tr -d ' ')
[[ "$backup_count" == 2 ]]
echo "CONCURRENT_BACKUPS=2"
backup=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'jianghu-*.backup' | sort | head -n 1)

target=jianghu_restore_success
bash scripts/restore-postgres.sh "$backup" --database "$target"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$target" -c \
  'CREATE TABLE replace_sentinel(id integer);' >/dev/null
bash scripts/restore-postgres.sh "$backup" --database "$target" --replace
sentinel=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$target" -tAc \
  "SELECT to_regclass('public.replace_sentinel') IS NULL" | tr -d '[:space:]')
[[ "$sentinel" == t ]]
workbuddy_smoke=$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d "$target" -tAc \
  'SELECT ((SELECT count(*) FROM "Account" WHERE id = '\''ops-account'\'') = 1
       AND (SELECT count(*) FROM "Opportunity" WHERE id = '\''ops-opportunity'\'') = 1
       AND (SELECT count(*) FROM "SyncRun" WHERE id = '\''ops-sync'\'') = 1)::int' | tr -d '[:space:]')
[[ "$workbuddy_smoke" == 1 ]]
echo "WORKBUDDY_DATA_SMOKE=1"

if POSTGRES_DB=caller_override bash scripts/restore-postgres.sh "$backup" --database "$POSTGRES_DB" >/dev/null 2>&1; then
  echo "production database override bypassed" >&2; exit 1
fi
for refused in postgres template0 template1 arbitrary_name; do
  if bash scripts/restore-postgres.sh "$backup" --database "$refused" >/dev/null 2>&1; then
    echo "unsafe target accepted: $refused" >&2; exit 1
  fi
done

WRONG_MASTER_SECRET=$(openssl rand -hex 32)
if BACKUP_MASTER_SECRET=$WRONG_MASTER_SECRET bash scripts/restore-postgres.sh "$backup" --database jianghu_restore_wrong_key >/dev/null 2>&1; then
  echo "wrong key accepted" >&2; exit 1
fi
assert_database_absent jianghu_restore_wrong_key

tampered="$BACKUP_DIR/jianghu-tampered.backup"
cp -R "$backup" "$tampered"
printf tamper >> "$tampered/payload.enc"
if bash scripts/restore-postgres.sh "$tampered" --database jianghu_restore_tampered >/dev/null 2>&1; then
  echo "tampered backup accepted" >&2; exit 1
fi
assert_database_absent jianghu_restore_tampered

bad_archive="$BACKUP_DIR/jianghu-bad-archive.backup"
cp -R "$backup" "$bad_archive"
derive_backup_keys "$BACKUP_MASTER_SECRET"
printf 'not a PostgreSQL archive' \
  | backup_encrypt_payload "$bad_archive/payload.enc"
write_artifact_integrity "$bad_archive"
if bash scripts/restore-postgres.sh "$bad_archive" --database jianghu_restore_bad_archive >/dev/null 2>&1; then
  echo "bad archive accepted" >&2; exit 1
fi
assert_database_absent jianghu_restore_bad_archive
echo "BAD_ARCHIVE_PARTIAL_CLEANUP=1"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$target' AND pid <> pg_backend_pid();" >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -U "$POSTGRES_USER" -d postgres -c \
  "DROP DATABASE \"$target\";" >/dev/null
assert_database_absent "$target"

# ── Fresh-install 场景（ADR-INT-502 清库重装的等价物）──
# 第一遍 update.sh：空库首装（构建 → entrypoint 迁移空库 → readiness → 自动写首个认证备份 + marker）；
# 第二遍原样重跑：existing_db=1 → marker/备份认证 → 回滚点 → 停写 no-op 迁移 → readiness，
# 即公司服务器未来每一次日常更新的等价物。全程隔离 Compose 项目 + git clone 临时仓（自带 origin，pull --ff-only 走通）。
fresh_root=$(mktemp -d "/tmp/jianghu-fresh-install.${$}.XXXXXX")
fresh_project="jianghu_fresh_${$}"
fresh_backups="$fresh_root-backups"
fresh_rollbacks="$fresh_root-rollbacks"
fresh_origin="$fresh_root/origin.git"
fresh_branch='ci-deploy-fixture'
fresh_port=$(( 20000 + RANDOM % 20000 ))
git clone -q "file://$ROOT_DIR" "$fresh_root/repo"
# pull_request checkouts can expose only a detached synthetic merge commit.
# Give the deployment fixture its own tracked branch and isolated origin so
# deploy-company-update.sh exercises the production pull gate deterministically.
git init --bare -q "$fresh_origin"
# The CI workspace is shallow; allow only this disposable fixture origin to accept it.
deployment_git_in_dir "$fresh_origin" config receive.shallowUpdate true
deployment_git_in_dir "$fresh_root/repo" switch -q -C "$fresh_branch"
deployment_git_in_dir "$fresh_root/repo" remote set-url origin "file://$fresh_origin"
deployment_git_in_dir "$fresh_root/repo" push -qu -u origin "$fresh_branch"
[[ "$(deployment_git_in_dir "$fresh_root/repo" rev-parse --abbrev-ref '@{upstream}')" == "origin/$fresh_branch" ]]
# Local pre-commit runs clone HEAD, so overlay the current server and workspace
# package snapshots to exercise their exact cross-package contract. CI normally has no overlay diff.
tar -cf - --exclude='node_modules' --exclude='dist' --exclude='*.db' server packages \
  | tar -xf - -C "$fresh_root/repo"
deployment_git_in_dir "$fresh_root/repo" -c user.name=CI -c user.email=ci@example.invalid add server packages
if ! deployment_git_in_dir "$fresh_root/repo" diff --cached --quiet; then
  deployment_git_in_dir "$fresh_root/repo" -c user.name=CI -c user.email=ci@example.invalid commit -qm 'current server snapshot'
fi
cat > "$fresh_root/repo/.env" <<EOF
COMPOSE_PROJECT_NAME=$fresh_project
POSTGRES_USER=jianghu_fresh
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=jianghu_fresh
JWT_SECRET=$(openssl rand -hex 32)
AI_KEY_SECRET=$(openssl rand -hex 32)
OUTBOUND_ALLOWED_HOSTS=example.com
BACKUP_MASTER_SECRET=$(openssl rand -hex 32)
BACKUP_DIR=$fresh_backups
WEB_PORT=$fresh_port
EOF
# 清空外层测试环境变量，让临时仓的 .env 成为唯一配置来源（等价公司服务器现场）。
fresh_env=(env -u COMPOSE_PROJECT_NAME -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  -u JWT_SECRET -u AI_KEY_SECRET -u OUTBOUND_ALLOWED_HOSTS -u BACKUP_MASTER_SECRET \
  -u BACKUP_DIR -u BACKUP_RETENTION_DAYS \
  JIANGHU_ROOT="$fresh_root/repo" ROLLBACK_ROOT="$fresh_rollbacks")
"${fresh_env[@]}" bash "$fresh_root/repo/deploy-company-update.sh" >/dev/null
[[ -s "$fresh_backups/.int501-bootstrap-verified" ]]
fresh_migrations=$(docker compose -p "$fresh_project" exec -T db psql -U jianghu_fresh -d jianghu_fresh -tAc \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')
[[ "$fresh_migrations" == "$expected_migration_count" ]]
fresh_backup_count=$(find "$fresh_backups" -maxdepth 1 -type d -name 'jianghu-*.backup' | wc -l | tr -d ' ')
[[ "$fresh_backup_count" == 1 ]]
echo "FRESH_INSTALL_FIRST_RUN_OK=1"

"${fresh_env[@]}" bash "$fresh_root/repo/deploy-company-update.sh" >/dev/null
fresh_migrations_after=$(docker compose -p "$fresh_project" exec -T db psql -U jianghu_fresh -d jianghu_fresh -tAc \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')
[[ "$fresh_migrations_after" == "$expected_migration_count" ]]
fresh_rollback_count=$(find "$fresh_rollbacks" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
[[ "$fresh_rollback_count" -ge 1 ]]
echo "FRESH_INSTALL_SECOND_UPDATE_OK=1"
POSTGRES_PASSWORD=x JWT_SECRET=x AI_KEY_SECRET=x OUTBOUND_ALLOWED_HOSTS=example.com \
  docker compose -p "$fresh_project" down -v --remove-orphans >/dev/null
rm -rf "$fresh_root" "$fresh_backups" "$fresh_rollbacks"
fresh_project=''
fresh_root=''

docker compose -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null
rm -rf "$BACKUP_DIR"
trap - EXIT
echo "POSTGRES_OPS_INTEGRATION_OK=1"
