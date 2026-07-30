import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    include: ['**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./src/test/setup-vitest.ts'],
    globals: true, // describe, it, expect をグローバルに使用可能に
  },
});
