#!/usr/bin/env bash

backup_process_start_identity() {
  local pid=$1 started
  started=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  [[ -n "$started" ]] || return 1
  printf '%s' "$started" | openssl dgst -sha256 -r | awk '{print $1}'
}

backup_owner_record_active() {
  local owner_file=$1 pid start nonce expected_nonce current_start
  [[ -f "$owner_file" ]] || return 1
  pid=$(sed -n '1s/^pid=//p' "$owner_file" 2>/dev/null || true)
  start=$(sed -n '2s/^start=//p' "$owner_file" 2>/dev/null || true)
  nonce=$(sed -n '3s/^nonce=//p' "$owner_file" 2>/dev/null || true)
  expected_nonce=${owner_file##*/owner.}
  [[ "$pid" =~ ^[0-9]+$ && "$start" =~ ^[0-9a-f]{64}$ && "$nonce" == "$expected_nonce" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  current_start=$(backup_process_start_identity "$pid") || return 1
  [[ "$current_start" == "$start" ]]
}

backup_lock_owner_file() {
  find "$1" -maxdepth 1 -type f -name 'owner.*' -print 2>/dev/null | head -n 1
}

backup_acquire_operation_guard() {
  local attempt
  BACKUP_GUARD_NONCE=$(openssl rand -hex 16)
  BACKUP_GUARD_RECORD="pid=$$\nstart=$(backup_process_start_identity $$)\nnonce=$BACKUP_GUARD_NONCE"
  for attempt in $(seq 1 "${BACKUP_LOCK_WAIT_ATTEMPTS:-120}"); do
    if mkdir "$BACKUP_LOCK_GUARD" 2>/dev/null; then
      printf '%b\n' "$BACKUP_GUARD_RECORD" > "$BACKUP_LOCK_GUARD/owner.$BACKUP_GUARD_NONCE"
      return 0
    fi
    # Never reap the operation guard automatically. It serializes stale-main-lock
    # recovery, so moving it could let two reapers race and quarantine a successor.
    sleep "${BACKUP_LOCK_RETRY_DELAY:-0.25}"
  done
  return 1
}

backup_release_operation_guard() {
  local owner="$BACKUP_LOCK_GUARD/owner.${BACKUP_GUARD_NONCE:-missing}"
  if [[ -f "$owner" && "$(cat "$owner")" == "$(printf '%b' "${BACKUP_GUARD_RECORD:-}")" ]]; then
    rm -f "$owner"
    rmdir "$BACKUP_LOCK_GUARD" 2>/dev/null || true
  fi
}

init_backup_lock() {
  local root=$1
  BACKUP_LOCK_DIR="$root/.backup.lock"
  BACKUP_LOCK_GUARD="$root/.backup.lock.guard"
  BACKUP_LOCK_NONCE=''
  BACKUP_LOCK_RECORD=''
}

acquire_backup_lock() {
  local attempt owner quarantine
  BACKUP_LOCK_NONCE=$(openssl rand -hex 16)
  BACKUP_LOCK_RECORD="pid=$$\nstart=$(backup_process_start_identity $$)\nnonce=$BACKUP_LOCK_NONCE"
  for attempt in $(seq 1 "${BACKUP_LOCK_WAIT_ATTEMPTS:-120}"); do
    backup_acquire_operation_guard || { sleep "${BACKUP_LOCK_RETRY_DELAY:-0.25}"; continue; }
    if mkdir "$BACKUP_LOCK_DIR" 2>/dev/null; then
      printf '%b\n' "$BACKUP_LOCK_RECORD" > "$BACKUP_LOCK_DIR/owner.$BACKUP_LOCK_NONCE"
      backup_release_operation_guard
      return 0
    fi
    owner=$(backup_lock_owner_file "$BACKUP_LOCK_DIR")
    if [[ -n "$owner" ]] && ! backup_owner_record_active "$owner"; then
      quarantine="$(dirname "$BACKUP_LOCK_DIR")/.backup.lock.stale.$(openssl rand -hex 8)"
      if mv "$BACKUP_LOCK_DIR" "$quarantine" 2>/dev/null; then rm -rf "$quarantine"; fi
    fi
    backup_release_operation_guard
    sleep "${BACKUP_LOCK_RETRY_DELAY:-0.25}"
  done
  echo "another backup holds the publication lock" >&2
  return 1
}

release_backup_lock() {
  local nonce=${1:-$BACKUP_LOCK_NONCE} record=${2:-$BACKUP_LOCK_RECORD} owner
  [[ -n "$nonce" ]] || return 0
  backup_acquire_operation_guard || { echo "could not acquire lock guard for cleanup" >&2; return 1; }
  owner="$BACKUP_LOCK_DIR/owner.$nonce"
  if [[ -f "$owner" && "$(cat "$owner")" == "$(printf '%b' "$record")" ]]; then
    rm -f "$owner"
    rmdir "$BACKUP_LOCK_DIR" 2>/dev/null || true
  fi
  backup_release_operation_guard
}
