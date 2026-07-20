#!/usr/bin/env bash

deployment_env_value() {
  local env_file=$1 key=$2 line
  line=$(grep -E "^${key}=" "$env_file" 2>/dev/null | tail -n 1 || true)
  printf '%s' "${line#*=}"
}

deployment_ensure_env_default() {
  local env_file=$1 key=$2 value=$3
  if ! grep -q "^${key}=" "$env_file" 2>/dev/null \
      || { [[ -n "$value" ]] && [[ -z "$(deployment_env_value "$env_file" "$key")" ]]; }; then
    printf '\n%s=%s\n' "$key" "$value" >> "$env_file"
    echo "added $key to $env_file"
  fi
}

deployment_require_env_value() {
  local env_file=$1 key=$2
  [[ -n "$(deployment_env_value "$env_file" "$key")" ]] || {
    echo "$env_file 缺少 ${key}；请先按公司部署文档完成版本环境变量迁移，禁止部署。" >&2
    return 1
  }
}

wait_for_http_readiness() {
  local url=$1 attempts=${2:-40} i
  for i in $(seq 1 "$attempts"); do
    if curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${READINESS_RETRY_DELAY:-2}"
  done
  echo "readiness check failed after ${attempts} attempts: $url" >&2
  return 1
}

compose_project_name() {
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return
  fi
  local config project
  config=$(docker compose config 2>/dev/null) || { echo "docker compose config failed" >&2; return 2; }
  project=$(printf '%s\n' "$config" | awk '$1 == "name:" { print $2; exit }')
  [[ -n "$project" ]] || { echo "docker compose config returned no project name" >&2; return 2; }
  printf '%s' "$project"
}

deployment_has_existing_db() {
  local containers project volumes status
  containers=$(docker compose ps -a -q db 2>/dev/null) || { echo "could not inspect Compose db service" >&2; return 2; }
  [[ -n "$containers" ]] && return 0
  if project=$(compose_project_name); then status=0; else status=$?; fi
  [[ $status -eq 0 ]] || return 2
  volumes=$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.volume=pgdata') || { echo "could not inspect Compose database volumes" >&2; return 2; }
  [[ -n "$volumes" ]] && return 0
  return 1
}

resolve_deployment_db_state() {
  local status
  if deployment_has_existing_db; then
    DEPLOYMENT_HAS_EXISTING_DB=1
    return 0
  else
    status=$?
  fi
  case "$status" in
    1) DEPLOYMENT_HAS_EXISTING_DB=0; return 0 ;;
    *) DEPLOYMENT_HAS_EXISTING_DB=''; return 2 ;;
  esac
}
