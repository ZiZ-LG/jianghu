/// <reference path="./node-runtime.d.ts" />

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface StephenArtifactEntry {
  readonly path: string;
  readonly type: 'file' | 'symlink' | 'directory' | 'other';
  readonly bytes: Uint8Array;
}

export interface StephenReleaseFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface StephenReleaseMetadata {
  readonly schemaVersion: 1;
  readonly task: 'SAAS-607';
  readonly sourceSha: string;
  readonly fileCount: number;
  readonly contentChecksum: string;
  readonly smokePaths: readonly string[];
  readonly files: readonly StephenReleaseFile[];
}

export interface StephenReleaseVerifyCommand {
  readonly command: 'verify';
  readonly artifactDirectory: string;
  readonly sourceSha: string;
  readonly metadataFile: string;
}

export interface VerifyStephenArtifactInput {
  readonly artifactDirectory: string;
  readonly sourceSha: string;
  readonly metadataFile: string;
}

const requiredFiles = [
  'index.html',
  'fieldbook/index.html',
  'beian-police.png',
  'robots.txt',
  'sitemap.xml',
] as const;

const requiredMarkers = [
  'AI 技术',
  '大客户销售',
  '岗位组织转型',
  '京ICP备2026046195号-2',
  '京公网安备11010802049879号',
] as const;

const forbiddenEditorialStates = [
  'pending_owner_review',
  'not_published',
] as const;

const requiredSmokePaths = ['/', '/digest/', '/policy/', '/fieldbook/'] as const;
const MAX_ARTIFACT_FILES = 1000;
const MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_PATH_SEGMENTS = 16;

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function requireSourceSha(sourceSha: string) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('source SHA must be 40 lowercase hexadecimal characters');
  }
}

function invalidCliArguments(): never {
  throw new Error('invalid SAAS-607 CLI arguments');
}

export function parseStephenReleaseCliArgs(
  argv: readonly string[],
): StephenReleaseVerifyCommand {
  const [command, ...optionValues] = argv;
  if (command !== 'verify' || optionValues.length !== 6) invalidCliArguments();
  const options = new Map<string, string>();
  for (let index = 0; index < optionValues.length; index += 2) {
    const key = optionValues[index];
    const value = optionValues[index + 1];
    if (!key?.startsWith('--') || !value || options.has(key)) invalidCliArguments();
    options.set(key, value);
  }
  if (options.size !== 3
    || !options.has('--artifact')
    || !options.has('--source-sha')
    || !options.has('--metadata-file')) invalidCliArguments();

  const artifactDirectory = options.get('--artifact')!;
  const sourceSha = options.get('--source-sha')!;
  const metadataFile = options.get('--metadata-file')!;
  if (!isAbsolute(artifactDirectory)
    || artifactDirectory === '/'
    || resolve(artifactDirectory) !== artifactDirectory
    || !isAbsolute(metadataFile)
    || resolve(metadataFile) !== metadataFile
    || metadataFile !== resolve(artifactDirectory, '.stephen-release.json')) {
    invalidCliArguments();
  }
  try {
    requireSourceSha(sourceSha);
  } catch {
    invalidCliArguments();
  }
  return { command, artifactDirectory, sourceSha, metadataFile };
}

function requireSafeArtifactPath(path: string) {
  if (!path
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || !/^[A-Za-z0-9._/-]+$/.test(path)
    || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`artifact path is unsafe: ${path}`);
  }
}

function decodeTextEntries(entries: readonly StephenArtifactEntry[]) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return entries
    .filter((entry) => /\.(?:html|js|css|txt|xml|svg|json)$/.test(entry.path))
    .map((entry) => {
      try {
        return decoder.decode(entry.bytes);
      } catch {
        throw new Error(`artifact text file is not valid UTF-8: ${entry.path}`);
      }
    })
    .join('\n');
}

function sitemapSmokePaths(sitemap: string) {
  const paths = new Set<string>();
  for (const match of sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      throw new Error('artifact sitemap contains an invalid URL');
    }
    if (url.protocol !== 'https:' || url.hostname !== 'stephen.lake2ocean.top') {
      throw new Error('artifact sitemap contains a URL outside the canonical Stephen origin');
    }
    if (url.search || url.hash) {
      throw new Error('artifact sitemap paths must not contain query strings or fragments');
    }
    paths.add(url.pathname);
  }

  for (const required of requiredSmokePaths) {
    if (!paths.has(required)) {
      throw new Error(`artifact sitemap is missing required path: ${required}`);
    }
  }
  const detailPaths = [...paths]
    .filter((path) => path.startsWith('/items/') && path.length > '/items/'.length)
    .sort((left, right) => left.localeCompare(right));
  if (detailPaths.length === 0) {
    throw new Error('artifact sitemap has no public item detail path');
  }
  return [...requiredSmokePaths, ...detailPaths];
}

export function buildStephenReleaseMetadata(
  entries: readonly StephenArtifactEntry[],
  sourceSha: string,
): StephenReleaseMetadata {
  requireSourceSha(sourceSha);
  if (entries.length === 0) throw new Error('artifact is empty');
  if (entries.length > MAX_ARTIFACT_FILES) {
    throw new Error('artifact exceeds the 1000-file safety limit');
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    requireSafeArtifactPath(entry.path);
    if (entry.path.split('/').length > MAX_ARTIFACT_PATH_SEGMENTS) {
      throw new Error('artifact path exceeds the 16-segment depth limit');
    }
    if (entry.type !== 'file') {
      throw new Error(`artifact entries must be regular files: ${entry.path}`);
    }
    if (entry.bytes.byteLength > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error('artifact file exceeds the 8 MiB safety limit');
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > MAX_ARTIFACT_BYTES) {
      throw new Error('artifact exceeds the 16 MiB total-size safety limit');
    }
    if (paths.has(entry.path)) throw new Error(`artifact path is duplicated: ${entry.path}`);
    paths.add(entry.path);
  }
  for (const required of requiredFiles) {
    if (!paths.has(required)) throw new Error(`artifact is missing required file: ${required}`);
    if (entries.find((entry) => entry.path === required)?.bytes.byteLength === 0) {
      throw new Error(`required artifact file is empty: ${required}`);
    }
  }

  const text = decodeTextEntries(entries);
  for (const marker of requiredMarkers) {
    if (!text.includes(marker)) throw new Error(`artifact is missing required marker: ${marker}`);
  }
  for (const state of forbiddenEditorialStates) {
    if (text.includes(state)) {
      throw new Error(`artifact contains non-public editorial state: ${state}`);
    }
  }

  const sitemapEntry = entries.find((entry) => entry.path === 'sitemap.xml');
  if (!sitemapEntry) throw new Error('artifact is missing required file: sitemap.xml');
  let sitemap: string;
  try {
    sitemap = new TextDecoder('utf-8', { fatal: true }).decode(sitemapEntry.bytes);
  } catch {
    throw new Error('artifact text file is not valid UTF-8: sitemap.xml');
  }

  const files = entries
    .map((entry) => ({
      path: entry.path,
      size: entry.bytes.byteLength,
      sha256: sha256(entry.bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const checksumInput = files
    .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
    .join('');

  return {
    schemaVersion: 1,
    task: 'SAAS-607',
    sourceSha,
    fileCount: files.length,
    contentChecksum: sha256(checksumInput),
    smokePaths: sitemapSmokePaths(sitemap),
    files,
  };
}

async function collectArtifactEntries(
  artifactDirectory: string,
  metadataFile: string,
): Promise<StephenArtifactEntry[]> {
  const entries: StephenArtifactEntry[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    const children = [...await readdir(directory, { withFileTypes: true })]
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      const artifactPath = relative(artifactDirectory, absolutePath);
      if (absolutePath === metadataFile) continue;
      requireSafeArtifactPath(artifactPath);
      if (child.isDirectory()) {
        await visit(absolutePath);
      } else if (child.isFile()) {
        if (entries.length >= MAX_ARTIFACT_FILES) {
          throw new Error('artifact exceeds the 1000-file safety limit');
        }
        if (artifactPath.split('/').length > MAX_ARTIFACT_PATH_SEGMENTS) {
          throw new Error('artifact path exceeds the 16-segment depth limit');
        }
        const file = await lstat(absolutePath);
        if (!file.isFile() || file.isSymbolicLink()) {
          throw new Error(`artifact entries must be regular files: ${artifactPath}`);
        }
        if (file.size > MAX_ARTIFACT_FILE_BYTES) {
          throw new Error('artifact file exceeds the 8 MiB safety limit');
        }
        totalBytes += file.size;
        if (totalBytes > MAX_ARTIFACT_BYTES) {
          throw new Error('artifact exceeds the 16 MiB total-size safety limit');
        }
        const bytes = await readFile(absolutePath);
        if (bytes.byteLength !== file.size) {
          throw new Error(`artifact file changed while being read: ${artifactPath}`);
        }
        entries.push({
          path: artifactPath,
          type: 'file',
          bytes,
        });
      } else if (child.isSymbolicLink()) {
        entries.push({ path: artifactPath, type: 'symlink', bytes: new Uint8Array() });
      } else {
        entries.push({ path: artifactPath, type: 'other', bytes: new Uint8Array() });
      }
    }
  }

  await visit(artifactDirectory);
  return entries;
}

export async function verifyStephenArtifactDirectory(
  input: VerifyStephenArtifactInput,
): Promise<StephenReleaseMetadata> {
  const command = parseStephenReleaseCliArgs([
    'verify',
    '--artifact', input.artifactDirectory,
    '--source-sha', input.sourceSha,
    '--metadata-file', input.metadataFile,
  ]);
  const root = await lstat(command.artifactDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('artifact root must be a real directory');
  }
  const metadata = buildStephenReleaseMetadata(
    await collectArtifactEntries(command.artifactDirectory, command.metadataFile),
    command.sourceSha,
  );
  await writeFile(command.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return metadata;
}

function topLevelWorkflowBlock(workflow: string, key: string) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return [];
  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    block.push(line);
  }
  return block;
}

function workflowJobBlock(workflow: string, key: string) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${key}:`);
  if (start < 0) return '';
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function hasExecutableWorkflowLine(block: string, command: string) {
  return block.split(/\r?\n/).some((line) => line.trim() === command);
}

function executableWorkflowLineCount(block: string, command: string) {
  return block.split(/\r?\n/).filter((line) => line.trim() === command).length;
}

export function validateStephenReleaseWorkflow(workflow: string) {
  if (!/^\s{2}workflow_run:\s*$/m.test(workflow)
    || !/^\s{4}workflows:\s*\[['"]CI['"]\]\s*$/m.test(workflow)
    || !/^\s{4}types:\s*\[completed\]\s*$/m.test(workflow)) {
    throw new Error('release workflow must follow completed CI runs');
  }
  if (/^\s{2}(?:push|pull_request|pull_request_target|schedule|workflow_dispatch):/m
    .test(workflow)) {
    throw new Error('release workflow may only use workflow_run');
  }
  const runners = [...workflow.matchAll(/^\s*runs-on:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  if (runners.length !== 3 || runners.some((runner) => runner !== 'ubuntu-latest')) {
    throw new Error('release workflow runners must be ubuntu-latest');
  }
  const permissions = topLevelWorkflowBlock(workflow, 'permissions')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const expectedPermissions = ['actions: read', 'contents: read'];
  if (permissions.length !== expectedPermissions.length
    || expectedPermissions.some((entry) => !permissions.includes(entry))) {
    throw new Error('release workflow permissions must be minimal');
  }
  if (!/^concurrency:\s*$/m.test(workflow)
    || !/^\s+group:\s*stephen-production-release\s*$/m.test(workflow)
    || !/^\s+cancel-in-progress:\s*false\s*$/m.test(workflow)) {
    throw new Error('production releases must be serialized');
  }
  const timeouts = [...workflow.matchAll(/^\s+timeout-minutes:\s*(\d+)\s*$/gm)]
    .map((match) => Number(match[1]));
  if (timeouts.length !== 3
    || timeouts.some((timeout) => timeout < 1 || timeout > 60)) {
    throw new Error('release jobs need bounded timeouts');
  }
  if (!workflow.includes("vars.STEPHEN_RELEASE_ENABLED == '1'")) {
    throw new Error('production release must require explicit repository opt-in');
  }
  if ((workflow.split('actions/variables/STEPHEN_RELEASE_ENABLED').length - 1) < 2
    || (workflow.split('confirm_current_release_authorization').length - 1) < 4) {
    throw new Error('release job must re-read authorization after waiting and before finalize');
  }
  if ((workflow.split('RELEASE_CONTROL_TOKEN: ${{ secrets.STEPHEN_RELEASE_CONTROL_TOKEN }}').length - 1) !== 2
    || (workflow.split('GH_TOKEN="$RELEASE_CONTROL_TOKEN" gh api').length - 1) !== 2) {
    throw new Error('release authorization checks require the environment-scoped control token');
  }
  for (const condition of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ]) {
    if (!workflow.includes(condition)) {
      throw new Error('release eligibility must bind to a successful main CI run in this repository');
    }
  }
  if ((workflow.split('ref: ${{ github.event.workflow_run.head_sha }}').length - 1) !== 1
    || (workflow.split('ref: ${{ needs.eligibility.outputs.source_sha }}').length - 1) !== 1
    || (workflow.split('repos/$GH_REPO/git/ref/heads/main').length - 1) < 3
    || !workflow.includes('git rev-parse HEAD')
    || !workflow.includes('"$remote_main_sha" == "$SOURCE_SHA"')
    || !workflow.includes('"$checked_out_sha" == "$SOURCE_SHA"')
    || workflow.includes('git fetch --no-tags origin')) {
    throw new Error('release checkout must remain bound to the exact current main SHA');
  }
  if (!workflow.includes('git diff --name-only -z "$SOURCE_SHA^1" "$SOURCE_SHA"')
    || !workflow.includes('app/stephen/review-candidates/')) {
    throw new Error('release eligibility must report relevant first-parent paths');
  }
  if (!hasExecutableWorkflowLine(workflow, 'release_allowed=true')
    || workflow.includes('release_allowed=false')) {
    throw new Error('release eligibility must coalesce every exact green current main');
  }
  if (!workflow.includes('actions/workflows/stephen-checks.yml/runs')
    || !workflow.includes('--arg source_sha "$SOURCE_SHA"')
    || !workflow.includes('[[ "$conclusion" == "success" ]]')) {
    throw new Error('release eligibility must confirm Stephen checks for the exact SHA');
  }
  const actions = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  const checkoutAction = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
  const setupNodeAction = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
  const uploadArtifactAction = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
  const downloadArtifactAction = 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';
  if (actions.length !== 5
    || actions.filter((action) => action === checkoutAction).length !== 2
    || actions.filter((action) => action === setupNodeAction).length !== 1
    || actions.filter((action) => action === uploadArtifactAction).length !== 1
    || actions.filter((action) => action === downloadArtifactAction).length !== 1) {
    throw new Error('release workflow actions must be pinned build and artifact-transfer commits');
  }
  const buildJob = workflowJobBlock(workflow, 'build');
  const deployJob = workflowJobBlock(workflow, 'deploy');
  if (!buildJob || /^\s{4}environment:/m.test(buildJob) || buildJob.includes('secrets.')) {
    throw new Error('the build job must not receive a production environment or secrets');
  }
  const deployJobOffset = workflow.indexOf(deployJob);
  const workflowOutsideDeploy = deployJobOffset < 0
    ? workflow
    : `${workflow.slice(0, deployJobOffset)}${workflow.slice(deployJobOffset + deployJob.length)}`;
  if (/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/.test(workflowOutsideDeploy)) {
    throw new Error('production secrets must be isolated to the deploy job');
  }
  for (const command of [
    'npm ci --install-links',
    'npx tsc --noEmit -p stephen/tsconfig.json',
    'npx tsc --noEmit -p stephen/tsconfig.editorial.json',
    'npx vitest run --root stephen',
    'npm run build:stephen',
    'stephen/scripts/stephen-release-cli.ts verify',
  ]) {
    if (!buildJob.includes(command)) {
      throw new Error(`release validation command is missing: ${command}`);
    }
  }
  if (!deployJob
    || !deployJob.includes('needs: [eligibility, build]')
    || !deployJob.includes('artifact-ids: ${{ needs.build.outputs.artifact_id }}')) {
    throw new Error('the deploy job must consume the exact build artifact');
  }
  if (!deployJob.includes('merge-multiple: true')) {
    throw new Error('the deploy job must download the exact artifact into the verified bundle root');
  }
  if (!buildJob.includes('retention-days: 1')
    || !buildJob.includes('if-no-files-found: error')
    || !buildJob.includes('overwrite: false')
    || !buildJob.includes('release-bundle.sha256')
    || !buildJob.includes('archiveChecksum: $archive_checksum')
    || !buildJob.includes('contentChecksum: $content_checksum')
    || !deployJob.includes('sha256sum --check --strict release-bundle.sha256')
    || !deployJob.includes('.sourceSha == $source_sha')
    || !deployJob.includes('.archiveChecksum == $archive_checksum')) {
    throw new Error('the build artifact must be private, short-lived, and checksum-bound');
  }
  if (!hasExecutableWorkflowLine(
    deployJob,
    'sha256sum --check --strict release-bundle.sha256',
  ) || /^\s*if\s+false\s*;\s*then\s*$/m.test(deployJob)) {
    throw new Error('the deploy job must execute checksum verification');
  }
  if (!deployJob.includes('BASH_ENV: /dev/null')
    || !deployJob.includes('PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')) {
    throw new Error('the deploy runner must use a fixed clean shell environment');
  }
  if (/\b(?:npm|npx|node)\b/.test(deployJob)
    || /app\/stephen\/scripts|working-directory:|actions\/checkout|actions\/setup-node/.test(deployJob)
    || /\bgit\s+(?:rev-parse|show|diff|checkout|fetch)\b/.test(deployJob)) {
    throw new Error('the deploy job must not execute repository code');
  }
  if (!/^\s{4}environment:\s*production-stephen\s*$/m.test(deployJob)
    || (workflow.match(/^\s{4}environment:\s*production-stephen\s*$/gm) ?? []).length !== 1) {
    throw new Error('production secrets must be scoped to production-stephen');
  }
  for (const secret of [
    'STEPHEN_SSH_HOST',
    'STEPHEN_SSH_PORT',
    'STEPHEN_SSH_USER',
    'STEPHEN_SSH_PRIVATE_KEY',
    'STEPHEN_SSH_KNOWN_HOSTS',
  ]) {
    if (!workflow.includes(`secrets.${secret}`)
      || workflow.includes(`inputs.${secret}`)) {
      throw new Error('SSH configuration must come from environment secrets');
    }
  }
  if (!workflow.includes('StrictHostKeyChecking=yes')
    || !workflow.includes('UserKnownHostsFile=')
    || !workflow.includes('GlobalKnownHostsFile=/dev/null')
    || !workflow.includes('IdentitiesOnly=yes')
    || !workflow.includes('ssh-keygen -F')
    || /StrictHostKeyChecking=no/.test(workflow)) {
    throw new Error('SSH host verification must fail closed against the environment trust anchor');
  }
  if (!deployJob.includes('            -F /dev/null')) {
    throw new Error('SSH must ignore runner and repository configuration');
  }
  if (!workflow.includes('"stephen-upload $SOURCE_SHA" < "$archive"')
    || /\bscp\b/.test(workflow)
    || /sudo -n \/usr\/local\/sbin\/stephen-release-helper/.test(workflow)) {
    throw new Error('release upload and control must use the forced-command SSH dispatcher');
  }
  for (const operation of ['stage', 'activate', 'finalize', 'rollback', 'status']) {
    if (!workflow.includes(`stephen-helper ${operation}`)) {
      throw new Error(operation === 'rollback'
        ? 'post-activation smoke failure must invoke rollback'
        : `release workflow must invoke remote ${operation}`);
    }
  }
  if (!workflow.includes('lease_id=')
    || !workflow.includes('pending_lease_id=$lease_id')
    || !workflow.includes('server lease remains the final safety net')) {
    throw new Error('release activation must use a reconcilable server-side lease');
  }
  for (const surface of [
    '/healthz-stephen',
    '/release-id.json',
    '/api/',
    '.smokePaths[]',
    'https://lake2ocean.top/',
    'https://crm.lake2ocean.top/',
    'https://crm.lake2ocean.top/api/health',
    'https://zizai.tech/',
    'https://bjj.zizai.tech/',
  ]) {
    if (!workflow.includes(surface)) {
      throw new Error(`release smoke surface is missing: ${surface}`);
    }
  }
  for (const identity of [
    '江湖 CRM｜自在江湖客户管理',
    '江湖 · Game of JiangHu',
    'ZiZai 自在创造',
    'ZiZ 记事本',
  ]) {
    if (!workflow.includes(identity)) {
      throw new Error('shared-site smoke must assert stable site identities');
    }
  }
  for (const command of [
    `grep -Fq '江湖 CRM｜自在江湖客户管理' "$smoke_body" || return 1`,
    `grep -Fq '江湖 · Game of JiangHu' "$smoke_body" || return 1`,
    `grep -Fq 'ZiZai 自在创造' "$smoke_body" || return 1`,
    `grep -Fq 'ZiZ 记事本' "$smoke_body" || return 1`,
  ]) {
    if (!hasExecutableWorkflowLine(deployJob, command)) {
      throw new Error('shared-site smoke must execute stable site identity checks');
    }
  }
  if (executableWorkflowLineCount(deployJob, 'smoke_shared_sites || return 1') !== 2) {
    throw new Error('normal and rollback smoke must execute shared-site identity checks');
  }
  if (!workflow.includes('application/json*')
    || !workflow.includes('type == "object" and .ok == true')) {
    throw new Error('CRM health smoke must require its JSON identity');
  }
  if (!hasExecutableWorkflowLine(
    deployJob,
    '[[ "$content_type" == application/json* ]] || return 1',
  ) || !hasExecutableWorkflowLine(
    deployJob,
    `jq -e 'type == "object" and .ok == true' "$smoke_body" >/dev/null || return 1`,
  )) {
    throw new Error('CRM health smoke must execute its JSON identity check');
  }
  if (!workflow.includes('.sourceSha == $source_sha')
    || !workflow.includes('.contentChecksum == $checksum')
    || !workflow.includes("--proto '=https' --max-redirs 0")
    || /curl[^\n]*--location/.test(workflow)) {
    throw new Error('release smoke must bind the HTTPS response to the exact artifact identity');
  }
  if (workflow.includes('done < <(jq -r \'.smokePaths[]\' "$metadata")')
    || !hasExecutableWorkflowLine(
      deployJob,
      `smoke_paths=$(jq -er '.smokePaths[]' "$metadata") || return 1`,
    )
    || !hasExecutableWorkflowLine(deployJob, '[[ -n "$smoke_paths" ]] || return 1')
    || !hasExecutableWorkflowLine(
      deployJob,
      '[[ "$smoke_path" =~ ^/($|digest/$|policy/$|fieldbook/$|items/[a-z0-9-]+/$) ]] || return 1',
    )
    || !hasExecutableWorkflowLine(deployJob, 'done <<< "$smoke_paths"')
    || !deployJob.includes('and ((.smokePaths | type) == "array" and (.smokePaths | length) >= 5)')
    || !deployJob.includes('and any(.smokePaths[]; startswith("/items/"))')) {
    throw new Error('release smoke must fail closed on invalid or unsafe metadata paths');
  }
  if (!deployJob.includes("rollback_current_sha=''")
    || !hasExecutableWorkflowLine(
      deployJob,
      `fetch_status 200 'https://stephen.lake2ocean.top/release-id.json' || return 1`,
    )
    || !hasExecutableWorkflowLine(
      deployJob,
      `jq -e --arg source_sha "$rollback_current_sha" \\`,
    )) {
    throw new Error('rollback smoke must bind to the exact restored release identity');
  }
  if (!workflow.includes('trap cleanup EXIT')
    || /\bset\s+(?:-x|-o\s+xtrace)\b/.test(workflow)
    || /^\s*(?:env|printenv)(?:\s|$)/m.test(workflow)
    || /StrictHostKeyChecking=no|write-all|contents:\s*write/i.test(workflow)) {
    throw new Error('release workflow must not expose credentials or broaden permissions');
  }
  return { runners, permissions, environment: 'production-stephen' as const };
}
