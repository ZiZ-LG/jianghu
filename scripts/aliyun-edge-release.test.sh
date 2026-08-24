#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
GUARD="$REPO_ROOT/deploy/aliyun-edge-release.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/jianghu-edge-release-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local value=$1 expected=$2
  [[ "$value" == *"$expected"* ]] || fail "expected output to contain: $expected"
}

SOURCE_DIR="$TEST_ROOT/source"
ARTIFACT_DIR="$TEST_ROOT/public-home"
WRONG_ARTIFACT_DIR="$TEST_ROOT/legacy-crm"
FAKE_BIN="$TEST_ROOT/bin"
SSH_SENTINEL="$TEST_ROOT/ssh-invoked"
mkdir -p "$SOURCE_DIR" "$ARTIFACT_DIR/assets" "$WRONG_ARTIFACT_DIR/assets" "$FAKE_BIN"

git -C "$SOURCE_DIR" init -q
printf '%s\n' 'fixture source' > "$SOURCE_DIR/README.md"
git -C "$SOURCE_DIR" add README.md
git -C "$SOURCE_DIR" -c user.name='Jianghu Test' -c user.email='jianghu-test@example.invalid' \
  commit -q -m 'fixture source'
SOURCE_SHA=$(git -C "$SOURCE_DIR" rev-parse HEAD)

printf '%s' '<!doctype html><html><head><title>江湖 CRM｜自在江湖客户管理</title><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/beian-police.png"></head><body><script type="module" src="/assets/app.js"></script></body></html>' > "$ARTIFACT_DIR/index.html"
printf '%s\n' ':root{color:#123}' > "$ARTIFACT_DIR/assets/app.css"
printf '%s' '首页|自我修养|江湖 CRM|卧虎藏龙|进入江湖 CRM|https://crm.lake2ocean.top|京ICP备2026046195号-2|京公网安备11010802049879号' > "$ARTIFACT_DIR/assets/app.js"
printf '%s' 'fixture-police-icon' > "$ARTIFACT_DIR/beian-police.png"

printf '%s' '<!doctype html><html><head><title>江湖 · Game of JiangHu</title><link rel="stylesheet" href="/assets/app.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>' > "$WRONG_ARTIFACT_DIR/index.html"
printf '%s\n' ':root{color:#123}' > "$WRONG_ARTIFACT_DIR/assets/app.css"
printf '%s' '注册新工作区|销售干系人作战地图|轻量客户与事项' > "$WRONG_ARTIFACT_DIR/assets/app.js"

printf '%s\n' '#!/usr/bin/env bash' 'touch "$SSH_SENTINEL"' > "$FAKE_BIN/ssh"
chmod +x "$FAKE_BIN/ssh"
export SSH_SENTINEL
export PATH="$FAKE_BIN:$PATH"

COMMON_ARGS=(
  --site public-home
  --source-dir "$SOURCE_DIR"
  --source-sha "$SOURCE_SHA"
  --build-command 'npm run build (recovery lineage only)'
)

plan_output=$(bash "$GUARD" "${COMMON_ARGS[@]}" --artifact "$ARTIFACT_DIR" 2>&1) \
  || fail "valid plan mode failed: $plan_output"
assert_contains "$plan_output" "source_sha=$SOURCE_SHA"
assert_contains "$plan_output" 'build_command=npm run build (recovery lineage only)'
assert_contains "$plan_output" 'artifact_path='
assert_contains "$plan_output" 'artifact_checksum='
assert_contains "$plan_output" 'destination_host=admin@47.95.13.214'
assert_contains "$plan_output" 'destination_path=/usr/share/nginx/jianghu'
assert_contains "$plan_output" 'canonical_url=https://lake2ocean.top/'
assert_contains "$plan_output" 'title=江湖 CRM｜自在江湖客户管理'
assert_contains "$plan_output" 'release_mode=PLAN_ONLY'
assert_contains "$plan_output" 'production_touched=NO'
[[ ! -e "$SSH_SENTINEL" ]] || fail 'plan mode invoked ssh'

set +e
wrong_output=$(bash "$GUARD" "${COMMON_ARGS[@]}" --artifact "$WRONG_ARTIFACT_DIR" 2>&1)
wrong_status=$?
set -e
[[ $wrong_status -ne 0 ]] || fail 'legacy CRM artifact was accepted for the public homepage'
assert_contains "$wrong_output" 'PUBLIC_SITE_ARTIFACT_ERROR='
[[ ! -e "$SSH_SENTINEL" ]] || fail 'wrong artifact reached ssh'

set +e
unapproved_output=$(bash "$GUARD" "${COMMON_ARGS[@]}" --artifact "$ARTIFACT_DIR" --execute 2>&1)
unapproved_status=$?
set -e
[[ $unapproved_status -ne 0 ]] || fail 'execute without approval token succeeded'
assert_contains "$unapproved_output" 'PUBLIC_SITE_RELEASE_ERROR=explicit production deployment approval token is missing'
[[ ! -e "$SSH_SENTINEL" ]] || fail 'unapproved execute reached ssh'

set +e
blocked_output=$(HOMEPAGE_DEPLOY_APPROVED=YES bash "$GUARD" "${COMMON_ARGS[@]}" --artifact "$ARTIFACT_DIR" --execute 2>&1)
blocked_status=$?
set -e
[[ $blocked_status -ne 0 ]] || fail 'execute succeeded while deployment authorities are unresolved'
assert_contains "$blocked_output" 'PUBLIC_SITE_RELEASE_BLOCKED='
assert_contains "$blocked_output" 'source authority is unresolved'
assert_contains "$blocked_output" 'atomic runtime authority is unavailable'
[[ ! -e "$SSH_SENTINEL" ]] || fail 'blocked execute reached ssh'

echo 'ALIYUN_EDGE_RELEASE_GUARD_OK=1'
