#!/bin/bash
# Root-only integration probe for a disposable GitHub-hosted Ubuntu runner.
set -Eeuo pipefail
umask 022
PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

fail() {
  printf 'SAAS607_PRODUCTION_TEST_ERROR=%s\n' "$1" >&2
  exit 1
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'probe must run as root'
[[ "${GITHUB_ACTIONS:-}" == 'true' && "${RUNNER_ENVIRONMENT:-}" == 'github-hosted' ]] \
  || fail 'probe is restricted to a GitHub-hosted Actions runner'
[[ $# -eq 5 ]] || fail 'SHA, archive, checksum, helper source, and runner UID are required'

source_sha=$1
archive=$2
checksum=$3
helper_source=$4
runner_uid=$5
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'source SHA is invalid'
[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || fail 'archive checksum is invalid'
[[ "$runner_uid" =~ ^[0-9]+$ && "$runner_uid" -ne 0 ]] || fail 'runner UID is invalid'
[[ -f "$archive" && ! -L "$archive" ]] || fail 'archive is missing or unsafe'
[[ -f "$helper_source" && ! -L "$helper_source" ]] || fail 'helper source is missing or unsafe'

release_root='/srv/jianghu/stephen'
[[ ! -e "$release_root" && ! -L "$release_root" ]] \
  || fail 'fixed production root already exists; refusing integration probe'

install -d -m 0755 -o root -g root "$release_root" "$release_root/releases"
install -d -m 0730 -o "$runner_uid" -g root "$release_root/incoming"
install -m 0755 -o root -g root "$helper_source" \
  /usr/local/sbin/stephen-release-helper
install -m 0600 -o "$runner_uid" -g root "$archive" \
  "$release_root/incoming/$source_sha.tar.gz"

/usr/local/sbin/stephen-release-helper stage "$source_sha" "$checksum"
release_dir="$release_root/releases/$source_sha"
[[ -d "$release_dir" && ! -L "$release_dir" ]] || fail 'release was not staged'
[[ $(stat -c '%u' "$release_dir") == '0' ]] || fail 'release is not root owned'
[[ $(stat -c '%a' "$release_dir/index.html") == '644' ]] \
  || fail 'release file mode was not normalized'
[[ ! -e "$release_root/incoming/$source_sha.tar.gz" ]] \
  || fail 'successful stage did not clear the incoming archive'

install -m 0600 -o "$runner_uid" -g root "$archive" \
  "$release_root/incoming/$source_sha.tar.gz"
first_output="$release_root/first-stage.out"
second_output="$release_root/second-stage.out"
set +e
SAAS607_PRODUCTION_LOCK_PROBE=1 \
  /usr/local/sbin/stephen-release-helper stage "$source_sha" "$checksum" \
  > "$first_output" 2>&1 &
first_pid=$!
SAAS607_PRODUCTION_LOCK_PROBE=1 \
  /usr/local/sbin/stephen-release-helper stage "$source_sha" "$checksum" \
  > "$second_output" 2>&1 &
second_pid=$!
wait "$first_pid"
first_status=$?
wait "$second_pid"
second_status=$?
set -e
[[ "$first_status" -eq 0 && "$second_status" -eq 0 ]] \
  || fail 'serialized idempotent stage probe failed'
[[ ! -e "$release_root/incoming/$source_sha.tar.gz" ]] \
  || fail 'idempotent stage left an incoming archive'
find "$release_root/releases" -maxdepth 1 \
  \( -name '.archive-*' -o -name '.stage-*' \) -print -quit \
  | grep -q . && fail 'production stage left a temporary path'

printf 'SAAS607_PRODUCTION_STAGE_TEST_OK=1\nsource_sha=%s\n' "$source_sha"
