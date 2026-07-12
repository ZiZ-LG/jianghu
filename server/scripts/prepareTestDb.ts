import { rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TEST_DB_PATH = fileURLToPath(new URL('../prisma/test.db', import.meta.url));
const SQLITE_FILES = ['', '-journal', '-shm', '-wal'] as const;

export async function prepareTestDatabase(dbPath = DEFAULT_TEST_DB_PATH): Promise<void> {
  const resolvedPath = resolve(dbPath);
  if (basename(resolvedPath) !== 'test.db') {
    throw new Error('Refusing to prepare any database other than test.db');
  }

  await Promise.all(
    SQLITE_FILES.map((suffix) => rm(`${resolvedPath}${suffix}`, { force: true })),
  );
  await writeFile(resolvedPath, '');
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) {
  await prepareTestDatabase();
}
