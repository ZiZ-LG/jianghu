import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CHECKS, eventRequiresFull, selectChecks } from './select-checks.mjs';

export function verifyResults(plan, needs, expectedSha, { requireFull = false, expectedBase } = {}) {
  if (!plan || plan.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(expectedSha) ||
      plan.headSha !== expectedSha || !/^[a-f0-9]{40}$/.test(plan.baseSha) ||
      !/^[a-f0-9]{40}$/.test(plan.mergeBase) || (expectedBase && plan.baseSha !== expectedBase)) {
    throw new Error('Missing or mismatched candidate identity');
  }
  if (needs?.select?.result !== 'success') throw new Error('Selection did not succeed');
  if (typeof plan.full !== 'boolean' || typeof plan.forceFull !== 'boolean' ||
      typeof plan.legacyRequested !== 'boolean' || !plan.checks ||
      Object.keys(plan.checks).sort().join(',') !== [...CHECKS].sort().join(',')) throw new Error('Malformed selection');
  if (requireFull && !plan.forceFull) throw new Error('This event requires complete verification');
  const expected = selectChecks(plan.paths, { forceFull: plan.forceFull, legacyRequested: plan.legacyRequested });
  if (plan.full !== expected.full) throw new Error('Selection scope was changed');
  for (const name of CHECKS) {
    if (typeof plan.checks[name] !== 'boolean' || plan.checks[name] !== expected.checks[name]) throw new Error(`Invalid check selection: ${name}`);
    const result = needs[name]?.result;
    if (plan.checks[name] ? result !== 'success' : !['success', 'skipped'].includes(result)) {
      throw new Error(`Required result not satisfied: ${name}=${result ?? 'missing'}`);
    }
  }
  return CHECKS.filter(name => plan.checks[name]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = verifyResults(JSON.parse(process.env.CI_SELECTION || 'null'),
    JSON.parse(process.env.CI_NEEDS || '{}'), process.env.CI_HEAD_SHA,
    { requireFull: eventRequiresFull(process.env.GITHUB_EVENT_NAME), expectedBase: process.env.CI_BASE_SHA });
  const message = `Verified ${process.env.CI_HEAD_SHA}: ${required.join(', ')}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## CORE-215 required results\n\n${message}\n\nNo deployment or main merge is performed by this workflow.\n`);
}
