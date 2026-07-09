import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Svelte plugin compiles `.svelte` imports for component tests. svelteTesting
  // adds the `browser` resolve condition and a beforeEach/afterEach auto-cleanup —
  // note these are applied *globally* (to resolve.conditions and setupFiles), so
  // they also run for the node-environment specs. That is harmless here because the
  // node specs' deps expose no `browser` export condition and never render a
  // component (cleanup is a no-op without a DOM). If a browser-conditioned dep ever
  // enters a node spec's import path, split into vitest `projects` instead.
  plugins: [svelte(), svelteTesting()],
  test: {
    // Node is the default so the relay/WebSocket integration specs keep their
    // existing environment. Component specs opt into jsdom via a per-file
    // `// @vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
