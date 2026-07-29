/**
 * Serves the built embed bundle (`packages/timeline-embed/dist`) over a real
 * http origin so the widget can be exercised exactly as an embedding site would
 * load it: `<script src="/nostr-timeline.js">` plus the `/embed/` iframe page.
 *
 * A real origin also matters because IndexedDB refuses to work on an opaque
 * one, and the cache is the thing under test.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const EMBED_DIST = resolve(currentDir, '../../packages/timeline-embed/dist');

export interface EmbedSiteServer {
  port: number;
  /** Origin the widget is served from. */
  baseUrl: string;
  /** URL of the iframe host page. */
  embedUrl: string;
  close: () => Promise<void>;
}

/**
 * Start serving the embed bundle.
 *
 * @throws If the bundle has not been built yet
 */
export async function startEmbedSiteServer(): Promise<EmbedSiteServer> {
  let bundle: string;
  let embedPage: string;
  try {
    bundle = await readFile(resolve(EMBED_DIST, 'nostr-timeline.js'), 'utf8');
    embedPage = await readFile(resolve(EMBED_DIST, 'embed/index.html'), 'utf8');
  } catch (error) {
    throw new Error(
      `Embed bundle missing from ${EMBED_DIST}. Run "npm run build:embed" first. (${
        (error as Error).message
      })`
    );
  }

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/nostr-timeline.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(bundle);
      return;
    }
    if (path === '/embed/' || path === '/embed/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(embedPage);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    embedUrl: `${baseUrl}/embed/`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
