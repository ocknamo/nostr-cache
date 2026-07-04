import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: ['tests/**/*.e2e.spec.ts'],
    globals: true,
    alias: {
      '@nostr-cache/(.*)': resolve(__dirname, '../packages/$1/src'),
    },
    // E2E tests spawn real processes / browsers, so they need generous timeouts.
    testTimeout: 30000,
    hookTimeout: 60000,
    // Node and browser suites each manage global resources (ports, browser); run serially.
    fileParallelism: false,
  },
});
