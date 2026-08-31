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
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  await visit(directory);
  return files;
}

describe('SAAS-208 relationship workspace production boundaries', () => {
  it('keeps the projection and review command outside the frozen legacy Action/store contract', async () => {
    for (const path of ['packages/domain-contracts/src/actions.ts', 'app/src/store.ts']) {
      const source = await readFile(resolve(repositoryRoot, path), 'utf8');
      expect(source, path).not.toMatch(/RELATIONSHIP_WORKSPACE|REVIEW_HYPOTHESIS_VERIFICATION/);
    }
  });

  it('contains no methodology, legacy key-person, stage, forecast, or radar authority fallback', async () => {
    const paths = [
      'packages/domain-contracts/src/relationshipWorkspace.ts',
      'server/src/relationshipWorkspace/model.ts',
      'server/src/relationshipWorkspace/service.ts',
      'server/src/relationshipWorkspace/routes.ts',
      'app/src/lib/relationshipWorkspace.ts',
      'app/src/components/CrmRelationshipGraph.tsx',
      'app/src/components/RelationshipWorkspacePanel.tsx',
    ];
    const forbidden = /primaryDPersonId|StrategyRisk|pipelineStage|winProbability|G64111|ADURC|InterventionItem/;
    const violations: string[] = [];
    for (const path of paths) {
      if (forbidden.test(await readFile(resolve(repositoryRoot, path), 'utf8'))) violations.push(path);
    }
    expect(violations).toEqual([]);
  });

  it('does not turn candidate reads into formal writes or expose the human review writer to agents', async () => {
    const service = await readFile(resolve(repositoryRoot, 'server/src/relationshipWorkspace/service.ts'), 'utf8');
    expect(service).not.toMatch(/\b(?:candidate|relation)\s*\.\s*(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/i);

    const endpointUsers: string[] = [];
    for (const file of await sourceFiles(resolve(repositoryRoot, 'server/src'))) {
      const source = await readFile(file, 'utf8');
      if (source.includes('executeHypothesisVerificationReview')) {
        endpointUsers.push(relative(repositoryRoot, file));
      }
    }
    expect(endpointUsers.sort()).toEqual([
      'server/src/relationshipWorkspace/routes.ts',
      'server/src/relationshipWorkspace/service.ts',
    ]);
    const routes = await readFile(resolve(repositoryRoot, 'server/src/relationshipWorkspace/routes.ts'), 'utf8');
    expect(routes).toContain("assertionMode: 'user_asserted'");
    expect(routes).toContain("preHandler: [app.authenticate]");
  });

  it('keeps the PostgreSQL migration expand-only and leaves legacy data in place', async () => {
    const migration = await readFile(resolve(
      repositoryRoot,
      'server/prisma/postgres/migrations/20260831000000_expand_hypothesis_commitment_review/migration.sql',
    ), 'utf8');
    expect(migration).toContain('ALTER TABLE "PlanAction"');
    expect(migration).toContain('ALTER TABLE "HypothesisEvidenceLink"');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"(?:PlanAction|HypothesisEvidenceLink)"/i);
  });
});
