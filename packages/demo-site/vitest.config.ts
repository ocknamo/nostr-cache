import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

/**
 * Mirrors packages/web-client/vitest.config.ts: node is the default environment
 * (the relay/WebSocket integration specs need it) and component specs opt into
 * jsdom with a per-file `// @vitest-environment jsdom` docblock.
 *
 * `customElement: true` matches the production build so the custom-element spec
 * exercises the same compiler output that ships in the embed bundle.
 */
export default defineConfig({
  plugins: [svelte({ compilerOptions: { customElement: true } }), svelteTesting()],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
