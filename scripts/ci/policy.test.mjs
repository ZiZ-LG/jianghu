import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKS, candidatePaths, selectChecks } from './select-checks.mjs';
import { verifyResults } from './verify-results.mjs';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const selection = (paths, options = {}) => ({
  schemaVersion: 1, headSha: sha, baseSha: base, mergeBase: base,
  paths, ...selectChecks(paths, options),
});
const needsFor = (plan) => Object.fromEntries([
  ['select', { result: 'success' }],
  ...CHECKS.map(name => [name, { result: plan.checks[name] ? 'success' : 'skipped' }]),
]);

test('explanatory governance documents select only docs', () => {
  const plan = selectChecks(['AGENTS.md', 'docs/商业版开发待办清单v1.md',
    'docs/ADR-005-按功能批次自主研发与上线前数据基线.md',
    'docs/superpowers/plans/new-plan.md', 'docs/designs/new-design.md']);
  assert.deepEqual(Object.keys(plan.checks).filter(k => plan.checks[k]), ['docs']);
});

for (const path of ['docs/用户手册.md', 'docs/集成-M1实现清单.md',
  'docs/content/stephen-article.md', 'docs/pde-handoff/SPEC.md', 'unknown.md']) {
  test(`consumed or unclassified document expands checks: ${path}`, () => {
    const plan = selectChecks([path]);
    assert.equal(plan.full, true);
    for (const name of CHECKS.filter(n => n !== 'legacy-postgres-operations')) assert.equal(plan.checks[name], true);
  });
}

test('ordinary frontend code runs app without database or audit', () => {
  const { checks } = selectChecks(['app/src/components/TodayPanel.tsx']);
  assert.equal(checks.app, true);
  assert.equal(checks.server, false);
  assert.equal(checks['postgres-operations'], false);
  assert.equal(checks['dependency-audit'], false);
});

test('backend changes retain consumers, security, database and image checks', () => {
  const { checks } = selectChecks(['server/src/auth.ts']);
  for (const name of ['server', 'app', 'domain-contracts', 'postgres-operations', 'production-images']) assert.equal(checks[name], true);
});

for (const path of ['packages/domain-contracts/src/crm.ts', 'packages/g64111/src/score.ts',
  'packages/pde-kernel/src/index.ts', 'server/prisma/schema.prisma',
  'server/package-lock.json', 'app/package.json', 'docker-compose.yml',
  'scripts/backup-postgres.sh', '.github/workflows/ci.yml', 'scripts/ci/select-checks.mjs',
  'new-subsystem/runtime.ts']) {
  test(`critical or unknown change expands complete current checks: ${path}`, () => {
    assert.equal(selectChecks([path]).full, true);
  });
}

test('historical migration changes retain the legacy drill in addition to current checks', () => {
  assert.equal(selectChecks(['server/prisma/postgres/legacy/old.prisma']).checks['legacy-postgres-operations'], true);
  assert.equal(selectChecks(['scripts/test-postgres-ops-integration.sh']).checks['legacy-postgres-operations'], true);
});

test('full main, scheduled and manual runs cannot become light', () => {
  const { checks, full } = selectChecks(['AGENTS.md'], { forceFull: true });
  assert.equal(full, true);
  assert.equal(checks['postgres-operations'], true);
  assert.equal(checks['dependency-audit'], true);
  assert.equal(checks['legacy-postgres-operations'], false);
});

test('empty or malformed path sets never produce a light success', () => {
  assert.equal(selectChecks([]).full, true);
  assert.throws(() => selectChecks(['../outside.md']));
  assert.throws(() => selectChecks(['ok.md\napp/package.json']));
});

test('candidate diff includes earlier code, deletes and both sides of a rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-215-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI Test'); git('config', 'user.email', 'ci@example.invalid');
    mkdirSync(join(dir, 'app/src'), { recursive: true });
    writeFileSync(join(dir, 'app/src/a.ts'), 'before');
    writeFileSync(join(dir, 'app/src/delete.ts'), 'delete');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    git('mv', 'app/src/a.ts', 'app/src/b.ts');
    git('rm', 'app/src/delete.ts'); git('commit', '-qm', 'code');
    writeFileSync(join(dir, 'AGENTS.md'), 'documentation only last commit');
    git('add', '.'); git('commit', '-qm', 'docs');
    const result = candidatePaths(dir, baseSha, git('rev-parse', 'HEAD'));
    assert.deepEqual(result.paths, ['AGENTS.md', 'app/src/a.ts', 'app/src/b.ts', 'app/src/delete.ts']);
    assert.equal(selectChecks(result.paths).checks.app, true);
    assert.throws(() => candidatePaths(dir, 'f'.repeat(40), git('rev-parse', 'HEAD')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('required summary permits only explicit selected success', () => {
  const plan = selection(['AGENTS.md']);
  assert.doesNotThrow(() => verifyResults(plan, needsFor(plan), sha));
});

for (const result of ['failure', 'cancelled', 'skipped', 'timed_out', undefined]) {
  test(`required summary rejects selected ${result ?? 'missing'} result`, () => {
    const plan = selection(['server/src/auth.ts']);
    const needs = needsFor(plan);
    needs.server = result ? { result } : undefined;
    assert.throws(() => verifyResults(plan, needs, sha));
  });
}

test('required summary rejects selector failure, malformed plan and wrong SHA', () => {
  const plan = selection(['AGENTS.md']);
  assert.throws(() => verifyResults(plan, { ...needsFor(plan), select: { result: 'failure' } }, sha));
  assert.throws(() => verifyResults(plan, needsFor(plan), 'c'.repeat(40)));
  assert.throws(() => verifyResults({ ...plan, checks: { docs: true } }, needsFor(plan), sha));
  assert.throws(() => verifyResults({ ...plan, checks: { ...plan.checks, server: 'false' } }, needsFor(plan), sha));
});

test('required summary re-derives policy and rejects omitted dependent checks', () => {
  const plan = selection(['server/src/auth.ts']);
  plan.checks['postgres-operations'] = false;
  assert.throws(() => verifyResults(plan, needsFor(plan), sha));
});

test('unexpected failures cannot hide behind unselected jobs', () => {
  const plan = selection(['AGENTS.md']);
  assert.throws(() => verifyResults(plan, { ...needsFor(plan), app: { result: 'failure' } }, sha));
});
