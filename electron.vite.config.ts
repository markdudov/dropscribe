import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('electron/main.ts') } },
    },
    resolve: {
      alias: { '@shared': resolve('electron/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // A sandboxed preload cannot be ESM. This is not a style choice.
      rollupOptions: {
        input: { index: resolve('electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    resolve: {
      alias: { '@': resolve('src'), '@shared': resolve('electron/shared') },
    },
    build: {
      rollupOptions: { input: { index: resolve('src/index.html') } },
    },
  },
});
