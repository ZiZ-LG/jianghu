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
       'Legacy customer visit','legacy-owner-user','2026-10-07','2026-10-08','am',false,'workbuddy','legacy-owner-user');" >/dev/null
# Simulate a process kill after the first of the three adoption resolves. The
# next server start must recognize and complete this partial history.
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps --entrypoint npx server \
  prisma migrate resolve --applied 20260715000000_baseline \
  --schema prisma/postgres/schema.prisma >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)
   VALUES ('interrupted-bridge-fixture', repeat('0', 64), '20260715030000_adopt_pre_int501_schema', CURRENT_TIMESTAMP, 0);" >/dev/null
docker compose -p "$COMPOSE_PROJECT_NAME" up -d server >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-server-1" 2>/dev/null || true)" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME}-server-1")" == healthy ]]
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
fresh_port=$(( 20000 + RANDOM % 20000 ))
git clone -q "file://$ROOT_DIR" "$fresh_root/repo"
# Local pre-commit runs clone HEAD, so overlay the current server snapshot to
# exercise the exact migration under review. CI normally has no overlay diff.
tar -cf - --exclude='node_modules' --exclude='dist' --exclude='*.db' server \
  | tar -xf - -C "$fresh_root/repo"
deployment_git_in_dir "$fresh_root/repo" -c user.name=CI -c user.email=ci@example.invalid add server
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
