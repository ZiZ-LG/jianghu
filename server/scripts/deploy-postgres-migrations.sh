#!/bin/sh
set -eu

SCHEMA=prisma/postgres/schema.prisma
LEGACY_SCHEMA=prisma/postgres/legacy/20260712_pre_int501.prisma
PRE_PARTICIPANT_SCHEMA=prisma/postgres/legacy/20260821_pre_core105.prisma
PRE_COMMITMENT_SCHEMA=prisma/postgres/legacy/20260821_pre_core106.prisma
PRE_COMMITMENT_CUTOVER_SCHEMA=prisma/postgres/legacy/20260821_pre_core108.prisma
PRE_SCOPE_SCHEMA=prisma/postgres/legacy/20260821_pre_core109.prisma
PRE_METHODOLOGY_SCHEMA=prisma/postgres/legacy/20260821_pre_core110.prisma
PRE_METHODOLOGY_DATA_SCHEMA=prisma/postgres/legacy/20260821_pre_core111.prisma
PRE_PDE_CONTEXT_SCHEMA=prisma/postgres/legacy/20260821_pre_core113.prisma
PRE_CANDIDATE_SCHEMA=prisma/postgres/legacy/20260824_pre_core201.prisma
PRE_CUSTOMER_SCHEMA=$(mktemp /tmp/jianghu-pre-core115.prisma.XXXXXX)
cleanup_pre_customer_schema() {
  rm -f "$PRE_CUSTOMER_SCHEMA"
}
trap cleanup_pre_customer_schema EXIT
trap 'exit 1' HUP INT TERM
PRE_BRIDGE_MIGRATIONS='20260715000000_baseline 20260715010000_hash_command_run_idempotency_keys 20260715020000_add_person_created_at'
BRIDGE_MIGRATION=20260715030000_adopt_pre_int501_schema
MATTER_MIGRATION=20260821000000_expand_matter_fields
PARTICIPANT_MIGRATION=20260821010000_expand_matter_participants_relations
COMMITMENT_MIGRATION=20260821020000_expand_commitment_fields
COMMITMENT_CUTOVER_MIGRATION=20260821030000_release_customer_level_commitments
SCOPE_MIGRATION=20260821040000_add_tenant_data_scope_policy
METHODOLOGY_MIGRATION=20260821050000_add_methodology_foundation
METHODOLOGY_DATA_MIGRATION=20260821060000_add_methodology_data_foundation
PDE_CONTEXT_MIGRATION=20260821070000_add_pde_decision_context
CUSTOMER_MIGRATION=20260823000000_expand_customer_fields
CANDIDATE_MIGRATION=20260824000000_expand_candidate_foundation

npx tsx scripts/render-pre-customer-schema.ts "$PRE_CANDIDATE_SCHEMA" "$PRE_CUSTOMER_SCHEMA"

wait_for_migration_state() {
  i=0
  while true; do
    if state=$(npx tsx scripts/postgres-migration-state.ts 2>/tmp/postgres-migration-state.log); then
      printf '%s' "$state"
      return 0
    fi
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "[migration] 数据库始终不可用，放弃：" >&2
      cat /tmp/postgres-migration-state.log >&2
      return 1
    fi
    echo "[migration] 第 $i 次未就绪，2s 后重试…" >&2
    sleep 2
  done
}

schema_matches() {
  target_schema=$1
  npx prisma migrate diff \
    --from-schema-datasource "$SCHEMA" \
    --to-schema-datamodel "$target_schema" \
    --exit-code >/tmp/postgres-schema-drift.log 2>&1
}

matter_schema_matches_known_state() {
  schema_matches "$PRE_PARTICIPANT_SCHEMA" || schema_matches "$PRE_COMMITMENT_SCHEMA" \
    || schema_matches "$PRE_COMMITMENT_CUTOVER_SCHEMA" || schema_matches "$PRE_SCOPE_SCHEMA" \
    || schema_matches "$PRE_METHODOLOGY_SCHEMA" || schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA" \
    || schema_matches "$PRE_PDE_CONTEXT_SCHEMA" || schema_matches "$PRE_CUSTOMER_SCHEMA" \
    || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

participant_schema_matches_known_state() {
  schema_matches "$PRE_COMMITMENT_SCHEMA" || schema_matches "$PRE_COMMITMENT_CUTOVER_SCHEMA" \
    || schema_matches "$PRE_SCOPE_SCHEMA" || schema_matches "$PRE_METHODOLOGY_SCHEMA" \
    || schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA" || schema_matches "$PRE_PDE_CONTEXT_SCHEMA" \
    || schema_matches "$PRE_CUSTOMER_SCHEMA" || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

commitment_cutover_schema_matches_known_state() {
  schema_matches "$PRE_SCOPE_SCHEMA" || schema_matches "$PRE_METHODOLOGY_SCHEMA" \
    || schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA" || schema_matches "$PRE_PDE_CONTEXT_SCHEMA" \
    || schema_matches "$PRE_CUSTOMER_SCHEMA" || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

scope_schema_matches_known_state() {
  schema_matches "$PRE_METHODOLOGY_SCHEMA" || schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA" \
    || schema_matches "$PRE_PDE_CONTEXT_SCHEMA" || schema_matches "$PRE_CUSTOMER_SCHEMA" \
    || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

methodology_schema_matches_known_state() {
  schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA" || schema_matches "$PRE_PDE_CONTEXT_SCHEMA" \
    || schema_matches "$PRE_CUSTOMER_SCHEMA" || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

methodology_data_schema_matches_known_state() {
  schema_matches "$PRE_PDE_CONTEXT_SCHEMA" || schema_matches "$PRE_CUSTOMER_SCHEMA" \
    || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

pde_context_schema_matches_known_state() {
  schema_matches "$PRE_CUSTOMER_SCHEMA" || schema_matches "$PRE_CANDIDATE_SCHEMA" \
    || schema_matches "$SCHEMA"
}

customer_schema_matches_known_state() {
  schema_matches "$PRE_CANDIDATE_SCHEMA" || schema_matches "$SCHEMA"
}

candidate_schema_matches_known_state() {
  schema_matches "$SCHEMA"
}

refresh_applied_migrations() {
  applied_migrations=$(npx tsx scripts/list-applied-postgres-migrations.ts)
}

migration_is_applied() {
  printf '%s\n' "$applied_migrations" | grep -Fxq "$1"
}

resolve_missing_pre_bridge_migrations() {
  refresh_applied_migrations
  for migration in $PRE_BRIDGE_MIGRATIONS; do
    if ! migration_is_applied "$migration"; then
      npx prisma migrate resolve --applied "$migration" --schema "$SCHEMA"
      refresh_applied_migrations
    fi
  done
}

rollback_incomplete_bridge() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if printf '%s\n' "$incomplete_migrations" | grep -Fxq "$BRIDGE_MIGRATION"; then
    echo "[migration] 检测到中断的 bridge 事务，登记为 rolled back 后安全重放。"
    npx prisma migrate resolve --rolled-back "$BRIDGE_MIGRATION" --schema "$SCHEMA"
  fi
}

recover_incomplete_matter_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$MATTER_MIGRATION"; then
    return 0
  fi
  matter_schema_state=$(npx tsx scripts/postgres-matter-schema-state.ts)
  case "$matter_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的 Matter 事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$MATTER_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的 Matter 事务，验证后接管。"
      npm run migrate:matter-verify
      if ! matter_schema_matches_known_state; then
        echo "[migration] Matter schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$MATTER_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] Matter migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_matter_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$MATTER_MIGRATION"; then
    return 0
  fi
  matter_schema_state=$(npx tsx scripts/postgres-matter-schema-state.ts)
  case "$matter_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的 Matter schema，验证后接管。"
      npm run migrate:matter-verify
      if ! matter_schema_matches_known_state; then
        echo "[migration] 未登记 Matter schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$MATTER_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分 Matter schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_participant_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$PARTICIPANT_MIGRATION"; then
    return 0
  fi
  participant_schema_state=$(npx tsx scripts/postgres-participant-schema-state.ts)
  case "$participant_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的参与关系事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$PARTICIPANT_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的参与关系事务，验证后接管。"
      npm run migrate:matter-participant-verify
      if ! participant_schema_matches_known_state; then
        echo "[migration] 参与关系 schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$PARTICIPANT_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 参与关系 migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_participant_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$PARTICIPANT_MIGRATION"; then
    return 0
  fi
  participant_schema_state=$(npx tsx scripts/postgres-participant-schema-state.ts)
  case "$participant_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的参与关系 schema，验证后接管。"
      npm run migrate:matter-participant-verify
      if ! participant_schema_matches_known_state; then
        echo "[migration] 未登记参与关系 schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$PARTICIPANT_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分参与关系 schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_commitment_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$COMMITMENT_MIGRATION"; then
    return 0
  fi
  commitment_schema_state=$(npx tsx scripts/postgres-commitment-schema-state.ts)
  case "$commitment_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的 Commitment 事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$COMMITMENT_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded_required)
      echo "[migration] 检测到已提交但未完成登记的 Commitment 事务，验证后接管。"
      npm run migrate:commitment-verify
      if ! schema_matches "$PRE_COMMITMENT_CUTOVER_SCHEMA"; then
        echo "[migration] Commitment schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$COMMITMENT_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded_nullable)
      echo "[migration] 检测到 Commitment 与客户级 cutover 均已提交，验证当前权威后接管。"
      npm run migrate:commitment-verify
      if ! commitment_cutover_schema_matches_known_state; then
        echo "[migration] Commitment nullable schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$COMMITMENT_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] Commitment migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_commitment_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$COMMITMENT_MIGRATION"; then
    return 0
  fi
  commitment_schema_state=$(npx tsx scripts/postgres-commitment-schema-state.ts)
  case "$commitment_schema_state" in
    legacy) return 0 ;;
    expanded_required)
      echo "[migration] 检测到未登记但完整的 Commitment schema，验证后接管。"
      npm run migrate:commitment-verify
      if ! schema_matches "$PRE_COMMITMENT_CUTOVER_SCHEMA"; then
        echo "[migration] 未登记 Commitment schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$COMMITMENT_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded_nullable)
      echo "[migration] 检测到未登记的 nullable Commitment schema，验证当前权威后接管。"
      npm run migrate:commitment-verify
      if ! commitment_cutover_schema_matches_known_state; then
        echo "[migration] 未登记 nullable Commitment schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$COMMITMENT_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分 Commitment schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_commitment_cutover_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$COMMITMENT_CUTOVER_MIGRATION"; then
    return 0
  fi
  commitment_schema_state=$(npx tsx scripts/postgres-commitment-schema-state.ts)
  case "$commitment_schema_state" in
    expanded_required)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的 Commitment cutover，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$COMMITMENT_CUTOVER_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded_nullable)
      echo "[migration] 检测到已提交但未完成登记的 Commitment cutover，验证后接管。"
      npm run migrate:commitment-verify
      if ! commitment_cutover_schema_matches_known_state; then
        echo "[migration] Commitment cutover schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$COMMITMENT_CUTOVER_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] Commitment cutover 留下未知 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_commitment_cutover_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$COMMITMENT_CUTOVER_MIGRATION"; then
    return 0
  fi
  commitment_schema_state=$(npx tsx scripts/postgres-commitment-schema-state.ts)
  case "$commitment_schema_state" in
    legacy|expanded_required) return 0 ;;
    expanded_nullable)
      echo "[migration] 检测到未登记但完整的 Commitment cutover，验证后接管。"
      npm run migrate:commitment-verify
      if ! commitment_cutover_schema_matches_known_state; then
        echo "[migration] 未登记 Commitment cutover 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$COMMITMENT_CUTOVER_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分 Commitment cutover schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_scope_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$SCOPE_MIGRATION"; then
    return 0
  fi
  scope_schema_state=$(npx tsx scripts/postgres-scope-schema-state.ts)
  case "$scope_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的数据范围策略事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$SCOPE_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的数据范围策略事务，校验后接管。"
      if ! scope_schema_matches_known_state; then
        echo "[migration] 数据范围策略 schema 已扩展但与批准模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$SCOPE_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 数据范围策略 migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_scope_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$SCOPE_MIGRATION"; then
    return 0
  fi
  scope_schema_state=$(npx tsx scripts/postgres-scope-schema-state.ts)
  case "$scope_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的数据范围策略 schema，校验后接管。"
      if ! scope_schema_matches_known_state; then
        echo "[migration] 未登记数据范围策略 schema 与批准模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$SCOPE_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分数据范围策略 schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_methodology_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$METHODOLOGY_MIGRATION"; then
    return 0
  fi
  methodology_schema_state=$(npx tsx scripts/postgres-methodology-schema-state.ts)
  case "$methodology_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的方法论基础事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$METHODOLOGY_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的方法论基础事务，验证后接管。"
      npm run migrate:methodology-verify
      if ! methodology_schema_matches_known_state; then
        echo "[migration] 方法论基础 schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$METHODOLOGY_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 方法论基础 migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_methodology_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$METHODOLOGY_MIGRATION"; then
    return 0
  fi
  methodology_schema_state=$(npx tsx scripts/postgres-methodology-schema-state.ts)
  case "$methodology_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的方法论基础 schema，验证后接管。"
      npm run migrate:methodology-verify
      if ! methodology_schema_matches_known_state; then
        echo "[migration] 未登记方法论基础 schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$METHODOLOGY_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分方法论基础 schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_methodology_data_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$METHODOLOGY_DATA_MIGRATION"; then
    return 0
  fi
  methodology_data_schema_state=$(npx tsx scripts/postgres-methodology-data-schema-state.ts)
  case "$methodology_data_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的方法论数据事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$METHODOLOGY_DATA_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的方法论数据事务，验证后接管。"
      npm run migrate:methodology-data-verify
      if ! methodology_data_schema_matches_known_state; then
        echo "[migration] 方法论数据 schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$METHODOLOGY_DATA_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 方法论数据 migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_methodology_data_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$METHODOLOGY_DATA_MIGRATION"; then
    return 0
  fi
  methodology_data_schema_state=$(npx tsx scripts/postgres-methodology-data-schema-state.ts)
  case "$methodology_data_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的方法论数据 schema，验证后接管。"
      npm run migrate:methodology-data-verify
      if ! methodology_data_schema_matches_known_state; then
        echo "[migration] 未登记方法论数据 schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$METHODOLOGY_DATA_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分方法论数据 schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_pde_context_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$PDE_CONTEXT_MIGRATION"; then
    return 0
  fi
  pde_context_schema_state=$(npx tsx scripts/postgres-pde-context-schema-state.ts)
  case "$pde_context_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的 PDE 决策上下文事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$PDE_CONTEXT_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的 PDE 决策上下文事务，验证后接管。"
      npm run migrate:pde-context-verify
      if ! pde_context_schema_matches_known_state; then
        echo "[migration] PDE 决策上下文 schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$PDE_CONTEXT_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] PDE 决策上下文 migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_pde_context_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$PDE_CONTEXT_MIGRATION"; then
    return 0
  fi
  pde_context_schema_state=$(npx tsx scripts/postgres-pde-context-schema-state.ts)
  case "$pde_context_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的 PDE 决策上下文 schema，验证后接管。"
      npm run migrate:pde-context-verify
      if ! pde_context_schema_matches_known_state; then
        echo "[migration] 未登记 PDE 决策上下文 schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$PDE_CONTEXT_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分 PDE 决策上下文 schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_customer_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$CUSTOMER_MIGRATION"; then
    return 0
  fi
  customer_schema_state=$(npx tsx scripts/postgres-customer-schema-state.ts)
  case "$customer_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的 Customer 事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$CUSTOMER_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的 Customer 事务，校验后接管。"
      if ! customer_schema_matches_known_state; then
        echo "[migration] Customer schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$CUSTOMER_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] Customer migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_customer_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$CUSTOMER_MIGRATION"; then
    return 0
  fi
  customer_schema_state=$(npx tsx scripts/postgres-customer-schema-state.ts)
  case "$customer_schema_state" in
    legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的 Customer schema，校验后接管。"
      if ! customer_schema_matches_known_state; then
        echo "[migration] 未登记 Customer schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$CUSTOMER_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分 Customer schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

recover_incomplete_candidate_migration() {
  incomplete_migrations=$(npx tsx scripts/list-incomplete-postgres-migrations.ts)
  if ! printf '%s\n' "$incomplete_migrations" | grep -Fxq "$CANDIDATE_MIGRATION"; then
    return 0
  fi
  candidate_schema_state=$(npx tsx scripts/postgres-candidate-schema-state.ts)
  case "$candidate_schema_state" in
    legacy)
      echo "[migration] 检测到中断且已由 PostgreSQL 回滚的 Candidate 事务，登记后安全重放。"
      npx prisma migrate resolve --rolled-back "$CANDIDATE_MIGRATION" --schema "$SCHEMA"
      ;;
    expanded)
      echo "[migration] 检测到已提交但未完成登记的 Candidate 事务，只读校验后接管。"
      npm run migrate:candidate-report
      if ! candidate_schema_matches_known_state; then
        echo "[migration] Candidate schema 已扩展但与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$CANDIDATE_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] Candidate migration 留下部分 schema，必须从认证备份恢复后再试。" >&2
      exit 1
      ;;
  esac
}

adopt_existing_candidate_schema_if_safe() {
  refresh_applied_migrations
  if migration_is_applied "$CANDIDATE_MIGRATION"; then
    return 0
  fi
  candidate_schema_state=$(npx tsx scripts/postgres-candidate-schema-state.ts)
  case "$candidate_schema_state" in
    uninitialized|legacy) return 0 ;;
    expanded)
      echo "[migration] 检测到未登记但完整的 Candidate schema，只读校验后接管。"
      npm run migrate:candidate-report
      if ! candidate_schema_matches_known_state; then
        echo "[migration] 未登记 Candidate schema 与当前模型不一致，拒绝接管：" >&2
        cat /tmp/postgres-schema-drift.log >&2
        exit 1
      fi
      npx prisma migrate resolve --applied "$CANDIDATE_MIGRATION" --schema "$SCHEMA"
      ;;
    *)
      echo "[migration] 检测到未登记的部分 Candidate schema，拒绝继续。" >&2
      exit 1
      ;;
  esac
}

state=$(wait_for_migration_state)
case "$state" in
  untracked)
    if schema_matches "$SCHEMA"; then
      echo "[migration] 检测到与当前模型一致的未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_CANDIDATE_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-115 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_CUSTOMER_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-113 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_PDE_CONTEXT_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-112 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-110 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_METHODOLOGY_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-109 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_SCOPE_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-108 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_COMMITMENT_CUTOVER_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-107 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_COMMITMENT_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-105 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$PRE_PARTICIPANT_SCHEMA"; then
      echo "[migration] 检测到已批准的 CORE-104 未纳管 schema。"
      npx tsx scripts/assert-untracked-command-runs-empty.ts
    elif schema_matches "$LEGACY_SCHEMA"; then
      echo "[migration] 检测到已批准的 2026-07-12 公司旧 schema。"
    else
      echo "[migration] 未纳管 schema 不匹配当前模型或批准的旧模型，拒绝接管：" >&2
      cat /tmp/postgres-schema-drift.log >&2
      exit 1
    fi
    resolve_missing_pre_bridge_migrations
    ;;
  tracked)
    # A kill between individual `migrate resolve` calls leaves migration history
    # present while the business schema is still exactly legacy/current. Resume
    # only that recognized adoption state; arbitrary tracked drift stays managed
    # by normal Prisma failure semantics.
    refresh_applied_migrations
    if ! migration_is_applied "$BRIDGE_MIGRATION"; then
      if schema_matches "$LEGACY_SCHEMA"; then
        echo "[migration] 继续中断的旧 schema 接管。"
        rollback_incomplete_bridge
        resolve_missing_pre_bridge_migrations
      elif schema_matches "$SCHEMA"; then
        rollback_incomplete_bridge
        if ! migration_is_applied 20260715010000_hash_command_run_idempotency_keys; then
          npx tsx scripts/assert-untracked-command-runs-empty.ts
        fi
        echo "[migration] 继续中断的当前 schema 接管。"
        resolve_missing_pre_bridge_migrations
      elif schema_matches "$PRE_CANDIDATE_SCHEMA" || schema_matches "$PRE_CUSTOMER_SCHEMA" \
        || schema_matches "$PRE_PDE_CONTEXT_SCHEMA" \
        || schema_matches "$PRE_METHODOLOGY_DATA_SCHEMA" \
        || schema_matches "$PRE_METHODOLOGY_SCHEMA" \
        || schema_matches "$PRE_SCOPE_SCHEMA" \
        || schema_matches "$PRE_COMMITMENT_CUTOVER_SCHEMA" \
        || schema_matches "$PRE_COMMITMENT_SCHEMA" || schema_matches "$PRE_PARTICIPANT_SCHEMA"; then
        rollback_incomplete_bridge
        if ! migration_is_applied 20260715010000_hash_command_run_idempotency_keys; then
          npx tsx scripts/assert-untracked-command-runs-empty.ts
        fi
        echo "[migration] 继续中断的已批准扩展 schema 接管。"
        resolve_missing_pre_bridge_migrations
      fi
    fi
    ;;
  empty) ;;
  *) echo "[migration] 无法识别迁移状态：$state" >&2; exit 1 ;;
esac

recover_incomplete_matter_migration
adopt_existing_matter_schema_if_safe
recover_incomplete_participant_migration
adopt_existing_participant_schema_if_safe
recover_incomplete_commitment_migration
adopt_existing_commitment_schema_if_safe
recover_incomplete_commitment_cutover_migration
adopt_existing_commitment_cutover_schema_if_safe
recover_incomplete_scope_migration
adopt_existing_scope_schema_if_safe
recover_incomplete_methodology_migration
adopt_existing_methodology_schema_if_safe
recover_incomplete_methodology_data_migration
adopt_existing_methodology_data_schema_if_safe
recover_incomplete_pde_context_migration
adopt_existing_pde_context_schema_if_safe
recover_incomplete_customer_migration
adopt_existing_customer_schema_if_safe
recover_incomplete_candidate_migration
adopt_existing_candidate_schema_if_safe
refresh_applied_migrations
matter_migration_pending=0
if ! migration_is_applied "$MATTER_MIGRATION"; then
  matter_migration_pending=1
  echo "[migration] 在 Matter 扩展前执行只读状态映射预演…"
  npm run migrate:matter-report
fi

participant_migration_pending=0
if ! migration_is_applied "$PARTICIPANT_MIGRATION"; then
  participant_migration_pending=1
  echo "[migration] 在参与关系扩展前执行只读父树与去重预演…"
  npm run migrate:matter-participant-report
fi

commitment_migration_pending=0
if ! migration_is_applied "$COMMITMENT_MIGRATION"; then
  commitment_migration_pending=1
  echo "[migration] 在 Commitment 扩展前执行只读父树、日期与负责人预演…"
  npm run migrate:commitment-report
fi

commitment_cutover_migration_pending=0
if ! migration_is_applied "$COMMITMENT_CUTOVER_MIGRATION"; then
  commitment_cutover_migration_pending=1
  echo "[migration] CORE-108 将在事务内校验通用 Commitment 后放宽客户级空 Matter…"
fi

methodology_migration_pending=0
if ! migration_is_applied "$METHODOLOGY_MIGRATION"; then
  methodology_migration_pending=1
  if [ "$matter_migration_pending" -eq 0 ]; then
    echo "[migration] 在方法论基础扩展前拒绝未纳管 active binding 指针…"
    npm run migrate:methodology-report
  else
    echo "[migration] 旧库尚无 active binding 指针列；Matter 扩展后由方法论迁移事务内预检。"
  fi
fi

methodology_data_migration_pending=0
if ! migration_is_applied "$METHODOLOGY_DATA_MIGRATION"; then
  methodology_data_migration_pending=1
  if [ "$methodology_migration_pending" -eq 0 ]; then
    echo "[migration] 在方法论数据扩展前校验基础父树与 active binding 指针…"
    npm run migrate:methodology-data-report
  else
    echo "[migration] 旧库尚无方法论基础表；基础扩展后由方法论数据迁移继续执行。"
  fi
fi

pde_context_migration_pending=0
if ! migration_is_applied "$PDE_CONTEXT_MIGRATION"; then
  pde_context_migration_pending=1
  echo "[migration] 在 PDE 决策上下文扩展前执行 legacy 阶段影子映射预演…"
  npm run migrate:pde-context-report
fi

candidate_migration_pending=0
if ! migration_is_applied "$CANDIDATE_MIGRATION"; then
  candidate_migration_pending=1
  echo "[migration] 在 Candidate 基座扩展前执行五来源逐租户只读预演与完整性校验…"
  npm run migrate:candidate-report
fi

echo "[migration] 在唯一索引迁移前执行同步锚与企微绑定冲突扫描…"
npm run migrate:sync-anchor-report
npm run migrate:wecom-bind-report

echo "[migration] 冲突扫描通过，部署版本化迁移…"
npx prisma migrate deploy --schema "$SCHEMA"

if [ "$matter_migration_pending" -eq 1 ]; then
  echo "[migration] 校验 Matter 生命周期影子列与 legacy status 一致…"
  npm run migrate:matter-verify
fi

if [ "$participant_migration_pending" -eq 1 ]; then
  echo "[migration] 校验 MatterParticipant 回填与迁移时 legacy 候选一致…"
  npm run migrate:matter-participant-verify
fi

if [ "$commitment_migration_pending" -eq 1 ] || [ "$commitment_cutover_migration_pending" -eq 1 ]; then
  echo "[migration] 校验 Commitment 当前权威、父树与 nullable cutover 状态一致…"
  npm run migrate:commitment-verify
fi

if [ "$methodology_migration_pending" -eq 1 ]; then
  echo "[migration] 校验方法论租户父树、active pointer、版本与试点基线…"
  npm run migrate:methodology-verify
fi

if [ "$methodology_data_migration_pending" -eq 1 ]; then
  echo "[migration] 校验方法论定义、实例目标、评估快照与迁移记录…"
  npm run migrate:methodology-data-verify
fi

if [ "$pde_context_migration_pending" -eq 1 ]; then
  echo "[migration] 校验 PDE 决策上下文租户父树、profile 与影子迁移完整性…"
  npm run migrate:pde-context-verify
fi

echo "[migration] 以单事务幂等回填五来源 Candidate，并在最后写入 CORE-203 marker…"
npm run migrate:candidate-apply
echo "[migration] 双向校验 Candidate 权威与五张只读兼容投影…"
npm run migrate:candidate-verify

if ! schema_matches "$SCHEMA"; then
  echo "[migration] 迁移后 schema 与当前模型仍不一致，拒绝启动：" >&2
  cat /tmp/postgres-schema-drift.log >&2
  exit 1
fi

echo "[migration] 版本化迁移与冲突扫描通过。"
