/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Vitest only. The real app build lives in electron.vite.config.ts.
export default defineConfig({
  resolve: {
    alias: { '@': resolve('src'), '@shared': resolve('electron/shared') },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['node_modules/**', 'out/**', 'release/**'],
  },
});
