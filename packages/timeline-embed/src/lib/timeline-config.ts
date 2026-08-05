/**
 * Parses the widget's string inputs — custom element attributes and iframe
 * query parameters — into the typed config the relay and NIP-01 filters need.
 *
 * Everything here is pure and string-in/value-out so both entry points (the
 * custom element and the iframe page) share one interpretation of `relays`,
 * `kinds`, `authors` and `limit`.
 */

import type { Filter } from '@nostr-cache/shared';

export const DEFAULT_LIMIT = 50;
export const DEFAULT_KINDS = [1];

function splitList(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a comma-separated relay list, dropping anything that is not a usable
 * WebSocket URL.
 *
 * A `ws://` upstream is rejected on an https page because the browser blocks it
 * as mixed content — worth catching here, where we can explain it, rather than
 * letting the connection fail silently later. (The intercepted local URL is
 * exempt: it is served in-page and never reaches the network.)
 *
 * @param value Raw attribute value, e.g. `"wss://nos.lol, wss://relay.damus.io"`
 * @returns The relay URLs that passed validation
 */
export function parseRelays(value: string | null | undefined): string[] {
  const secureContext = typeof location !== 'undefined' && location.protocol === 'https:';
  const relays: string[] = [];

  for (const entry of splitList(value)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      console.warn(`[nostr-timeline] Ignoring malformed relay URL: ${entry}`);
      continue;
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      console.warn(`[nostr-timeline] Ignoring non-WebSocket relay URL: ${entry}`);
      continue;
    }
    if (secureContext && url.protocol === 'ws:') {
      console.warn(
        `[nostr-timeline] Ignoring ${entry}: an https page cannot open a ws:// upstream (mixed content). Use wss://.`
      );
      continue;
    }
    relays.push(entry);
  }

  return [...new Set(relays)];
}

function parseNumberList(value: string | null | undefined): number[] {
  const numbers: number[] = [];
  for (const entry of splitList(value)) {
    const parsed = Number(entry);
    if (Number.isInteger(parsed) && parsed >= 0) {
      numbers.push(parsed);
    } else {
      console.warn(`[nostr-timeline] Ignoring invalid kind: ${entry}`);
    }
  }
  return numbers;
}

/**
 * Parse the kind 0 freshness window (`profile-freshness`) out of a string
 * input.
 *
 * Whole seconds; `0` turns the window off, so every profile lookup is forwarded
 * upstream. Anything unparseable is ignored with a warning, leaving the caller's
 * default (`DEFAULT_PROFILE_FRESHNESS`) in place — a typo in an embed URL should
 * cost the reader nothing more than the default behaviour.
 *
 * @param value Raw attribute or query-parameter value, e.g. `"3600"`
 * @returns Seconds, or `undefined` when nothing usable was given
 */
export function parseFreshness(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  // Negatives are rejected rather than read as "off": the relay counts seconds,
  // so a negative one is a mistake, and 0 already spells the disable case.
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[nostr-timeline] Ignoring invalid profile-freshness (expected whole seconds, 0 to disable): ${value}`
    );
    return undefined;
  }
  return parsed;
}

/**
 * Parse the `debug` switch that turns the widget's diagnostic UI on.
 *
 * Off unless asked for: the `cache` / `upstream` badges exist to show that the
 * cache is working, which is a thing the *embedder* wants to verify — a reader
 * of the embedding site has no use for them.
 *
 * A bare `debug` (attribute with no value, or `?debug` in an iframe URL) arrives
 * as an empty string and counts as "on", matching how HTML boolean attributes
 * read. Anything else — including `false` and `0` — leaves it off.
 *
 * Booleans are accepted as well as strings: a Svelte parent writing
 * `<nostr-timeline debug>` sets the custom element's property rather than an
 * attribute, so what arrives is `true`, not `""`.
 *
 * @param value Raw attribute, property or query-parameter value
 * @returns Whether debug UI should be rendered
 */
export function parseDebug(value: string | boolean | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'true' || normalized === '1';
}

/** Keeps the `show-origin` deprecation notice to one line per page. */
let showOriginWarned = false;

/**
 * Read the deprecated `show-origin` switch, kept so embeds written against the
 * older attribute keep working.
 *
 * It can only turn the badges *on*: they used to be on unless `show-origin` said
 * otherwise, and honouring an absent attribute as "on" would give back the very
 * default this flag was moved away from. So `show-origin="true"` still shows
 * them (that embedder asked for them explicitly), `show-origin="false"` still
 * hides them, and an embed that never mentioned either gets the new default.
 *
 * @param value Raw attribute or query-parameter value
 * @returns Whether this legacy switch asks for the badges
 */
export function parseShowOriginAlias(value: string | boolean | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (!showOriginWarned) {
    showOriginWarned = true;
    console.warn(
      '[nostr-timeline] show-origin is deprecated; use debug to render the cache/upstream badges. They are hidden by default now.'
    );
  }
  return parseDebug(value);
}

export interface FilterInput {
  kinds?: string | null;
  authors?: string | null;
  limit?: string | null;
}

/**
 * Build the NIP-01 filter for the timeline subscription.
 *
 * Omitted or unparseable inputs fall back to the defaults (kind 1, 50 events)
 * so a bare `<nostr-timeline>` still shows something.
 */
export function parseFilter(input: FilterInput): Filter {
  const kinds = parseNumberList(input.kinds);
  const authors = splitList(input.authors);
  const parsedLimit = Number(input.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;

  const filter: Filter = {
    kinds: kinds.length > 0 ? kinds : DEFAULT_KINDS,
    limit,
  };
  if (authors.length > 0) {
    filter.authors = authors;
  }
  return filter;
}

/**
 * Read the widget config out of an iframe URL's query string, so
 * `embed/?relays=wss://nos.lol&kinds=1&limit=20` configures the same things the
 * custom element's attributes do.
 */
export function configFromSearchParams(params: URLSearchParams): {
  relays: string[];
  filter: Filter;
  dbName: string | undefined;
  /** Seconds a cached profile is served for; `undefined` keeps the default. */
  profileFreshness: number | undefined;
  /** Whether to render the diagnostic `cache` / `upstream` badges. */
  debug: boolean;
  /** Whether to render author avatars. */
  showAvatars: boolean;
  /** Whether to render media attachments found in a note's body. */
  showMedia: boolean;
} {
  return {
    relays: parseRelays(params.get('relays')),
    filter: parseFilter({
      kinds: params.get('kinds'),
      authors: params.get('authors'),
      limit: params.get('limit'),
    }),
    dbName: params.get('db-name') ?? undefined,
    profileFreshness: parseFreshness(params.get('profile-freshness')),
    debug: parseDebug(params.get('debug')) || parseShowOriginAlias(params.get('show-origin')),
    showAvatars: params.get('show-avatars') !== 'false',
    showMedia: params.get('show-media') !== 'false',
  };
}
