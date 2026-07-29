import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * The demo's own testable logic is plain TypeScript (`src/lib`), so node is the
 * environment and no DOM setup is needed. The Svelte plugin is still required
 * because those modules import `@nostr-cache/timeline-embed`, whose entry point
 * re-exports `.svelte` components; `customElement: true` matches how the widget
 * is compiled for the embed bundle.
 *
 * The panels themselves are covered where the behaviour actually lives: shared
 * logic and components in packages/timeline-embed, and the whole page end to
 * end in e2e/tests/browser.
 */
export default defineConfig({
  plugins: [svelte({ compilerOptions: { customElement: true } })],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
