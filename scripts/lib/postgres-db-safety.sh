#!/usr/bin/env bash

# The caller defines postgres_query_database_presence DATABASE. It must print
# exactly "1" for present, nothing for absent, and return nonzero on query error.
postgres_database_exists() {
  local database=$1 raw status
  if raw=$(postgres_query_database_presence "$database"); then status=0; else status=$?; fi
  if [[ $status -ne 0 ]]; then
    echo "database presence query failed: $database" >&2
    return 2
  fi
  raw=$(printf '%s' "$raw" | tr -d '[:space:]')
  case "$raw" in
    1) return 0 ;;
    '') return 1 ;;
    *) echo "database presence query returned an unexpected result: $database" >&2; return 2 ;;
  esac
}

postgres_assert_database_absent() {
  local database=$1 status
  if postgres_database_exists "$database"; then status=0; else status=$?; fi
  case "$status" in
    1) return 0 ;;
    0) echo "database still exists: $database" >&2; return 1 ;;
    *) return 2 ;;
  esac
}

postgres_require_verified_cleanup() {
  local cleanup_function=$1
  shift
  if "$cleanup_function" "$@"; then return 0; fi
  echo "CRITICAL: database cleanup could not be verified" >&2
  return 70
}

postgres_restore_readiness_sql() {
  case "${1-}" in
    current)
      printf '%s' "SELECT (to_regclass('public.\"Tenant\"') IS NOT NULL AND to_regclass('public.\"CommandRun\"') IS NOT NULL AND to_regclass('public.\"EvidenceEvent\"') IS NOT NULL AND to_regclass('public._prisma_migrations') IS NOT NULL)::int"
      ;;
    pre-int501)
      # These three tables have existed since the initial schema. Later tables
      # such as SyncRun cannot identify an arbitrary pre-migration deployment.
      printf '%s' "SELECT (to_regclass('public.\"Tenant\"') IS NOT NULL AND to_regclass('public.\"User\"') IS NOT NULL AND to_regclass('public.\"Account\"') IS NOT NULL)::int"
      ;;
    *)
      echo "unsupported restore readiness profile: ${1-}" >&2
      return 1
      ;;
  esac
}

postgres_public_schema_signature_sql() {
  # This is an integrity fingerprint, not a password hash. The authenticated
  # backup protects against tampering; this comparison proves that the isolated
  # restore recreated the same set of public tables as the live legacy source.
  printf '%s' "SELECT md5(string_agg(tablename, E'\\n' ORDER BY tablename)) FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
}

postgres_validate_restore_readiness_scope() {
  local profile=$1 database=$2
  case "$profile" in
    current) return 0 ;;
    pre-int501)
      [[ "$database" =~ ^jianghu_restore_bootstrap_[A-Za-z0-9_]+$ ]] || {
        echo "pre-int501 readiness is restricted to bootstrap restore databases" >&2
        return 1
      }
      ;;
    *)
      echo "unsupported restore readiness profile: $profile" >&2
      return 1
      ;;
  esac
}
