import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { type Plugin, defineConfig } from 'vite';

/** GitHub project pages serve this repo from a sub-path. */
const BASE = '/nostr-cache/';

const EMBED_DIST = fileURLToPath(new URL('../timeline-embed/dist', import.meta.url));

/** Files the embed bundle contributes to the deployed site. */
const EMBED_ASSETS: Record<string, { file: string; type: string }> = {
  'nostr-timeline.js': { file: 'nostr-timeline.js', type: 'text/javascript; charset=utf-8' },
  'embed/': { file: 'embed/index.html', type: 'text/html; charset=utf-8' },
  'embed/index.html': { file: 'embed/index.html', type: 'text/html; charset=utf-8' },
  // Shared by both iframe pages: the query-string forwarding and the height
  // postMessage the embedding page listens for.
  'embed/embed-host.js': { file: 'embed/embed-host.js', type: 'text/javascript; charset=utf-8' },
  'embed/follow/': { file: 'embed/follow/index.html', type: 'text/html; charset=utf-8' },
  'embed/follow/index.html': {
    file: 'embed/follow/index.html',
    type: 'text/html; charset=utf-8',
  },
};

/**
 * Serves `packages/timeline-embed/dist` during `vite dev`.
 *
 * In a production build those files are copied in by `scripts/copy-embed.mjs`;
 * this middleware makes the dev server resolve the same URLs so the embed
 * panel's live `<iframe>` and `<script src>` work without a separate static
 * server. It requires `npm run build:embed` to have been run — and says so
 * rather than 404ing silently.
 */
function serveEmbedBundle(): Plugin {
  return {
    name: 'serve-embed-bundle',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0].replace(BASE, '').replace(/^\//, '');
        const asset = EMBED_ASSETS[path];
        if (!asset) {
          next();
          return;
        }
        try {
          const body = await readFile(`${EMBED_DIST}/${asset.file}`);
          res.setHeader('Content-Type', asset.type);
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(
            `${asset.file} not found. Build the widget first: npm run build:embed (from the repo root).`
          );
        }
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  // Matches the embed build so `<nostr-timeline>` registers as a custom
  // element here too — the demo embeds the real widget rather than a lookalike.
  plugins: [svelte({ compilerOptions: { customElement: true } }), serveEmbedBundle()],
  server: { port: 5174 },
  build: { outDir: 'dist' },
});
