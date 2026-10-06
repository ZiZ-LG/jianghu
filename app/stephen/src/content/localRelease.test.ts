import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyStephenArtifactDirectory, type StephenArtifactEntry } from '../../scripts/stephen-release.ts';

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const OPERATOR_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const PREVIOUS_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const OLDER_SHA = '0123456789abcdef0123456789abcdef01234567';
const SOURCE_REPOSITORY = 'ZiZ-LG/stephen-knowledge-hub';
const OPERATOR_REPOSITORY = 'ZiZ-LG/jianghu';
const helperPath = decodeURIComponent(new URL('../../../../deploy/stephen-remote-release.sh', import.meta.url).pathname);
const localReleasePath = decodeURIComponent(new URL('../../../../deploy/stephen-local-release.sh', import.meta.url).pathname);

function validArtifact(): StephenArtifactEntry[] {
  return [
    {
      path: 'index.html',
      type: 'file',
      bytes: new TextEncoder().encode('<!doctype html><title>自我修养｜AI Sales Fieldcraft</title><script src="/assets/index.js"></script>'),
    },
    {
      path: 'assets/index.js',
      type: 'file',
      bytes: new TextEncoder().encode([
        '自我修养｜AI 技术、大客户销售与岗位组织转型',
        'AI 技术',
        '大客户销售',
        '岗位组织转型',
        '京ICP备2026046195号-2',
        '京公网安备11010802049879号',
      ].join('\n')),
    },
    {
      path: 'fieldbook/index.html',
      type: 'file',
      bytes: new TextEncoder().encode('<!doctype html><title>AI 销售的自我修养</title>'),
    },
    {
      path: 'beian-police.png',
      type: 'file',
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    },
    {
      path: 'robots.txt',
      type: 'file',
      bytes: new TextEncoder().encode('User-agent: *\nAllow: /\n'),
    },
    {
      path: 'sitemap.xml',
      type: 'file',
      bytes: new TextEncoder().encode([
        '<urlset>',
        '<url><loc>https://stephen.lake2ocean.top/</loc></url>',
        '<url><loc>https://stephen.lake2ocean.top/digest/</loc></url>',
        '<url><loc>https://stephen.lake2ocean.top/policy/</loc></url>',
        '<url><loc>https://stephen.lake2ocean.top/fieldbook/</loc></url>',
        '<url><loc>https://stephen.lake2ocean.top/items/approved-item/</loc></url>',
        '</urlset>',
      ].join('')),
    },
  ];
}

function runCommand(command: string, args: readonly string[], cwd?: string) {
  return spawnSync(command, args, { encoding: 'utf8', cwd });
}

async function createReleaseArchive(
  temporaryRoot: string,
  sourceSha: string,
  sourceRepository?: string,
) {
  const artifactDirectory = join(temporaryRoot, `artifact-${sourceSha}`);
  await writeArtifactDirectory(artifactDirectory, validArtifact());
  await verifyStephenArtifactDirectory({
    artifactDirectory,
    sourceSha,
    metadataFile: join(artifactDirectory, '.stephen-release.json'),
  });
  if (sourceRepository) {
    const metadataPath = join(artifactDirectory, '.stephen-release.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, sourceRepository }), 'utf8');
  }
  await chmod(join(artifactDirectory, 'assets/index.js'), 0o4755);
  const archive = join(temporaryRoot, `${sourceSha}.tar.gz`);
  const packed = runCommand('tar', ['-czf', archive, '.'], artifactDirectory);
  expect(packed.status, packed.stderr).toBe(0);
  const digest = runCommand('shasum', ['-a', '256', archive]);
  expect(digest.status, digest.stderr).toBe(0);
  return { archive, checksum: digest.stdout.trim().split(/\s+/)[0] };
}

async function writeArtifactDirectory(
  artifactDirectory: string,
  entries: readonly StephenArtifactEntry[],
) {
  for (const entry of entries) {
    const destination = join(artifactDirectory, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes);
  }
}

async function installIncomingArchive(
  releaseRoot: string,
  sourceSha: string,
  archive: string,
) {
  const incoming = join(releaseRoot, 'incoming');
  await mkdir(incoming, { recursive: true });
  const bytes = await readFile(archive);
  await writeFile(join(incoming, `${sourceSha}.tar.gz`), bytes);
}

function runReleaseHelper(
  releaseRoot: string,
  command: 'stage' | 'activate' | 'finalize' | 'rollback' | 'expire' | 'recover' | 'status',
  ...args: readonly string[]
) {
  return spawnSync('bash', [
    helperPath,
    '--test-root', releaseRoot,
    command,
    ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, SAAS607_HELPER_TEST_MODE: '1' },
  });
}

type LocalReleaseFixture = {
  temporaryRoot: string;
  releaseRoot: string;
  sourceDirectory: string;
  artifactDirectory: string;
  stateFile: string;
};

async function createLocalReleaseFixture(
  prefix: string,
  smokeResult: 'pass' | 'fail' = 'pass',
): Promise<LocalReleaseFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), prefix));
  const releaseRoot = join(temporaryRoot, 'release-root');
  const sourceDirectory = join(temporaryRoot, 'source');
  const artifactDirectory = join(temporaryRoot, 'artifact');
  const stateFile = join(temporaryRoot, 'release-state.json');
  await mkdir(sourceDirectory, { recursive: true });
  await writeArtifactDirectory(artifactDirectory, validArtifact());
  const previous = await createReleaseArchive(temporaryRoot, PREVIOUS_SHA);
  await installIncomingArchive(releaseRoot, PREVIOUS_SHA, previous.archive);
  expect(runReleaseHelper(releaseRoot, 'stage', PREVIOUS_SHA, previous.checksum).status)
    .toBe(0);
  await symlink(`releases/${PREVIOUS_SHA}`, join(releaseRoot, 'current'));
  await mkdir(join(releaseRoot, 'test-control'), { recursive: true });
  await writeFile(join(releaseRoot, 'test-control', 'operator-sha'), `${OPERATOR_SHA}\n`, 'utf8');
  await writeFile(join(releaseRoot, 'test-control', 'runtime-ready'), 'yes\n', 'utf8');
  await writeFile(join(releaseRoot, 'test-control', 'nginx-check'), 'pass\n', 'utf8');
  await writeFile(join(releaseRoot, 'test-control', 'smoke-result'), `${smokeResult}\n`, 'utf8');
  return {
    temporaryRoot,
    releaseRoot,
    sourceDirectory,
    artifactDirectory,
    stateFile,
  };
}

function localReleaseArgs(
  fixture: LocalReleaseFixture,
  command: 'activate' | 'finalize' | 'rollback' | 'verify',
  bundleName = 'bundle',
) {
  const common = [
    '--artifact', fixture.artifactDirectory,
    '--test-root', fixture.releaseRoot,
  ];
  if (command === 'activate') {
    return [
      localReleasePath,
      command,
      '--source-dir', fixture.sourceDirectory,
      '--source-sha', SOURCE_SHA,
      '--operator-sha', OPERATOR_SHA,
      '--bundle-dir', join(fixture.temporaryRoot, bundleName),
      '--state-file', fixture.stateFile,
      ...common,
    ];
  }
  if (command === 'finalize') {
    return [
      localReleasePath,
      command,
      '--source-dir', fixture.sourceDirectory,
      '--state-file', fixture.stateFile,
      ...common,
    ];
  }
  return [
    localReleasePath,
    command,
    '--state-file', fixture.stateFile,
    ...common,
  ];
}

function runLocalRelease(
  fixture: LocalReleaseFixture,
  command: 'activate' | 'finalize' | 'rollback' | 'verify',
  environment: Record<string, string> = {},
  bundleName = 'bundle',
) {
  return spawnSync('bash', localReleaseArgs(fixture, command, bundleName), {
    encoding: 'utf8',
    env: {
      ...process.env,
      STEPHEN_LOCAL_RELEASE_TEST_MODE: '1',
      ...environment,
    },
  });
}

describe('SAAS-607 dual-repository local release operator', () => {
  it('fails closed with a bounded CLI before touching production', () => {
    const missing = spawnSync('bash', [localReleasePath], {
      encoding: 'utf8',
      env: { ...process.env },
    });

    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('Usage:');
    expect(missing.stderr).toContain('plan|activate|verify|finalize|rollback');

    const invalidCases = [
      ['unknown'],
      ['plan', '--source-dir', '.', '--source-sha', SOURCE_SHA,
      '--operator-sha', OPERATOR_SHA, '--bundle-dir', '/tmp/bundle'],
      ['plan', '--source-dir', '/tmp/source', '--source-sha', 'ABC', '--bundle-dir', '/tmp/bundle'],
      [
        'plan',
        '--source-dir', '/tmp/source',
        '--source-dir', '/tmp/source-again',
        '--source-sha', SOURCE_SHA,
        '--operator-sha', OPERATOR_SHA,
        '--bundle-dir', '/tmp/bundle',
      ],
    ];
    for (const args of invalidCases) {
      const rejected = spawnSync('bash', [localReleasePath, ...args], {
        encoding: 'utf8',
        env: { ...process.env },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe('');
    }
  });

  it('packages a bound plan without invoking a production write path', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-local-plan-'));
    try {
      const sourceDirectory = join(temporaryRoot, 'source');
      const artifactDirectory = join(temporaryRoot, 'artifact');
      const bundleDirectory = join(temporaryRoot, 'bundle');
      const releaseRoot = join(temporaryRoot, 'release-root');
      await mkdir(sourceDirectory, { recursive: true });
      await writeArtifactDirectory(artifactDirectory, validArtifact());

      const planned = spawnSync('bash', [
        localReleasePath,
        'plan',
        '--source-dir', sourceDirectory,
        '--source-sha', SOURCE_SHA,
        '--operator-sha', OPERATOR_SHA,
        '--bundle-dir', bundleDirectory,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });

      expect(planned.status, planned.stderr).toBe(0);
      expect(JSON.parse(planned.stdout)).toMatchObject({
        schemaVersion: 2,
        operatorSha: OPERATOR_SHA,
        operatorRepository: OPERATOR_REPOSITORY,
        sourceRepository: SOURCE_REPOSITORY,
        task: 'SAAS-607',
        command: 'plan',
        sourceSha: SOURCE_SHA,
        releaseState: 'PLAN_ONLY',
        productionTouched: false,
      });
      expect(JSON.parse(planned.stdout).archiveChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(planned.stdout).contentChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(planned.stdout)).toMatchObject({
        ciUrl: 'test-only',
        stephenChecksUrl: 'test-only',
      });
      await expect(readFile(join(releaseRoot, 'incoming', `${SOURCE_SHA}.tar.gz`)))
        .rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('keeps static fallback and rendered-title artifact checks separate', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-local-title-'));
    try {
      const sourceDirectory = join(temporaryRoot, 'source');
      const releaseRoot = join(temporaryRoot, 'release-root');
      await mkdir(sourceDirectory, { recursive: true });
      const withoutFallback = validArtifact().map((entry) => entry.path === 'index.html'
        ? { ...entry, bytes: new TextEncoder().encode('<title>自我修养｜AI 技术、大客户销售与岗位组织转型</title><script src="/assets/index.js"></script>') }
        : entry);
      const artifactDirectory = join(temporaryRoot, 'artifact');
      await writeArtifactDirectory(artifactDirectory, withoutFallback);

      const rejected = spawnSync('bash', [
        localReleasePath,
        'plan',
        '--source-dir', sourceDirectory,
        '--source-sha', SOURCE_SHA,
        '--operator-sha', OPERATOR_SHA,
        '--bundle-dir', join(temporaryRoot, 'bundle'),
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });

      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('static fallback title');

      const withoutDynamicTitle = validArtifact().map((entry) => entry.path === 'assets/index.js'
        ? {
            ...entry,
            bytes: new TextEncoder().encode('AI 技术\n大客户销售\n岗位组织转型'),
          }
        : entry);
      const dynamicArtifactDirectory = join(temporaryRoot, 'artifact-without-dynamic-title');
      await writeArtifactDirectory(dynamicArtifactDirectory, withoutDynamicTitle);
      const dynamicRejected = spawnSync('bash', [
        localReleasePath,
        'plan',
        '--source-dir', sourceDirectory,
        '--source-sha', SOURCE_SHA,
        '--operator-sha', OPERATOR_SHA,
        '--bundle-dir', join(temporaryRoot, 'dynamic-title-bundle'),
        '--artifact', dynamicArtifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(dynamicRejected.status).not.toBe(0);
      expect(dynamicRejected.stderr).toContain('rendered dynamic title');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects an existing state target before upload, stage, or activation', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-existing-state-');
    try {
      await writeFile(fixture.stateFile, '{"reserved":true}\n', 'utf8');
      await chmod(fixture.stateFile, 0o600);
      const rejected = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });

      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('state file already exists');
      const remoteStatus = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(remoteStatus).toContain('pending_source_sha=none');
      await expect(readFile(join(fixture.releaseRoot, 'incoming', `${SOURCE_SHA}.tar.gz`)))
        .rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('requires the release journal to live in an operator-owned mode-0700 directory', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-insecure-state-parent-');
    try {
      const insecureParent = join(fixture.temporaryRoot, 'shared-state');
      await mkdir(insecureParent, { recursive: true });
      await chmod(insecureParent, 0o755);
      const insecureFixture = {
        ...fixture,
        stateFile: join(insecureParent, 'release-state.json'),
      };
      const rejected = runLocalRelease(insecureFixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });

      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('mode 0700');
      const remoteStatus = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(remoteStatus).toContain('pending_source_sha=none');
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects contradictory state-machine records before remote reconciliation', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-invalid-state-pair-');
    try {
      const activated = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activated.status, activated.stderr).toBe(0);
      const pending = JSON.parse(activated.stdout);
      await writeFile(fixture.stateFile, JSON.stringify({
        ...pending,
        command: 'rollback',
      }), 'utf8');
      await chmod(fixture.stateFile, 0o600);

      const rejected = runLocalRelease(fixture, 'verify');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('state file schema is invalid');
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout)
        .toContain(`pending_lease_id=${pending.leaseId}`);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('treats an exact already-active SHA as a verified idempotent no-op', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-already-active-');
    try {
      const sourceRelease = await createReleaseArchive(fixture.temporaryRoot, SOURCE_SHA, SOURCE_REPOSITORY);
      await installIncomingArchive(fixture.releaseRoot, SOURCE_SHA, sourceRelease.archive);
      expect(runReleaseHelper(
        fixture.releaseRoot,
        'stage',
        SOURCE_SHA,
        sourceRelease.checksum,
      ).status).toBe(0);
      await rm(join(fixture.releaseRoot, 'current'), { recursive: true, force: true });
      await symlink(`releases/${SOURCE_SHA}`, join(fixture.releaseRoot, 'current'));

      const activated = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activated.status, activated.stderr).toBe(0);
      expect(JSON.parse(activated.stdout)).toMatchObject({
        command: 'activate',
        sourceSha: SOURCE_SHA,
        releaseState: 'ALREADY_ACTIVE',
        productionTouched: false,
      });
      const beforeVerify = await readFile(fixture.stateFile, 'utf8');
      const verified = runLocalRelease(fixture, 'verify');
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        releaseState: 'ALREADY_ACTIVE',
        observedReleaseState: 'ALREADY_ACTIVE',
        currentSha: SOURCE_SHA,
        pendingSourceSha: 'none',
      });
      expect(await readFile(fixture.stateFile, 'utf8')).toBe(beforeVerify);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('binds the rollback baseline in local state to the exact remote pending predecessor', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-previous-tamper-');
    try {
      const activated = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activated.status, activated.stderr).toBe(0);
      const pending = JSON.parse(activated.stdout);
      await writeFile(fixture.stateFile, JSON.stringify({
        ...pending,
        previousSha: OLDER_SHA,
      }), 'utf8');
      await chmod(fixture.stateFile, 0o600);

      const finalizeRejected = runLocalRelease(fixture, 'finalize', {
        STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(finalizeRejected.status).not.toBe(0);
      expect(finalizeRejected.stderr).toContain('does not match the local release state');

      const rollbackRejected = runLocalRelease(fixture, 'rollback', {
        STEPHEN_PRODUCTION_ROLLBACK_APPROVAL: `rollback:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(rollbackRejected.status).not.toBe(0);
      expect(rollbackRejected.stderr).toContain('does not match the exact pending rollback request');
      const remoteStatus = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${SOURCE_SHA}`);
      expect(remoteStatus).toContain(`previous_sha=${PREVIOUS_SHA}`);
      expect(remoteStatus).toContain(`pending_lease_id=${pending.leaseId}`);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('reconciles a lost finalize response and a later lease expiry deterministically', async () => {
    const finalizedFixture = await createLocalReleaseFixture('saas-607-finalize-retry-');
    try {
      const activated = runLocalRelease(finalizedFixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activated.status, activated.stderr).toBe(0);
      const pending = JSON.parse(activated.stdout);
      expect(runReleaseHelper(
        finalizedFixture.releaseRoot,
        'finalize',
        SOURCE_SHA,
        pending.leaseId,
      ).status).toBe(0);

      const reconciled = runLocalRelease(finalizedFixture, 'finalize', {
        STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(JSON.parse(reconciled.stdout)).toMatchObject({
        command: 'finalize',
        releaseState: 'FINALIZED',
      });
    } finally {
      await rm(finalizedFixture.temporaryRoot, { recursive: true, force: true });
    }

    const expiredFixture = await createLocalReleaseFixture('saas-607-expiry-reconcile-');
    try {
      const activated = runLocalRelease(expiredFixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activated.status, activated.stderr).toBe(0);
      const pending = JSON.parse(activated.stdout);
      expect(runReleaseHelper(
        expiredFixture.releaseRoot,
        'expire',
        SOURCE_SHA,
        pending.leaseId,
      ).status).toBe(0);

      const observed = runLocalRelease(expiredFixture, 'verify');
      expect(observed.status, observed.stderr).toBe(0);
      expect(JSON.parse(observed.stdout)).toMatchObject({
        releaseState: 'PENDING_BROWSER_VERIFICATION',
        observedReleaseState: 'ROLLED_BACK',
        currentSha: PREVIOUS_SHA,
      });
      const reconcileRejected = runLocalRelease(expiredFixture, 'finalize', {
        STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(reconcileRejected.status).not.toBe(0);
      expect(reconcileRejected.stderr).toContain('expired or rolled back');
      expect(JSON.parse(await readFile(expiredFixture.stateFile, 'utf8'))).toMatchObject({
        command: 'rollback',
        releaseState: 'ROLLED_BACK',
      });
    } finally {
      await rm(expiredFixture.temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('rolls back when exact main advances after the final candidate smoke', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-main-forward-');
    try {
      await writeFile(
        join(fixture.releaseRoot, 'test-control', 'exact-main-results'),
        'pass\npass\npass\npass\nfail\n',
        'utf8',
      );
      const activated = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activated.status, activated.stderr).toBe(0);
      const pending = JSON.parse(activated.stdout);

      const rejected = runLocalRelease(fixture, 'finalize', {
        STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('exact-main revalidation failed');
      const state = JSON.parse(await readFile(fixture.stateFile, 'utf8'));
      expect(state).toMatchObject({ command: 'rollback', releaseState: 'ROLLED_BACK' });
      const remoteStatus = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(remoteStatus).toContain('pending_source_sha=none');
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('requires exact-SHA approval and stops a successful activation at the browser gate', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-local-activate-');
    const {
      temporaryRoot,
      releaseRoot,
      artifactDirectory,
      stateFile,
    } = fixture;
    try {
      const args = localReleaseArgs(fixture, 'activate');
      const unapproved = spawnSync('bash', args, {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(unapproved.status).not.toBe(0);
      expect(unapproved.stderr).toContain('exact-SHA production release approval is missing');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`current_sha=${PREVIOUS_SHA}`);
      await expect(readFile(stateFile)).rejects.toThrow();

      const activated = spawnSync('bash', args, {
        encoding: 'utf8',
        env: {
          ...process.env,
          STEPHEN_LOCAL_RELEASE_TEST_MODE: '1',
          STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
        },
      });
      expect(activated.status, activated.stderr).toBe(0);
      const result = JSON.parse(activated.stdout);
      expect(result).toMatchObject({
        command: 'activate',
        sourceSha: SOURCE_SHA,
        releaseState: 'PENDING_BROWSER_VERIFICATION',
        productionTouched: true,
      });
      expect(result.leaseId).toMatch(/^[0-9a-f]{32}$/);
      const stored = JSON.parse(await readFile(stateFile, 'utf8'));
      expect(stored).toMatchObject(result);
      expect(JSON.stringify(stored)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|OPENSSH|gho_/i);
      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
      const remoteStatus = runReleaseHelper(releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${SOURCE_SHA}`);
      expect(remoteStatus).toContain(`pending_source_sha=${SOURCE_SHA}`);
      expect(remoteStatus).toContain(`pending_lease_id=${result.leaseId}`);
      const pendingStateContents = await readFile(stateFile, 'utf8');
      const pendingVerified = spawnSync('bash', [
        localReleasePath,
        'verify',
        '--state-file', stateFile,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(pendingVerified.status, pendingVerified.stderr).toBe(0);
      expect(JSON.parse(pendingVerified.stdout)).toMatchObject({
        releaseState: 'PENDING_BROWSER_VERIFICATION',
        observedReleaseState: 'PENDING_BROWSER_VERIFICATION',
      });
      expect(await readFile(stateFile, 'utf8')).toBe(pendingStateContents);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rolls back the pending lease when candidate smoke fails', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-local-smoke-fail-', 'fail');
    const {
      temporaryRoot,
      releaseRoot,
      artifactDirectory,
      stateFile,
    } = fixture;
    try {
      const rejected = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });

      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('pending activation was rolled back');
      const remoteStatus = runReleaseHelper(releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(remoteStatus).toContain('pending_source_sha=none');
      const rollbackStateContents = await readFile(stateFile, 'utf8');
      const rollbackVerified = spawnSync('bash', [
        localReleasePath,
        'verify',
        '--state-file', stateFile,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(rollbackVerified.status, rollbackVerified.stderr).toBe(0);
      expect(JSON.parse(rollbackVerified.stdout)).toMatchObject({
        releaseState: 'ROLLED_BACK',
        observedReleaseState: 'ROLLED_BACK',
        currentSha: PREVIOUS_SHA,
      });
      expect(await readFile(stateFile, 'utf8')).toBe(rollbackStateContents);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
        command: 'rollback',
        releaseState: 'ROLLED_BACK',
        productionTouched: true,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('requires browser evidence before finalize and preserves a verifiable final state', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-local-finalize-');
    const {
      temporaryRoot,
      releaseRoot,
      sourceDirectory,
      artifactDirectory,
      stateFile,
    } = fixture;
    try {
      const activation = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activation.status, activation.stderr).toBe(0);
      const pending = JSON.parse(activation.stdout);
      const finalizeArgs = [
        localReleasePath,
        'finalize',
        '--source-dir', sourceDirectory,
        '--state-file', stateFile,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ];

      const unverified = spawnSync('bash', finalizeArgs, {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(unverified.status).not.toBe(0);
      expect(unverified.stderr).toContain('exact browser verification evidence is missing');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`pending_lease_id=${pending.leaseId}`);

      const tamperedStateFile = join(temporaryRoot, 'tampered-state.json');
      await writeFile(tamperedStateFile, JSON.stringify({
        ...pending,
        sourceSha: OLDER_SHA,
      }), 'utf8');
      await chmod(tamperedStateFile, 0o600);
      const tampered = spawnSync('bash', [
        localReleasePath,
        'finalize',
        '--source-dir', sourceDirectory,
        '--state-file', tamperedStateFile,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          STEPHEN_LOCAL_RELEASE_TEST_MODE: '1',
          STEPHEN_BROWSER_VERIFICATION: `verified:${OLDER_SHA}:${pending.leaseId}`,
        },
      });
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain('does not match the local release state');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`pending_lease_id=${pending.leaseId}`);

      const finalized = spawnSync('bash', finalizeArgs, {
        encoding: 'utf8',
        env: {
          ...process.env,
          STEPHEN_LOCAL_RELEASE_TEST_MODE: '1',
          STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
        },
      });
      expect(finalized.status, finalized.stderr).toBe(0);
      expect(JSON.parse(finalized.stdout)).toMatchObject({
        command: 'finalize',
        sourceSha: SOURCE_SHA,
        leaseId: pending.leaseId,
        releaseState: 'FINALIZED',
      });
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain('pending_source_sha=none');
      const finalStateContents = await readFile(stateFile, 'utf8');
      expect(JSON.parse(finalStateContents).releaseState).toBe('FINALIZED');

      const verified = spawnSync('bash', [
        localReleasePath,
        'verify',
        '--state-file', stateFile,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        command: 'verify',
        sourceSha: SOURCE_SHA,
        leaseId: pending.leaseId,
        releaseState: 'FINALIZED',
        currentSha: SOURCE_SHA,
        pendingSourceSha: 'none',
        productionTouched: false,
      });
      expect(await readFile(stateFile, 'utf8')).toBe(finalStateContents);

      const repeatedFinalize = spawnSync('bash', finalizeArgs, {
        encoding: 'utf8',
        env: {
          ...process.env,
          STEPHEN_LOCAL_RELEASE_TEST_MODE: '1',
          STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
        },
      });
      expect(repeatedFinalize.status).not.toBe(0);
      expect(repeatedFinalize.stderr).toContain('not eligible for finalize reconciliation');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('keeps manual rollback behind its own exact pending-lease approval', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-local-rollback-');
    const {
      temporaryRoot,
      releaseRoot,
      artifactDirectory,
      stateFile,
    } = fixture;
    try {
      const activation = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(activation.status, activation.stderr).toBe(0);
      const pending = JSON.parse(activation.stdout);
      const rollbackArgs = [
        localReleasePath,
        'rollback',
        '--state-file', stateFile,
        '--artifact', artifactDirectory,
        '--test-root', releaseRoot,
      ];
      const unapproved = spawnSync('bash', rollbackArgs, {
        encoding: 'utf8',
        env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
      });
      expect(unapproved.status).not.toBe(0);
      expect(unapproved.stderr).toContain('exact pending-lease rollback approval is missing');

      const rolledBack = spawnSync('bash', rollbackArgs, {
        encoding: 'utf8',
        env: {
          ...process.env,
          STEPHEN_LOCAL_RELEASE_TEST_MODE: '1',
          STEPHEN_PRODUCTION_ROLLBACK_APPROVAL: `rollback:${SOURCE_SHA}:${pending.leaseId}`,
        },
      });
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      expect(JSON.parse(rolledBack.stdout)).toMatchObject({
        command: 'rollback',
        sourceSha: SOURCE_SHA,
        leaseId: pending.leaseId,
        releaseState: 'ROLLED_BACK',
      });
      const remoteStatus = runReleaseHelper(releaseRoot, 'status').stdout;
      expect(remoteStatus).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(remoteStatus).toContain('pending_source_sha=none');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function rewriteJson(path: string, patch: Record<string, unknown>) {
  const current = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...current, ...patch }), 'utf8');
}

async function activateFixture(fixture: LocalReleaseFixture) {
  const result = runLocalRelease(fixture, 'activate', {
    STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown> & { leaseId: string };
}

describe('SAAS-607 dual-repository identity and evidence rejection', () => {
  it('binds source and operator independently, and records the legacy rollback baseline', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-dual-identity-');
    try {
      const previousMetadata = JSON.parse(await readFile(
        join(fixture.releaseRoot, 'releases', PREVIOUS_SHA, '.stephen-release.json'), 'utf8',
      ));
      expect(previousMetadata).not.toHaveProperty('sourceRepository');
      const pending = await activateFixture(fixture);
      expect(pending).toMatchObject({
        schemaVersion: 2,
        sourceSha: SOURCE_SHA,
        sourceRepository: SOURCE_REPOSITORY,
        operatorSha: OPERATOR_SHA,
        operatorRepository: OPERATOR_REPOSITORY,
        sourceDirectory: fixture.sourceDirectory,
        previousSha: PREVIOUS_SHA,
        previousSourceRepository: 'legacy-private',
        previousContentChecksum: previousMetadata.contentChecksum,
      });
      expect(pending.operatorSha).not.toBe(pending.sourceSha);
      const verified = runLocalRelease(fixture, 'verify');
      expect(verified.status, verified.stderr).toBe(0);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a different operator checkout before uploading any candidate', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-operator-mismatch-');
    try {
      await writeFile(join(fixture.releaseRoot, 'test-control', 'operator-sha'), `${OLDER_SHA}\n`, 'utf8');
      const before = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      const rejected = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('operator SHA');
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toBe(before);
      await expect(readFile(fixture.stateFile)).rejects.toThrow();
      await expect(readFile(join(fixture.releaseRoot, 'incoming', `${SOURCE_SHA}.tar.gz`))).rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('stops activation before upload when the existing runtime smoke is unhealthy', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-preflight-smoke-');
    try {
      await writeFile(join(fixture.releaseRoot, 'test-control', 'preflight-smoke-result'), 'fail\n', 'utf8');
      const before = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      const rejected = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(rejected.status).not.toBe(0);
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toBe(before);
      await expect(readFile(fixture.stateFile)).rejects.toThrow();
      await expect(readFile(join(fixture.releaseRoot, 'incoming', `${SOURCE_SHA}.tar.gz`))).rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { field: 'operatorRepository', value: SOURCE_REPOSITORY },
    { field: 'sourceRepository', value: OPERATOR_REPOSITORY },
    { field: 'operatorSha', value: OLDER_SHA },
    { field: 'sourceSha', value: OLDER_SHA },
    { field: 'contentChecksum', value: '0'.repeat(64) },
    { field: 'archiveChecksum', value: 'not-a-checksum' },
    { field: 'previousSourceRepository', value: 'somebody/other-site' },
    { field: 'schemaVersion', value: 1 },
  ])('rejects a changed journal $field without mutating the pending transaction', async ({ field, value }) => {
    const fixture = await createLocalReleaseFixture('saas-607-state-evidence-');
    try {
      await activateFixture(fixture);
      const remoteBefore = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      await rewriteJson(fixture.stateFile, { [field]: value });
      const stateBefore = await readFile(fixture.stateFile, 'utf8');
      const rejected = runLocalRelease(fixture, 'verify');
      expect(rejected.status, `field=${field}\n${rejected.stdout}\n${rejected.stderr}`).not.toBe(0);
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toBe(remoteBefore);
      expect(await readFile(fixture.stateFile, 'utf8')).toBe(stateBefore);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each(['verify', 'finalize', 'rollback'] as const)(
    'rechecks the recorded private operator for %s', async (command) => {
      const fixture = await createLocalReleaseFixture('saas-607-state-operator-');
      try {
        const pending = await activateFixture(fixture);
        await writeFile(join(fixture.releaseRoot, 'test-control', 'operator-sha'), `${OLDER_SHA}\n`, 'utf8');
        const remoteBefore = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
        const stateBefore = await readFile(fixture.stateFile, 'utf8');
        const rejected = runLocalRelease(fixture, command, {
          STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
          STEPHEN_PRODUCTION_ROLLBACK_APPROVAL: `rollback:${SOURCE_SHA}:${pending.leaseId}`,
        });
        expect(rejected.status, rejected.stderr).not.toBe(0);
        expect(rejected.stderr).toContain('operator SHA');
        expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toBe(remoteBefore);
        expect(await readFile(fixture.stateFile, 'utf8')).toBe(stateBefore);
      } finally {
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: 'repository', patch: { sourceRepository: OPERATOR_REPOSITORY } },
    { name: 'source SHA', patch: { sourceSha: OLDER_SHA } },
    { name: 'content checksum', patch: { contentChecksum: '0'.repeat(64) } },
  ])('rejects a live candidate with the wrong $name', async ({ patch }) => {
    const fixture = await createLocalReleaseFixture('saas-607-live-evidence-');
    try {
      const pending = await activateFixture(fixture);
      const metadataPath = join(fixture.releaseRoot, 'releases', SOURCE_SHA, '.stephen-release.json');
      await rewriteJson(metadataPath, patch);
      const remoteBefore = runReleaseHelper(fixture.releaseRoot, 'status').stdout;
      const stateBefore = await readFile(fixture.stateFile, 'utf8');
      const verified = runLocalRelease(fixture, 'verify');
      expect(verified.status, verified.stdout).not.toBe(0);
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toBe(remoteBefore);
      expect(await readFile(fixture.stateFile, 'utf8')).toBe(stateBefore);
      const finalized = runLocalRelease(fixture, 'finalize', {
        STEPHEN_BROWSER_VERIFICATION: `verified:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(finalized.status).not.toBe(0);
      expect(finalized.stderr).toContain('rolled back');
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toContain('pending_source_sha=none');
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not treat a legacy-private artifact at an equal SHA as an already-active public release', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-same-sha-different-repo-');
    try {
      const legacy = await createReleaseArchive(fixture.temporaryRoot, SOURCE_SHA);
      await installIncomingArchive(fixture.releaseRoot, SOURCE_SHA, legacy.archive);
      expect(runReleaseHelper(fixture.releaseRoot, 'stage', SOURCE_SHA, legacy.checksum).status).toBe(0);
      await rm(join(fixture.releaseRoot, 'current'), { recursive: true, force: true });
      await symlink(`releases/${SOURCE_SHA}`, join(fixture.releaseRoot, 'current'));
      const rejected = runLocalRelease(fixture, 'activate', {
        STEPHEN_PRODUCTION_RELEASE_APPROVAL: `release:${SOURCE_SHA}`,
      });
      expect(rejected.status, rejected.stdout).not.toBe(0);
      await expect(readFile(fixture.stateFile)).rejects.toThrow();
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toContain('pending_source_sha=none');
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'repository', patch: { sourceRepository: SOURCE_REPOSITORY } },
    { name: 'checksum', patch: { contentChecksum: '0'.repeat(64) } },
  ])('does not claim a restored baseline verified when its $name changed', async ({ patch }) => {
    const fixture = await createLocalReleaseFixture('saas-607-restored-evidence-');
    try {
      const pending = await activateFixture(fixture);
      const rolledBack = runLocalRelease(fixture, 'rollback', {
        STEPHEN_PRODUCTION_ROLLBACK_APPROVAL: `rollback:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      await rewriteJson(join(fixture.releaseRoot, 'releases', PREVIOUS_SHA, '.stephen-release.json'), patch);
      const stateBefore = await readFile(fixture.stateFile, 'utf8');
      const verified = runLocalRelease(fixture, 'verify');
      expect(verified.status, verified.stdout).not.toBe(0);
      expect(await readFile(fixture.stateFile, 'utf8')).toBe(stateBefore);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('allows explicit rollback when the pending candidate metadata is damaged', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-damaged-candidate-rollback-');
    try {
      const pending = await activateFixture(fixture);
      await rewriteJson(join(fixture.releaseRoot, 'releases', SOURCE_SHA, '.stephen-release.json'), {
        sourceRepository: OPERATOR_REPOSITORY, contentChecksum: '0'.repeat(64),
      });
      const rolledBack = runLocalRelease(fixture, 'rollback', {
        STEPHEN_PRODUCTION_ROLLBACK_APPROVAL: `rollback:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      const verified = runLocalRelease(fixture, 'verify');
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({ observedReleaseState: 'ROLLED_BACK', currentSha: PREVIOUS_SHA });
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });
});

// Execute the operator's actual jq predicates against API-shaped responses; no GitHub request is made.
describe('SAAS-607 exact repository workflow gates', () => {
  it.each([
    { repository: OPERATOR_REPOSITORY, sha: OPERATOR_SHA, otherRepository: SOURCE_REPOSITORY },
    { repository: SOURCE_REPOSITORY, sha: SOURCE_SHA, otherRepository: OPERATOR_REPOSITORY },
  ])('accepts only the latest exact main push check for $repository', async ({ repository, sha, otherRepository }) => {
    const operator = await readFile(localReleasePath, 'utf8');
    const filter = operator.match(/WORKFLOW_RUN_FILTER='([\s\S]*?)'\n/)?.[1];
    expect(filter).toBeDefined();
    const run = {
      id: 1, created_at: '2026-10-06T00:00:00Z', run_attempt: 1,
      head_sha: sha, head_branch: 'main', event: 'push',
      head_repository: { full_name: repository }, status: 'completed', conclusion: 'success',
    };
    const evaluate = (runs: Record<string, unknown>[]) => spawnSync('jq', [
      '-e', '--arg', 'source_sha', sha, '--arg', 'repository', repository, filter!,
    ], { encoding: 'utf8', input: new TextEncoder().encode(JSON.stringify({ workflow_runs: runs })) });
    expect(evaluate([run]).status).toBe(0);
    for (const patch of [
      { head_sha: OLDER_SHA }, { head_branch: 'feature' }, { event: 'workflow_dispatch' },
      { head_repository: { full_name: otherRepository } },
      { status: 'in_progress', conclusion: null },
    ]) expect(evaluate([{ ...run, ...patch }]).status).not.toBe(0);
    expect(evaluate([run, { ...run, id: 2, created_at: '2026-10-06T00:01:00Z', conclusion: 'failure' }]).status).not.toBe(0);
    expect(evaluate([run, { ...run, run_attempt: 2, status: 'in_progress', conclusion: null }]).status).not.toBe(0);
    expect(evaluate([{ ...run, conclusion: 'failure' }, { ...run, run_attempt: 2 }]).status).toBe(0);
  });

  it('fails closed for enabled automation on later pages or an incomplete variable result', async () => {
    const operator = await readFile(localReleasePath, 'utf8');
    const filter = operator.match(/VARIABLE_GATE_FILTER='([\s\S]*?)'\n/)?.[1];
    expect(filter).toBeDefined();
    const firstPage = { total_count: 101, variables: Array.from({ length: 100 }, (_, i) => ({ name: `OTHER_${i}`, value: '0' })) };
    const evaluate = (pages: unknown[]) => spawnSync('jq', ['-e', filter!], { encoding: 'utf8', input: new TextEncoder().encode(JSON.stringify(pages)) });
    expect(evaluate([firstPage, { total_count: 101, variables: [{ name: 'STEPHEN_RELEASE_ENABLED', value: '1' }] }]).status).not.toBe(0);
    expect(evaluate([firstPage, { total_count: 101, variables: [{ name: 'STEPHEN_RELEASE_ENABLED', value: '0' }] }]).status).toBe(0);
    expect(evaluate([firstPage]).status).not.toBe(0);
  });
});

async function exerciseProductionIdentityGate(fault: string, gate = 'verify_exact_green_main') {
  const createdRoot = await mkdtemp(join(tmpdir(), 'saas-607-production-gate-'));
  const temporaryRoot = runCommand('pwd', ['-P'], createdRoot).stdout.trim();
  try {
    const operatorDirectory = join(temporaryRoot, 'operator');
    const sourceDirectory = join(temporaryRoot, 'source');
    const initializeRepository = async (directory: string, repository: string) => {
      await mkdir(directory, { recursive: true });
      for (const args of [
        ['init', '-q'],
        ['config', 'user.name', 'Release Gate Fixture'],
        ['config', 'user.email', 'release-fixture@example.invalid'],
        ['config', 'commit.gpgsign', 'false'],
        ['remote', 'add', 'origin', `https://github.com/${repository}.git`],
      ]) expect(runCommand('git', args, directory).status).toBe(0);
      for (const file of ['deploy/stephen-local-release.sh', 'deploy/public-site-targets.json',
        'app/stephen/scripts/stephen-release-cli.ts', 'app/stephen/scripts/stephen-release.ts']) {
        await mkdir(dirname(join(directory, file)), { recursive: true });
        await writeFile(join(directory, file), 'fixture\n', 'utf8');
      }
      expect(runCommand('git', ['add', 'deploy', 'app'], directory).status).toBe(0);
      expect(runCommand('git', ['commit', '-qm', repository], directory).status).toBe(0);
      return runCommand('git', ['rev-parse', 'HEAD'], directory).stdout.trim();
    };
    const operatorSha = await initializeRepository(operatorDirectory, OPERATOR_REPOSITORY);
    const sourceSha = await initializeRepository(sourceDirectory, SOURCE_REPOSITORY);
    if (fault === 'source-origin') {
      expect(runCommand('git', ['remote', 'set-url', 'origin', `https://github.com/${OPERATOR_REPOSITORY}.git`], sourceDirectory).status).toBe(0);
    }
    if (fault === 'operator-origin') {
      expect(runCommand('git', ['remote', 'set-url', 'origin', `https://github.com/${SOURCE_REPOSITORY}.git`], operatorDirectory).status).toBe(0);
    }
    if (fault === 'source-dirty') await writeFile(join(sourceDirectory, 'untracked.txt'), 'do not release\n', 'utf8');
    if (fault === 'operator-dirty') await writeFile(join(operatorDirectory, 'untracked.txt'), 'do not release\n', 'utf8');
    const makeRun = (repository: string, sha: string, id = 1, conclusion = 'success') => ({
      id, run_attempt: 1, created_at: `2026-10-06T00:0${id}:00Z`,
      head_sha: sha, head_branch: 'main', event: 'push', head_repository: { full_name: repository },
      status: 'completed', conclusion, html_url: `https://github.com/${repository}/actions/runs/${id}`,
    });
    const privateRuns = [makeRun(OPERATOR_REPOSITORY, operatorSha)];
    const publicRuns = [makeRun(SOURCE_REPOSITORY, sourceSha)];
    if (fault === 'operator-latest-workflow-failed') privateRuns.push(makeRun(OPERATOR_REPOSITORY, operatorSha, 2, 'failure'));
    if (fault === 'source-latest-workflow-failed') publicRuns.push(makeRun(SOURCE_REPOSITORY, sourceSha, 2, 'failure'));
    await writeFile(join(temporaryRoot, 'private-runs.json'), JSON.stringify({ workflow_runs: privateRuns }), 'utf8');
    await writeFile(join(temporaryRoot, 'public-runs.json'), JSON.stringify({ workflow_runs: publicRuns }), 'utf8');
    await writeFile(join(temporaryRoot, 'variables.json'), JSON.stringify([{ total_count: 1, variables: [{ name: 'STEPHEN_RELEASE_ENABLED', value: fault === 'automatic-release-enabled' ? '1' : '0' }] }]), 'utf8');
    const operator = await readFile(localReleasePath, 'utf8');
    const dispatchStart = operator.indexOf('[[ $# -ge 1 ]] || usage');
    expect(dispatchStart).toBeGreaterThan(0);
    // Reuse the production functions unchanged. Real local Git proves clean HEAD/origin;
    // only network-bearing fetch/GitHub calls are replaced with deterministic replies.
    const harness = `${operator.slice(0, dispatchStart)}
REPO_ROOT=$PROBE_OPERATOR_DIRECTORY
source_dir=$PROBE_SOURCE_DIRECTORY
operator_sha=$PROBE_OPERATOR_SHA
source_sha=$PROBE_SOURCE_SHA
test_mode=0
git() {
  if [[ "$1" == '-C' && "$3" == 'fetch' ]]; then
    printf 'fetch:%s\\n' "$2" >> "$PROBE_LOG"
    return 0
  fi
  if [[ "$1" == '-C' && "$3" == 'rev-parse' && "$4" == 'origin/main' ]]; then
    if [[ "$2" == "$REPO_ROOT" ]]; then printf '%s\\n' "$PROBE_OPERATOR_MAIN";
    else printf '%s\\n' "$PROBE_SOURCE_MAIN"; fi
    return 0
  fi
  command git "$@"
}
gh() {
  printf 'gh:%s\\n' "$*" >> "$PROBE_LOG"
  local argument
  for argument in "$@"; do
    case "$argument" in
      "repos/$GH_REPO/git/ref/heads/main") printf '%s\\n' "$PROBE_OPERATOR_GITHUB_MAIN"; return 0 ;;
      "repos/$SOURCE_REPO/git/ref/heads/main") printf '%s\\n' "$PROBE_SOURCE_GITHUB_MAIN"; return 0 ;;
      "repos/$GH_REPO/actions/workflows/"*) cat "$PROBE_ROOT/private-runs.json"; return 0 ;;
      "repos/$SOURCE_REPO/actions/workflows/"*) cat "$PROBE_ROOT/public-runs.json"; return 0 ;;
      "repos/$GH_REPO/actions/variables") cat "$PROBE_ROOT/variables.json"; return 0 ;;
    esac
  done
  printf 'unexpected-gh-call\\n' >&2; return 96
}
ssh() { printf 'UNEXPECTED_NETWORK\\n' >> "$PROBE_LOG"; return 97; }
curl() { printf 'UNEXPECTED_NETWORK\\n' >> "$PROBE_LOG"; return 97; }
configure_ssh() { printf 'TRANSPORT_CONFIGURED\\n' >> "$PROBE_LOG"; }
upload_archive() { printf 'UPLOAD_REACHED\\n' >> "$PROBE_LOG"; }
${gate}
configure_ssh
upload_archive
`;
    const harnessPath = join(temporaryRoot, 'gate.sh');
    await writeFile(harnessPath, harness, 'utf8');
    const logPath = join(temporaryRoot, 'calls.log');
    await writeFile(logPath, '', 'utf8');
    const result = runCommand('bash', ['-n', harnessPath]);
    expect(result.status, result.stderr).toBe(0);
    const observed = spawnSync('bash', [harnessPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STEPHEN_LOCAL_PROXY: '',
        PROBE_ROOT: temporaryRoot,
        PROBE_LOG: logPath,
        PROBE_OPERATOR_DIRECTORY: operatorDirectory,
        PROBE_SOURCE_DIRECTORY: fault === 'same-directory' ? operatorDirectory : sourceDirectory,
        PROBE_OPERATOR_SHA: fault === 'operator-head' ? OLDER_SHA : operatorSha,
        PROBE_SOURCE_SHA: fault === 'source-head' ? OLDER_SHA : sourceSha,
        PROBE_OPERATOR_MAIN: fault === 'operator-main-drift' ? OLDER_SHA : operatorSha,
        PROBE_SOURCE_MAIN: fault === 'source-main-drift' ? OLDER_SHA : sourceSha,
        PROBE_OPERATOR_GITHUB_MAIN: fault === 'operator-github-main-drift' ? OLDER_SHA : operatorSha,
        PROBE_SOURCE_GITHUB_MAIN: fault === 'source-github-main-drift' ? OLDER_SHA : sourceSha,
      },
    });
    return { result: observed, log: await readFile(logPath, 'utf8') };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

describe('SAAS-607 production identity functions with isolated transport', () => {
  it('admits distinct clean canonical checkouts with both exact-green main SHAs', async () => {
    const { result, log } = await exerciseProductionIdentityGate('none');
    expect(result.status, result.stderr).toBe(0);
    expect(log).toContain(`repos/${SOURCE_REPOSITORY}/actions/workflows/checks.yml/runs`);
    expect(log).toContain(`repos/${OPERATOR_REPOSITORY}/actions/workflows/ci.yml/runs`);
    expect(log).toContain(`repos/${OPERATOR_REPOSITORY}/actions/workflows/stephen-checks.yml/runs`);
    expect(log).toContain('UPLOAD_REACHED');
    expect(log).not.toContain('UNEXPECTED_NETWORK');
  });

  it.each([
    'same-directory', 'operator-origin', 'source-origin', 'operator-head', 'source-head',
    'operator-dirty', 'source-dirty', 'operator-main-drift', 'source-main-drift',
    'operator-github-main-drift', 'source-github-main-drift',
    'operator-latest-workflow-failed', 'source-latest-workflow-failed', 'automatic-release-enabled',
  ])('rejects %s before transport setup or upload', async (fault) => {
    const { result, log } = await exerciseProductionIdentityGate(fault);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('STEPHEN_LOCAL_RELEASE_ERROR');
    expect(log).not.toContain('TRANSPORT_CONFIGURED');
    expect(log).not.toContain('UPLOAD_REACHED');
    expect(log).not.toContain('UNEXPECTED_NETWORK');
  });

  it.each(['operator-main-drift', 'source-main-drift', 'source-head', 'source-dirty', 'source-origin'])(
    'keeps a pinned private operator usable for recovery despite %s', async (fault) => {
      const { result, log } = await exerciseProductionIdentityGate(fault, 'require_operator_checkout_for_state');
      expect(result.status, result.stderr).toBe(0);
      expect(log).not.toContain('gh:');
      expect(log).not.toContain('fetch:');
      expect(log).not.toContain('UNEXPECTED_NETWORK');
    },
  );
});

describe('SAAS-607 recovery after main advances', () => {
  it('verifies and rolls back a pinned transaction without a public checkout or current-main gate', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-pinned-recovery-');
    try {
      const pending = await activateFixture(fixture);
      const gateQueue = join(fixture.releaseRoot, 'test-control', 'exact-main-results');
      await writeFile(gateQueue, 'fail\n', 'utf8');
      await rm(fixture.sourceDirectory, { recursive: true, force: true });
      const verified = runLocalRelease(fixture, 'verify');
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout).observedReleaseState).toBe('PENDING_BROWSER_VERIFICATION');
      const rolledBack = runLocalRelease(fixture, 'rollback', {
        STEPHEN_PRODUCTION_ROLLBACK_APPROVAL: `rollback:${SOURCE_SHA}:${pending.leaseId}`,
      });
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      expect(JSON.parse(rolledBack.stdout).releaseState).toBe('ROLLED_BACK');
      expect(await readFile(gateQueue, 'utf8')).toBe('fail\n');
      expect(runReleaseHelper(fixture.releaseRoot, 'status').stdout).toContain(`current_sha=${PREVIOUS_SHA}`);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('SAAS-607 deterministic release bundle', () => {
  it('keeps the same archive identity when artifact file times and executable bits change', async () => {
    const fixture = await createLocalReleaseFixture('saas-607-deterministic-bundle-');
    try {
      const plan = (bundleName: string) => {
        const args = localReleaseArgs(fixture, 'activate', bundleName);
        args[1] = 'plan';
        args.splice(args.indexOf('--state-file'), 2);
        return spawnSync('bash', args, {
          encoding: 'utf8', env: { ...process.env, STEPHEN_LOCAL_RELEASE_TEST_MODE: '1' },
        });
      };
      const first = plan('first-bundle');
      expect(first.status, first.stderr).toBe(0);
      const changedFile = join(fixture.artifactDirectory, 'assets/index.js');
      expect(runCommand('touch', ['-t', '202501020304.05', changedFile]).status).toBe(0);
      await chmod(changedFile, 0o755);
      const second = plan('second-bundle');
      expect(second.status, second.stderr).toBe(0);
      const firstPlan = JSON.parse(first.stdout);
      const secondPlan = JSON.parse(second.stdout);
      expect(secondPlan).toMatchObject({
        archiveChecksum: firstPlan.archiveChecksum,
        contentChecksum: firstPlan.contentChecksum,
        sourceRepository: SOURCE_REPOSITORY,
        sourceSha: SOURCE_SHA,
        operatorSha: OPERATOR_SHA,
        productionTouched: false,
      });
      await expect(readFile(join(fixture.releaseRoot, 'incoming', `${SOURCE_SHA}.tar.gz`))).rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });
});
