#!/bin/bash
# Forced command for the dedicated Stephen GitHub Actions SSH key.
set -Eeuo pipefail
umask 077
PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
unset PYTHONPATH PYTHONHOME

PRODUCTION_ROOT='/srv/jianghu/stephen'
MAX_INCOMING_BYTES=$((100 * 1024 * 1024))
release_root=$PRODUCTION_ROOT
test_mode=0
upload_tmp=''
test_lock=''

fail() {
  printf 'SAAS607_SSH_ERROR=%s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "$upload_tmp" && -f "$upload_tmp" ]]; then
    rm -f -- "$upload_tmp"
  fi
  if [[ -n "$test_lock" && -d "$test_lock" ]]; then
    rmdir -- "$test_lock" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${1:-}" == '--test-root' ]]; then
  [[ "${SAAS607_DISPATCHER_TEST_MODE:-}" == '1' ]] \
    || fail 'test mode requires SAAS607_DISPATCHER_TEST_MODE=1'
  [[ ${EUID:-$(id -u)} -ne 0 ]] || fail 'test mode is forbidden for root'
  [[ $# -eq 2 ]] || fail 'test root is required'
  release_root=$2
  case "$release_root" in
    /tmp/*|/private/tmp/*|/var/folders/*) ;;
    *) fail 'test root must be under an operating-system temporary directory' ;;
  esac
  [[ "$release_root" != *'/../'* && "$release_root" != */.. \
    && "$release_root" != *'/./'* && "$release_root" != */. ]] \
    || fail 'test root is unsafe'
  test_mode=1
else
  [[ $# -eq 0 ]] || fail 'arguments are not accepted outside test mode'
  [[ ${EUID:-$(id -u)} -ne 0 ]] || fail 'SSH dispatcher must run as the deploy user'
  dispatcher_path=$(readlink -f -- "${BASH_SOURCE[0]}")
  [[ $(stat -c '%u' "$dispatcher_path") == '0' ]] \
    || fail 'SSH dispatcher must be owned by root'
  dispatcher_mode=$(stat -c '%a' "$dispatcher_path")
  (( (8#$dispatcher_mode & 022) == 0 )) \
    || fail 'SSH dispatcher must not be group or world writable'
fi

ensure_incoming() {
  if [[ $test_mode -eq 1 ]]; then
    mkdir -p -- "$release_root/incoming"
  fi
  [[ -d "$release_root" && ! -L "$release_root" \
    && -d "$release_root/incoming" && ! -L "$release_root/incoming" ]] \
    || fail 'incoming root is missing or unsafe'
}

cleanup_stale_incoming() {
  python3 -I - "$release_root/incoming" <<'PY' \
    || fail 'incoming retention cleanup failed'
import os
import re
import stat
import sys
import time

root = sys.argv[1]
now = time.time()
for entry in os.scandir(root):
    value = entry.stat(follow_symlinks=False)
    if not stat.S_ISREG(value.st_mode):
        continue
    archive = re.fullmatch(r'[0-9a-f]{40}\.tar\.gz', entry.name)
    temporary = re.fullmatch(r'\.upload-[0-9a-f]{40}-[0-9]+', entry.name)
    maximum_age = 24 * 60 * 60 if archive else 60 * 60 if temporary else None
    if maximum_age is not None and now - value.st_mtime > maximum_age:
        os.unlink(entry.path)
PY
}

incoming_bytes() {
  python3 -I - "$release_root/incoming" <<'PY' \
    || fail 'incoming quota could not be measured'
import os
import stat
import sys

total = 0
for entry in os.scandir(sys.argv[1]):
    value = entry.stat(follow_symlinks=False)
    if stat.S_ISREG(value.st_mode):
        total += value.st_size
print(total)
PY
}

receive_upload() {
  local source_sha=$1
  ensure_incoming
  if [[ $test_mode -eq 1 ]]; then
    test_lock="$release_root/incoming/.upload-test-lock"
    mkdir -- "$test_lock" 2>/dev/null || fail 'another upload is active'
  else
    exec 9>"$release_root/incoming/.upload.lock"
    flock -x 9
  fi
  cleanup_stale_incoming
  local occupied_bytes
  occupied_bytes=$(incoming_bytes)
  local available_bytes=$((MAX_INCOMING_BYTES - occupied_bytes))
  (( available_bytes > 0 )) \
    || fail 'incoming upload quota has no remaining capacity'
  local maximum_upload_bytes=$((50 * 1024 * 1024))
  if (( available_bytes < maximum_upload_bytes )); then
    maximum_upload_bytes=$available_bytes
  fi
  upload_tmp="$release_root/incoming/.upload-$source_sha-$$"
  [[ ! -e "$upload_tmp" && ! -L "$upload_tmp" ]] \
    || fail 'temporary upload path already exists'

  local python_code
  read -r -d '' python_code <<'PY' || true
import os
import sys

MAX_ARCHIVE_BYTES = min(50 * 1024 * 1024, int(sys.argv[2]))
destination = sys.argv[1]
descriptor = os.open(
    destination,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o600,
)
written = 0
try:
    while True:
        chunk = sys.stdin.buffer.read(1024 * 1024)
        if not chunk:
            break
        written += len(chunk)
        if written > MAX_ARCHIVE_BYTES:
            raise OSError('upload exceeds the 50 MiB limit')
        view = memoryview(chunk)
        while view:
            count = os.write(descriptor, view)
            view = view[count:]
    if written <= 0:
        raise OSError('upload is empty')
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  python3 -I -c "$python_code" "$upload_tmp" "$maximum_upload_bytes" \
    || fail 'upload is empty, unsafe, or exceeds its bounded incoming quota'

  local target="$release_root/incoming/$source_sha.tar.gz"
  mv -f -- "$upload_tmp" "$target"
  upload_tmp=''
  printf 'upload_status=stored\nsource_sha=%s\n' "$source_sha"
}

dispatch_helper() {
  if [[ $test_mode -eq 1 ]]; then
    printf 'test_helper_command=%s\n' "$1"
    return 0
  fi
  exec /usr/bin/sudo -n /usr/local/sbin/stephen-release-helper "$@"
}

original_command=${SSH_ORIGINAL_COMMAND:-}
if [[ "$original_command" =~ ^stephen-upload\ ([0-9a-f]{40})$ ]]; then
  receive_upload "${BASH_REMATCH[1]}"
elif [[ "$original_command" == 'stephen-helper status' ]]; then
  dispatch_helper status
elif [[ "$original_command" =~ ^stephen-helper\ stage\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  dispatch_helper stage "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
elif [[ "$original_command" =~ ^stephen-helper\ activate\ ([0-9a-f]{40})\ ([0-9a-f]{32})$ ]]; then
  dispatch_helper activate "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
elif [[ "$original_command" =~ ^stephen-helper\ finalize\ ([0-9a-f]{40})\ ([0-9a-f]{32})$ ]]; then
  dispatch_helper finalize "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
elif [[ "$original_command" =~ ^stephen-helper\ rollback\ ([0-9a-f]{40})\ ([0-9a-f]{32})$ ]]; then
  dispatch_helper rollback "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
else
  fail 'SSH command is not allowed'
fi
