import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHECKS, eventRequiresFull, selectChecks } from './select-checks.mjs';
import { verifyResults } from './verify-results.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../../.github/workflows/stephen-release.yml', import.meta.url), 'utf8');

test('development has one PR trigger; main keeps the existing complete CI release identity', () => {
  assert.match(workflow, /^name: CI\n/);
  assert.match(workflow, /\n  push:\n    branches: \[main\]\n  pull_request:\n/);
  assert.doesNotMatch(workflow, /paths-ignore:|\[skip ci\]|continue-on-error:/);
  assert.match(release, /workflows: \['CI'\]/);
  assert.match(release, /workflow_run\.conclusion == 'success'/);
  assert.match(release, /workflow_run\.event == 'push'/);
  assert.match(release, /workflow_run\.head_branch == 'main'/);
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.equal(eventRequiresFull(event), true);
    const plan = { schemaVersion: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      mergeBase: 'b'.repeat(40), paths: ['AGENTS.md'], ...selectChecks(['AGENTS.md']) };
    assert.throws(() => verifyResults(plan, { select: { result: 'success' } }, plan.headSha, { requireFull: true }));
  }
  assert.equal(eventRequiresFull('pull_request'), false);
  assert.throws(() => eventRequiresFull('unknown'));
});

test('only new PR events can cancel their replaced development run', () => {
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' && github.run_attempt == 1 \}\}/);
  assert.match(workflow, /format\('ci-pr-\{0\}', github.event.pull_request.number\)/);
  assert.match(workflow, /format\('ci-run-\{0\}', github.run_id\)/);
});

test('every selectable job is wired to a fixed always-running required summary', () => {
  const needed = workflow.match(/\n    needs: \[([^\]]+)\]/)?.[1].split(',').map(s => s.trim());
  assert.deepEqual(needed, ['select', ...CHECKS]);
  assert.match(workflow, /name: CI required\n    if: always\(\)/);
  for (const name of CHECKS) {
    assert.ok(workflow.includes(`  ${name}:\n    needs: select\n    if: needs.select.outputs.${name} == 'true'`), name);
  }
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@v4\n([\s\S]*?)(?=\n      -|$)/g)];
  assert.equal(checkouts.length, CHECKS.length + 2);
  for (const [, checkout] of checkouts) assert.match(checkout, /ref: \$\{\{ env.CI_HEAD_SHA \}\}/);
});

test('current and legacy database checks stay distinct and auditable', () => {
  assert.match(workflow, /run: bash scripts\/test-postgres-current-baseline.sh/);
  assert.match(workflow, /run: bash scripts\/test-postgres-ops-integration.sh/);
  assert.match(workflow, /schedule:\n    - cron:/);
  assert.match(workflow, /run: npm audit --audit-level=high/);
  assert.match(workflow, /CI_SELECTION: \$\{\{ needs.select.outputs.selection \}\}/);
  assert.match(workflow, /CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
});
