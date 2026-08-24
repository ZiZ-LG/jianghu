#!/usr/bin/env bash
# SAAS-107 public-edge release guard.
#
# This command is intentionally unable to mutate Aliyun while the committed
# public-home target has no single authoritative source build and the active
# edge does not consume an atomic release pointer. It has no registry override
# and no hidden bypass. A later, separately approved shared-runtime task must
# close both machine-readable gates before implementing the version-directory
# upload, same-filesystem pointer rename, full smoke matrix, and rollback path.
set -Eeuo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
VERIFIER="$REPO_ROOT/scripts/verify-public-site-artifact.mjs"

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy/aliyun-edge-release.sh \
    --site public-home \
    --artifact /absolute/versioned/artifact \
    --source-dir /absolute/clean/git/worktree \
    --source-sha <40-lowercase-hex> \
    --build-command '<exact command>' \
    [--execute]

Plan mode is read-only. --execute additionally requires the literal environment
confirmation HOMEPAGE_DEPLOY_APPROVED=YES and still fails closed until both the
source-authority and atomic-runtime-authority gates are committed as ready.
USAGE
  exit 2
}

site=''
artifact=''
source_dir=''
source_sha=''
build_command=''
execute=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --site|--artifact|--source-dir|--source-sha|--build-command)
      [[ $# -ge 2 && -n "$2" ]] || usage
      case "$1" in
        --site) [[ -z "$site" ]] || usage; site=$2 ;;
        --artifact) [[ -z "$artifact" ]] || usage; artifact=$2 ;;
        --source-dir) [[ -z "$source_dir" ]] || usage; source_dir=$2 ;;
        --source-sha) [[ -z "$source_sha" ]] || usage; source_sha=$2 ;;
        --build-command) [[ -z "$build_command" ]] || usage; build_command=$2 ;;
      esac
      shift 2
      ;;
    --execute)
      [[ $execute -eq 0 ]] || usage
      execute=1
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$site" == public-home ]] || {
  echo 'PUBLIC_SITE_RELEASE_ERROR=this guard only manages public-home' >&2
  exit 2
}
[[ -n "$artifact" && -n "$source_dir" && -n "$source_sha" && -n "$build_command" ]] || usage

verifier_args=(
  "$VERIFIER"
  --site "$site"
  --artifact "$artifact"
  --source-dir "$source_dir"
  --source-sha "$source_sha"
  --build-command "$build_command"
)

set +e
inspection_report=$(node "${verifier_args[@]}" 2>&1)
inspection_status=$?
set -e
if [[ $inspection_status -ne 0 ]]; then
  printf '%s\n' "$inspection_report" >&2
  exit "$inspection_status"
fi

printf '%s' "$inspection_report" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const report = JSON.parse(input);
    for (const [key, value] of [
      ["source_sha", report.sourceSha],
      ["build_command", report.buildCommand],
      ["artifact_path", report.artifactPath],
      ["artifact_checksum", report.artifactChecksum],
      ["destination_host", report.destinationHost],
      ["destination_path", report.destinationPath],
      ["canonical_url", report.canonicalUrl],
      ["title", report.title],
      ["deploy_allowed", String(report.deployAllowed)],
    ]) console.log(`${key}=${value}`);
  });
'

if [[ $execute -eq 0 ]]; then
  echo 'release_mode=PLAN_ONLY'
  echo 'production_touched=NO'
  exit 0
fi

[[ "${HOMEPAGE_DEPLOY_APPROVED:-}" == YES ]] || {
  echo 'PUBLIC_SITE_RELEASE_ERROR=explicit production deployment approval token is missing' >&2
  exit 1
}

set +e
deployment_report=$(node "${verifier_args[@]}" --for-deploy 2>&1)
deployment_status=$?
set -e
if [[ $deployment_status -ne 0 ]]; then
  echo "PUBLIC_SITE_RELEASE_BLOCKED=${deployment_report#PUBLIC_SITE_ARTIFACT_ERROR=}" >&2
  exit "$deployment_status"
fi

# Reaching this branch would mean the committed registry was enabled without
# the separately reviewed atomic executor being present. That is itself a
# deployment-blocking configuration error, not permission to improvise SSH.
echo 'PUBLIC_SITE_RELEASE_BLOCKED=registry is enabled but the approved atomic executor is not implemented' >&2
exit 1
