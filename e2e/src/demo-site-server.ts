/**
 * Serves the built demo site (`packages/demo-site/dist`) over a real http
 * origin.
 *
 * The layout E2E needs a server rather than `file://` for two reasons: the page
 * boots its relay against IndexedDB on load, which refuses to work on an opaque
 * origin, and the site is built with `base: '/nostr-cache/'`, so its asset URLs
 * only resolve under that path prefix.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const SITE_DIST = resolve(currentDir, '../../packages/demo-site/dist');

/** The site is deployed under a project-pages sub-path, and its URLs assume it. */
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
 * Map a request path to a file inside the built site.
 *
 * A directory resolves to its own `index.html` — not the site root's. The demo
 * has no client-side routing, but it does embed `/nostr-cache/embed/` in an
 * iframe, and answering that with the SPA would nest the whole demo page inside
 * itself instead of loading the widget.
 */
function toFilePath(requestPath: string): string {
  const withoutBase = requestPath.startsWith(BASE)
    ? requestPath.slice(BASE.length)
    : requestPath.replace(/^\//, '');
  return withoutBase === '' || withoutBase.endsWith('/') ? `${withoutBase}index.html` : withoutBase;
}

/**
 * Start serving the demo site.
 *
 * @throws If the site has not been built yet
 */
export async function startDemoSiteServer(): Promise<DemoSiteServer> {
  try {
    await readFile(resolve(SITE_DIST, 'index.html'));
  } catch (error) {
    throw new Error(
      `Demo site missing from ${SITE_DIST}. Run "npm run build:demo" first. (${
        (error as Error).message
      })`
    );
  }

  const httpServer = createServer((req, res) => {
    const file = toFilePath((req.url ?? '/').split('?')[0]);
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
