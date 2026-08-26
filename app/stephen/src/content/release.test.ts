import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildStephenReleaseMetadata,
  parseStephenReleaseCliArgs,
  validateStephenReleaseWorkflow,
  verifyStephenArtifactDirectory,
  type StephenArtifactEntry,
} from '../../scripts/stephen-release.ts';
import { approvedSeedItems } from './items';

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const PREVIOUS_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const OLDER_SHA = '0123456789abcdef0123456789abcdef01234567';
const LEASE_ID = '1234567890abcdef1234567890abcdef';
const helperPath = decodeURIComponent(
  new URL('../../../../deploy/stephen-remote-release.sh', import.meta.url).pathname,
);
const dispatcherPath = decodeURIComponent(
  new URL('../../../../deploy/stephen-ssh-dispatcher.sh', import.meta.url).pathname,
);
const workflowPath = decodeURIComponent(
  new URL('../../../../.github/workflows/stephen-release.yml', import.meta.url).pathname,
);
const checksWorkflowPath = decodeURIComponent(
  new URL('../../../../.github/workflows/stephen-checks.yml', import.meta.url).pathname,
);
const recoveryServicePath = decodeURIComponent(
  new URL('../../../../deploy/stephen-release-recover.service', import.meta.url).pathname,
);
const productionStageTestPath = decodeURIComponent(
  new URL('../../../../deploy/stephen-production-stage-test.sh', import.meta.url).pathname,
);

function validArtifact(): StephenArtifactEntry[] {
  return [
    {
      path: 'index.html',
      type: 'file',
      bytes: new TextEncoder().encode('<!doctype html><title>自我修养</title><script src="/assets/index.js"></script>'),
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

describe('SAAS-607 exact-SHA artifact contract', () => {
  it('accepts a complete static build and derives all required smoke paths', () => {
    const metadata = buildStephenReleaseMetadata(validArtifact(), SOURCE_SHA);

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      task: 'SAAS-607',
      sourceSha: SOURCE_SHA,
      fileCount: 6,
    });
    expect(metadata.smokePaths).toEqual([
      '/',
      '/digest/',
      '/policy/',
      '/fieldbook/',
      '/items/approved-item/',
    ]);
    expect(metadata.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makes the directory checksum independent of traversal order and sensitive to bytes', () => {
    const entries = validArtifact();
    const forward = buildStephenReleaseMetadata(entries, SOURCE_SHA).contentChecksum;
    const reversed = buildStephenReleaseMetadata([...entries].reverse(), SOURCE_SHA).contentChecksum;
    const changed = entries.map((entry) => entry.path === 'robots.txt'
      ? { ...entry, bytes: new TextEncoder().encode('User-agent: *\nDisallow: /\n') }
      : entry);

    expect(reversed).toBe(forward);
    expect(buildStephenReleaseMetadata(changed, SOURCE_SHA).contentChecksum).not.toBe(forward);
  });

  it('bounds file count, path depth, individual files, and total artifact bytes', () => {
    const tooMany = [
      ...validArtifact(),
      ...Array.from({ length: 995 }, (_, index) => ({
        path: `extra/${index}.txt`,
        type: 'file' as const,
        bytes: new Uint8Array([index % 255]),
      })),
    ];
    expect(() => buildStephenReleaseMetadata(tooMany, SOURCE_SHA))
      .toThrow('artifact exceeds the 1000-file safety limit');

    expect(() => buildStephenReleaseMetadata([
      ...validArtifact(),
      {
        path: 'extra/oversized.bin',
        type: 'file',
        bytes: new Uint8Array((8 * 1024 * 1024) + 1),
      },
    ], SOURCE_SHA)).toThrow('artifact file exceeds the 8 MiB safety limit');

    expect(() => buildStephenReleaseMetadata([
      ...validArtifact(),
      {
        path: `${Array.from({ length: 17 }, () => 'deep').join('/')}/file.txt`,
        type: 'file',
        bytes: new Uint8Array([1]),
      },
    ], SOURCE_SHA)).toThrow('artifact path exceeds the 16-segment depth limit');

    expect(() => buildStephenReleaseMetadata([
      ...validArtifact(),
      ...Array.from({ length: 3 }, (_, index) => ({
        path: `extra/chunk-${index}.bin`,
        type: 'file' as const,
        bytes: new Uint8Array(6 * 1024 * 1024),
      })),
    ], SOURCE_SHA)).toThrow('artifact exceeds the 16 MiB total-size safety limit');
  });

  it.each([
    ['', 'source SHA must be 40 lowercase hexadecimal characters'],
    ['ABCDEF7890abcdef1234567890abcdef12345678', 'source SHA must be 40 lowercase hexadecimal characters'],
    ['1234', 'source SHA must be 40 lowercase hexadecimal characters'],
  ])('rejects an unsafe source identity: %s', (sourceSha, message) => {
    expect(() => buildStephenReleaseMetadata(validArtifact(), sourceSha)).toThrow(message);
  });

  it('rejects links and path traversal before packaging', () => {
    expect(() => buildStephenReleaseMetadata([
      ...validArtifact(),
      { path: 'assets/current.js', type: 'symlink', bytes: new Uint8Array() },
    ], SOURCE_SHA)).toThrow('artifact entries must be regular files');

    expect(() => buildStephenReleaseMetadata([
      ...validArtifact(),
      { path: '../escape', type: 'file', bytes: new Uint8Array([1]) },
    ], SOURCE_SHA)).toThrow('artifact path is unsafe');

    expect(() => buildStephenReleaseMetadata(validArtifact().map((entry) => (
      entry.path === 'beian-police.png'
        ? { ...entry, bytes: new Uint8Array() }
        : entry
    )), SOURCE_SHA)).toThrow('required artifact file is empty: beian-police.png');
  });

  it('fails closed when required compliance content or a detail journey is absent', () => {
    const withoutPoliceFiling = validArtifact().map((entry) => entry.path === 'assets/index.js'
      ? {
        ...entry,
        bytes: new TextEncoder().encode('AI 技术\n大客户销售\n岗位组织转型\n京ICP备2026046195号-2'),
      }
      : entry);
    expect(() => buildStephenReleaseMetadata(withoutPoliceFiling, SOURCE_SHA))
      .toThrow('artifact is missing required marker: 京公网安备11010802049879号');

    const withoutDetail = validArtifact().map((entry) => entry.path === 'sitemap.xml'
      ? {
        ...entry,
        bytes: new TextEncoder().encode([
          '<urlset>',
          '<url><loc>https://stephen.lake2ocean.top/</loc></url>',
          '<url><loc>https://stephen.lake2ocean.top/digest/</loc></url>',
          '<url><loc>https://stephen.lake2ocean.top/policy/</loc></url>',
          '<url><loc>https://stephen.lake2ocean.top/fieldbook/</loc></url>',
          '</urlset>',
        ].join('')),
      }
      : entry);
    expect(() => buildStephenReleaseMetadata(withoutDetail, SOURCE_SHA))
      .toThrow('artifact sitemap has no public item detail path');
  });

  it.each(['pending_owner_review', 'not_published'])
  ('rejects non-public candidate state leaking into the static artifact: %s', (state) => {
    const entries = validArtifact().map((entry) => entry.path === 'assets/index.js'
      ? { ...entry, bytes: new Uint8Array([...entry.bytes, ...new TextEncoder().encode(state)]) }
      : entry);

    expect(() => buildStephenReleaseMetadata(entries, SOURCE_SHA))
      .toThrow(`artifact contains non-public editorial state: ${state}`);
  });

  it('keeps every owner-approved seed detail in the production sitemap', async () => {
    const sitemapPath = decodeURIComponent(
      new URL('../../public/sitemap.xml', import.meta.url).pathname,
    );
    const sitemap = await readFile(sitemapPath, 'utf8');

    for (const item of approvedSeedItems) {
      expect(sitemap).toContain(
        `<loc>https://stephen.lake2ocean.top/items/${item.slug}/</loc>`,
      );
    }
  });
});

describe('SAAS-607 release CLI boundary', () => {
  it('accepts only the exact verify command and binds metadata to the artifact root', () => {
    expect(parseStephenReleaseCliArgs([
      'verify',
      '--artifact', '/tmp/stephen-dist',
      '--source-sha', SOURCE_SHA,
      '--metadata-file', '/tmp/stephen-dist/.stephen-release.json',
    ])).toEqual({
      command: 'verify',
      artifactDirectory: '/tmp/stephen-dist',
      sourceSha: SOURCE_SHA,
      metadataFile: '/tmp/stephen-dist/.stephen-release.json',
    });
  });

  it.each([
    ['verify', '--artifact', 'relative', '--source-sha', SOURCE_SHA, '--metadata-file', 'relative/.stephen-release.json'],
    ['verify', '--artifact', '/tmp/stephen-dist', '--source-sha', SOURCE_SHA, '--metadata-file', '/tmp/outside.json'],
    ['verify', '--artifact', '/tmp/stephen-dist', '--source-sha', SOURCE_SHA],
    ['publish', '--artifact', '/tmp/stephen-dist', '--source-sha', SOURCE_SHA, '--metadata-file', '/tmp/stephen-dist/.stephen-release.json'],
  ])('rejects unsafe or unexpected CLI arguments: %j', (...argv) => {
    expect(() => parseStephenReleaseCliArgs(argv)).toThrow('invalid SAAS-607 CLI arguments');
  });

  it('walks the real artifact without following links and writes bound metadata', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-artifact-'));
    const artifactDirectory = join(temporaryRoot, 'dist');
    const metadataFile = join(artifactDirectory, '.stephen-release.json');
    try {
      for (const entry of validArtifact()) {
        const destination = join(artifactDirectory, entry.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.bytes);
      }

      const metadata = await verifyStephenArtifactDirectory({
        artifactDirectory,
        sourceSha: SOURCE_SHA,
        metadataFile,
      });
      const stored = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<string, unknown>;

      expect(stored.sourceSha).toBe(SOURCE_SHA);
      expect(stored.contentChecksum).toBe(metadata.contentChecksum);

      await symlink('index.html', join(artifactDirectory, 'linked-index.html'));
      await expect(verifyStephenArtifactDirectory({
        artifactDirectory,
        sourceSha: SOURCE_SHA,
        metadataFile,
      })).rejects.toThrow('artifact entries must be regular files: linked-index.html');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function runCommand(command: string, args: readonly string[], cwd?: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function runDispatcher(
  releaseRoot: string,
  originalCommand: string,
  input?: Uint8Array,
) {
  return spawnSync('/bin/bash', [dispatcherPath, '--test-root', releaseRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SAAS607_DISPATCHER_TEST_MODE: '1',
      SSH_ORIGINAL_COMMAND: originalCommand,
    },
    input,
  });
}

async function createReleaseArchive(
  temporaryRoot: string,
  sourceSha: string,
) {
  const artifactDirectory = join(temporaryRoot, `artifact-${sourceSha}`);
  for (const entry of validArtifact()) {
    const destination = join(artifactDirectory, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes);
  }
  await verifyStephenArtifactDirectory({
    artifactDirectory,
    sourceSha,
    metadataFile: join(artifactDirectory, '.stephen-release.json'),
  });
  await chmod(join(artifactDirectory, 'assets/index.js'), 0o4755);
  const archive = join(temporaryRoot, `${sourceSha}.tar.gz`);
  const packed = runCommand('tar', ['-czf', archive, '.'], artifactDirectory);
  expect(packed.status, packed.stderr).toBe(0);
  const digest = runCommand('shasum', ['-a', '256', archive]);
  expect(digest.status, digest.stderr).toBe(0);
  return { archive, checksum: digest.stdout.trim().split(/\s+/)[0] };
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

function createUnsafeArchive(
  archive: string,
  kind: 'traversal' | 'symlink' | 'oversized',
) {
  const script = [
    'import io, sys, tarfile',
    'archive, kind = sys.argv[1:]',
    "with tarfile.open(archive, 'w:gz') as handle:",
    "    metadata = b'{}'",
    "    metadata_item = tarfile.TarInfo('.stephen-release.json')",
    '    metadata_item.size = len(metadata)',
    '    handle.addfile(metadata_item, io.BytesIO(metadata))',
    "    baseline = b'baseline'",
    "    baseline_item = tarfile.TarInfo('index.html')",
    '    baseline_item.size = len(baseline)',
    '    handle.addfile(baseline_item, io.BytesIO(baseline))',
    "    if kind == 'traversal':",
    "        payload = b'escape'",
    "        item = tarfile.TarInfo('assets/../escape.txt')",
    '        item.size = len(payload)',
    '        handle.addfile(item, io.BytesIO(payload))',
    "    elif kind == 'symlink':",
    "        item = tarfile.TarInfo('assets/link')",
    '        item.type = tarfile.SYMTYPE',
    "        item.linkname = '/tmp/escape'",
    '        handle.addfile(item)',
    '    else:',
    "        item = tarfile.TarInfo('assets/oversized.bin')",
    '        item.size = 8 * 1024 * 1024 + 1',
    "        handle.addfile(item, io.BytesIO(b'0' * item.size))",
  ].join('\n');
  return runCommand('python3', ['-I', '-c', script, archive, kind]);
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

describe('SAAS-607 remote release helper', () => {
  it('does not trust archive ownership or permissions during production extraction', async () => {
    const helper = await readFile(helperPath, 'utf8');

    expect(helper).toContain('copy_incoming_archive "$incoming_archive" "$archive_tmp"');
    expect(helper).toContain("release root and releases directory must not be group or world writable");
    expect(helper).toContain('os.O_RDONLY | os.O_NOFOLLOW');
    expect(helper).toContain('MAX_ARCHIVE_BYTES = 50 * 1024 * 1024');
    expect(helper).toContain("tarfile.open(archive_path, mode='r|gz')");
    expect(helper).toContain('MAX_ARTIFACT_BYTES = 16 * 1024 * 1024');
    expect(helper).toContain('MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024');
    expect(helper).toContain('MAX_RELEASE_STORE_BYTES = 512 * 1024 * 1024');
    expect(helper).toContain('ensure_release_capacity');
    expect(helper).toContain('python3 -I');
    expect(helper).toContain('flock -x -w 120 9');
    expect(helper).toContain('/usr/bin/timeout --signal=TERM --kill-after=5s 20s');
    expect(helper).toContain('/usr/bin/docker exec "$EDGE_CONTAINER" nginx -t');
    expect(helper).toContain('https://stephen.lake2ocean.top/release-id.json');
    expect(helper).toContain('runtime_identity_matches "$expected_sha"');
    expect(helper).toContain("--on-active='30m'");
    expect(helper).toContain('stephen-release-helper expire');
    expect(helper).toContain('--property=Restart=on-failure');
    expect(helper.indexOf('schedule_expiry "$source_sha" "$lease_id"'))
      .toBeLessThan(helper.indexOf('write_pending "$source_sha" "$lease_id"'));
    expect(helper).toContain(
      'tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage_tmp"',
    );
    expect(helper).toContain('chown -R root:root -- "$stage_tmp"');
  });

  it('stages a checksummed archive idempotently and refuses a checksum mismatch', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-helper-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    try {
      const release = await createReleaseArchive(temporaryRoot, SOURCE_SHA);
      await installIncomingArchive(releaseRoot, SOURCE_SHA, release.archive);

      const staged = runReleaseHelper(releaseRoot, 'stage', SOURCE_SHA, release.checksum);
      expect(staged.status, staged.stderr).toBe(0);
      expect(staged.stdout).toContain('stage_status=staged');
      expect(JSON.parse(await readFile(
        join(releaseRoot, 'releases', SOURCE_SHA, '.stephen-release.json'),
        'utf8',
      )).sourceSha).toBe(SOURCE_SHA);
      expect((await stat(
        join(releaseRoot, 'releases', SOURCE_SHA, 'assets/index.js'),
      )).mode & 0o777).toBe(0o644);
      await expect(readFile(join(releaseRoot, 'incoming', `${SOURCE_SHA}.tar.gz`)))
        .rejects.toThrow();

      const repeated = runReleaseHelper(releaseRoot, 'stage', SOURCE_SHA, release.checksum);
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain('stage_status=already_staged');

      await writeFile(
        join(releaseRoot, 'releases', SOURCE_SHA, 'index.html'),
        new TextEncoder().encode('tampered after staging'),
      );
      const tampered = runReleaseHelper(releaseRoot, 'stage', SOURCE_SHA, release.checksum);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain('release files do not match metadata');

      const mismatchRoot = join(temporaryRoot, 'mismatch-root');
      await installIncomingArchive(mismatchRoot, SOURCE_SHA, release.archive);
      const mismatch = runReleaseHelper(
        mismatchRoot,
        'stage',
        SOURCE_SHA,
        '0'.repeat(64),
      );
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain('archive checksum does not match');
      await expect(readFile(join(mismatchRoot, 'releases', SOURCE_SHA, 'index.html')))
        .rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects an oversized incoming archive before copying it into the root release area', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-oversized-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    const incoming = join(releaseRoot, 'incoming');
    try {
      await mkdir(incoming, { recursive: true });
      const incomingArchive = join(incoming, `${SOURCE_SHA}.tar.gz`);
      const created = runCommand('truncate', ['-s', '52428801', incomingArchive]);
      expect(created.status, created.stderr).toBe(0);

      const rejected = runReleaseHelper(
        releaseRoot,
        'stage',
        SOURCE_SHA,
        '0'.repeat(64),
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('incoming archive exceeds the 50 MiB safety limit');
      expect(await readdir(join(releaseRoot, 'releases'), { withFileTypes: true }))
        .toHaveLength(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('fails closed before a new stage can exceed the release-store quota', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-release-quota-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    try {
      const release = await createReleaseArchive(temporaryRoot, SOURCE_SHA);
      await installIncomingArchive(releaseRoot, SOURCE_SHA, release.archive);
      const releases = join(releaseRoot, 'releases');
      await mkdir(releases, { recursive: true });
      const filler = runCommand('truncate', [
        '-s',
        String(450 * 1024 * 1024),
        join(releases, 'quota-filler'),
      ]);
      expect(filler.status, filler.stderr).toBe(0);

      const rejected = runReleaseHelper(
        releaseRoot,
        'stage',
        SOURCE_SHA,
        release.checksum,
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('release store quota or free-space reserve');
      await expect(readFile(join(releases, SOURCE_SHA, 'index.html')))
        .rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects traversal, link, and oversized declared tar members before extraction', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-unsafe-tar-'));
    try {
      for (const kind of ['traversal', 'symlink', 'oversized'] as const) {
        const releaseRoot = join(temporaryRoot, kind);
        const archive = join(temporaryRoot, `${kind}.tar.gz`);
        const created = createUnsafeArchive(archive, kind);
        expect(created.status, created.stderr).toBe(0);
        const digest = runCommand('shasum', ['-a', '256', archive]);
        expect(digest.status, digest.stderr).toBe(0);
        await installIncomingArchive(releaseRoot, SOURCE_SHA, archive);

        const rejected = runReleaseHelper(
          releaseRoot,
          'stage',
          SOURCE_SHA,
          digest.stdout.trim().split(/\s+/)[0],
        );
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain(
          'archive members, paths, or declared size are unsafe',
        );
        expect(await readdir(join(releaseRoot, 'releases'), { withFileTypes: true }))
          .toHaveLength(0);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('preserves current on Nginx precheck failure and can roll back a later activation', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-activate-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    try {
      for (const sourceSha of [PREVIOUS_SHA, SOURCE_SHA]) {
        const release = await createReleaseArchive(temporaryRoot, sourceSha);
        await installIncomingArchive(releaseRoot, sourceSha, release.archive);
        const staged = runReleaseHelper(releaseRoot, 'stage', sourceSha, release.checksum);
        expect(staged.status, staged.stderr).toBe(0);
      }
      await symlink(`releases/${PREVIOUS_SHA}`, join(releaseRoot, 'current'));
      await mkdir(join(releaseRoot, 'test-control'), { recursive: true });
      await writeFile(join(releaseRoot, 'test-control', 'runtime-ready'), 'yes\n', 'utf8');
      await writeFile(join(releaseRoot, 'test-control', 'nginx-check'), 'fail\n', 'utf8');

      const rejected = runReleaseHelper(releaseRoot, 'activate', SOURCE_SHA, LEASE_ID);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('Nginx validation failed before switch');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`current_sha=${PREVIOUS_SHA}`);

      await writeFile(join(releaseRoot, 'test-control', 'nginx-check'), 'pass\n', 'utf8');
      await writeFile(join(releaseRoot, 'test-control', 'reload-fail'), 'yes\n', 'utf8');
      const reloadRejected = runReleaseHelper(releaseRoot, 'activate', SOURCE_SHA, LEASE_ID);
      expect(reloadRejected.status).not.toBe(0);
      expect(reloadRejected.stderr).toContain('Nginx reload failed; previous release restored');
      const restorePending = runReleaseHelper(releaseRoot, 'status');
      expect(restorePending.stdout).toContain(`current_sha=${PREVIOUS_SHA}`);
      expect(restorePending.stdout).toContain(`pending_lease_id=${LEASE_ID}`);
      expect(await readFile(
        join(releaseRoot, 'test-control', 'scheduled-expiry'),
        'utf8',
      )).toContain(`${SOURCE_SHA} ${LEASE_ID}`);

      await writeFile(join(releaseRoot, 'test-control', 'reload-fail'), 'no\n', 'utf8');
      const recovered = runReleaseHelper(releaseRoot, 'recover');
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain('recovery_status=rolled_back');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain('pending_source_sha=none');
      await expect(readFile(join(releaseRoot, 'test-control', 'scheduled-expiry')))
        .rejects.toThrow();
      const activated = runReleaseHelper(releaseRoot, 'activate', SOURCE_SHA, LEASE_ID);
      expect(activated.status, activated.stderr).toBe(0);
      expect(activated.stdout).toContain('activation_status=pending');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`current_sha=${SOURCE_SHA}`);
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`pending_lease_id=${LEASE_ID}`);

      const staleLease = 'ffffffffffffffffffffffffffffffff';
      const staleExpiry = runReleaseHelper(releaseRoot, 'expire', SOURCE_SHA, staleLease);
      expect(staleExpiry.status, staleExpiry.stderr).toBe(0);
      expect(staleExpiry.stdout).toContain('expiry_status=stale_timer_ignored');
      expect(runReleaseHelper(releaseRoot, 'rollback', SOURCE_SHA, staleLease).status)
        .not.toBe(0);
      expect(runReleaseHelper(releaseRoot, 'finalize', SOURCE_SHA, staleLease).status)
        .not.toBe(0);
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`current_sha=${SOURCE_SHA}`);

      const rolledBack = runReleaseHelper(releaseRoot, 'rollback', SOURCE_SHA, LEASE_ID);
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`current_sha=${PREVIOUS_SHA}`);

      const nextLease = 'abcdef1234567890abcdef1234567890';
      const pending = runReleaseHelper(releaseRoot, 'activate', SOURCE_SHA, nextLease);
      expect(pending.status, pending.stderr).toBe(0);
      const finalized = runReleaseHelper(releaseRoot, 'finalize', SOURCE_SHA, nextLease);
      expect(finalized.status, finalized.stderr).toBe(0);
      expect(finalized.stdout).toContain('finalize_status=finalized');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain('pending_source_sha=none');

      const reverseLease = 'fedcba0987654321fedcba0987654321';
      expect(runReleaseHelper(releaseRoot, 'activate', PREVIOUS_SHA, reverseLease).status)
        .toBe(0);
      expect(runReleaseHelper(releaseRoot, 'finalize', PREVIOUS_SHA, reverseLease).status)
        .toBe(0);
      const expiryLease = '00112233445566778899aabbccddeeff';
      expect(runReleaseHelper(releaseRoot, 'activate', SOURCE_SHA, expiryLease).status)
        .toBe(0);
      const expired = runReleaseHelper(releaseRoot, 'expire', SOURCE_SHA, expiryLease);
      expect(expired.status, expired.stderr).toBe(0);
      expect(expired.stdout).toContain('expiry_status=rolled_back');
      expect(runReleaseHelper(releaseRoot, 'status').stdout)
        .toContain(`current_sha=${PREVIOUS_SHA}`);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('rolls back even when the pending release is corrupted', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-corrupt-rollback-'));
    try {
      for (const recovery of ['rollback', 'expire', 'recover'] as const) {
        const releaseRoot = join(temporaryRoot, recovery);
        for (const sourceSha of [OLDER_SHA, PREVIOUS_SHA, SOURCE_SHA]) {
          const release = await createReleaseArchive(
            join(temporaryRoot, `${recovery}-${sourceSha}`),
            sourceSha,
          );
          await installIncomingArchive(releaseRoot, sourceSha, release.archive);
          const staged = runReleaseHelper(releaseRoot, 'stage', sourceSha, release.checksum);
          expect(staged.status, staged.stderr).toBe(0);
        }
        await symlink(`releases/${PREVIOUS_SHA}`, join(releaseRoot, 'current'));
        await symlink(`releases/${OLDER_SHA}`, join(releaseRoot, 'previous'));
        await mkdir(join(releaseRoot, 'test-control'), { recursive: true });
        await writeFile(join(releaseRoot, 'test-control', 'runtime-ready'), 'yes\n', 'utf8');
        await writeFile(join(releaseRoot, 'test-control', 'nginx-check'), 'pass\n', 'utf8');
        const lease = recovery === 'rollback'
          ? '11111111111111111111111111111111'
          : recovery === 'expire'
            ? '22222222222222222222222222222222'
            : '33333333333333333333333333333333';
        expect(runReleaseHelper(releaseRoot, 'activate', SOURCE_SHA, lease).status).toBe(0);
        await writeFile(
          join(releaseRoot, 'releases', SOURCE_SHA, 'index.html'),
          'corrupted pending release',
          'utf8',
        );

        const result = recovery === 'recover'
          ? runReleaseHelper(releaseRoot, recovery)
          : runReleaseHelper(releaseRoot, recovery, SOURCE_SHA, lease);
        expect(result.status, result.stderr).toBe(0);
        const status = runReleaseHelper(releaseRoot, 'status');
        expect(status.stdout).toContain(`current_sha=${PREVIOUS_SHA}`);
        expect(status.stdout).toContain(`previous_sha=${OLDER_SHA}`);
        expect(status.stdout).toContain('pending_source_sha=none');
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('installs a boot recovery unit for any persistent pending activation', async () => {
    const service = await readFile(recoveryServicePath, 'utf8');

    expect(service).toContain('ExecStart=/usr/local/sbin/stephen-release-helper recover');
    expect(service).toContain('After=docker.service network-online.target');
    expect(service).toContain('Restart=on-failure');
    expect(service).toContain('RestartSec=15s');
  });
});

describe('SAAS-607 forced-command SSH boundary', () => {
  it('accepts a bounded exact-SHA upload and refuses an interactive shell command', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-dispatcher-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    try {
      const incoming = join(releaseRoot, 'incoming');
      const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const staleArchive = join(incoming, `${staleSha}.tar.gz`);
      await mkdir(incoming, { recursive: true });
      await writeFile(staleArchive, new TextEncoder().encode('stale failed upload'));
      const aged = runCommand('touch', ['-t', '202001010000', staleArchive]);
      expect(aged.status, aged.stderr).toBe(0);
      const payload = new TextEncoder().encode('checksummed release archive bytes');
      const uploaded = runDispatcher(
        releaseRoot,
        `stephen-upload ${SOURCE_SHA}`,
        payload,
      );
      expect(uploaded.status, uploaded.stderr).toBe(0);
      const dispatcher = await readFile(dispatcherPath, 'utf8');
      expect(dispatcher).toContain('python3 -I');
      expect(dispatcher).toContain('incoming upload quota has no remaining capacity');
      expect(dispatcher).toContain('cleanup_stale_incoming');
      expect(Array.from(await readFile(join(
        releaseRoot,
        'incoming',
        `${SOURCE_SHA}.tar.gz`,
      )))).toEqual(Array.from(payload));
      await expect(readFile(staleArchive)).rejects.toThrow();

      const shell = runDispatcher(releaseRoot, 'bash -lc id');
      expect(shell.status).not.toBe(0);
      expect(shell.stderr).toContain('SSH command is not allowed');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('bounds the temporary upload by remaining incoming capacity', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-dispatcher-quota-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    try {
      const incoming = join(releaseRoot, 'incoming');
      await mkdir(incoming, { recursive: true });
      const existing = join(
        incoming,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tar.gz',
      );
      const created = runCommand('truncate', ['-s', '104857599', existing]);
      expect(created.status, created.stderr).toBe(0);
      const rejected = runDispatcher(
        releaseRoot,
        `stephen-upload ${SOURCE_SHA}`,
        new TextEncoder().encode('too large for remaining quota'),
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('bounded incoming quota');
      await expect(readFile(join(incoming, `${SOURCE_SHA}.tar.gz`)))
        .rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('accepts only the fixed helper command grammar', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'saas-607-dispatcher-helper-'));
    const releaseRoot = join(temporaryRoot, 'release-root');
    try {
      const accepted = runDispatcher(releaseRoot, 'stephen-helper status');
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('test_helper_command=status');

      const injection = runDispatcher(
        releaseRoot,
        `stephen-helper stage ${SOURCE_SHA} ${'0'.repeat(64)}; id`,
      );
      expect(injection.status).not.toBe(0);
      expect(injection.stderr).toContain('SSH command is not allowed');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('SAAS-607 GitHub release workflow contract', () => {
  it('runs the production-only stage branch on the disposable Ubuntu check runner', async () => {
    const checksWorkflow = await readFile(checksWorkflowPath, 'utf8');
    const productionProbe = await readFile(productionStageTestPath, 'utf8');

    expect(checksWorkflow).toContain('runs-on: ubuntu-latest');
    expect(checksWorkflow).toContain('actions: read');
    expect(checksWorkflow).toContain('repos/$GH_REPO/actions/variables');
    expect(checksWorkflow).toContain('stephen-production-stage-test.sh');
    expect(checksWorkflow).toContain('RUNNER_ENVIRONMENT=github-hosted');
    expect(productionProbe).toContain('SAAS607_PRODUCTION_LOCK_PROBE=1');
    expect(productionProbe).toContain('serialized idempotent stage probe failed');
  });

  it('accepts the exact-green-main, environment-scoped, rollback-capable workflow', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).not.toContain("git fetch --no-tags origin");
    expect(validateStephenReleaseWorkflow(workflow)).toEqual({
      runners: ['ubuntu-latest', 'ubuntu-latest'],
      permissions: ['actions: read', 'contents: read'],
      environment: 'production-stephen',
    });
  });

  it('rejects unsafe runner, permissions, SSH, enablement, or rollback mutations', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(() => validateStephenReleaseWorkflow(
      workflow.replace('runs-on: ubuntu-latest', 'runs-on: macos-latest'),
    )).toThrow('release workflow runners must be ubuntu-latest');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace('contents: read', 'contents: write'),
    )).toThrow('release workflow permissions must be minimal');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace("vars.STEPHEN_RELEASE_ENABLED == '1'", 'true'),
    )).toThrow('production release must require explicit repository opt-in');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace('StrictHostKeyChecking=yes', 'StrictHostKeyChecking=no'),
    )).toThrow('SSH host verification must fail closed');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace('stephen-helper rollback', 'stephen-helper recover'),
    )).toThrow('post-activation smoke failure must invoke rollback');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace(
        'repos/$GH_REPO/actions/variables/STEPHEN_RELEASE_ENABLED',
        'repos/$GH_REPO/actions/variables/BROKEN_RELEASE_GATE',
      ),
    )).toThrow('release job must re-read authorization after waiting and before finalize');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace('/release-id.json', '/healthz-stephen'),
    )).toThrow('release smoke surface is missing: /release-id.json');
    expect(() => validateStephenReleaseWorkflow(
      workflow.replace('stephen-helper finalize', 'stephen-helper status'),
    )).toThrow('release workflow must invoke remote finalize');
  });
});
