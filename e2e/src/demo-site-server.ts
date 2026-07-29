/**
 * Serves the built demo site (`packages/demo-site/dist`) over a real http
 * origin.
 *
 * The layout E2E needs the shipped artifact rather than a dev server: the
 * published CSS is what a phone actually loads, and IndexedDB — which the page
 * boots its relay against on load — refuses to work on an opaque origin.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const SITE_DIST = resolve(currentDir, '../../packages/demo-site/dist');

/** The site is deployed under a project-pages sub-path, and links assume it. */
const BASE = '/nostr-cache/';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export interface DemoSiteServer {
  port: number;
  /** URL of the demo page itself. */
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Start serving the demo site.
 *
 * @throws If the site has not been built yet
 */
export async function startDemoSiteServer(): Promise<DemoSiteServer> {
  const indexPath = resolve(SITE_DIST, 'index.html');
  try {
    await readFile(indexPath);
  } catch (error) {
    throw new Error(
      `Demo site missing from ${SITE_DIST}. Run "npm run build:demo" first. (${
        (error as Error).message
      })`
    );
  }

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const relative = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '');
    // Vite emits a single-page app, so anything without a file extension is the
    // SPA entry rather than a 404.
    const file = relative === '' || extname(relative) === '' ? 'index.html' : relative;

    const target = resolve(SITE_DIST, normalize(file));
    if (target !== SITE_DIST && !target.startsWith(SITE_DIST + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }

    readFile(target)
      .then((body) => {
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
        });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      });
  });

  await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', () => done()));

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}${BASE}`,
    close: () => new Promise<void>((done) => httpServer.close(() => done())),
  };
}
