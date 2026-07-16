#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(serverDir, 'prisma/schema.prisma');
const committedPath = resolve(serverDir, 'prisma/postgres/schema.prisma');

export function renderPostgresSchema(source) {
  const matches = source.match(/provider\s*=\s*"sqlite"/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one SQLite datasource provider, found ${matches.length}`);
  }
  return source.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const outputPath = outputIndex >= 0 ? resolve(serverDir, args[outputIndex + 1] ?? '') : committedPath;
  const rendered = renderPostgresSchema(await readFile(sourcePath, 'utf8'));

  if (args.includes('--check')) {
    const committed = await readFile(committedPath, 'utf8').catch(() => '');
    if (committed !== rendered) {
      console.error('Generated PostgreSQL schema is stale. Run: npm run schema:postgres:render');
      process.exitCode = 1;
    }
    return;
  }

  await writeAtomic(outputPath, rendered);
}

await main();
