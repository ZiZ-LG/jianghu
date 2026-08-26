#!/bin/bash
# SAAS-607 root-owned server helper. Production installation path:
# /usr/local/sbin/stephen-release-helper
set -Eeuo pipefail
umask 022
PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
unset TAR_OPTIONS GZIP BZIP2 BZIP XZ_OPT PYTHONPATH PYTHONHOME

PRODUCTION_ROOT='/srv/jianghu/stephen'
EDGE_CONTAINER='zizai-site'
CONTAINER_ROOT='/srv/stephen/current'
test_mode=0
release_root=$PRODUCTION_ROOT
stage_tmp=''
archive_tmp=''
test_lock=''
production_lock_probe=''
activation_cleanup_pending=0
activation_restore_current=''
activation_restore_previous=''
activation_source_sha=''
activation_lease_id=''

fail() {
  printf 'SAAS607_REMOTE_ERROR=%s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ $activation_cleanup_pending -eq 1 ]]; then
    activation_cleanup_pending=0
    best_effort_restore_activation
  fi
  if [[ -n "$stage_tmp" && -d "$stage_tmp" ]]; then
    rm -rf -- "$stage_tmp"
  fi
  if [[ -n "$archive_tmp" && -f "$archive_tmp" ]]; then
    rm -f -- "$archive_tmp"
  fi
  if [[ -n "$test_lock" && -d "$test_lock" ]]; then
    rmdir -- "$test_lock" 2>/dev/null || true
  fi
  if [[ -n "$production_lock_probe" && -d "$production_lock_probe" ]]; then
    rmdir -- "$production_lock_probe" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${1:-}" == '--test-root' ]]; then
  [[ "${SAAS607_HELPER_TEST_MODE:-}" == '1' ]] \
    || fail 'test mode requires SAAS607_HELPER_TEST_MODE=1'
  [[ ${EUID:-$(id -u)} -ne 0 ]] || fail 'test mode is forbidden for root'
  [[ $# -ge 3 ]] || fail 'test root and command are required'
  release_root=$2
  case "$release_root" in
    /tmp/*|/private/tmp/*|/var/folders/*) ;;
    *) fail 'test root must be under an operating-system temporary directory' ;;
  esac
  [[ "$release_root" != *'/../'* && "$release_root" != */.. \
    && "$release_root" != *'/./'* && "$release_root" != */. ]] \
    || fail 'test root is unsafe'
  test_mode=1
  shift 2
else
  [[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'production helper must run as root'
  helper_path=$(readlink -f -- "${BASH_SOURCE[0]}")
  [[ $(stat -c '%u' "$helper_path") == '0' ]] \
    || fail 'production helper must be owned by root'
  helper_mode=$(stat -c '%a' "$helper_path")
  (( (8#$helper_mode & 022) == 0 )) \
    || fail 'production helper must not be group or world writable'
fi

command_name=${1:-}
[[ -n "$command_name" ]] || fail 'command is required'
shift

require_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail 'release SHA must be 40 lowercase hexadecimal characters'
}

require_checksum() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail 'archive checksum must be 64 lowercase hexadecimal characters'
}

require_lease() {
  [[ "$1" =~ ^[0-9a-f]{32}$ ]] \
    || fail 'activation lease must be 32 lowercase hexadecimal characters'
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

copy_incoming_archive() {
  local source=$1
  local destination=$2
  python3 -I - "$source" "$destination" <<'PY' \
    || fail 'incoming archive exceeds the 50 MiB safety limit or is unsafe'
import os
import stat
import sys

MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
source, destination = sys.argv[1:]
source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
destination_fd = -1
try:
    source_stat = os.fstat(source_fd)
    if (
        not stat.S_ISREG(source_stat.st_mode)
        or source_stat.st_size <= 0
        or source_stat.st_size > MAX_ARCHIVE_BYTES
    ):
        raise OSError('unsafe archive size or type')
    destination_fd = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    copied = 0
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        copied += len(chunk)
        if copied > MAX_ARCHIVE_BYTES:
            raise OSError('archive grew beyond the safety limit')
        view = memoryview(chunk)
        while view:
            written = os.write(destination_fd, view)
            view = view[written:]
    if copied <= 0:
        raise OSError('archive is empty')
    os.fsync(destination_fd)
finally:
    os.close(source_fd)
    if destination_fd >= 0:
        os.close(destination_fd)
PY
}

ensure_root() {
  if [[ $test_mode -eq 1 ]]; then
    mkdir -p -- "$release_root/incoming" "$release_root/releases"
  fi
  [[ -d "$release_root" && ! -L "$release_root" ]] \
    || fail 'release root must be a real directory'
  [[ -d "$release_root/incoming" && ! -L "$release_root/incoming" ]] \
    || fail 'incoming directory is missing or unsafe'
  [[ -d "$release_root/releases" && ! -L "$release_root/releases" ]] \
    || fail 'releases directory is missing or unsafe'
  if [[ $test_mode -eq 0 ]]; then
    [[ $(stat -c '%u' "$release_root") == '0' \
      && $(stat -c '%u' "$release_root/releases") == '0' ]] \
      || fail 'release root and releases directory must be owned by root'
    local root_mode
    local releases_mode
    root_mode=$(stat -c '%a' "$release_root")
    releases_mode=$(stat -c '%a' "$release_root/releases")
    (( (8#$root_mode & 022) == 0 && (8#$releases_mode & 022) == 0 )) \
      || fail 'release root and releases directory must not be group or world writable'
  fi
}

acquire_lock() {
  if [[ $test_mode -eq 1 ]]; then
    test_lock="$release_root/.release-test-lock"
    mkdir -- "$test_lock" 2>/dev/null || fail 'another release operation is active'
  else
    exec 9>"$release_root/.release.lock"
    flock -x -w 120 9 || fail 'release lock could not be acquired within 120 seconds'
  fi
}

exercise_production_lock_probe() {
  [[ -z "${SAAS607_PRODUCTION_LOCK_PROBE:-}" ]] && return 0
  [[ "${SAAS607_PRODUCTION_LOCK_PROBE:-}" == '1' \
    && "${GITHUB_ACTIONS:-}" == 'true' \
    && "${RUNNER_ENVIRONMENT:-}" == 'github-hosted' \
    && $test_mode -eq 0 ]] \
    || fail 'production lock probe is restricted to a GitHub-hosted runner'
  production_lock_probe="$release_root/.production-lock-probe-active"
  mkdir -- "$production_lock_probe" 2>/dev/null \
    || fail 'release lock did not serialize the production probe'
  /bin/sleep 2
  rmdir -- "$production_lock_probe"
  production_lock_probe=''
}

validate_metadata() {
  local metadata=$1
  local expected_sha=$2
  [[ -f "$metadata" && ! -L "$metadata" ]] || fail 'release metadata is missing or unsafe'
  python3 -I - "$metadata" "$expected_sha" <<'PY' \
    || fail 'release metadata does not match the requested SHA'
import json
import os
import re
import sys

MAX_METADATA_BYTES = 1024 * 1024
path, expected_sha = sys.argv[1:]
if not 0 < os.path.getsize(path) <= MAX_METADATA_BYTES:
    raise SystemExit(1)
with open(path, 'r', encoding='utf-8') as handle:
    value = json.load(handle)
valid = (
    value.get('schemaVersion') == 1
    and value.get('task') == 'SAAS-607'
    and value.get('sourceSha') == expected_sha
    and type(value.get('fileCount')) is int
    and 0 < value.get('fileCount') <= 1000
    and isinstance(value.get('files'), list)
    and len(value.get('files')) == value.get('fileCount')
    and re.fullmatch(r'[0-9a-f]{64}', value.get('contentChecksum', '')) is not None
)
raise SystemExit(0 if valid else 1)
PY
}

verify_release_files() {
  local release_dir=$1
  python3 -I - "$release_dir" <<'PY' \
    || fail 'release files do not match metadata'
import hashlib
import json
import os
import re
import sys

root = os.path.realpath(sys.argv[1])
metadata_path = os.path.join(root, '.stephen-release.json')
if not 0 < os.path.getsize(metadata_path) <= 1024 * 1024:
    raise SystemExit(1)
with open(metadata_path, 'r', encoding='utf-8') as handle:
    metadata = json.load(handle)

files = metadata.get('files')
if (
    not isinstance(files, list)
    or not 0 < len(files) <= 1000
    or metadata.get('fileCount') != len(files)
):
    raise SystemExit(1)
expected = {}
expected_bytes = 0
for item in files:
    path = item.get('path')
    size = item.get('size')
    digest = item.get('sha256')
    valid_path = (
        isinstance(path, str)
        and re.fullmatch(r'[A-Za-z0-9._/-]+', path) is not None
        and not path.startswith('/')
        and all(part not in ('', '.', '..') for part in path.split('/'))
        and len(path.split('/')) <= 16
    )
    if (
        not valid_path
        or type(size) is not int
        or size < 0
        or size > 8 * 1024 * 1024
        or re.fullmatch(r'[0-9a-f]{64}', digest or '') is None
        or path in expected
    ):
        raise SystemExit(1)
    expected[path] = (size, digest)
    expected_bytes += size
    if expected_bytes > 16 * 1024 * 1024:
        raise SystemExit(1)

actual = {}
for directory, directory_names, file_names in os.walk(root, followlinks=False):
    for name in directory_names:
        if os.path.islink(os.path.join(directory, name)):
            raise SystemExit(1)
    for name in file_names:
        absolute_path = os.path.join(directory, name)
        if os.path.islink(absolute_path):
            raise SystemExit(1)
        relative_path = os.path.relpath(absolute_path, root)
        if relative_path in ('.stephen-release.json', '.artifact.sha256'):
            continue
        if len(actual) >= 1000:
            raise SystemExit(1)
        file_stat = os.stat(absolute_path, follow_symlinks=False)
        if file_stat.st_size > 8 * 1024 * 1024:
            raise SystemExit(1)
        hasher = hashlib.sha256()
        size = 0
        with open(absolute_path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                size += len(chunk)
                hasher.update(chunk)
        actual[relative_path] = (size, hasher.hexdigest())

if actual != expected or len(actual) != metadata.get('fileCount'):
    raise SystemExit(1)
checksum_input = ''.join(
    f'{path}\0{size}\0{digest}\n'
    for path, (size, digest) in sorted(actual.items())
).encode('utf-8')
if hashlib.sha256(checksum_input).hexdigest() != metadata.get('contentChecksum'):
    raise SystemExit(1)
PY
}

validate_archive_members() {
  local archive=$1
  python3 -I - "$archive" <<'PY' \
    || fail 'archive members, paths, or declared size are unsafe'
import re
import sys
import tarfile

MAX_MEMBERS = 2000
MAX_FILES = 1001
MAX_METADATA_BYTES = 1024 * 1024
MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
archive_path = sys.argv[1]
paths = set()
member_count = 0
file_count = 0
artifact_bytes = 0
metadata_seen = False
try:
    with tarfile.open(archive_path, mode='r|gz') as handle:
        for member in handle:
            path = member.name
            if path in ('.', './'):
                continue
            while path.startswith('./'):
                path = path[2:]
            path = path.rstrip('/')
            member_count += 1
            if member_count > MAX_MEMBERS:
                raise SystemExit(1)
            valid_path = (
                path
                and not path.startswith('/')
                and '\\' not in path
                and re.fullmatch(r'[A-Za-z0-9._/-]+', path) is not None
                and all(part not in ('', '.', '..') for part in path.split('/'))
                and len(path.split('/')) <= 16
                and path not in paths
            )
            if not valid_path or not (member.isdir() or member.isfile()):
                raise SystemExit(1)
            paths.add(path)
            if member.isdir():
                if member.size != 0:
                    raise SystemExit(1)
                continue
            file_count += 1
            if file_count > MAX_FILES:
                raise SystemExit(1)
            if path == '.artifact.sha256':
                raise SystemExit(1)
            if path == '.stephen-release.json':
                if member.size <= 0 or member.size > MAX_METADATA_BYTES:
                    raise SystemExit(1)
                metadata_seen = True
                continue
            if member.size < 0 or member.size > MAX_ARTIFACT_FILE_BYTES:
                raise SystemExit(1)
            artifact_bytes += member.size
            if artifact_bytes > MAX_ARTIFACT_BYTES:
                raise SystemExit(1)
except (OSError, tarfile.TarError):
    raise SystemExit(1)

if not paths or not metadata_seen or file_count < 2:
    raise SystemExit(1)
PY
}

ensure_release_capacity() {
  python3 -I - "$release_root/releases" <<'PY' \
    || fail 'release store quota or free-space reserve would be exceeded'
import os
import stat
import sys

MAX_RELEASE_STORE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_EXPANDED_RELEASE_BYTES = 17 * 1024 * 1024
MIN_FREE_BYTES = 512 * 1024 * 1024
root = sys.argv[1]
stored_bytes = 0
for directory, directory_names, file_names in os.walk(root, followlinks=False):
    for name in directory_names:
        path = os.path.join(directory, name)
        if os.path.islink(path):
            raise SystemExit(1)
    for name in file_names:
        path = os.path.join(directory, name)
        value = os.stat(path, follow_symlinks=False)
        if not stat.S_ISREG(value.st_mode):
            raise SystemExit(1)
        stored_bytes += value.st_size
        if stored_bytes + MAX_ARCHIVE_BYTES + MAX_EXPANDED_RELEASE_BYTES > MAX_RELEASE_STORE_BYTES:
            raise SystemExit(1)
filesystem = os.statvfs(root)
available_bytes = filesystem.f_bavail * filesystem.f_frsize
if available_bytes < MIN_FREE_BYTES + MAX_ARCHIVE_BYTES + MAX_EXPANDED_RELEASE_BYTES:
    raise SystemExit(1)
PY
}

release_is_staged() {
  local source_sha=$1
  local release_dir="$release_root/releases/$source_sha"
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || return 1
  validate_metadata "$release_dir/.stephen-release.json" "$source_sha"
  verify_release_files "$release_dir"
  [[ -f "$release_dir/.artifact.sha256" && ! -L "$release_dir/.artifact.sha256" ]] \
    || fail 'staged release checksum marker is missing'
}

remove_incoming_if_present() {
  local incoming_archive=$1
  if [[ -L "$incoming_archive" ]]; then
    fail 'incoming archive must not be a symbolic link'
  elif [[ -f "$incoming_archive" ]]; then
    unlink -- "$incoming_archive"
  elif [[ -e "$incoming_archive" ]]; then
    fail 'incoming archive path is unsafe'
  fi
}

stage_release() {
  [[ $# -eq 2 ]] || fail 'stage requires SHA and checksum'
  local source_sha=$1
  local expected_checksum=$2
  require_sha "$source_sha"
  require_checksum "$expected_checksum"
  ensure_root
  acquire_lock
  exercise_production_lock_probe

  local incoming_archive="$release_root/incoming/$source_sha.tar.gz"
  local release_dir="$release_root/releases/$source_sha"
  if [[ -e "$release_dir" || -L "$release_dir" ]]; then
    release_is_staged "$source_sha"
    [[ $(tr -d '[:space:]' < "$release_dir/.artifact.sha256") == "$expected_checksum" ]] \
      || fail 'existing release has a different archive checksum'
    remove_incoming_if_present "$incoming_archive"
    printf 'stage_status=already_staged\nsource_sha=%s\n' "$source_sha"
    return 0
  fi
  [[ -f "$incoming_archive" && ! -L "$incoming_archive" ]] \
    || fail 'incoming archive is missing or unsafe'
  ensure_release_capacity
  archive_tmp="$release_root/releases/.archive-$source_sha-$$.tar.gz"
  [[ ! -e "$archive_tmp" && ! -L "$archive_tmp" ]] \
    || fail 'temporary archive path already exists'
  copy_incoming_archive "$incoming_archive" "$archive_tmp"
  if [[ $test_mode -eq 0 ]]; then
    [[ $(stat -c '%u' "$archive_tmp") == '0' ]] \
      || fail 'temporary archive must be owned by root'
  fi
  local archive=$archive_tmp
  local archive_size
  archive_size=$(wc -c < "$archive")
  (( archive_size > 0 && archive_size <= 52428800 )) \
    || fail 'incoming archive exceeds the 50 MiB safety limit'
  local actual_checksum
  actual_checksum=$(sha256_file "$archive")
  [[ "$actual_checksum" == "$expected_checksum" ]] \
    || fail 'archive checksum does not match'

  validate_archive_members "$archive"
  stage_tmp="$release_root/releases/.stage-$source_sha-$$"
  [[ ! -e "$stage_tmp" && ! -L "$stage_tmp" ]] || fail 'temporary stage path already exists'
  mkdir -m 0700 -- "$stage_tmp"
  tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage_tmp"
  if [[ $test_mode -eq 0 ]]; then
    chown -R root:root -- "$stage_tmp"
  fi
  if find "$stage_tmp" -type l -print -quit | grep -q .; then
    fail 'extracted release contains a symbolic link'
  fi
  local extracted_files
  local extracted_kib
  extracted_files=$(find "$stage_tmp" -type f | wc -l | tr -d '[:space:]')
  extracted_kib=$(du -sk "$stage_tmp" | awk '{print $1}')
  (( extracted_files > 1 && extracted_files <= 1001 )) \
    || fail 'extracted release has an unsafe file count'
  (( extracted_kib <= 17408 )) \
    || fail 'extracted release exceeds the 17 MiB safety limit'
  find "$stage_tmp" -type f -exec chmod 0644 {} +
  find "$stage_tmp" -type d -exec chmod 0755 {} +
  validate_metadata "$stage_tmp/.stephen-release.json" "$source_sha"
  verify_release_files "$stage_tmp"
  printf '%s\n' "$expected_checksum" > "$stage_tmp/.artifact.sha256"
  mv -- "$stage_tmp" "$release_dir"
  stage_tmp=''
  remove_incoming_if_present "$incoming_archive"
  printf 'stage_status=staged\nsource_sha=%s\narchive_checksum=%s\n' \
    "$source_sha" "$expected_checksum"
}

link_target_sha_unverified() {
  local name=$1
  local link_path="$release_root/$name"
  [[ -L "$link_path" ]] || fail "$name must be a symbolic link"
  local target
  target=$(readlink -- "$link_path")
  [[ "$target" =~ ^releases/([0-9a-f]{40})$ ]] \
    || fail "$name points outside the versioned release directory"
  printf '%s' "${BASH_REMATCH[1]}"
}

link_sha() {
  local name=$1
  local source_sha
  source_sha=$(link_target_sha_unverified "$name")
  release_is_staged "$source_sha"
  printf '%s' "$source_sha"
}

atomic_link() {
  local name=$1
  local source_sha=$2
  require_sha "$source_sha"
  local next="$release_root/.$name.next.$$"
  [[ ! -e "$next" && ! -L "$next" ]] || fail 'atomic link temporary path exists'
  ln -s -- "releases/$source_sha" "$next"
  python3 -I - "$next" "$release_root/$name" <<'PY' \
    || fail 'atomic link replacement failed'
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
}

remove_link_if_present() {
  local name=$1
  local link_path="$release_root/$name"
  if [[ -L "$link_path" ]]; then
    unlink -- "$link_path"
  elif [[ -e "$link_path" ]]; then
    fail "$name exists but is not a symbolic link"
  fi
}

runtime_identity_matches() {
  local expected_sha=$1
  curl -q --silent --show-error --fail --max-time 15 \
    --proto '=https' --max-redirs 0 \
    'https://stephen.lake2ocean.top/release-id.json' \
    | python3 -I -c '
import json
import sys

expected_sha = sys.argv[1]
value = json.load(sys.stdin)
valid = (
    value.get("schemaVersion") == 1
    and value.get("task") == "SAAS-607"
    and value.get("sourceSha") == expected_sha
)
raise SystemExit(0 if valid else 1)
' "$expected_sha"
}

runtime_ready() {
  local expected_sha=$1
  if [[ $test_mode -eq 1 ]]; then
    [[ -f "$release_root/test-control/runtime-ready" \
      && $(tr -d '[:space:]' < "$release_root/test-control/runtime-ready") == 'yes' ]]
    return
  fi
  /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
    /usr/bin/docker inspect "$EDGE_CONTAINER" >/dev/null 2>&1 \
    && /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
      /usr/bin/docker exec "$EDGE_CONTAINER" test -d "$CONTAINER_ROOT" \
    && runtime_identity_matches "$expected_sha"
}

nginx_check() {
  if [[ $test_mode -eq 1 ]]; then
    [[ -f "$release_root/test-control/nginx-check" \
      && $(tr -d '[:space:]' < "$release_root/test-control/nginx-check") == 'pass' ]]
    return
  fi
  /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
    /usr/bin/docker exec "$EDGE_CONTAINER" nginx -t
}

nginx_reload() {
  if [[ $test_mode -eq 1 ]]; then
    if [[ -f "$release_root/test-control/reload-fail" \
      && $(tr -d '[:space:]' < "$release_root/test-control/reload-fail") == 'yes' ]]; then
      return 1
    fi
    printf 'reload\n' >> "$release_root/test-control/reloads"
    return 0
  fi
  /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
    /usr/bin/docker exec "$EDGE_CONTAINER" nginx -s reload
}

restore_links() {
  local current_sha=$1
  local previous_sha=${2:-}
  atomic_link current "$current_sha"
  if [[ -n "$previous_sha" ]]; then
    atomic_link previous "$previous_sha"
  else
    remove_link_if_present previous
  fi
}

pending_path() {
  printf '%s/.activation-pending.json' "$release_root"
}

write_pending() {
  local source_sha=$1
  local lease_id=$2
  local current_sha=$3
  local previous_sha=${4:-}
  local marker
  marker=$(pending_path)
  [[ ! -e "$marker" && ! -L "$marker" ]] \
    || fail 'another activation is already pending'
  python3 -I - "$marker" "$source_sha" "$lease_id" "$current_sha" "$previous_sha" <<'PY' \
    || fail 'failed to persist the activation transaction'
import json
import os
import sys

marker, source_sha, lease_id, current_sha, previous_sha = sys.argv[1:]
temporary = f'{marker}.next.{os.getpid()}'
payload = {
    'schemaVersion': 1,
    'task': 'SAAS-607',
    'sourceSha': source_sha,
    'leaseId': lease_id,
    'restoreCurrentSha': current_sha,
    'restorePreviousSha': previous_sha or None,
}
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o600,
)
try:
    data = (json.dumps(payload, sort_keys=True) + '\n').encode('utf-8')
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, marker)
directory = os.open(os.path.dirname(marker), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

pending_snapshot() {
  local marker
  marker=$(pending_path)
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  python3 -I - "$marker" <<'PY' \
    || fail 'pending activation marker is invalid'
import json
import re
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    value = json.load(handle)
source_sha = value.get('sourceSha')
lease_id = value.get('leaseId')
current_sha = value.get('restoreCurrentSha')
previous_sha = value.get('restorePreviousSha')
valid = (
    value.get('schemaVersion') == 1
    and value.get('task') == 'SAAS-607'
    and re.fullmatch(r'[0-9a-f]{40}', source_sha or '') is not None
    and re.fullmatch(r'[0-9a-f]{32}', lease_id or '') is not None
    and re.fullmatch(r'[0-9a-f]{40}', current_sha or '') is not None
    and (
        previous_sha is None
        or re.fullmatch(r'[0-9a-f]{40}', previous_sha or '') is not None
    )
)
if not valid:
    raise SystemExit(1)
print(source_sha, lease_id, current_sha, previous_sha or 'none')
PY
}

remove_pending() {
  local marker
  marker=$(pending_path)
  if [[ -L "$marker" ]]; then
    fail 'pending activation marker must not be a symbolic link'
  fi
  if [[ -f "$marker" ]]; then
    unlink -- "$marker"
  elif [[ -e "$marker" ]]; then
    fail 'pending activation marker is unsafe'
  fi
}

schedule_expiry() {
  local source_sha=$1
  local lease_id=$2
  if [[ $test_mode -eq 1 ]]; then
    printf '%s %s\n' "$source_sha" "$lease_id" \
      > "$release_root/test-control/scheduled-expiry"
    return 0
  fi
  /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
    /usr/bin/systemd-run --quiet --collect \
    --unit="stephen-release-$lease_id" \
    --on-active='30m' \
    --property=Restart=on-failure \
    --property=RestartSec=15s \
    /usr/local/sbin/stephen-release-helper expire "$source_sha" "$lease_id"
}

cancel_expiry() {
  local lease_id=$1
  if [[ $test_mode -eq 1 ]]; then
    rm -f -- "$release_root/test-control/scheduled-expiry"
    return 0
  fi
  /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
    /usr/bin/systemctl stop "stephen-release-$lease_id.timer" \
      "stephen-release-$lease_id.service" >/dev/null 2>&1 || true
  /usr/bin/timeout --signal=TERM --kill-after=5s 20s \
    /usr/bin/systemctl reset-failed "stephen-release-$lease_id.timer" \
      "stephen-release-$lease_id.service" >/dev/null 2>&1 || true
}

best_effort_restore_activation() {
  set +e
  if (restore_links "$activation_restore_current" "$activation_restore_previous") \
    && nginx_check >/dev/null 2>&1 \
    && nginx_reload >/dev/null 2>&1; then
    remove_pending
    cancel_expiry "$activation_lease_id"
  else
    printf '%s\n' \
      'SAAS607_REMOTE_ERROR=immediate restore was incomplete; pending marker and expiry remain armed' >&2
  fi
  set -e
}

rollback_pending_locked() {
  local failed_sha=$1
  local lease_id=$2
  local pending_source=$3
  local pending_lease=$4
  local restore_current=$5
  local restore_previous=$6
  local cancel_timer=${7:-1}
  if [[ "$restore_previous" == 'none' ]]; then restore_previous=''; fi
  [[ "$pending_source" == "$failed_sha" && "$pending_lease" == "$lease_id" ]] \
    || fail 'pending activation does not match the rollback request'
  release_is_staged "$restore_current"
  if [[ -n "$restore_previous" ]]; then release_is_staged "$restore_previous"; fi
  local current_sha
  current_sha=$(link_target_sha_unverified current)
  if [[ "$current_sha" != "$failed_sha" && "$current_sha" != "$restore_current" ]]; then
    fail 'current release is inconsistent with the pending transaction'
  fi
  restore_links "$restore_current" "$restore_previous"
  if ! nginx_check || ! nginx_reload; then
    fail 'pending rollback restored links but Nginx validation or reload failed'
  fi
  remove_pending
  if [[ "$cancel_timer" -eq 1 ]]; then cancel_expiry "$lease_id"; fi
}

activate_release() {
  [[ $# -eq 2 ]] || fail 'activate requires SHA and lease'
  local source_sha=$1
  local lease_id=$2
  require_sha "$source_sha"
  require_lease "$lease_id"
  ensure_root
  acquire_lock
  release_is_staged "$source_sha"
  local current_sha
  current_sha=$(link_sha current)
  local marker
  marker=$(pending_path)
  if [[ -e "$marker" || -L "$marker" ]]; then
    local pending_source pending_lease restore_current restore_previous
    read -r pending_source pending_lease restore_current restore_previous \
      <<< "$(pending_snapshot)"
    if [[ "$pending_source" == "$source_sha" && "$pending_lease" == "$lease_id" \
      && "$current_sha" == "$source_sha" ]]; then
      printf 'activation_status=pending\ncurrent_sha=%s\nlease_id=%s\n' \
        "$source_sha" "$lease_id"
      return 0
    fi
    fail 'another activation is already pending'
  fi
  if [[ "$current_sha" == "$source_sha" ]]; then
    printf 'activation_status=already_active\ncurrent_sha=%s\n' "$source_sha"
    return 0
  fi
  local old_previous=''
  if [[ -L "$release_root/previous" ]]; then
    old_previous=$(link_sha previous)
  elif [[ -e "$release_root/previous" ]]; then
    fail 'previous exists but is not a symbolic link'
  fi

  runtime_ready "$current_sha" \
    || fail 'Stephen runtime does not consume the exact atomic current release'
  nginx_check || fail 'Nginx validation failed before switch'
  activation_restore_current=$current_sha
  activation_restore_previous=$old_previous
  activation_source_sha=$source_sha
  activation_lease_id=$lease_id
  activation_cleanup_pending=1
  schedule_expiry "$source_sha" "$lease_id" \
    || fail 'activation expiry timer could not be scheduled; previous release restored'
  write_pending "$source_sha" "$lease_id" "$current_sha" "$old_previous"
  atomic_link previous "$current_sha"
  atomic_link current "$source_sha"
  nginx_check || fail 'Nginx validation failed after switch; previous release restored'
  nginx_reload || fail 'Nginx reload failed; previous release restored'
  activation_cleanup_pending=0
  printf 'activation_status=pending\ncurrent_sha=%s\nprevious_sha=%s\nlease_id=%s\n' \
    "$source_sha" "$current_sha" "$lease_id"
}

finalize_release() {
  [[ $# -eq 2 ]] || fail 'finalize requires SHA and lease'
  local source_sha=$1
  local lease_id=$2
  require_sha "$source_sha"
  require_lease "$lease_id"
  ensure_root
  acquire_lock
  local pending_source pending_lease restore_current restore_previous
  read -r pending_source pending_lease restore_current restore_previous \
    <<< "$(pending_snapshot)"
  [[ "$pending_source" == "$source_sha" && "$pending_lease" == "$lease_id" ]] \
    || fail 'pending activation does not match the finalize request'
  [[ $(link_sha current) == "$source_sha" ]] \
    || fail 'current release does not match the finalize request'
  runtime_ready "$source_sha" \
    || fail 'Stephen runtime does not expose the exact pending release'
  nginx_check || fail 'Nginx validation failed before finalize'
  remove_pending
  cancel_expiry "$lease_id"
  printf 'finalize_status=finalized\ncurrent_sha=%s\nlease_id=%s\n' \
    "$source_sha" "$lease_id"
}

rollback_release() {
  [[ $# -eq 2 ]] || fail 'rollback requires the failed SHA and lease'
  local failed_sha=$1
  local lease_id=$2
  require_sha "$failed_sha"
  require_lease "$lease_id"
  ensure_root
  acquire_lock
  local pending_source pending_lease restore_current restore_previous
  read -r pending_source pending_lease restore_current restore_previous \
    <<< "$(pending_snapshot)"
  rollback_pending_locked "$failed_sha" "$lease_id" "$pending_source" \
    "$pending_lease" "$restore_current" "$restore_previous"
  printf 'rollback_status=rolled_back\ncurrent_sha=%s\nfailed_sha=%s\n' \
    "$restore_current" "$failed_sha"
}

expire_release() {
  [[ $# -eq 2 ]] || fail 'expire requires SHA and lease'
  local failed_sha=$1
  local lease_id=$2
  require_sha "$failed_sha"
  require_lease "$lease_id"
  ensure_root
  acquire_lock
  local marker
  marker=$(pending_path)
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    printf 'expiry_status=no_pending_activation\n'
    return 0
  fi
  local pending_source pending_lease restore_current restore_previous
  read -r pending_source pending_lease restore_current restore_previous \
    <<< "$(pending_snapshot)"
  if [[ "$pending_source" != "$failed_sha" || "$pending_lease" != "$lease_id" ]]; then
    printf 'expiry_status=stale_timer_ignored\n'
    return 0
  fi
  rollback_pending_locked "$failed_sha" "$lease_id" "$pending_source" \
    "$pending_lease" "$restore_current" "$restore_previous" 0
  printf 'expiry_status=rolled_back\ncurrent_sha=%s\nfailed_sha=%s\n' \
    "$restore_current" "$failed_sha"
}

recover_release() {
  [[ $# -eq 0 ]] || fail 'recover accepts no arguments'
  ensure_root
  acquire_lock
  local marker
  marker=$(pending_path)
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    printf 'recovery_status=no_pending_activation\n'
    return 0
  fi
  local pending_source pending_lease restore_current restore_previous
  read -r pending_source pending_lease restore_current restore_previous \
    <<< "$(pending_snapshot)"
  rollback_pending_locked "$pending_source" "$pending_lease" "$pending_source" \
    "$pending_lease" "$restore_current" "$restore_previous"
  printf 'recovery_status=rolled_back\ncurrent_sha=%s\nfailed_sha=%s\n' \
    "$restore_current" "$pending_source"
}

show_status() {
  [[ $# -eq 0 ]] || fail 'status accepts no arguments'
  ensure_root
  acquire_lock
  local current_sha='none'
  local previous_sha='none'
  if [[ -L "$release_root/current" ]]; then
    current_sha=$(link_target_sha_unverified current)
  elif [[ -e "$release_root/current" ]]; then
    fail 'current exists but is not a symbolic link'
  fi
  if [[ -L "$release_root/previous" ]]; then
    previous_sha=$(link_target_sha_unverified previous)
  elif [[ -e "$release_root/previous" ]]; then
    fail 'previous exists but is not a symbolic link'
  fi
  local pending_source='none'
  local pending_lease='none'
  local marker
  marker=$(pending_path)
  if [[ -e "$marker" || -L "$marker" ]]; then
    local restore_current restore_previous
    read -r pending_source pending_lease restore_current restore_previous \
      <<< "$(pending_snapshot)"
  fi
  printf 'current_sha=%s\nprevious_sha=%s\npending_source_sha=%s\npending_lease_id=%s\n' \
    "$current_sha" "$previous_sha" "$pending_source" "$pending_lease"
}

case "$command_name" in
  stage) stage_release "$@" ;;
  activate) activate_release "$@" ;;
  finalize) finalize_release "$@" ;;
  rollback) rollback_release "$@" ;;
  expire) expire_release "$@" ;;
  recover) recover_release "$@" ;;
  status) show_status "$@" ;;
  *) fail 'unsupported command' ;;
esac
