#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(here, '../fixtures/compatibility.json'), 'utf8'));
const itemKeys = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', '1K'];

function requestedPath(argv) {
  const index = argv.indexOf('--score-py');
  if (index >= 0 && argv[index + 1]) return resolve(argv[index + 1]);
  if (process.env.WORKBUDDY_SCORE_PY) return resolve(process.env.WORKBUDDY_SCORE_PY);
  return null;
}

function discoverScorePy() {
  const explicit = requestedPath(process.argv.slice(2));
  if (explicit) return explicit;
  const candidates = [
    join(homedir(), '.workbuddy/skills/_shared/score.py'),
    '/Volumes/PowerData/数字员工销售自助包-v2.0.6/3-WorkBuddy-skill-源码/_shared/score.py',
    '/Volumes/PowerData/数字员工销售自助包-v2.0.6/一键装配包/skills/_shared/score.py',
    '/Volumes/PowerData/数字员工销售自助包-v2.0.6/4-云盘骨架/上传到 _master/engine/score.py',
  ];
  return candidates.find(existsSync) ?? null;
}

function parseExternalReport(output) {
  const items = {};
  const itemPattern = /(?:^|\s)(C[1-6]|P[1-4]|1K)=(-?\d+(?:\.\d+)?)/gm;
  for (const match of output.matchAll(itemPattern)) items[match[1]] = Number(match[2]);
  const totalMatch = output.match(/趋赢力总分:\s*(-?\d+(?:\.\d+)?)\s*\/\s*100/);
  return { items, total: totalMatch ? Number(totalMatch[1]) : undefined };
}

function exactMismatch(expected, actual) {
  for (const key of itemKeys) {
    if (!Object.is(actual.items[key], expected.items[key])) {
      return `${key}: expected ${expected.items[key]}, got ${String(actual.items[key])}`;
    }
  }
  if (!Object.is(actual.total, expected.total)) {
    return `total: expected ${expected.total}, got ${String(actual.total)}`;
  }
  return null;
}

const scorePy = discoverScorePy();
if (!scorePy || !existsSync(scorePy)) {
  console.error('BLOCKED: WorkBuddy score.py not found. Pass --score-py PATH or set WORKBUDDY_SCORE_PY.');
  process.exit(2);
}

const python = process.env.PYTHON ?? 'python3';
const failures = [];
let passed = 0;
console.log(`score.py compatibility target: ${scorePy}`);

for (const fixture of fixtures.cases) {
  const result = spawnSync(python, [scorePy, '--json'], {
    input: `${JSON.stringify(fixture.expected.items)}\n`,
    encoding: 'utf8',
  });
  if (result.error) {
    failures.push(`${fixture.id}: could not execute ${python}: ${result.error.message}`);
    continue;
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    failures.push(`${fixture.id}: score.py exited ${result.status}: ${detail}`);
    continue;
  }
  const actual = parseExternalReport(result.stdout);
  const mismatch = exactMismatch(fixture.expected, actual);
  if (mismatch) failures.push(`${fixture.id}: ${mismatch}`);
  else passed += 1;
}

console.log(`compatible fixtures: ${passed}/${fixtures.cases.length}`);
if (failures.length) {
  console.error('INCOMPATIBLE: external score.py does not match @jianghu/g64111 fixtures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('COMPATIBLE: external score.py matches every item and total exactly.');
