import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCrmFieldAuthority, listCrmFieldConsumers } from '../src/index.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function executableTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return executableTypeScriptFiles(absolutePath);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return [];
    return [absolutePath];
  });
}

function findExecutableConsumers(token) {
  const roots = ['app/src', 'server/src', 'server/scripts', 'packages/domain-contracts/src'];
  return roots
    .flatMap((root) => executableTypeScriptFiles(join(REPO_ROOT, root)))
    .filter((file) => relative(REPO_ROOT, file) !== 'packages/domain-contracts/src/authority.ts')
    .filter((file) => readFileSync(file, 'utf8').includes(token))
    .map((file) => relative(REPO_ROOT, file).split('\\').join('/'))
    .sort();
}

describe('CRM authority source inventory', () => {
  it('fails when an executable customerType reference is absent from the machine inventory', () => {
    expect(listCrmFieldConsumers(getCrmFieldAuthority('customer.category')).sort())
      .toEqual(findExecutableConsumers('customerType'));
  });
});
