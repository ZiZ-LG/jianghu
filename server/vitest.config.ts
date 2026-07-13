import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    setupFiles: ['./tests/helpers/testDb.ts'],
    pool: 'forks',
    maxWorkers: 1,
  },
});
