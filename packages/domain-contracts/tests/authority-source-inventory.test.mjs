import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCrmFieldAuthority } from '../src/index.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function executableTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return executableTypeScriptFiles(absolutePath);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return [];
    return [absolutePath];
  });
}

function findExecutableConsumers(tokens) {
  const roots = ['app/src', 'server/src', 'server/scripts', 'packages/domain-contracts/src'];
  return roots
    .flatMap((root) => executableTypeScriptFiles(join(REPO_ROOT, root)))
    .filter((file) => relative(REPO_ROOT, file) !== 'packages/domain-contracts/src/authority.ts')
    .filter((file) => tokens.some((token) => readFileSync(file, 'utf8').includes(token)))
    .map((file) => relative(REPO_ROOT, file).split('\\').join('/'))
    .sort();
}

describe('CRM authority source inventory', () => {
  it('fails when an executable categoryKey or customerType reference is absent from the machine inventory', () => {
    const authority = getCrmFieldAuthority('customer.category');
    expect([
      ...(authority?.consumers.reads ?? []),
      ...(authority?.consumers.writes ?? []),
      ...(authority?.consumers.adapters ?? []),
      ...(authority?.consumers.migrations ?? []),
    ].sort()).toEqual(findExecutableConsumers(['categoryKey', 'customerType']));
  });
});
