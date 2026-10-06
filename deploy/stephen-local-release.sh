#!/usr/bin/env bash
# SAAS-607 local-human operator; private control and public source have distinct identities.
set -Eeuo pipefail
umask 077

PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export PATH
unset BASH_ENV ENV CDPATH GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
RELEASE_CLI="$REPO_ROOT/app/stephen/scripts/stephen-release-cli.ts"
GH_REPO='ZiZ-LG/jianghu'
SOURCE_REPO='ZiZ-LG/stephen-knowledge-hub'
WORKFLOW_RUN_FILTER='[.workflow_runs[]
  | select(.head_sha == $source_sha)
  | select(.head_branch == "main")
  | select(.event == "push")
  | select(.head_repository.full_name == $repository)]
  | sort_by(.created_at, .run_attempt, .id)
  | last
  | type == "object"
    and .status == "completed"
    and .conclusion == "success"'
VARIABLE_GATE_FILTER='(type == "array")
  and (length > 0)
  and (.[0].total_count | type == "number" and . >= 0 and floor == .)
  and (([.[]?.variables[]?] | length) == .[0].total_count)
  and ([.[]?.variables[]?
    | select(.name == "STEPHEN_RELEASE_ENABLED")
    | .value]
    | all(. != "1"))'

CI_RUN_URL=''
STEPHEN_CHECK_RUN_URL=''
SOURCE_CHECK_RUN_URL=''

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy/stephen-local-release.sh plan|activate|verify|finalize|rollback [options]

Common plan/activate options:
  --source-dir /absolute/clean/public-worktree
  --operator-sha <40-lowercase-hex-private-main>
  --source-sha <40-lowercase-hex>
  --bundle-dir /absolute/output-directory

State commands additionally use:
  --state-file /absolute/release-state.json

Default plan mode is read-only. Test-only options --artifact and --test-root
require STEPHEN_LOCAL_RELEASE_TEST_MODE=1 and can never contact production.
USAGE
  exit 2
}

fail() {
  printf 'STEPHEN_LOCAL_RELEASE_ERROR=%s\n' "$1" >&2
  exit 1
}

require_absolute_path() {
  local value=$1 label=$2
  [[ "$value" == /* && "$value" != '/' \
    && "$value" != *'/../'* && "$value" != */.. \
    && "$value" != *'/./'* && "$value" != */. ]] \
    || fail "$label must be a safe absolute path"
}

require_source_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'source SHA must be 40 lowercase hexadecimal characters'
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

verify_titles() {
  local artifact=$1
  grep -Fq '<title>自我修养｜AI Sales Fieldcraft</title>' "$artifact/index.html" \
    || fail 'artifact static fallback title is missing or incorrect'
  local dynamic_title='自我修养｜AI 技术、大客户销售与岗位组织转型'
  local matched=0 javascript_file
  while IFS= read -r -d '' javascript_file; do
    if grep -Fq "$dynamic_title" "$javascript_file"; then
      matched=1
      break
    fi
  done < <(find "$artifact/assets" -type f -name '*.js' -print0 2>/dev/null)
  [[ $matched -eq 1 ]] || fail 'artifact rendered dynamic title is missing or incorrect'
}

HTTP_PROXY_OPTIONS=()
LOCAL_PROXY=${STEPHEN_LOCAL_PROXY:-}
if [[ -n "$LOCAL_PROXY" ]]; then
  [[ "$LOCAL_PROXY" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]] || fail 'local proxy must be 127.0.0.1 with a numeric port'
  local_proxy_port=${BASH_REMATCH[1]}
  (( 10#$local_proxy_port >= 1 && 10#$local_proxy_port <= 65535 )) || fail 'local proxy port is invalid'
  HTTP_PROXY_OPTIONS=(--proxy "socks5h://$LOCAL_PROXY")
elif [[ -z "${HTTPS_PROXY:-${https_proxy:-}}" && -z "${ALL_PROXY:-${all_proxy:-}}" ]]; then
  HTTP_PROXY_OPTIONS=(--noproxy '*')
fi

operator_tmp=''
cleanup() {
  if [[ -n "$operator_tmp" && -d "$operator_tmp" ]]; then
    rm -rf -- "$operator_tmp"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_operator_tmp() {
  if [[ -z "$operator_tmp" ]]; then
    operator_tmp=$(mktemp -d "${TMPDIR:-/tmp}/stephen-local-release.XXXXXX")
  fi
}

require_successful_workflow_run() {
  local repository=$1 expected_sha=$2 workflow_file=$3 output_file=$4 run_url
  gh api --hostname github.com --method GET \
    "repos/$repository/actions/workflows/$workflow_file/runs" \
    -f head_sha="$expected_sha" -f branch=main -f event=push -F per_page=20 \
    > "$output_file"
  jq -e --arg source_sha "$expected_sha" --arg repository "$repository" \
    "$WORKFLOW_RUN_FILTER" "$output_file" >/dev/null \
    || fail "$repository/$workflow_file newest run is not successful for the exact current main SHA"
  run_url=$(jq -er --arg source_sha "$expected_sha" --arg repository "$repository" '
    [.workflow_runs[] | select(.head_sha == $source_sha)
      | select(.head_branch == "main") | select(.event == "push")
      | select(.head_repository.full_name == $repository)]
      | sort_by(.created_at, .run_attempt, .id) | last | .html_url
      | select(type == "string")
      | select(startswith("https://github.com/" + $repository + "/actions/runs/"))' "$output_file") \
    || fail 'selected workflow run URL is outside the canonical repository'
  case "$repository/$workflow_file" in
    "$GH_REPO/ci.yml") CI_RUN_URL=$run_url ;;
    "$GH_REPO/stephen-checks.yml") STEPHEN_CHECK_RUN_URL=$run_url ;;
    "$SOURCE_REPO/checks.yml") SOURCE_CHECK_RUN_URL=$run_url ;;
    *) fail 'unsupported workflow identity' ;;
  esac
}

require_canonical_origin() {
  local directory=$1 repository=$2 origin_url
  origin_url=$(git -C "$directory" remote get-url origin 2>/dev/null) \
    || fail 'worktree has no canonical origin'
  case "$origin_url" in
    "git@github.com:$repository"|"git@github.com:$repository.git"|"ssh://git@github.com/$repository"|"ssh://git@github.com/$repository.git"|"https://github.com/$repository"|"https://github.com/$repository.git") ;;
    *) fail "worktree origin is not the canonical $repository repository" ;;
  esac
}

require_clean_checkout() {
  local directory=$1 expected_sha=$2 repository=$3 canonical_root git_root checked_sha changes
  require_absolute_path "$directory" 'checkout directory'
  [[ -d "$directory" && ! -L "$directory" ]] || fail 'checkout directory is missing or unsafe'
  canonical_root=$(cd "$directory" && pwd -P) || fail 'checkout cannot be resolved'
  [[ "$directory" == "$canonical_root" ]] || fail 'checkout directory must be canonical'
  git_root=$(git -C "$directory" rev-parse --show-toplevel 2>/dev/null) \
    || fail 'checkout is not a Git worktree'
  [[ "$git_root" == "$canonical_root" ]] || fail 'checkout must be the worktree root'
  checked_sha=$(git -C "$directory" rev-parse HEAD)
  [[ "$checked_sha" == "$expected_sha" ]] || fail "$repository checkout does not match its recorded SHA"
  changes=$(git -C "$directory" status --porcelain --untracked-files=all)
  [[ -z "$changes" ]] || fail "$repository worktree must be clean before release"
  require_canonical_origin "$directory" "$repository"
}

require_operator_source_alignment() {
  require_source_sha "$operator_sha"
  if [[ $test_mode -eq 1 ]]; then
    local expected_file="$test_root/test-control/operator-sha"
    if [[ -f "$expected_file" ]]; then
      [[ "$(tr -d '[:space:]' < "$expected_file")" == "$operator_sha" ]] \
        || fail 'operator checkout does not match the release operator SHA'
    fi
    return
  fi
  require_clean_checkout "$REPO_ROOT" "$operator_sha" "$GH_REPO"
  [[ "$source_dir" != "$REPO_ROOT" ]] || fail 'public source must be separate from the private operator'
  git -C "$REPO_ROOT" ls-files --error-unmatch \
    deploy/stephen-local-release.sh deploy/public-site-targets.json \
    app/stephen/scripts/stephen-release-cli.ts app/stephen/scripts/stephen-release.ts >/dev/null \
    || fail 'operator, target registry, or private artifact validator is not tracked'
}

require_operator_checkout_for_state() {
  require_operator_source_alignment
}

verify_current_main() {
  local directory=$1 repository=$2 expected_sha=$3 remote_ref_sha github_main_sha
  git -C "$directory" fetch --no-tags origin main >&2
  remote_ref_sha=$(git -C "$directory" rev-parse origin/main)
  [[ "$remote_ref_sha" == "$expected_sha" ]] || fail "$repository origin/main does not match its recorded SHA"
  github_main_sha=$(gh api --hostname github.com --method GET \
    "repos/$repository/git/ref/heads/main" --jq '.object.sha')
  [[ "$github_main_sha" == "$expected_sha" ]] || fail "$repository GitHub main does not match its recorded SHA"
}

verify_exact_green_main() {
  ensure_operator_tmp
  require_operator_source_alignment
  require_clean_checkout "$source_dir" "$source_sha" "$SOURCE_REPO"
  verify_current_main "$REPO_ROOT" "$GH_REPO" "$operator_sha"
  verify_current_main "$source_dir" "$SOURCE_REPO" "$source_sha"
  require_successful_workflow_run "$GH_REPO" "$operator_sha" ci.yml "$operator_tmp/ci-runs.json"
  require_successful_workflow_run "$GH_REPO" "$operator_sha" stephen-checks.yml "$operator_tmp/stephen-check-runs.json"
  require_successful_workflow_run "$SOURCE_REPO" "$source_sha" checks.yml "$operator_tmp/source-check-runs.json"
  gh api --hostname github.com --paginate --slurp --method GET \
    "repos/$GH_REPO/actions/variables" -F per_page=100 > "$operator_tmp/repository-variables.json"
  jq -e "$VARIABLE_GATE_FILTER" "$operator_tmp/repository-variables.json" >/dev/null \
    || fail 'GitHub automatic Stephen release must remain disabled for the local-human lane'
}

transaction_exact_main_gate() {
  if [[ $test_mode -eq 0 ]]; then
    verify_exact_green_main
    return
  fi
  require_operator_source_alignment
  local gate_file="$test_root/test-control/exact-main-results"
  [[ -f "$gate_file" ]] || return 0
  local gate_result gate_tmp
  gate_result=$(sed -n '1p' "$gate_file")
  gate_tmp="$gate_file.next.$$"
  sed '1d' "$gate_file" > "$gate_tmp"
  mv -- "$gate_tmp" "$gate_file"
  [[ "$gate_result" == 'pass' ]] || fail 'test exact-main gate rejected the transaction'
}

run_quality_gates() {
  (
    cd "$source_dir"
    npm ci >&2
    npm run typecheck >&2
    npm test >&2
    npm run build >&2
    npm run audit:public >&2
  )
  # Repository scripts may not change the source or the operator that passed the gate.
  require_operator_source_alignment
  require_clean_checkout "$source_dir" "$source_sha" "$SOURCE_REPO"
}

load_production_target() {
  local registry="$REPO_ROOT/deploy/public-site-targets.json"
  local destination
  jq -e '
    .schemaVersion == 1
      and .targets["self-cultivation"].source.authority == "authoritative"
      and .targets["self-cultivation"].source.repository == "ZiZ-LG/stephen-knowledge-hub"
      and .targets["self-cultivation"].deployment.manager == "stephen-release-helper"
      and .targets["self-cultivation"].deployment.atomicRuntimeAuthority == true
      and .targets["self-cultivation"].deployment.destinationPath == "/srv/jianghu/stephen/current"
      and .targets["self-cultivation"].nginx.root == "/srv/stephen/current"' \
    "$registry" >/dev/null || fail 'Stephen production target registry is not release-ready'
  destination=$(jq -er '.targets["self-cultivation"].deployment.destinationHost' "$registry")
  [[ "$destination" =~ ^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$ ]] \
    || fail 'Stephen destination host is invalid'
  REMOTE_USER=${destination%@*}
  REMOTE_HOST=${destination#*@}
  REMOTE="$REMOTE_USER@$REMOTE_HOST"
}

configure_ssh() {
  load_production_target
  local identity_file=${STEPHEN_SSH_IDENTITY_FILE:-"$HOME/.ssh/id_ed25519"}
  local known_hosts_file=${STEPHEN_SSH_KNOWN_HOSTS_FILE:-"$HOME/.ssh/known_hosts"}
  local ssh_port=${STEPHEN_SSH_PORT:-22}
  require_absolute_path "$identity_file" 'SSH identity file'
  require_absolute_path "$known_hosts_file" 'SSH known-hosts file'
  [[ -f "$identity_file" && ! -L "$identity_file" ]] || fail 'SSH identity file is missing or unsafe'
  [[ -f "$known_hosts_file" && ! -L "$known_hosts_file" ]] \
    || fail 'SSH known-hosts file is missing or unsafe'
  [[ "$ssh_port" =~ ^[0-9]{1,5}$ ]] || fail 'SSH port is invalid'
  (( ssh_port >= 1 && ssh_port <= 65535 )) || fail 'SSH port is invalid'
  local known_host_lookup=$REMOTE_HOST
  if [[ "$ssh_port" != '22' ]]; then known_host_lookup="[$REMOTE_HOST]:$ssh_port"; fi
  ssh-keygen -F "$known_host_lookup" -f "$known_hosts_file" >/dev/null \
    || fail 'production host is missing from the trusted known-hosts file'
  SSH_OPTIONS=(
    -F /dev/null
    -o GlobalKnownHostsFile=/dev/null
    -i "$identity_file"
    -p "$ssh_port"
    -o BatchMode=yes
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$known_hosts_file"
  )
  if [[ -n "$LOCAL_PROXY" ]]; then
    SSH_OPTIONS+=(-o "ProxyCommand=/usr/bin/nc -w 5 -X 5 -x $LOCAL_PROXY %h %p")
  fi
}

remote_helper() {
  local helper_command=$1
  shift
  local remote_command
  case "$helper_command" in
    status)
      [[ $# -eq 0 ]] || fail 'invalid helper status arguments'
      remote_command='sudo -n /usr/local/sbin/stephen-release-helper status'
      ;;
    stage)
      [[ $# -eq 2 ]] || fail 'invalid helper stage arguments'
      require_source_sha "$1"
      [[ "$2" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid helper stage checksum'
      remote_command="sudo -n /usr/local/sbin/stephen-release-helper stage $1 $2"
      ;;
    activate|finalize|rollback)
      [[ $# -eq 2 ]] || fail "invalid helper $helper_command arguments"
      require_source_sha "$1"
      [[ "$2" =~ ^[0-9a-f]{32}$ ]] || fail "invalid helper $helper_command lease"
      remote_command="sudo -n /usr/local/sbin/stephen-release-helper $helper_command $1 $2"
      ;;
    *) fail 'invalid remote helper command' ;;
  esac
  if [[ $test_mode -eq 1 ]]; then
    SAAS607_HELPER_TEST_MODE=1 bash "$REPO_ROOT/deploy/stephen-remote-release.sh" \
      --test-root "$test_root" "$helper_command" "$@"
    return
  fi
  ssh "${SSH_OPTIONS[@]}" "$REMOTE" "$remote_command"
}

upload_archive() {
  if [[ $test_mode -eq 1 ]]; then
    mkdir -p -- "$test_root/incoming"
    cp -- "$BUNDLE_ARCHIVE" "$test_root/incoming/$source_sha.tar.gz"
    return
  fi
  ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
    "sudo -n /usr/bin/tee /srv/jianghu/stephen/incoming/$source_sha.tar.gz >/dev/null" \
    < "$BUNDLE_ARCHIVE"
}

fetch_status() {
  local expected=$1 url=$2 code
  code=$(curl -q "${HTTP_PROXY_OPTIONS[@]}" --silent --show-error --proto '=https' \
    --max-redirs 0 --max-time 20 \
    --dump-header "$operator_tmp/http-headers" \
    --output "$operator_tmp/http-body" \
    --write-out '%{http_code}' "$url") || return 1
  [[ "$code" == "$expected" ]]
}

smoke_shared_sites() {
  local content_type
  fetch_status 200 'https://lake2ocean.top/' || return 1
  grep -Fq '江湖 CRM｜自在江湖客户管理' "$operator_tmp/http-body" || return 1
  fetch_status 200 'https://crm.lake2ocean.top/' || return 1
  grep -Fq '江湖 · Game of JiangHu' "$operator_tmp/http-body" || return 1
  fetch_status 200 'https://crm.lake2ocean.top/api/health' || return 1
  content_type=$(awk 'BEGIN { IGNORECASE = 1 } /^content-type:/ { sub(/\r$/, ""); sub(/^[^:]*:[[:space:]]*/, ""); print; exit }' "$operator_tmp/http-headers")
  [[ "$content_type" == application/json* ]] || return 1
  jq -e 'type == "object" and .ok == true' "$operator_tmp/http-body" >/dev/null || return 1
  fetch_status 200 'https://zizai.tech/' || return 1
  grep -Fq 'ZiZai 自在创造' "$operator_tmp/http-body" || return 1
  fetch_status 200 'https://bjj.zizai.tech/' || return 1
  grep -Fq 'ZiZ 记事本' "$operator_tmp/http-body" || return 1
}

smoke_current_release() {
  local expected_sha=$1 expected_checksum=${2:-} expected_repository=${3:-} asset_path
  if [[ $test_mode -eq 1 ]]; then
    local metadata="$test_root/releases/$expected_sha/.stephen-release.json"
    jq -e --arg source_sha "$expected_sha" --arg checksum "$expected_checksum" \
      --arg repository "$expected_repository" '
      .schemaVersion == 1 and .task == "SAAS-607" and .sourceSha == $source_sha
        and (.contentChecksum | type == "string" and test("^[0-9a-f]{64}$"))
        and ($checksum == "" or .contentChecksum == $checksum)
        and (if $repository == "legacy-private" then (has("sourceRepository") | not)
          elif $repository == "" then ((has("sourceRepository") | not)
            or .sourceRepository == "ZiZ-LG/stephen-knowledge-hub")
          else .sourceRepository == $repository end)' "$metadata" >/dev/null || return 1
    OBSERVED_SOURCE_REPOSITORY=$(jq -er 'if has("sourceRepository") then .sourceRepository else "legacy-private" end' "$metadata") || return 1
    OBSERVED_CONTENT_CHECKSUM=$(jq -er '.contentChecksum' "$metadata") || return 1
    return 0
  fi
  ensure_operator_tmp
  fetch_status 200 'https://stephen.lake2ocean.top/' || return 1
  grep -Fq '<title>自我修养｜AI Sales Fieldcraft</title>' "$operator_tmp/http-body" || return 1
  cp "$operator_tmp/http-body" "$operator_tmp/stephen-bundle"
  while IFS= read -r asset_path; do
    curl -q "${HTTP_PROXY_OPTIONS[@]}" --silent --show-error --fail --proto '=https' \
      --max-redirs 0 --max-time 20 \
      "https://stephen.lake2ocean.top$asset_path" >> "$operator_tmp/stephen-bundle" \
      || return 1
  done < <(grep -Eo 'src="/assets/[^"]+\.js"' "$operator_tmp/http-body" \
    | sed -E 's/^src="([^"]+)"$/\1/' | sort -u)
  grep -Fq '自我修养｜AI 技术、大客户销售与岗位组织转型' \
    "$operator_tmp/stephen-bundle" || return 1
  fetch_status 200 'https://stephen.lake2ocean.top/fieldbook/' || return 1
  fetch_status 200 'https://stephen.lake2ocean.top/policy/' || return 1
  fetch_status 200 'https://stephen.lake2ocean.top/healthz-stephen' || return 1
  [[ $(tr -d '[:space:]' < "$operator_tmp/http-body") == 'ok' ]] || return 1
  fetch_status 200 'https://stephen.lake2ocean.top/release-id.json' || return 1
  jq -e --arg source_sha "$expected_sha" --arg checksum "$expected_checksum" \
    --arg repository "$expected_repository" '
    .schemaVersion == 1
      and .task == "SAAS-607"
      and .sourceSha == $source_sha
      and (.contentChecksum | type == "string" and test("^[0-9a-f]{64}$"))
      and ($checksum == "" or .contentChecksum == $checksum)
      and (if $repository == "legacy-private" then (has("sourceRepository") | not)
        elif $repository == "" then ((has("sourceRepository") | not)
          or .sourceRepository == "ZiZ-LG/stephen-knowledge-hub")
        else .sourceRepository == $repository end)' \
    "$operator_tmp/http-body" >/dev/null || return 1
  OBSERVED_SOURCE_REPOSITORY=$(jq -er 'if has("sourceRepository") then .sourceRepository else "legacy-private" end' "$operator_tmp/http-body") || return 1
  OBSERVED_CONTENT_CHECKSUM=$(jq -er '.contentChecksum' "$operator_tmp/http-body") || return 1
  fetch_status 404 'https://stephen.lake2ocean.top/api/' || return 1
  fetch_status 200 'https://stephen.lake2ocean.top/beian-police.png' || return 1
  [[ -s "$operator_tmp/http-body" ]] || return 1
  smoke_shared_sites
}

smoke_candidate_release() {
  if [[ $test_mode -eq 1 ]]; then
    [[ -f "$test_root/test-control/smoke-result" \
      && $(tr -d '[:space:]' < "$test_root/test-control/smoke-result") == 'pass' ]] || return 1
    jq -e --arg sha "$source_sha" --arg checksum "$BUNDLE_CONTENT_CHECKSUM" --arg repository "$SOURCE_REPO" \
      '.sourceSha == $sha and .sourceRepository == $repository and .contentChecksum == $checksum' \
      "$test_root/releases/$source_sha/.stephen-release.json" >/dev/null
    return
  fi
  ensure_operator_tmp
  smoke_current_release "$source_sha" "$BUNDLE_CONTENT_CHECKSUM" "$SOURCE_REPO" || return 1
  local smoke_path smoke_source smoke_paths_file
  smoke_source=${BUNDLE_METADATA:-$state_file}
  smoke_paths_file="$operator_tmp/candidate-smoke-paths"
  jq -er '.smokePaths[]' "$smoke_source" > "$smoke_paths_file" || return 1
  while IFS= read -r smoke_path; do
    [[ "$smoke_path" =~ ^/($|digest/$|policy/$|fieldbook/$|library/$|learn/($|ai-foundations/$|knowledge-answers/$|workflow-agents/$|customer-discovery/$|value-and-cost/$|pilot-evaluation/$|adoption-and-governance/$|career-evidence/$)|items/[a-z0-9-]+/$) ]] \
      || return 1
    fetch_status 200 "https://stephen.lake2ocean.top$smoke_path" || return 1
  done < "$smoke_paths_file"
}

validate_state_parent() {
  require_absolute_path "$state_file" 'state file'
  local requested_parent canonical_parent parent_owner parent_mode
  requested_parent=$(dirname "$state_file")
  [[ -d "$requested_parent" && ! -L "$requested_parent" ]] \
    || fail 'state file parent is unsafe'
  canonical_parent=$(cd "$requested_parent" 2>/dev/null && pwd -P) \
    || fail 'state file parent cannot be resolved'
  state_file="$canonical_parent/$(basename "$state_file")"
  if stat -f '%u %Lp' "$canonical_parent" >/dev/null 2>&1; then
    read -r parent_owner parent_mode <<< "$(stat -f '%u %Lp' "$canonical_parent")"
  else
    read -r parent_owner parent_mode <<< "$(stat -c '%u %a' "$canonical_parent")"
  fi
  [[ "$parent_owner" == "$(id -u)" && "$parent_mode" == '700' ]] \
    || fail 'state file parent must be owned by the operator with mode 0700'
}

validate_new_state_target() {
  validate_state_parent
  [[ ! -e "$state_file" && ! -L "$state_file" ]] || fail 'state file already exists'
}

sync_local_path() {
  if [[ $test_mode -eq 1 ]]; then return 0; fi
  python3 -I - "$1" <<'PY' || fail 'local release state sync failed'
import os
import sys

path = sys.argv[1]
flags = os.O_RDONLY
if os.path.isdir(path):
    flags |= getattr(os, 'O_DIRECTORY', 0)
descriptor = os.open(path, flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

create_release_state() {
  local release_state=$1 lease_id=$2 previous_sha=$3 production_touched=$4 terminal=$5
  validate_new_state_target
  local state_parent state_tmp completed_at=''
  state_parent=$(dirname "$state_file")
  state_tmp=$(mktemp "$state_file.next.XXXXXX")
  if [[ "$terminal" == 'true' ]]; then
    completed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  fi
  jq -n \
    --arg source_sha "$source_sha" \
    --arg source_directory "$source_dir" \
    --arg operator_sha "$operator_sha" \
    --arg previous_repository "$PREVIOUS_SOURCE_REPOSITORY" \
    --arg previous_checksum "$PREVIOUS_CONTENT_CHECKSUM" \
    --arg lease_id "$lease_id" \
    --arg previous_sha "$previous_sha" \
    --arg archive_checksum "$BUNDLE_ARCHIVE_CHECKSUM" \
    --arg content_checksum "$BUNDLE_CONTENT_CHECKSUM" \
    --arg release_state "$release_state" \
    --arg created_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg completed_at "$completed_at" \
    --argjson smoke_paths "$(jq -ce '.smokePaths' "$BUNDLE_METADATA")" \
    --argjson production_touched "$production_touched" \
    '{
      schemaVersion: 2,
      task: "SAAS-607",
      operatorRepository: "ZiZ-LG/jianghu",
      operatorSha: $operator_sha,
      sourceRepository: "ZiZ-LG/stephen-knowledge-hub",
      sourceDirectory: $source_directory,
      previousSourceRepository: $previous_repository,
      previousContentChecksum: $previous_checksum,
      command: "activate",
      sourceSha: $source_sha,
      leaseId: $lease_id,
      previousSha: $previous_sha,
      archiveChecksum: $archive_checksum,
      contentChecksum: $content_checksum,
      smokePaths: $smoke_paths,
      releaseState: $release_state,
      productionTouched: $production_touched,
      createdAt: $created_at
    }
    | if $completed_at == "" then . else .completedAt = $completed_at end' > "$state_tmp"
  chmod 0600 "$state_tmp"
  sync_local_path "$state_tmp"
  ln "$state_tmp" "$state_file" 2>/dev/null || {
    rm -f -- "$state_tmp"
    fail 'state file already exists'
  }
  rm -f -- "$state_tmp"
  sync_local_path "$state_parent"
  load_release_state
}

load_release_state() {
  validate_state_parent
  [[ -f "$state_file" && ! -L "$state_file" ]] || fail 'state file is missing or unsafe'
  local state_size state_owner state_mode
  if stat -f '%u %Lp' "$state_file" >/dev/null 2>&1; then
    read -r state_owner state_mode <<< "$(stat -f '%u %Lp' "$state_file")"
  else
    read -r state_owner state_mode <<< "$(stat -c '%u %a' "$state_file")"
  fi
  [[ "$state_owner" == "$(id -u)" && "$state_mode" == '600' ]] \
    || fail 'state file must be owned by the operator with mode 0600'
  state_size=$(wc -c < "$state_file" | tr -d '[:space:]')
  [[ "$state_size" =~ ^[0-9]+$ ]] || fail 'state file size is invalid'
  (( state_size > 0 && state_size <= 65536 )) || fail 'state file size is unsafe'
  STATE_SNAPSHOT=$(jq -ce 'select(
    type == "object"
      and .schemaVersion == 2
      and .task == "SAAS-607"
      and .operatorRepository == "ZiZ-LG/jianghu"
      and (.operatorSha | type == "string" and test("^[0-9a-f]{40}$"))
      and .sourceRepository == "ZiZ-LG/stephen-knowledge-hub"
      and (.sourceDirectory | type == "string" and startswith("/") and length > 1 and length <= 4096)
      and (.previousSourceRepository == "legacy-private" or .previousSourceRepository == "ZiZ-LG/stephen-knowledge-hub")
      and (.previousContentChecksum | type == "string" and test("^[0-9a-f]{64}$"))
      and (.command == "activate" or .command == "finalize" or .command == "rollback")
      and (.sourceSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.leaseId | type == "string" and test("^[0-9a-f]{32}$"))
      and (.previousSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.archiveChecksum | type == "string" and test("^[0-9a-f]{64}$"))
      and (.contentChecksum | type == "string" and test("^[0-9a-f]{64}$"))
      and (.smokePaths | type == "array" and length >= 1 and length <= 100
        and all(.[]; type == "string"
          and test("^/($|digest/$|policy/$|fieldbook/$|library/$|learn/($|ai-foundations/$|knowledge-answers/$|workflow-agents/$|customer-discovery/$|value-and-cost/$|pilot-evaluation/$|adoption-and-governance/$|career-evidence/$)|items/[a-z0-9-]+/$)")))
      and (.releaseState == "ACTIVATION_INTENT"
        or .releaseState == "UPLOAD_REQUESTED"
        or .releaseState == "STAGED"
        or .releaseState == "PENDING_BROWSER_VERIFICATION"
        or .releaseState == "FINALIZE_REQUESTED"
        or .releaseState == "FINALIZED"
        or .releaseState == "ROLLED_BACK"
        or .releaseState == "ACTIVATION_FAILED"
        or .releaseState == "ALREADY_ACTIVE")
      and (.productionTouched | type == "boolean")
      and (.createdAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and ((has("completedAt") | not) or (.completedAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
      and (
        (.command == "activate"
          and .releaseState == "ACTIVATION_INTENT"
          and .productionTouched == false
          and (has("completedAt") | not))
        or (.command == "activate"
          and (.releaseState == "UPLOAD_REQUESTED"
            or .releaseState == "STAGED"
            or .releaseState == "PENDING_BROWSER_VERIFICATION")
          and .productionTouched == true
          and (has("completedAt") | not))
        or (.command == "activate"
          and .releaseState == "ALREADY_ACTIVE"
          and .productionTouched == false
          and has("completedAt"))
        or (.command == "activate"
          and .releaseState == "ACTIVATION_FAILED"
          and .productionTouched == true
          and has("completedAt"))
        or (.command == "finalize"
          and .releaseState == "FINALIZE_REQUESTED"
          and .productionTouched == true
          and (has("completedAt") | not))
        or (.command == "finalize"
          and .releaseState == "FINALIZED"
          and .productionTouched == true
          and has("completedAt"))
        or (.command == "rollback"
          and .releaseState == "ROLLED_BACK"
          and .productionTouched == true
          and has("completedAt"))
      )
      and ((keys - ["archiveChecksum", "command", "completedAt", "contentChecksum",
        "createdAt", "leaseId", "previousSha", "productionTouched", "releaseState",
        "schemaVersion", "smokePaths", "sourceSha", "task", "operatorRepository", "operatorSha",
        "sourceRepository", "sourceDirectory", "previousSourceRepository", "previousContentChecksum"]) | length == 0)
    )' \
    "$state_file") || fail 'state file schema is invalid'

  local recorded_source_directory
  recorded_source_directory=$(jq -er '.sourceDirectory' <<< "$STATE_SNAPSHOT")
  require_absolute_path "$recorded_source_directory" 'recorded public source directory'
  [[ -z "$source_dir" || "$source_dir" == "$recorded_source_directory" ]] \
    || fail 'source directory does not match the release state'
  source_dir=$recorded_source_directory
  operator_sha=$(jq -er '.operatorSha' <<< "$STATE_SNAPSHOT")
  PREVIOUS_SOURCE_REPOSITORY=$(jq -er '.previousSourceRepository' <<< "$STATE_SNAPSHOT")
  PREVIOUS_CONTENT_CHECKSUM=$(jq -er '.previousContentChecksum' <<< "$STATE_SNAPSHOT")
  source_sha=$(jq -er '.sourceSha' <<< "$STATE_SNAPSHOT")
  STATE_LEASE_ID=$(jq -er '.leaseId' <<< "$STATE_SNAPSHOT")
  STATE_PREVIOUS_SHA=$(jq -er '.previousSha' <<< "$STATE_SNAPSHOT")
  STATE_RELEASE_STATE=$(jq -er '.releaseState' <<< "$STATE_SNAPSHOT")
  BUNDLE_ARCHIVE_CHECKSUM=$(jq -er '.archiveChecksum' <<< "$STATE_SNAPSHOT")
  BUNDLE_CONTENT_CHECKSUM=$(jq -er '.contentChecksum' <<< "$STATE_SNAPSHOT")
  BUNDLE_METADATA=$state_file
}

require_finalizable_release_state() {
  case "$STATE_RELEASE_STATE" in
    ACTIVATION_INTENT|UPLOAD_REQUESTED|STAGED|PENDING_BROWSER_VERIFICATION|FINALIZE_REQUESTED) ;;
    *) fail 'release state is not eligible for finalize reconciliation' ;;
  esac
}

update_release_state() {
  local next_command=$1 next_release_state=$2 production_touched=$3 terminal=$4
  local state_parent state_tmp completed_at=''
  state_parent=$(dirname "$state_file")
  state_tmp=$(mktemp "$state_file.next.XXXXXX")
  if [[ "$terminal" == 'true' ]]; then
    completed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  fi
  jq \
    --arg command "$next_command" \
    --arg release_state "$next_release_state" \
    --arg completed_at "$completed_at" \
    --argjson production_touched "$production_touched" \
    '.command = $command
      | .releaseState = $release_state
      | .productionTouched = $production_touched
      | if $completed_at == "" then del(.completedAt) else .completedAt = $completed_at end' \
    <<< "$STATE_SNAPSHOT" > "$state_tmp"
  chmod 0600 "$state_tmp"
  sync_local_path "$state_tmp"
  mv -- "$state_tmp" "$state_file"
  sync_local_path "$state_parent"
  load_release_state
}

read_remote_status() {
  local status_output=$1
  [[ $(printf '%s\n' "$status_output" | wc -l | tr -d '[:space:]') == '4' ]] \
    || fail 'remote status response has an unexpected shape'
  [[ $(grep -Ec '^current_sha=(none|[0-9a-f]{40})$' <<< "$status_output") == '1' \
    && $(grep -Ec '^previous_sha=(none|[0-9a-f]{40})$' <<< "$status_output") == '1' \
    && $(grep -Ec '^pending_source_sha=(none|[0-9a-f]{40})$' <<< "$status_output") == '1' \
    && $(grep -Ec '^pending_lease_id=(none|[0-9a-f]{32})$' <<< "$status_output") == '1' ]] \
    || fail 'remote status response is not trustworthy'
  REMOTE_CURRENT_SHA=$(awk -F= '$1 == "current_sha" { print $2 }' <<< "$status_output")
  REMOTE_PREVIOUS_SHA=$(awk -F= '$1 == "previous_sha" { print $2 }' <<< "$status_output")
  REMOTE_PENDING_SHA=$(awk -F= '$1 == "pending_source_sha" { print $2 }' <<< "$status_output")
  REMOTE_PENDING_LEASE=$(awk -F= '$1 == "pending_lease_id" { print $2 }' <<< "$status_output")
}

classify_remote_transaction() {
  if [[ "$REMOTE_CURRENT_SHA" == "$source_sha"
    && "$REMOTE_PREVIOUS_SHA" == "$STATE_PREVIOUS_SHA"
    && "$REMOTE_PENDING_SHA" == "$source_sha"
    && "$REMOTE_PENDING_LEASE" == "$STATE_LEASE_ID" ]]; then
    REMOTE_TRANSACTION_STATE='PENDING_BROWSER_VERIFICATION'
  elif [[ "$REMOTE_CURRENT_SHA" == "$source_sha"
    && "$REMOTE_PREVIOUS_SHA" == "$STATE_PREVIOUS_SHA"
    && "$REMOTE_PENDING_SHA" == 'none'
    && "$REMOTE_PENDING_LEASE" == 'none' ]]; then
    REMOTE_TRANSACTION_STATE='FINALIZED'
  elif [[ "$REMOTE_CURRENT_SHA" == "$STATE_PREVIOUS_SHA"
    && "$REMOTE_PENDING_SHA" == 'none'
    && "$REMOTE_PENDING_LEASE" == 'none' ]]; then
    REMOTE_TRANSACTION_STATE='ROLLED_BACK'
  else
    REMOTE_TRANSACTION_STATE='INCONSISTENT'
  fi
}

rollback_pending_activation() {
  local failed_sha=$1 lease_id=$2 expected_previous=$3 rollback_output
  set +e
  rollback_output=$(remote_helper rollback "$failed_sha" "$lease_id" 2>&1)
  local rollback_rc=$?
  set -e
  [[ $rollback_rc -eq 0 ]] || fail "pending activation rollback failed: $rollback_output"
  local rollback_status
  rollback_status=$(remote_helper status)
  read_remote_status "$rollback_status"
  [[ "$REMOTE_CURRENT_SHA" == "$expected_previous"
    && "$REMOTE_PENDING_SHA" == 'none'
    && "$REMOTE_PENDING_LEASE" == 'none' ]] \
    || fail 'pending activation rollback did not restore the expected release cleanly'
}

generate_lease_id() {
  local lease_id
  lease_id=$(openssl rand -hex 16)
  [[ "$lease_id" =~ ^[0-9a-f]{32}$ ]] || fail 'could not generate a safe activation lease'
  printf '%s' "$lease_id"
}

prepare_bundle() {
  local artifact release_cli
  if [[ $test_mode -eq 1 ]]; then
    artifact=$artifact_override
  else
    artifact="$source_dir/dist"
  fi
  [[ -d "$artifact" && ! -L "$artifact" ]] || fail 'Stephen artifact directory is missing or unsafe'
  verify_titles "$artifact"
  if [[ -e "$bundle_dir" || -L "$bundle_dir" ]]; then
    [[ -d "$bundle_dir" && ! -L "$bundle_dir" ]] || fail 'bundle directory is unsafe'
    [[ -z "$(find "$bundle_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
      || fail 'bundle directory must be empty'
  else
    mkdir -m 0700 -p -- "$bundle_dir"
  fi
  ensure_operator_tmp
  local metadata="$artifact/.stephen-release.json"
  local metadata_summary="$bundle_dir/metadata-summary.json"
  local public_metadata="$operator_tmp/public-source-metadata.json"
  if [[ $test_mode -eq 0 ]]; then
    node --experimental-strip-types "$source_dir/scripts/stephen-release-cli.ts" verify \
      --artifact "$artifact" --source-sha "$source_sha" --metadata-file "$metadata" >&2
    [[ -f "$metadata" && ! -L "$metadata" ]] || fail 'public source metadata is missing or unsafe'
    local metadata_bytes
    metadata_bytes=$(wc -c < "$metadata" | tr -d '[:space:]')
    (( metadata_bytes > 0 && metadata_bytes <= 1048576 )) || fail 'public metadata exceeds its safety limit'
    cp -- "$metadata" "$public_metadata"
    jq -e --arg repository "$SOURCE_REPO" --arg source_sha "$source_sha" '
      .sourceRepository == $repository and .sourceSha == $source_sha
        and .schemaVersion == 1 and .task == "SAAS-607"' "$public_metadata" >/dev/null \
      || fail 'public metadata has an unexpected source repository or SHA'
  fi
  # The private exact-SHA validator independently hashes the actual build tree.
  # The public repository cannot replace this final validator with its own script.
  node --experimental-strip-types "$RELEASE_CLI" verify \
    --artifact "$artifact" --source-sha "$source_sha" --metadata-file "$metadata" \
    > "$metadata_summary"
  if [[ $test_mode -eq 0 ]]; then
    jq -e --slurpfile public "$public_metadata" \
      '. == ($public[0] | del(.sourceRepository))' "$metadata" >/dev/null \
      || fail 'public artifact metadata differs from independent private validation'
    cp -- "$public_metadata" "$metadata"
  else
    # Fixture generation only; production always requires the independently compared source metadata.
    jq --arg repository "$SOURCE_REPO" '. + {sourceRepository: $repository}' "$metadata" \
      > "$public_metadata"
    cp -- "$public_metadata" "$metadata"
  fi
  # Add only the reviewed learning paths to the existing finite smoke contract.
  jq '.smokePaths += ["/learn/", "/learn/ai-foundations/", "/learn/knowledge-answers/",
    "/learn/workflow-agents/", "/learn/customer-discovery/", "/learn/value-and-cost/",
    "/learn/pilot-evaluation/", "/learn/adoption-and-governance/", "/learn/career-evidence/", "/library/"]
    | .smokePaths |= unique' "$metadata" > "$public_metadata"
  cp -- "$public_metadata" "$metadata"
  if [[ $test_mode -eq 0 ]]; then
    require_operator_source_alignment
    require_clean_checkout "$source_dir" "$source_sha" "$SOURCE_REPO"
  fi
  local archive_name="stephen-$source_sha.tar.gz"
  local archive="$bundle_dir/$archive_name"
  # Fixed ordering, ownership, permissions, and timestamps keep plan/retry archives identical.
  python3 -I - "$artifact" "$archive" <<'PY_ARCHIVE'
import gzip
import os
import stat
import sys
import tarfile
root, destination = sys.argv[1:]
with open(destination, 'xb') as output:
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for directory, directories, files in os.walk(root, followlinks=False):
                directories.sort()
                for name in directories:
                    if os.path.islink(os.path.join(directory, name)):
                        raise ValueError('archive must not contain symbolic links')
                for name in sorted(files):
                    path = os.path.join(directory, name)
                    if not stat.S_ISREG(os.lstat(path).st_mode):
                        raise ValueError('archive must only contain regular files')
                    relative = os.path.relpath(path, root).replace(os.sep, '/')
                    info = tarfile.TarInfo(relative)
                    info.size = os.path.getsize(path)
                    info.mode = 0o644
                    info.uid = info.gid = info.mtime = 0
                    with open(path, 'rb') as source:
                        archive.addfile(info, source)
PY_ARCHIVE
  [[ -f "$archive" && ! -L "$archive" ]] || fail 'release archive was not created safely'
  local archive_checksum content_checksum
  archive_checksum=$(sha256_file "$archive")
  content_checksum=$(jq -er '.contentChecksum' "$metadata")
  jq -n --arg source_sha "$source_sha" --arg operator_sha "$operator_sha" \
    --arg source_repository "$SOURCE_REPO" --arg operator_repository "$GH_REPO" \
    --arg archive_file "$archive_name" --arg archive_checksum "$archive_checksum" \
    --arg content_checksum "$content_checksum" '{
      schemaVersion: 2, task: "SAAS-607", operatorRepository: $operator_repository,
      operatorSha: $operator_sha, sourceRepository: $source_repository, sourceSha: $source_sha,
      archiveFile: $archive_file, archiveChecksum: $archive_checksum, contentChecksum: $content_checksum
    }' > "$bundle_dir/release-bundle.json"
  printf '%s  %s\n' "$archive_checksum" "$archive_name" > "$bundle_dir/release-bundle.sha256"
  printf '%s  %s\n' "$(sha256_file "$bundle_dir/release-bundle.json")" 'release-bundle.json' \
    >> "$bundle_dir/release-bundle.sha256"
  BUNDLE_ARCHIVE=$archive
  BUNDLE_ARCHIVE_CHECKSUM=$archive_checksum
  BUNDLE_CONTENT_CHECKSUM=$content_checksum
  BUNDLE_METADATA=$metadata
}

read_and_smoke_predecessor() {
  local previous_sha=$1
  if [[ $test_mode -eq 1 ]]; then
    local metadata="$test_root/releases/$previous_sha/.stephen-release.json"
    jq -e --arg sha "$previous_sha" '.schemaVersion == 1 and .task == "SAAS-607"
      and .sourceSha == $sha and (.contentChecksum | type == "string" and test("^[0-9a-f]{64}$"))
      and ((has("sourceRepository") | not) or .sourceRepository == "ZiZ-LG/stephen-knowledge-hub")' \
      "$metadata" >/dev/null || fail 'previous release identity is invalid'
    PREVIOUS_SOURCE_REPOSITORY=$(jq -er 'if has("sourceRepository") then .sourceRepository else "legacy-private" end' "$metadata")
    PREVIOUS_CONTENT_CHECKSUM=$(jq -er '.contentChecksum' "$metadata")
    local smoke_file="$test_root/test-control/preflight-smoke-result"
    [[ ! -f "$smoke_file" || "$(tr -d '[:space:]' < "$smoke_file")" == pass ]] \
      || fail 'read-only current-release or shared-site smoke failed before upload'
    return
  fi
  smoke_current_release "$previous_sha" \
    || fail 'read-only current-release or shared-site smoke failed before upload'
  PREVIOUS_SOURCE_REPOSITORY=$OBSERVED_SOURCE_REPOSITORY
  PREVIOUS_CONTENT_CHECKSUM=$OBSERVED_CONTENT_CHECKSUM
  if [[ "$PREVIOUS_SOURCE_REPOSITORY" == 'legacy-private' ]]; then
    git -C "$REPO_ROOT" cat-file -e "$previous_sha^{commit}" 2>/dev/null \
      && git -C "$REPO_ROOT" merge-base --is-ancestor "$previous_sha" "$operator_sha" \
      || fail 'metadata without a repository is not a known legacy private release'
  fi
}

[[ $# -ge 1 ]] || usage
command_name=$1
shift
case "$command_name" in
  plan|activate|verify|finalize|rollback) ;;
  *) usage ;;
esac

source_dir=''
source_sha=''
operator_sha=''
bundle_dir=''
state_file=''
artifact_override=''
test_root=''

while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 && -n "$2" ]] || usage
  case "$1" in
    --source-dir) [[ -z "$source_dir" ]] || usage; source_dir=$2 ;;
    --source-sha) [[ -z "$source_sha" ]] || usage; source_sha=$2 ;;
    --operator-sha) [[ -z "$operator_sha" ]] || usage; operator_sha=$2 ;;
    --bundle-dir) [[ -z "$bundle_dir" ]] || usage; bundle_dir=$2 ;;
    --state-file) [[ -z "$state_file" ]] || usage; state_file=$2 ;;
    --artifact) [[ -z "$artifact_override" ]] || usage; artifact_override=$2 ;;
    --test-root) [[ -z "$test_root" ]] || usage; test_root=$2 ;;
    *) usage ;;
  esac
  shift 2
done

test_mode=0
if [[ -n "$test_root" || -n "$artifact_override" \
  || "${STEPHEN_LOCAL_RELEASE_TEST_MODE:-}" == '1' ]]; then
  [[ "${STEPHEN_LOCAL_RELEASE_TEST_MODE:-}" == '1' \
    && -n "$test_root" && -n "$artifact_override" ]] \
    || fail 'test mode requires test root, artifact, and STEPHEN_LOCAL_RELEASE_TEST_MODE=1'
  require_absolute_path "$test_root" 'test root'
  case "$test_root" in
    /tmp/*|/private/tmp/*|/var/folders/*) ;;
    *) fail 'test root must be under an operating-system temporary directory' ;;
  esac
  require_absolute_path "$artifact_override" 'artifact'
  test_mode=1
fi

case "$command_name" in
  plan)
    [[ -n "$source_dir" && -n "$source_sha" && -n "$operator_sha" && -n "$bundle_dir" \
      && -z "$state_file" ]] || usage
    require_absolute_path "$source_dir" 'source directory'
    require_absolute_path "$bundle_dir" 'bundle directory'
    require_source_sha "$source_sha"
    require_source_sha "$operator_sha"
    [[ -d "$source_dir" && ! -L "$source_dir" ]] || fail 'source directory is missing or unsafe'
    remote_current_sha='test-only'
    ci_run_url='test-only'
    stephen_check_run_url='test-only'
    source_check_run_url='test-only'
    if [[ $test_mode -eq 0 ]]; then
      transaction_exact_main_gate
      ci_run_url=$CI_RUN_URL
      stephen_check_run_url=$STEPHEN_CHECK_RUN_URL
      source_check_run_url=$SOURCE_CHECK_RUN_URL
      run_quality_gates
    fi
    require_operator_source_alignment
    prepare_bundle
    if [[ $test_mode -eq 0 ]]; then
      transaction_exact_main_gate
      configure_ssh
      remote_status_output=$(remote_helper status)
      read_remote_status "$remote_status_output"
      [[ "$REMOTE_PENDING_SHA" == 'none' && "$REMOTE_PENDING_LEASE" == 'none' ]] \
        || fail 'production has a pending Stephen activation'
      remote_current_sha=$REMOTE_CURRENT_SHA
      require_source_sha "$remote_current_sha"
      read_and_smoke_predecessor "$remote_current_sha"
    fi
    jq -cn \
      --arg source_sha "$source_sha" \
      --arg operator_sha "$operator_sha" \
      --arg source_checks_url "$source_check_run_url" \
      --arg archive_checksum "$BUNDLE_ARCHIVE_CHECKSUM" \
      --arg content_checksum "$BUNDLE_CONTENT_CHECKSUM" \
      --arg current_sha "$remote_current_sha" \
      --arg ci_url "$ci_run_url" \
      --arg stephen_checks_url "$stephen_check_run_url" \
      '{
        schemaVersion: 2,
        task: "SAAS-607",
        operatorRepository: "ZiZ-LG/jianghu",
        operatorSha: $operator_sha,
        sourceRepository: "ZiZ-LG/stephen-knowledge-hub",
        sourceChecksUrl: $source_checks_url,
        command: "plan",
        sourceSha: $source_sha,
        archiveChecksum: $archive_checksum,
        contentChecksum: $content_checksum,
        currentSha: $current_sha,
        ciUrl: $ci_url,
        stephenChecksUrl: $stephen_checks_url,
        releaseState: "PLAN_ONLY",
        productionTouched: false
      }'
    ;;
  activate)
    [[ -n "$source_dir" && -n "$source_sha" && -n "$operator_sha" && -n "$bundle_dir" \
      && -n "$state_file" ]] || usage
    require_absolute_path "$source_dir" 'source directory'
    require_absolute_path "$bundle_dir" 'bundle directory'
    require_absolute_path "$state_file" 'state file'
    require_source_sha "$source_sha"
    require_source_sha "$operator_sha"
    [[ -d "$source_dir" && ! -L "$source_dir" ]] || fail 'source directory is missing or unsafe'
    validate_new_state_target
    [[ "${STEPHEN_PRODUCTION_RELEASE_APPROVAL:-}" == "release:$source_sha" ]] \
      || fail 'exact-SHA production release approval is missing'
    if [[ $test_mode -eq 0 ]]; then
      require_operator_source_alignment
    fi
    transaction_exact_main_gate
    if [[ $test_mode -eq 0 ]]; then
      run_quality_gates
      configure_ssh
    fi
    prepare_bundle
    local_status_output=$(remote_helper status)
    read_remote_status "$local_status_output"
    [[ "$REMOTE_PENDING_SHA" == 'none' && "$REMOTE_PENDING_LEASE" == 'none' ]] \
      || fail 'production has a pending Stephen activation'
    previous_sha=$REMOTE_CURRENT_SHA
    require_source_sha "$previous_sha"
    read_and_smoke_predecessor "$previous_sha"
    lease_id=$(generate_lease_id)

    if [[ "$previous_sha" == "$source_sha" ]]; then
      smoke_candidate_release || fail 'already-active release or shared-site smoke failed'
      create_release_state 'ALREADY_ACTIVE' "$lease_id" "$previous_sha" false true
      jq -c . "$state_file"
      exit 0
    fi

    transaction_exact_main_gate
    create_release_state 'ACTIVATION_INTENT' "$lease_id" "$previous_sha" false false

    update_release_state 'activate' 'UPLOAD_REQUESTED' true false
    upload_archive
    set +e
    stage_output=$(remote_helper stage "$source_sha" "$BUNDLE_ARCHIVE_CHECKSUM" 2>&1)
    stage_rc=$?
    set -e
    if [[ $stage_rc -ne 0 ]] \
      || ! grep -Eq '^stage_status=(staged|already_staged)$' <<< "$stage_output" \
      || ! grep -Fxq "source_sha=$source_sha" <<< "$stage_output"; then
      update_release_state 'activate' 'ACTIVATION_FAILED' true true
      fail "remote stage failed or returned an untrusted response: $stage_output"
    fi
    update_release_state 'activate' 'STAGED' true false
    set +e
    exact_main_output=$( (transaction_exact_main_gate) 2>&1 )
    exact_main_rc=$?
    set -e
    if [[ $exact_main_rc -ne 0 ]]; then
      update_release_state 'activate' 'ACTIVATION_FAILED' true true
      fail "exact-main revalidation failed before activation: $exact_main_output"
    fi
    set +e
    activation_output=$(remote_helper activate "$source_sha" "$lease_id" 2>&1)
    activation_rc=$?
    set -e
    set +e
    reconciliation=$(remote_helper status 2>&1)
    reconciliation_rc=$?
    set -e
    [[ $reconciliation_rc -eq 0 ]] \
      || fail 'activation outcome is ambiguous; retain the state file and run verify'
    read_remote_status "$reconciliation"
    classify_remote_transaction
    if [[ "$REMOTE_TRANSACTION_STATE" == 'PENDING_BROWSER_VERIFICATION' ]]; then
      if [[ $activation_rc -ne 0 ]] \
        || ! grep -Fxq 'activation_status=pending' <<< "$activation_output" \
        || ! grep -Fxq "current_sha=$source_sha" <<< "$activation_output" \
        || ! grep -Fxq "lease_id=$lease_id" <<< "$activation_output"; then
        rollback_pending_activation "$source_sha" "$lease_id" "$previous_sha"
        update_release_state 'rollback' 'ROLLED_BACK' true true
        fail "activation response was untrusted and the exact pending lease was rolled back: $activation_output"
      fi
      if ! smoke_candidate_release; then
        rollback_pending_activation "$source_sha" "$lease_id" "$previous_sha"
        update_release_state 'rollback' 'ROLLED_BACK' true true
        fail 'candidate smoke failed and the pending activation was rolled back'
      fi
      update_release_state 'activate' 'PENDING_BROWSER_VERIFICATION' true false
      jq -c . "$state_file"
      exit 0
    fi
    if [[ "$REMOTE_TRANSACTION_STATE" == 'ROLLED_BACK' ]]; then
      update_release_state 'activate' 'ACTIVATION_FAILED' true true
      fail "Stephen activation failed without leaving a pending lease: $activation_output"
    fi
    fail 'activation outcome could not be reconciled safely; retain the state file and run verify'
    ;;
  finalize)
    [[ -n "$source_dir" && -n "$state_file"
      && -z "$source_sha" && -z "$operator_sha" && -z "$bundle_dir" ]] || usage
    require_absolute_path "$source_dir" 'source directory'
    require_absolute_path "$state_file" 'state file'
    [[ -d "$source_dir" && ! -L "$source_dir" ]] \
      || fail 'source directory is missing or unsafe'
    load_release_state
    require_finalizable_release_state
    [[ "${STEPHEN_BROWSER_VERIFICATION:-}" \
      == "verified:$source_sha:$STATE_LEASE_ID" ]] \
      || fail 'exact browser verification evidence is missing'

    require_operator_source_alignment
    if [[ $test_mode -eq 0 ]]; then configure_ssh; fi
    final_status=$(remote_helper status)
    read_remote_status "$final_status"
    classify_remote_transaction
    if [[ "$REMOTE_TRANSACTION_STATE" == 'FINALIZED' ]]; then
      transaction_exact_main_gate
      smoke_candidate_release \
        || fail 'reconciled final release or shared-site smoke failed'
      update_release_state 'finalize' 'FINALIZED' true true
      jq -c . "$state_file"
      exit 0
    fi
    if [[ "$REMOTE_TRANSACTION_STATE" == 'ROLLED_BACK' ]]; then
      update_release_state 'rollback' 'ROLLED_BACK' true true
      fail 'pending activation expired or rolled back before finalize'
    fi
    [[ "$REMOTE_TRANSACTION_STATE" == 'PENDING_BROWSER_VERIFICATION' ]] \
      || fail 'remote transaction does not match the local release state'

    set +e
    exact_main_output=$( (transaction_exact_main_gate) 2>&1 )
    exact_main_rc=$?
    set -e
    if [[ $exact_main_rc -ne 0 ]]; then
      rollback_pending_activation "$source_sha" "$STATE_LEASE_ID" "$STATE_PREVIOUS_SHA"
      update_release_state 'rollback' 'ROLLED_BACK' true true
      fail "exact-main revalidation failed; pending activation was rolled back: $exact_main_output"
    fi
    if ! smoke_candidate_release; then
      rollback_pending_activation "$source_sha" "$STATE_LEASE_ID" "$STATE_PREVIOUS_SHA"
      update_release_state 'rollback' 'ROLLED_BACK' true true
      fail 'final candidate smoke failed and the pending activation was rolled back'
    fi
    set +e
    exact_main_output=$( (transaction_exact_main_gate) 2>&1 )
    exact_main_rc=$?
    set -e
    if [[ $exact_main_rc -ne 0 ]]; then
      rollback_pending_activation "$source_sha" "$STATE_LEASE_ID" "$STATE_PREVIOUS_SHA"
      update_release_state 'rollback' 'ROLLED_BACK' true true
      fail "exact-main revalidation failed after smoke; pending activation was rolled back: $exact_main_output"
    fi

    update_release_state 'finalize' 'FINALIZE_REQUESTED' true false
    set +e
    finalization_output=$(remote_helper finalize "$source_sha" "$STATE_LEASE_ID" 2>&1)
    finalization_rc=$?
    set -e
    finalization_response='untrusted'
    if [[ $finalization_rc -eq 0 ]] \
      && grep -Fxq 'finalize_status=finalized' <<< "$finalization_output" \
      && grep -Fxq "current_sha=$source_sha" <<< "$finalization_output" \
      && grep -Fxq "lease_id=$STATE_LEASE_ID" <<< "$finalization_output"; then
      finalization_response='acknowledged'
    fi
    set +e
    reconciliation=$(remote_helper status 2>&1)
    reconciliation_rc=$?
    set -e
    [[ $reconciliation_rc -eq 0 ]] \
      || fail 'finalize outcome is ambiguous; retain the state file and rerun verify or finalize'
    read_remote_status "$reconciliation"
    classify_remote_transaction
    case "$REMOTE_TRANSACTION_STATE" in
      FINALIZED)
        update_release_state 'finalize' 'FINALIZED' true true
        jq -c . "$state_file"
        ;;
      ROLLED_BACK)
        update_release_state 'rollback' 'ROLLED_BACK' true true
        fail "pending activation expired or rolled back during finalize ($finalization_response response)"
        ;;
      PENDING_BROWSER_VERIFICATION)
        rollback_pending_activation "$source_sha" "$STATE_LEASE_ID" "$STATE_PREVIOUS_SHA"
        update_release_state 'rollback' 'ROLLED_BACK' true true
        fail "finalize did not commit and the pending activation was rolled back ($finalization_response response)"
        ;;
      *)
        fail "finalize outcome could not be reconciled safely ($finalization_response response)"
        ;;
    esac
    ;;
  rollback)
    [[ -n "$state_file" && -z "$source_dir" && -z "$source_sha" && -z "$operator_sha"
      && -z "$bundle_dir" ]] || usage
    require_absolute_path "$state_file" 'state file'
    load_release_state
    require_finalizable_release_state
    [[ "${STEPHEN_PRODUCTION_ROLLBACK_APPROVAL:-}" \
      == "rollback:$source_sha:$STATE_LEASE_ID" ]] \
      || fail 'exact pending-lease rollback approval is missing'
    require_operator_checkout_for_state
    if [[ $test_mode -eq 0 ]]; then configure_ssh; fi
    rollback_status_output=$(remote_helper status)
    read_remote_status "$rollback_status_output"
    classify_remote_transaction
    if [[ "$REMOTE_TRANSACTION_STATE" == 'PENDING_BROWSER_VERIFICATION' ]]; then
      rollback_pending_activation "$source_sha" "$STATE_LEASE_ID" "$STATE_PREVIOUS_SHA"
    elif [[ "$REMOTE_TRANSACTION_STATE" == 'ROLLED_BACK' ]]; then
      : # Expiry or a retried operator already completed the exact rollback.
    else
      fail 'remote state does not match the exact pending rollback request'
    fi
    update_release_state 'rollback' 'ROLLED_BACK' true true
    if ! smoke_current_release "$STATE_PREVIOUS_SHA" "$PREVIOUS_CONTENT_CHECKSUM" "$PREVIOUS_SOURCE_REPOSITORY"; then
      fail 'rollback completed, but restored-release or shared-site smoke failed'
    fi
    jq -c . "$state_file"
    ;;
  verify)
    [[ -n "$state_file" && -z "$source_dir" && -z "$source_sha" && -z "$operator_sha"
      && -z "$bundle_dir" ]] || usage
    require_absolute_path "$state_file" 'state file'
    load_release_state
    require_operator_checkout_for_state
    if [[ $test_mode -eq 0 ]]; then configure_ssh; fi
    verification_status=$(remote_helper status)
    read_remote_status "$verification_status"
    observed_release_state=''
    case "$STATE_RELEASE_STATE" in
      ACTIVATION_INTENT|UPLOAD_REQUESTED|STAGED|PENDING_BROWSER_VERIFICATION|FINALIZE_REQUESTED)
        classify_remote_transaction
        case "$REMOTE_TRANSACTION_STATE" in
          PENDING_BROWSER_VERIFICATION)
            observed_release_state='PENDING_BROWSER_VERIFICATION'
            smoke_candidate_release \
              || fail 'pending release or shared-site verification smoke failed'
            ;;
          FINALIZED)
            observed_release_state='FINALIZED'
            smoke_candidate_release \
              || fail 'reconciled final release or shared-site verification smoke failed'
            ;;
          ROLLED_BACK)
            if [[ "$STATE_RELEASE_STATE" == 'ACTIVATION_INTENT' \
              || "$STATE_RELEASE_STATE" == 'UPLOAD_REQUESTED' \
              || "$STATE_RELEASE_STATE" == 'STAGED' ]]; then
              observed_release_state='NO_ACTIVE_TRANSACTION'
            else
              observed_release_state='ROLLED_BACK'
            fi
            smoke_current_release "$STATE_PREVIOUS_SHA" "$PREVIOUS_CONTENT_CHECKSUM" "$PREVIOUS_SOURCE_REPOSITORY" \
              || fail 'restored release or shared-site verification smoke failed'
            ;;
          *) fail 'in-flight release verification found inconsistent remote state' ;;
        esac
        ;;
      FINALIZED)
        [[ "$REMOTE_CURRENT_SHA" == "$source_sha"
          && "$REMOTE_PREVIOUS_SHA" == "$STATE_PREVIOUS_SHA"
          && "$REMOTE_PENDING_SHA" == 'none'
          && "$REMOTE_PENDING_LEASE" == 'none' ]] \
          || fail 'final release verification found inconsistent remote state'
        observed_release_state='FINALIZED'
        if [[ $test_mode -eq 1 ]]; then
          smoke_candidate_release || fail 'final release verification smoke failed'
        else
          smoke_current_release "$source_sha" "$BUNDLE_CONTENT_CHECKSUM" "$SOURCE_REPO" \
            || fail 'final release or shared-site verification smoke failed'
        fi
        ;;
      ALREADY_ACTIVE)
        [[ "$REMOTE_CURRENT_SHA" == "$source_sha"
          && "$REMOTE_PENDING_SHA" == 'none'
          && "$REMOTE_PENDING_LEASE" == 'none' ]] \
          || fail 'already-active release verification found inconsistent remote state'
        observed_release_state='ALREADY_ACTIVE'
        if [[ $test_mode -eq 1 ]]; then
          smoke_candidate_release || fail 'already-active release verification smoke failed'
        else
          smoke_current_release "$source_sha" "$BUNDLE_CONTENT_CHECKSUM" "$SOURCE_REPO" \
            || fail 'already-active release or shared-site verification smoke failed'
        fi
        ;;
      ROLLED_BACK)
        [[ "$REMOTE_CURRENT_SHA" == "$STATE_PREVIOUS_SHA"
          && "$REMOTE_PENDING_SHA" == 'none'
          && "$REMOTE_PENDING_LEASE" == 'none' ]] \
          || fail 'rolled-back release verification found inconsistent remote state'
        smoke_current_release "$STATE_PREVIOUS_SHA" "$PREVIOUS_CONTENT_CHECKSUM" "$PREVIOUS_SOURCE_REPOSITORY" \
          || fail 'restored release or shared-site verification smoke failed'
        observed_release_state='ROLLED_BACK'
        ;;
      ACTIVATION_FAILED)
        [[ "$REMOTE_CURRENT_SHA" == "$STATE_PREVIOUS_SHA"
          && "$REMOTE_PENDING_SHA" == 'none'
          && "$REMOTE_PENDING_LEASE" == 'none' ]] \
          || fail 'failed activation verification found inconsistent remote state'
        observed_release_state='ACTIVATION_FAILED'
        ;;
      *) fail 'unsupported release state' ;;
    esac
    jq -cn \
      --arg source_sha "$source_sha" \
      --arg operator_sha "$operator_sha" \
      --arg lease_id "$STATE_LEASE_ID" \
      --arg release_state "$STATE_RELEASE_STATE" \
      --arg observed_release_state "$observed_release_state" \
      --arg current_sha "$REMOTE_CURRENT_SHA" \
      --arg pending_sha "$REMOTE_PENDING_SHA" \
      --arg pending_lease "$REMOTE_PENDING_LEASE" \
      '{
        schemaVersion: 2,
        task: "SAAS-607",
        operatorRepository: "ZiZ-LG/jianghu",
        operatorSha: $operator_sha,
        sourceRepository: "ZiZ-LG/stephen-knowledge-hub",
        command: "verify",
        sourceSha: $source_sha,
        leaseId: $lease_id,
        releaseState: $release_state,
        observedReleaseState: $observed_release_state,
        currentSha: $current_sha,
        pendingSourceSha: $pending_sha,
        pendingLeaseId: $pending_lease,
        productionTouched: false
      }'
    ;;
esac
