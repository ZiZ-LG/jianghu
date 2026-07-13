import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../src/index.js';
import type { Deal } from '../src/index.js';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/golden-tests.json', import.meta.url)), 'utf8'));
const TOL = 1e-6;

function diff(actual: unknown, expected: unknown, path = '$'): string[] {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) <= TOL ? [] : [`${path}: ${actual} != ${expected}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array`];
    if (actual.length !== expected.length) return [`${path}: length ${actual.length} != ${expected.length}`];
    return expected.flatMap((value, index) => diff(actual[index], value, `${path}[${index}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected object`];
    const expectedKeys = Object.keys(expected as object).sort();
    const actualKeys = Object.keys(actual as object).sort();
    const out: string[] = [];
    for (const key of actualKeys) if (!expectedKeys.includes(key)) out.push(`${path}.${key}: extra key`);
    for (const key of expectedKeys) {
      if (!actualKeys.includes(key)) out.push(`${path}.${key}: missing key`);
      else out.push(...diff((actual as any)[key], (expected as any)[key], `${path}.${key}`));
    }
    return out;
  }
  return Object.is(actual, expected) ? [] : [`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`];
}

describe('approved evidence pseudo-counts', () => {
  it('matches oracle for no-evidence, approved-positive, and approved-negative cases', () => {
    const cases = golden.evidence_cases as Record<string, { input: Deal; eval: ReturnType<typeof evaluate> }>;
    for (const [name, value] of Object.entries(cases)) {
      const actual = evaluate(value.input);
      const differences = diff(actual, value.eval);
      expect(differences, `${name}\n${differences.join('\n')}`).toEqual([]);
    }

    const baseline = evaluate(cases.no_evidence!.input);
    const positive = evaluate(cases.approved_positive!.input);
    const negative = evaluate(cases.approved_negative!.input);
    expect(positive.stakeholders[0]!.pS).toBeGreaterThan(baseline.stakeholders[0]!.pS);
    expect(positive.pwin).toBeGreaterThan(baseline.pwin);
    expect(negative.stakeholders[0]!.pO).toBeGreaterThan(baseline.stakeholders[0]!.pO);
    expect(negative.pwin).toBeLessThan(baseline.pwin);
  });
});
