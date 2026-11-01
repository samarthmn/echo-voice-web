import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    'target/**',
    'public/js/**',
    'public/assets/**',
    'public/wasm/**',
    'extension/dist/**',
    'dist/**',
    'tmp/**',
    'design-system/**',
    'site/dist/**',
    'site/.astro/**',
    '.echo-data/**',
    '.echo-dev-data/**',
  ]),
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
      // Empty text and NaN deliberately select fallbacks; ?? would change that behavior.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, number: true, boolean: true } },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    files: ['eslint.config.ts'],
    languageOptions: {
      globals: globals.node,
      // The solution config contains references only; this single root file needs a default project.
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.ts'],
          defaultProject: 'scripts/tsconfig.json',
        },
      },
    },
  },
  {
    files: ['web/**/*.ts', 'extension/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: { 'no-console': ['error', { allow: ['error', 'warn'] }] },
  },
  {
    files: ['extension/src/**/*.ts'],
    languageOptions: { globals: globals.webextensions },
  },
  {
    files: ['web/inference-worker.ts'],
    languageOptions: { globals: globals.worker },
  },
  {
    files: ['extension/src/worklet.ts'],
    languageOptions: { globals: globals.audioWorklet },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Async mocks preserve the production Promise contract without needing an await.
      '@typescript-eslint/require-await': 'off',
      // No-op callbacks model browser APIs and unused fixture hooks.
      '@typescript-eslint/no-empty-function': 'off',
      // Fixtures deliberately throw primitive runtime failures to verify error reporting.
      '@typescript-eslint/only-throw-error': 'off',
      // Tests retain methods for restoration or install them on a fixture with its own receiver.
      '@typescript-eslint/unbound-method': 'off',
      // Recorder fixtures retain the constructed instance so tests can dispatch browser events.
      '@typescript-eslint/no-this-alias': 'off',
      // Mock signatures name unused production arguments to document the API being replaced.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
);
