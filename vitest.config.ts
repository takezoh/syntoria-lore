import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: process.env['VITEST_FIRESTORE'] === '1' ? [] : ['tests/**/*.firestore.test.ts'],
  },
});
