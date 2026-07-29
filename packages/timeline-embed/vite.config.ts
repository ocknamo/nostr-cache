import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * Builds the standalone embed bundle: a single self-contained IIFE that
 * registers the `<nostr-timeline>` custom element.
 *
 * `customElement: true` only *enables* custom-element support; a component
 * becomes one solely by declaring `<svelte:options customElement="..." />`.
 * Every other component here still compiles as a plain Svelte component, so the
 * same sources are reusable as a library by demo-site.
 *
 * Component styles live inside the custom element's shadow root (Svelte inlines
 * them into the component), so this build emits no separate stylesheet — the
 * single JS file really is the whole widget.
 *
 * `public/` (the iframe host page) is copied verbatim into `dist/`.
 */
export default defineConfig({
  plugins: [svelte({ compilerOptions: { customElement: true } })],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/embed-entry.ts',
      formats: ['iife'],
      name: 'NostrTimelineEmbed',
      fileName: () => 'nostr-timeline.js',
    },
  },
});
