import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareTestDatabase } from '../scripts/prepareTestDb.js';

describe('prepareTestDatabase', () => {
  it('replaces a stale test database and removes its sidecars', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jianghu-test-db-'));
    const dbPath = join(directory, 'test.db');
    const sidecars = ['-journal', '-shm', '-wal'].map((suffix) => `${dbPath}${suffix}`);

    try {
      await Promise.all([dbPath, ...sidecars].map((path) => writeFile(path, 'stale')));

      await prepareTestDatabase(dbPath);

      expect(await readFile(dbPath)).toHaveLength(0);
      for (const sidecar of sidecars) {
        await expect(stat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a database whose basename is not test.db', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jianghu-test-db-'));
    try {
      await expect(prepareTestDatabase(join(directory, 'dev.db'))).rejects.toThrow(
        'Refusing to prepare any database other than test.db',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
