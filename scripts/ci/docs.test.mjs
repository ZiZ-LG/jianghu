import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocuments, localLinks, validateTaskList } from './check-docs.mjs';

test('local links resolve Chinese paths, fragments and directory references', () => {
  assert.deepEqual(localLinks('[规范](../ADR-005-规范.md#范围) [目录](../../server/) [网络](https://example.test) [锚](#a)', 'docs/plans/a.md'),
    ['docs/ADR-005-规范.md', 'server/']);
});
test('fenced examples and inline code are excluded', () => {
  assert.deepEqual(localLinks('```md\n[x](missing.md)\n```\n`[x](missing.md)`\n[x](real.md)', 'README.md'), ['real.md']);
});
test('repository traversal links fail closed', () => {
  assert.throws(() => localLinks('[x](../../secret)', 'README.md'));
});
test('active task IDs are unique and at most one is in progress', () => {
  const row = '| CORE-215 | CORE | CI | 3d | CORE-207 | IN_PROGRESS |';
  assert.doesNotThrow(() => validateTaskList(`${row}\n### 旧 G5–G7 处置\n${row}`));
  assert.throws(() => validateTaskList(`${row}\n${row}`));
  assert.throws(() => validateTaskList(`${row}\n${row.replace('CORE-215', 'CORE-208')}`));
});

test('real Git document check rejects new broken links and deleted linked targets without rewriting history', () => {
  const root = mkdtempSync(join(tmpdir(), 'core215-docs-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q'); git('config', 'user.name', 'CI'); git('config', 'user.email', 'ci@example.invalid');
    mkdirSync(join(root, 'docs'));
    const task = '| CORE-215 | CORE | CI | 3d | CORE-207 | IN_PROGRESS |\n## 8. 状态更新记录\n\nHistorical record\n';
    writeFileSync(join(root, 'docs/商业版开发待办清单v1.md'), task);
    writeFileSync(join(root, 'README.md'), '[old broken](old-missing.md) [valid](docs/reference.md)');
    writeFileSync(join(root, 'docs/reference.md'), 'reference');
    const base = commit();
    writeFileSync(join(root, 'README.md'), '[old broken](old-missing.md) [valid](docs/reference.md)\nUpdated explanation');
    const good = commit();
    assert.doesNotThrow(() => checkDocuments(root, base, good));
    writeFileSync(join(root, 'README.md'), '[new broken](new-missing.md)');
    assert.throws(() => checkDocuments(root, base, commit()), /new-missing/);
    writeFileSync(join(root, 'README.md'), '[valid](docs/reference.md)');
    rmSync(join(root, 'docs/reference.md'));
    assert.throws(() => checkDocuments(root, base, commit()), /reference/);
    writeFileSync(join(root, 'docs/reference.md'), 'reference');
    writeFileSync(join(root, 'docs/商业版开发待办清单v1.md'), task.replace('Historical record', 'Rewritten record'));
    assert.throws(() => checkDocuments(root, base, commit()), /history was rewritten/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
