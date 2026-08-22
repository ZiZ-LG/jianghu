import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { G64111_ENGINE_REF } from '../src/methodology/g64111Manifest.js';

const repositoryRoot = resolve('..');

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  await visit(directory);
  return files;
}

describe('CORE-112 G64111 dependency boundary', () => {
  it('pins the adapter engineRef to the shared package version', async () => {
    const packageJson = JSON.parse(await readFile(
      resolve(repositoryRoot, 'packages/g64111/package.json'),
      'utf8',
    )) as { version: string };
    expect(G64111_ENGINE_REF).toBe(`g64111:${packageJson.version}`);
  });

  it('allows production code to import the shared engine only through the app/server adapters', async () => {
    const roots = [resolve(repositoryRoot, 'app/src'), resolve(repositoryRoot, 'server/src')];
    const allowed = new Set([
      'app/src/lib/g64111.ts',
      'server/src/g64111.ts',
    ]);
    const directEngineImport = /(?:from\s*|import\s*)['"]@jianghu\/g64111(?:\/[^'"]*)?['"]/g;
    const violations: string[] = [];

    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, 'utf8');
        if (!directEngineImport.test(source)) continue;
        const path = relative(repositoryRoot, file);
        if (!allowed.has(path)) violations.push(path);
        directEngineImport.lastIndex = 0;
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the generic CRM/no-pack path free of G64111 legacy fields and gap imports', async () => {
    const genericFiles = [
      'packages/domain-contracts/src/crm.ts',
      'packages/domain-contracts/tests/g64111-off.compile.ts',
      'app/src/lib/today.ts',
      'app/src/lib/router.ts',
      'server/src/matter/lifecycle.ts',
      'server/src/matter/ownership.ts',
      'server/src/matter/participants.ts',
      'server/src/mutation/commitments.ts',
      'server/src/mutation/matterOwnership.ts',
      'server/src/mutation/matterParticipants.ts',
      'server/src/resourceScope.ts',
      'server/src/scope.ts',
    ];
    const forbidden = /@jianghu\/g64111|primaryDPersonId|pipelineStage|engageStage|\bADURC\b|from\s+['"].*\/gaps['"]/;
    const violations: string[] = [];

    for (const path of genericFiles) {
      const source = await readFile(resolve(repositoryRoot, path), 'utf8');
      if (forbidden.test(source)) violations.push(path);
    }

    expect(violations).toEqual([]);
  });
});
