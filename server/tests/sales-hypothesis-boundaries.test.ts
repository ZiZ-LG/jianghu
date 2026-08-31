import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve('..');

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  await visit(directory);
  return files;
}

describe('SAAS-207 SalesHypothesis production boundaries', () => {
  it('keeps the canonical commands outside the legacy App Action contract and store', async () => {
    for (const path of ['packages/domain-contracts/src/actions.ts', 'app/src/store.ts']) {
      const source = await readFile(resolve(repositoryRoot, path), 'utf8');
      expect(source, path).not.toMatch(/SALES_HYPOTHESIS|HYPOTHESIS_EVIDENCE/);
    }
  });

  it('has no production update or delete path for immutable revisions and evidence links', async () => {
    const forbiddenMutation = /\b(?:salesHypothesisRevision|hypothesisEvidenceLink)\s*\.\s*(?:update|updateMany|delete|deleteMany|upsert)\s*\(/;
    const violations: string[] = [];
    for (const file of await sourceFiles(resolve(repositoryRoot, 'server/src'))) {
      const path = relative(repositoryRoot, file);
      if (path === 'server/src/hypotheses/migration.ts') continue;
      const source = await readFile(file, 'utf8');
      if (forbiddenMutation.test(source)) violations.push(path);
    }
    expect(violations).toEqual([]);
  });

  it('does not seed or construct new legacy StrategyRisk assumptions in production code', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(resolve(repositoryRoot, 'server/src'))) {
      const path = relative(repositoryRoot, file);
      if (path === 'server/src/hypotheses/migration.ts') continue;
      const source = await readFile(file, 'utf8');
      if (/\bkind\s*:\s*['"]assumption['"]/.test(source)) violations.push(path);
    }
    expect(violations).toEqual([]);
    const mutator = await readFile(resolve(repositoryRoot, 'server/src/mutate.ts'), 'utf8');
    expect(mutator).toContain('LegacyAssumptionFrozenError');
  });
});
