/**
 * Serves the built embed bundle (`packages/timeline-embed/dist`) over a real
 * http origin so the widget can be exercised exactly as an embedding site would
 * load it: `<script src="/nostr-timeline.js">` plus the `/embed/` iframe page.
 *
 * A real origin also matters because IndexedDB refuses to work on an opaque
 * one, and the cache is the thing under test.
 */

import { readFile } from 'node:fs/promises';
import { type RequestListener, createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const currentDir = dirname(fileURLToPath(import.meta.url));
const EMBED_DIST = resolve(currentDir, '../../packages/timeline-embed/dist');

/** Path this server serves a real image from. See {@link EmbedSiteServer.avatarUrl}. */
const AVATAR_PATH = '/avatar.png';
/** Smallest valid PNG: 1x1, fully transparent. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/** Path this server serves a tall image from. See {@link EmbedSiteServer.photoUrl}. */
const PHOTO_PATH = '/photo.png';

/**
 * A PNG far taller than any height the card gives an attachment.
 *
 * Built rather than embedded: a picture that is genuinely 1000px tall is the
 * only way to test the height an attachment is *given*, and one large enough to
 * matter is too big to paste in as base64.
 */
function buildTallPng(width = 600, height = 1000): Buffer {
  // One filter byte (0 = none) then RGB triples, per scanline.
  const scanline = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline));

  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 bits per channel, colour type 2 (truecolour), no interlacing.
  header.set([8, 2, 0, 0, 0], 8);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TALL_PNG = buildTallPng();

/** Path of the bare host page. See {@link EmbedSiteServer.scriptOnlyUrl}. */
const SCRIPT_ONLY_PATH = '/script-only/';
/**
 * A page that loads the bundle and puts no widget on itself.
 *
 * The bundle also publishes the relay API, for pages that want the cache
 * without a timeline on them, and that half cannot be reached through the
 * iframe host pages — they mount an element as they load. A real origin is
 * still required (IndexedDB refuses to work on an opaque one), which rules out
 * building this page with Playwright's `setContent`.
 */
const SCRIPT_ONLY_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>nostr-cache embed: script only</title>
    <script>
      // Captured before the bundle can patch it, so a test can tell whether the
      // relay is running by comparing constructors.
      window.__originalWebSocket = window.WebSocket;
    </script>
    <script src="/nostr-timeline.js"></script>
  </head>
  <body></body>
</html>
`;

export interface EmbedSiteServer {
  port: number;
  /** Origin the widget is served from. */
  baseUrl: string;
  /** URL of the iframe host page. */
  embedUrl: string;
  /** URL of a page that loads the bundle without mounting a widget. */
  scriptOnlyUrl: string;
  /** URL of the follow-timeline iframe host page. */
  followEmbedUrl: string;
  /** URL of the post-detail iframe host page. */
  postEmbedUrl: string;
  /** URL of a real image, for use as a profile's `picture`. */
  avatarUrl: string;
  /** URL of a tall image, for a note whose body is a photo. */
  photoUrl: string;
  close: () => Promise<void>;
}

export interface EmbedSiteServerOptions {
  /**
   * Serve over https with the given certificate.
   *
   * GitHub Pages is https-only, and an https page blocks `ws://` as mixed
   * content — so whether the emulator's interception survives on a secure
   * origin can only be established over real TLS.
   */
  tls?: { key: Buffer; cert: Buffer };
}

/**
 * Start serving the embed bundle.
 *
 * @throws If the bundle has not been built yet
 */
export async function startEmbedSiteServer(
  options: EmbedSiteServerOptions = {}
): Promise<EmbedSiteServer> {
  let bundle: string;
  let embedPage: string;
  let followEmbedPage: string;
  let postEmbedPage: string;
  let embedHost: string;
  try {
    bundle = await readFile(resolve(EMBED_DIST, 'nostr-timeline.js'), 'utf8');
    embedPage = await readFile(resolve(EMBED_DIST, 'embed/index.html'), 'utf8');
    followEmbedPage = await readFile(resolve(EMBED_DIST, 'embed/follow/index.html'), 'utf8');
    postEmbedPage = await readFile(resolve(EMBED_DIST, 'embed/post/index.html'), 'utf8');
    embedHost = await readFile(resolve(EMBED_DIST, 'embed/embed-host.js'), 'utf8');
  } catch (error) {
    throw new Error(
      `Embed bundle missing from ${EMBED_DIST}. Run "npm run build:embed" first. (${
        (error as Error).message
      })`
    );
  }

  const handler: RequestListener = (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/nostr-timeline.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(bundle);
      return;
    }
    if (path === SCRIPT_ONLY_PATH) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SCRIPT_ONLY_PAGE);
      return;
    }
    if (path === '/embed/' || path === '/embed/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(embedPage);
      return;
    }
    if (path === '/embed/follow/' || path === '/embed/follow/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(followEmbedPage);
      return;
    }
    if (path === '/embed/post/' || path === '/embed/post/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(postEmbedPage);
      return;
    }
    // Every page loads this for the query-string forwarding and the height
    // protocol, so a 404 here means none of them mounts anything.
    if (path === '/embed/embed-host.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(embedHost);
      return;
    }
    // Stands in for the avatar host a real profile's `picture` points at, so
    // the image path is exercised against a URL that actually loads.
    if (path === AVATAR_PATH) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TRANSPARENT_PNG);
      return;
    }
    // A picture with a real height, for the attachment a note carries in its
    // body — the avatar above is 1x1, so it can say nothing about layout.
    if (path === PHOTO_PATH) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TALL_PNG);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };

  const httpServer = options.tls
    ? createHttpsServer(options.tls, handler)
    : createHttpServer(handler);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    embedUrl: `${baseUrl}/embed/`,
    scriptOnlyUrl: `${baseUrl}${SCRIPT_ONLY_PATH}`,
    followEmbedUrl: `${baseUrl}/embed/follow/`,
    postEmbedUrl: `${baseUrl}/embed/post/`,
    avatarUrl: `${baseUrl}${AVATAR_PATH}`,
    photoUrl: `${baseUrl}${PHOTO_PATH}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
