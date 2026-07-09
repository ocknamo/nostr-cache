import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Svelte plugin compiles `.svelte` imports for component tests; svelteTesting
  // wires the browser resolve condition and auto-cleanup between test cases.
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
