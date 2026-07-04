/**
 * Static page server for the browser E2E suite.
 *
 * Serves a minimal HTML page plus the browser bundle over a real http origin
 * so that IndexedDB (which requires a non-opaque origin) works in the page.
 * The relay's WebSocketServerEmulator intercepts the client WebSocket in-process
 * and never touches the network, so no WebSocket endpoint is needed here.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>nostr-cache e2e</title></head>
  <body><script src="/bundle.js"></script></body>
</html>`;

/**
 * A running static server for the browser test page.
 */
export interface StaticServer {
  /** Bound port. */
  port: number;
  /** Page URL to navigate to. */
  baseUrl: string;
  /** Emulated relay WebSocket URL (intercepted in-page; never hits this server). */
  wsUrl: string;
  /** Shut down the http server. */
  close: () => Promise<void>;
}

/**
 * Start serving the given bundle file over http.
 */
export async function startStaticServer(bundlePath: string): Promise<StaticServer> {
  const bundle = await readFile(bundlePath, 'utf8');

  const httpServer = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(bundle);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
