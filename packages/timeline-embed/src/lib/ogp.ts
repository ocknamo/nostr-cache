/**
 * Link previews (OGP) for the ordinary links in a note.
 *
 * A browser cannot read another origin's HTML, so the page is fetched through a
 * CORS proxy, which returns it with `Access-Control-Allow-Origin` on it, and
 * the `og:` meta tags are read here. The embedder names that proxy in
 * `ogp-proxy` — a corsproxy.io URL carrying their own API key, or any proxy
 * taking the target in a `url` parameter. There is no default: without the
 * attribute nothing here runs, and the widget will not hand a reader's IP and
 * reading history to a third-party service on its own, the same stance
 * `show-media` takes.
 *
 * The page is treated as hostile: it is whatever a stranger's link points at.
 * It is read with `DOMParser`, which builds an inert document — no script runs
 * and no subresource is fetched — every field goes through the same validators
 * kind 0 does (`profile.ts`), and the card's `href` is always the URL we asked
 * about rather than one the page names, so a page can mislabel a link but
 * cannot redirect it.
 */

import { type ContentPart, mediaKind } from './content-parts.ts';
import { safeImageUrl, safeText } from './profile.ts';

/** Abandon a request that has not answered by then; the card stays absent. */
export const OGP_TIMEOUT_MS = 5000;

/** Rendered lengths. Longer values are clipped rather than rejected. */
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_SITE_NAME_LENGTH = 100;

/** Past this a string is not a title that went long, it is a payload. */
const MAX_FIELD_LENGTH = 4096;

/**
 * Longest image URL accepted — the body's link ceiling (`content-parts.ts`)
 * rather than the avatar's, which `safeImageUrl` defaults to. A preview image
 * is often generated per page, with the title and a signature in its query
 * string, and cutting those off would cost the card its picture.
 */
const MAX_IMAGE_URL_LENGTH = 2048;

/** Bytes of the page read; the metadata is in `<head>`, so the rest is waste. */
const MAX_HTML_BYTES = 256 * 1024;

/** How far into the page a `<meta charset>` is still believed. */
const MAX_CHARSET_SCAN = 2048;

/**
 * Previews kept for the page. Failures are kept too — a proxy that is down
 * should cost one request, not one per card that scrolls past.
 */
export const MAX_CACHED_PREVIEWS = 200;

/**
 * Requests in flight at once, as in the profile lookups: a fast scroll through
 * a long timeline should not open a connection per card.
 */
const MAX_CONCURRENT = 4;

export interface OgpData {
  /** The link the card points at — always the URL we asked about. */
  url: string;
  /** Required: a card with no title says nothing a link does not. */
  title: string;
  description?: string;
  /** Validated as `http(s)`, so it is safe to put in an `<img src>`. */
  image?: string;
  siteName?: string;
}

/**
 * The link to preview: the first ordinary one in the body.
 *
 * A `nostr:` entity is a quote card and an attachment is already rendered from
 * the URL itself, so neither is a candidate. The extension is re-checked rather
 * than trusting the part kind, because a media URL past the per-note attachment
 * cap comes through as an ordinary link.
 */
export function previewTarget(parts: ContentPart[]): string | undefined {
  for (const part of parts) {
    if (part.kind === 'link' && mediaKind(part.href) === undefined) {
      return part.href;
    }
  }
  return undefined;
}

/** Parse a proxy URL, resolving a relative one against the embedding page. */
function readProxy(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value, typeof location === 'undefined' ? undefined : location.href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  return url;
}

/**
 * Build the request for one target URL: the proxy with the target added as a
 * `url` parameter, which is how corsproxy.io takes it.
 *
 * The parameter is appended rather than set through `searchParams`, which
 * spells a space `+`; corsproxy.io asks for `encodeURIComponent`. Whatever
 * query string the proxy URL already carries survives, so an API key on it
 * keeps working.
 *
 * @returns undefined when the proxy is not a usable `http(s)` URL
 */
export function ogpRequestUrl(proxy: string, target: string): string | undefined {
  const url = readProxy(proxy);
  if (!url) {
    return undefined;
  }
  url.hash = '';
  // A proxy written with a bare trailing `?` keeps it in `href` while `search`
  // reports none, which would otherwise spell the parameter `?&url=`.
  const base = url.href.endsWith('?') ? url.href.slice(0, -1) : url.href;
  return `${base}${url.search ? '&' : '?'}url=${encodeURIComponent(target)}`;
}

/** Read one field, then clip it to what the card renders. */
function readField(value: unknown, max: number): string | undefined {
  const text = safeText(value, MAX_FIELD_LENGTH);
  if (text === undefined) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The first of these keys the page carries a value for. */
function pick(tags: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = tags.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Index the `<meta>` tags by `property` (how OGP spells it) or `name` (how
 * Twitter cards and the plain description do).
 *
 * The first of a repeated key wins: a page listing several `og:image` means the
 * first one for the preview.
 */
function readMetaTags(doc: Document): Map<string, string> {
  const tags = new Map<string, string>();
  for (const meta of doc.querySelectorAll('meta')) {
    const key = (meta.getAttribute('property') ?? meta.getAttribute('name'))?.trim().toLowerCase();
    // An empty tag counts as absent, so a page that spells `og:title` that way
    // still falls through to the next spelling of the same field.
    const content = meta.getAttribute('content')?.trim();
    if (key && content && !tags.has(key)) {
      tags.set(key, content);
    }
  }
  return tags;
}

/** Resolve against the page it came from, since `og:image` may be a path. */
function absoluteUrl(value: string | undefined, base: string): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  try {
    return new URL(value.trim(), base).href;
  } catch {
    return undefined;
  }
}

/**
 * Read the metadata out of a fetched page.
 *
 * The Twitter card spellings and the plain `<title>` / `<meta name`
 * `="description">` are read as fallbacks, because plenty of pages carry one
 * set and not the other.
 *
 * @param url The URL that was asked about; the card links here
 * @returns undefined when there is nothing worth rendering
 */
export function parseOgpHtml(html: string, url: string): OgpData | undefined {
  if (typeof DOMParser === 'undefined') {
    return undefined;
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return undefined;
  }
  const tags = readMetaTags(doc);

  const title = readField(pick(tags, ['og:title', 'twitter:title']) ?? doc.title, MAX_TITLE_LENGTH);
  if (!title) {
    return undefined;
  }

  const data: OgpData = { url, title };
  const description = readField(
    pick(tags, ['og:description', 'twitter:description', 'description']),
    MAX_DESCRIPTION_LENGTH
  );
  const siteName = readField(
    pick(tags, ['og:site_name', 'application-name']),
    MAX_SITE_NAME_LENGTH
  );
  const image = safeImageUrl(
    absoluteUrl(
      pick(tags, [
        'og:image',
        'og:image:secure_url',
        'og:image:url',
        'twitter:image',
        'twitter:image:src',
      ]),
      url
    ),
    MAX_IMAGE_URL_LENGTH
  );

  if (description) {
    data.description = description;
  }
  if (image) {
    data.image = image;
  }
  if (siteName) {
    data.siteName = siteName;
  }
  return data;
}

const CHARSET_PATTERN = /charset\s*=\s*["']?\s*([a-z0-9_\-:]+)/i;

/**
 * Decode the page's bytes.
 *
 * `Response.text()` is UTF-8 whatever the page says, which would leave a
 * Shift_JIS title as mojibake, so the declared encoding is honoured — from the
 * response header, or from the `<meta charset>` in the ASCII-compatible head.
 */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder().decode(bytes.subarray(0, MAX_CHARSET_SCAN));
  const label =
    CHARSET_PATTERN.exec(contentType)?.[1] ?? CHARSET_PATTERN.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * The page's first {@link MAX_HTML_BYTES}, stopping the download there rather
 * than reading it all and slicing: the metadata is in `<head>`, and the rest is
 * bandwidth the reader pays for and nothing reads.
 */
async function readCappedBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer()).slice(0, MAX_HTML_BYTES);
  }
  const bytes = new Uint8Array(MAX_HTML_BYTES);
  let size = 0;
  while (size < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const room = Math.min(value.length, MAX_HTML_BYTES - size);
    bytes.set(value.subarray(0, room), size);
    size += room;
  }
  await reader.cancel().catch(() => {});
  return bytes.subarray(0, size);
}

async function fetchOgp(request: string, target: string): Promise<OgpData | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OGP_TIMEOUT_MS);
  try {
    const response = await fetch(request, {
      credentials: 'omit',
      // As on the thumbnail: the proxy is told which URL to look up, not which
      // page the widget is embedded in.
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      return undefined;
    }
    // The abort above covers this read, so a page that never stops arriving
    // costs the timeout rather than the wait.
    return parseOgpHtml(decodeHtml(await readCappedBytes(response), contentType), target);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Promises rather than results, so two cards quoting the same URL share one
 * request instead of racing.
 */
const cache = new Map<string, Promise<OgpData | undefined>>();

/**
 * The preview for one link, fetching it the first time it is asked for.
 *
 * @returns undefined for anything that did not produce a card — a bad proxy, a
 *   failed request, a page with no title. The caller renders nothing, and the
 *   link is still in the body where the author wrote it.
 */
export function requestOgp(proxy: string, target: string): Promise<OgpData | undefined> {
  const key = `${proxy}\n${target}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const request = ogpRequestUrl(proxy, target);
  const pending =
    request === undefined ? Promise.resolve(undefined) : withSlot(() => fetchOgp(request, target));
  cache.set(key, pending);

  if (cache.size > MAX_CACHED_PREVIEWS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return pending;
}

/**
 * Empties the page-scoped cache. Nothing in the widget calls it — it is here
 * for tests, and for a consumer driving the components directly.
 */
export function resetOgpCache(): void {
  cache.clear();
}
