import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: ['**/*.test.ts', '**/*.spec.ts'],
    setupFiles: ['./tests/setup-vitest.ts'],
    globals: true,
    testTimeout: 5000,
  },
});
