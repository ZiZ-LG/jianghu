import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifierPath = resolve(repoRoot, 'scripts/verify-public-site-artifact.mjs');
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jianghu-public-artifact-'));
  temporaryRoots.push(root);
  return root;
}

function makeCleanSourceRepository(root) {
  const sourceDir = join(root, 'source');
  mkdirSync(sourceDir);
  execFileSync('git', ['init', '-q'], { cwd: sourceDir });
  writeFileSync(join(sourceDir, 'README.md'), 'fixture source\n');
  execFileSync('git', ['add', 'README.md'], { cwd: sourceDir });
  execFileSync('git', [
    '-c', 'user.name=Jianghu Test',
    '-c', 'user.email=jianghu-test@example.invalid',
    'commit', '-q', '-m', 'fixture source',
  ], { cwd: sourceDir });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceDir,
    encoding: 'utf8',
  }).trim();
  return { sourceDir, sourceSha };
}

function writeArtifact(root, {
  title = '江湖 CRM｜自在江湖客户管理',
  javascript = [
    '首页',
    '自我修养',
    '江湖 CRM',
    '卧虎藏龙',
    '进入江湖 CRM',
    'https://crm.lake2ocean.top',
    '京ICP备2026046195号-2',
    '京公网安备11010802049879号',
  ].join('|'),
  includeJavascript = true,
  extraHead = '',
} = {}) {
  const artifactDir = join(root, `artifact-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(artifactDir, 'assets'), { recursive: true });
  writeFileSync(join(artifactDir, 'index.html'), [
    '<!doctype html>',
    '<html><head>',
    `<title>${title}</title>`,
    '<link rel="stylesheet" href="/assets/app.css">',
    '<link rel="icon" href="/beian-police.png">',
    extraHead,
    '</head><body><div id="root"></div>',
    '<script type="module" src="/assets/app.js"></script>',
    '</body></html>',
  ].join(''));
  writeFileSync(join(artifactDir, 'assets/app.css'), ':root{color:#123}\n');
  if (includeJavascript) writeFileSync(join(artifactDir, 'assets/app.js'), javascript);
  writeFileSync(join(artifactDir, 'beian-police.png'), 'fixture-police-icon');
  return artifactDir;
}

function runVerifier({
  site = 'public-home',
  artifactDir,
  sourceDir,
  sourceSha,
  buildCommand = 'npm run build (recovery lineage only)',
  forDeploy = false,
}) {
  const args = [
    verifierPath,
    '--site', site,
    '--artifact', artifactDir,
    '--source-dir', sourceDir,
    '--source-sha', sourceSha,
    '--build-command', buildCommand,
  ];
  if (forDeploy) args.push('--for-deploy');
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
}

test('accepts the public homepage identity and emits a stable provenance checksum', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root);

  const first = runVerifier({ artifactDir, sourceDir, sourceSha });
  const second = runVerifier({ artifactDir, sourceDir, sourceSha });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstReport = JSON.parse(first.stdout);
  const secondReport = JSON.parse(second.stdout);
  assert.deepEqual(firstReport, {
    siteId: 'public-home',
    sourceSha,
    buildCommand: 'npm run build (recovery lineage only)',
    artifactPath: realpathSync(artifactDir),
    artifactChecksum: firstReport.artifactChecksum,
    destinationHost: 'admin@47.95.13.214',
    destinationPath: '/usr/share/nginx/jianghu',
    canonicalUrl: 'https://lake2ocean.top/',
    title: '江湖 CRM｜自在江湖客户管理',
    deployAllowed: false,
  });
  assert.match(firstReport.artifactChecksum, /^[0-9a-f]{64}$/);
  assert.equal(secondReport.artifactChecksum, firstReport.artifactChecksum);
});

test('rejects a legacy CRM build when it is targeted at the public homepage', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root, {
    title: '江湖 · Game of JiangHu',
    javascript: '注册新工作区|销售干系人作战地图|轻量客户与事项',
  });

  const result = runVerifier({ artifactDir, sourceDir, sourceSha });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^PUBLIC_SITE_ARTIFACT_ERROR=/);
  assert.match(result.stderr, /title|forbidden marker/);
});

test('rejects a public homepage whose navigation markers are out of order', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root, {
    javascript: '进入江湖 CRM|首页|江湖 CRM|自我修养|卧虎藏龙|https://crm.lake2ocean.top|京ICP备2026046195号-2|京公网安备11010802049879号',
  });

  const result = runVerifier({ artifactDir, sourceDir, sourceSha });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required marker order/);
});

test('rejects an artifact whose index references a missing asset', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root, { includeJavascript: false });

  const result = runVerifier({ artifactDir, sourceDir, sourceSha });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /referenced asset is missing: assets\/app\.js/);
});

test('rejects symbolic links inside an artifact tree', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root);
  symlinkSync('/etc/hosts', join(artifactDir, 'assets/host-link.txt'));

  const result = runVerifier({ artifactDir, sourceDir, sourceSha });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact contains a symbolic link/);
});

test('rejects dirty source provenance and a SHA that is not the source HEAD', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root);
  writeFileSync(join(sourceDir, 'untracked.txt'), 'dirty\n');

  const dirty = runVerifier({ artifactDir, sourceDir, sourceSha });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /source worktree is dirty/);

  rmSync(join(sourceDir, 'untracked.txt'));
  const mismatched = runVerifier({
    artifactDir,
    sourceDir,
    sourceSha: '0000000000000000000000000000000000000000',
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /source HEAD does not match source SHA/);
});

test('rejects a build command containing an API key without echoing the value', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root);
  const secretValue = 'must-not-appear-in-output';

  const result = runVerifier({
    artifactDir,
    sourceDir,
    sourceSha,
    buildCommand: `VITE_API_KEY=${secretValue} npm run build`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /build command appears to contain a secret/);
  assert.doesNotMatch(result.stderr, new RegExp(secretValue));
  assert.doesNotMatch(result.stdout, new RegExp(secretValue));
});

test('rejects all inline environment assignments before printing a build command', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root);
  const assignedValue = 'must-not-appear-in-output';

  const result = runVerifier({
    artifactDir,
    sourceDir,
    sourceSha,
    buildCommand: `VITE_PUBLIC_LABEL=${assignedValue} npm run build`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inline environment assignments/);
  assert.doesNotMatch(result.stderr, new RegExp(assignedValue));
  assert.doesNotMatch(result.stdout, new RegExp(assignedValue));
});

test('rejects automatic navigation away from the public homepage', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const metaRefresh = writeArtifact(root, {
    extraHead: '<meta http-equiv="refresh" content="0;url=https://crm.lake2ocean.top/">',
  });
  const scriptRedirect = writeArtifact(root, {
    javascript: '首页|自我修养|江湖 CRM|卧虎藏龙|进入江湖 CRM|https://crm.lake2ocean.top|京ICP备2026046195号-2|京公网安备11010802049879号|window.location.replace("https://crm.lake2ocean.top/")',
  });

  const metaResult = runVerifier({ artifactDir: metaRefresh, sourceDir, sourceSha });
  const scriptResult = runVerifier({ artifactDir: scriptRedirect, sourceDir, sourceSha });

  assert.notEqual(metaResult.status, 0);
  assert.match(metaResult.stderr, /automatic navigation/);
  assert.notEqual(scriptResult.status, 0);
  assert.match(scriptResult.stderr, /automatic navigation/);
});

test('allows framework code that only compares location.href without navigating', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root, {
    javascript: '首页|自我修养|江湖 CRM|卧虎藏龙|进入江湖 CRM|https://crm.lake2ocean.top|京ICP备2026046195号-2|京公网安备11010802049879号|typeof contentWindow.location.href=="string"',
  });

  const result = runVerifier({ artifactDir, sourceDir, sourceSha });

  assert.equal(result.status, 0, result.stderr);
});

test('blocks deployment while public source and atomic runtime authorities are unresolved', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const artifactDir = writeArtifact(root);

  const result = runVerifier({ artifactDir, sourceDir, sourceSha, forDeploy: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public-home deployment is blocked/);
  assert.match(result.stderr, /source authority|atomic runtime authority/);
});

test('the public-edge guard cannot deploy CRM or self-cultivation artifacts', () => {
  const root = makeTemporaryRoot();
  const { sourceDir, sourceSha } = makeCleanSourceRepository(root);
  const crmArtifact = writeArtifact(root, {
    title: '江湖 · Game of JiangHu',
    javascript: '注册新工作区|轻量客户与事项|京ICP备2026046195号-2|京公网安备11010802049879号',
  });
  const stephenArtifact = writeArtifact(root, {
    title: '自我修养｜AI 技术、大客户销售与岗位组织转型',
    javascript: 'AI 技术|大客户销售|岗位组织转型|京ICP备2026046195号-2|京公网安备11010802049879号',
  });

  const crm = runVerifier({
    site: 'crm',
    artifactDir: crmArtifact,
    sourceDir,
    sourceSha,
    buildCommand: 'npm run build',
    forDeploy: true,
  });
  const stephen = runVerifier({
    site: 'self-cultivation',
    artifactDir: stephenArtifact,
    sourceDir,
    sourceSha,
    buildCommand: 'npm run build:stephen',
    forDeploy: true,
  });

  assert.notEqual(crm.status, 0);
  assert.match(crm.stderr, /crm is not managed by the public-edge release guard/);
  assert.notEqual(stephen.status, 0);
  assert.match(stephen.stderr, /self-cultivation is not managed by the public-edge release guard/);
});
