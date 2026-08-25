/**
 * Link previews (OGP) for the ordinary links in a note.
 *
 * A browser cannot read another origin's HTML, so the metadata has to come from
 * somewhere else: the embedder names an endpoint (`ogp-endpoint`) and this
 * module asks it for one URL at a time. Without that attribute nothing here
 * runs — the widget will not hand a reader's IP and reading history to a
 * third-party service by default, the same stance `show-media` takes.
 *
 * The response is treated as hostile: it is whatever the endpoint chose to
 * return about a URL a stranger wrote. Every field goes through the same
 * validators kind 0 does (`profile.ts`), and the card's `href` is always the
 * URL we asked about rather than one the response named — so an endpoint can
 * mislabel a link but cannot redirect it.
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

/** Response bodies longer than this are dropped unparsed. */
const MAX_RESPONSE_LENGTH = 64 * 1024;

/**
 * Previews kept for the page. Failures are kept too — an endpoint that is down
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

/** Parse an endpoint, resolving a relative one against the embedding page. */
function readEndpoint(value: string): URL | undefined {
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
 * Build the request for one target URL.
 *
 * `{url}` in the endpoint is substituted (percent-encoded) for the proxies that
 * take the target in their path; otherwise the target goes in a `url` query
 * parameter, set rather than appended so an endpoint that carries an API key in
 * its own query string keeps it.
 *
 * @returns undefined when the endpoint is not a usable `http(s)` URL
 */
export function ogpRequestUrl(endpoint: string, target: string): string | undefined {
  if (endpoint.includes('{url}')) {
    return readEndpoint(endpoint.replaceAll('{url}', encodeURIComponent(target)))?.href;
  }
  const url = readEndpoint(endpoint);
  if (!url) {
    return undefined;
  }
  url.searchParams.set('url', target);
  return url.href;
}

/** Read one field, then clip it to what the card renders. */
function readField(value: unknown, max: number): string | undefined {
  const text = safeText(value, MAX_FIELD_LENGTH);
  if (text === undefined) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The first of these keys the response carries a value for.
 *
 * `null` counts as absent, so a service that spells a missing field that way
 * still falls through to its other spelling of the same field.
 */
function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

/**
 * Validate an endpoint's answer.
 *
 * Both the plain (`title`) and the OG-prefixed (`og:title`) spellings are read,
 * because both are common in the wild and the difference is not one an embedder
 * should have to write an adapter for.
 *
 * @param url The URL that was asked about; the card links here
 * @returns undefined when there is nothing worth rendering
 */
export function parseOgpResponse(payload: unknown, url: string): OgpData | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;

  const title = readField(pick(record, ['title', 'og:title', 'ogTitle']), MAX_TITLE_LENGTH);
  if (!title) {
    return undefined;
  }

  const data: OgpData = { url, title };
  const description = readField(
    pick(record, ['description', 'og:description', 'ogDescription']),
    MAX_DESCRIPTION_LENGTH
  );
  const siteName = readField(
    pick(record, ['siteName', 'site_name', 'og:site_name', 'ogSiteName']),
    MAX_SITE_NAME_LENGTH
  );
  const image = safeImageUrl(pick(record, ['image', 'og:image', 'ogImage']), MAX_IMAGE_URL_LENGTH);

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

async function fetchOgp(request: string, target: string): Promise<OgpData | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OGP_TIMEOUT_MS);
  try {
    const response = await fetch(request, {
      credentials: 'omit',
      // As on the thumbnail: the endpoint is told which URL to look up, not
      // which page the widget is embedded in.
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    if (!(response.headers.get('content-type') ?? '').includes('json')) {
      return undefined;
    }
    // Read as text first so an endpoint answering with a huge body costs a
    // string rather than a parsed object graph.
    const body = await response.text();
    if (body.length > MAX_RESPONSE_LENGTH) {
      return undefined;
    }
    return parseOgpResponse(JSON.parse(body), target);
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
 * @returns undefined for anything that did not produce a card — a bad endpoint,
 *   a failed request, a response with no title. The caller renders nothing, and
 *   the link is still in the body where the author wrote it.
 */
export function requestOgp(endpoint: string, target: string): Promise<OgpData | undefined> {
  const key = `${endpoint}\n${target}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const request = ogpRequestUrl(endpoint, target);
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
