/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5173, host: true }, // PORT 由 preview 工具 autoPort 注入，缺省仍 5173
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
