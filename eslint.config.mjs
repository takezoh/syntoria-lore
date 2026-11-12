import eslint from '@eslint/js';
import typescriptEslint from 'typescript-eslint';

export default typescriptEslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  ...typescriptEslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'tests/**/*.ts'],
    // The Firestore boundary: the repository, the client factory, the deletion ledger and the
    // access module that reads admissions and provisions authorizations.
    ignores: [
      'packages/memory-records/src/firestore-repository.ts',
      'packages/memory-records/src/firestore-observation-ledger.ts',
      'packages/memory-records/src/firestore-client.ts',
      'packages/memory-records/src/firestore-deletion-ledger.ts',
      'packages/memory-records/src/access.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@google-cloud/firestore',
              message: 'Use the Firestore memory-record repository boundary.',
            },
          ],
        },
      ],
    },
  },
);
