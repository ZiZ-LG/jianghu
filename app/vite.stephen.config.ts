import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const appDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(appDir, 'stephen'),
  base: '/',
  publicDir: resolve(appDir, 'stephen/public'),
  plugins: [react()],
  build: {
    outDir: resolve(appDir, 'dist/stephen'),
    emptyOutDir: true,
  },
});
