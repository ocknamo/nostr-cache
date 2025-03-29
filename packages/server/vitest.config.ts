import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: ['**/*.test.ts', '**/*.spec.ts'],
    setupFiles: ['./tests/setup-vitest.ts'],
    globals: true,
    alias: {
      '@nostr-cache/(.*)': resolve(__dirname, '../$1/src'),
      '@nostr-cache/cache-relay/dist/(.*)': resolve(__dirname, '../cache-relay/src/$1'),
    },
    testTimeout: 5000,
  },
});
