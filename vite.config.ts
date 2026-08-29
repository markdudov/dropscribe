import { resolve } from 'node:path';
// From `vitest/config`, not `vite` — only this one knows about the `test` key.
import { defineConfig } from 'vitest/config';

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
