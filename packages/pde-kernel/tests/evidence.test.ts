import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../src/index.js';
import type { Deal } from '../src/index.js';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/golden-tests.json', import.meta.url)), 'utf8'));
const TOL = 1e-6;

describe('approved evidence pseudo-counts', () => {
  it('matches oracle for no-evidence, approved-positive, and approved-negative cases', () => {
    const cases = golden.evidence_cases as Record<string, { input: Deal; eval: ReturnType<typeof evaluate> }>;
    for (const [name, value] of Object.entries(cases)) {
      const actual = evaluate(value.input);
      expect(actual.pwin, `${name}.pwin`).toBeCloseTo(value.eval.pwin, 6);
      actual.stakeholders.forEach((stakeholder, index) => {
        const expected = value.eval.stakeholders[index]!;
        expect(Math.abs(stakeholder.pS - expected.pS), `${name}.pS`).toBeLessThanOrEqual(TOL);
        expect(Math.abs(stakeholder.pN - expected.pN), `${name}.pN`).toBeLessThanOrEqual(TOL);
        expect(Math.abs(stakeholder.pO - expected.pO), `${name}.pO`).toBeLessThanOrEqual(TOL);
      });
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
