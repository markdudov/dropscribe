import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'release/**',
      'dist/**',
      '.dev/**',
      'vendor/bin/**',
      // macOS AppleDouble stubs on volumes that cannot store xattrs inline.
      '**/._*',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly' },
    },
    plugins: { '@typescript-eslint': tseslint, 'react-hooks': reactHooks },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', URL: 'readonly', AbortSignal: 'readonly' },
    },
  },
];
