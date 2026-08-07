/**
 * Parses the widget's string inputs — custom element attributes and iframe
 * query parameters — into the typed config the relay and NIP-01 filters need.
 *
 * Everything here is pure and string-in/value-out so both entry points (the
 * custom element and the iframe page) share one interpretation of `relays`,
 * `filters`, `kinds`, `authors` and `limit`. The JSON `filters` attribute is
 * involved enough to live on its own, in `filter-json.ts`.
 */

import type { Filter } from '@nostr-cache/shared';
import { parseFilterList, toPubkeyHex } from './filter-json.ts';

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
  /**
   * JSON array of NIP-01 filters. When it parses to at least one usable filter
   * the three fields below are ignored — see {@link parseFilters}.
   */
  filters?: string | null;
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

/** Keeps the `filters` precedence notice to one line per page. */
let filtersPrecedenceWarned = false;

/**
 * Build the filter list for the timeline subscription.
 *
 * `filters` wins outright when it yields anything usable: it can describe
 * things `kinds` / `authors` / `limit` cannot (several filters, `since`, tag
 * filters), so merging the two would produce a query the embedder never wrote.
 * The narrower attributes are the fallback — including when every filter in the
 * JSON turned out to be unusable, so a typo costs the reader a default timeline
 * rather than a blank one.
 */
export function parseFilters(input: FilterInput): Filter[] {
  const filters = parseFilterList(input.filters);
  if (!filters) {
    return [parseFilter(input)];
  }
  if (!filtersPrecedenceWarned && (input.kinds || input.authors || input.limit)) {
    filtersPrecedenceWarned = true;
    console.warn('[nostr-timeline] filters is set; ignoring kinds, authors and limit.');
  }
  // An unbounded filter would have the relay hand back everything it has cached
  // and then ask upstream for the same, on every page load. The widget's
  // documented default applies unless the embedder named their own.
  return filters.map((filter) =>
    filter.limit === undefined ? { ...filter, limit: DEFAULT_LIMIT } : filter
  );
}

/**
 * Parse the `pubkey` attribute of `<nostr-follow-timeline>`.
 *
 * hex, `npub` and `nprofile` are all accepted, matching how `authors` entries
 * are read. Unlike every other attribute here, an unusable value is *not*
 * survivable: `pubkey` is the one input the widget cannot supply a default for,
 * since there is no sensible follow list to fall back to. The caller reports it
 * to the reader rather than subscribing to something else.
 *
 * @param value Raw attribute or query-parameter value
 * @returns Lowercase hex, or `undefined` when the value is not a pubkey
 */
export function parsePubkey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const hex = toPubkeyHex(value.trim());
  if (!hex) {
    console.warn(`[nostr-timeline] Invalid pubkey (expected hex, npub or nprofile): ${value}`);
  }
  return hex;
}

/**
 * Parse a comma-separated `kinds` list.
 *
 * @returns The kinds to request; never empty
 */
export function parseKinds(value: string | null | undefined): number[] {
  const kinds = parseNumberList(value);
  return kinds.length > 0 ? kinds : DEFAULT_KINDS;
}

export function parseLimit(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

/**
 * Parse `max-follows`, the cap on how many follow-list entries reach `authors`.
 *
 * @returns A positive count, or `undefined` when nothing usable was given —
 *   leaving the caller's default (`DEFAULT_MAX_FOLLOWS`) in place
 */
export function parseMaxFollows(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  // Zero is rejected rather than read as "follow nobody": that would leave the
  // timeline with no authors at all, which is the one shape this widget must
  // never subscribe with.
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[nostr-timeline] Ignoring invalid max-follows (expected a positive whole number): ${value}`
    );
    return undefined;
  }
  return parsed;
}

/**
 * Parse `since-days`, the optional recency bound on a follow timeline.
 *
 * @param value Whole days
 * @returns Seconds to look back, or `undefined` for no bound
 */
export function parseSinceDays(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[nostr-timeline] Ignoring invalid since-days (expected a positive whole number of days): ${value}`
    );
    return undefined;
  }
  return parsed * 86_400;
}

/**
 * Read a switch that is on unless explicitly turned off, the way
 * `show-avatars` / `show-media` read.
 *
 * Booleans are accepted for the same reason {@link parseDebug} accepts them: a
 * Svelte parent setting the property rather than the attribute delivers one.
 */
export function parseEnabled(value: string | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return value !== 'false';
}

/**
 * Read the widget config out of an iframe URL's query string, so
 * `embed/?relays=wss://nos.lol&kinds=1&limit=20` configures the same things the
 * custom element's attributes do.
 */
export function configFromSearchParams(params: URLSearchParams): {
  relays: string[];
  /** Filters for the timeline REQ; always at least one. */
  filters: Filter[];
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
    filters: parseFilters({
      filters: params.get('filters'),
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

export interface FollowTimelineConfig {
  relays: string[];
  /** Hex pubkey whose follows are shown, or `undefined` when unusable. */
  pubkey: string | undefined;
  kinds: number[];
  limit: number;
  /** Cap on follow-list entries; `undefined` keeps `DEFAULT_MAX_FOLLOWS`. */
  maxFollows: number | undefined;
  includeSelf: boolean;
  /** Recency bound in seconds; `undefined` for none. */
  sinceSeconds: number | undefined;
  dbName: string | undefined;
  /** Seconds a cached profile is served for; `undefined` keeps the default. */
  profileFreshness: number | undefined;
  /** Seconds a cached follow list is served for; `undefined` keeps the default. */
  followsFreshness: number | undefined;
  debug: boolean;
  showAvatars: boolean;
  showMedia: boolean;
}

/**
 * Read `<nostr-follow-timeline>`'s config out of an iframe URL's query string.
 *
 * Its own function rather than a branch inside {@link configFromSearchParams},
 * for the same reason the two elements are separate: a query string carries no
 * element type, so a single entry point would have to guess which widget the
 * caller meant — and quietly drop the parameters the guessed element lacks.
 */
export function followConfigFromSearchParams(params: URLSearchParams): FollowTimelineConfig {
  return {
    relays: parseRelays(params.get('relays')),
    pubkey: parsePubkey(params.get('pubkey')),
    kinds: parseKinds(params.get('kinds')),
    limit: parseLimit(params.get('limit')),
    maxFollows: parseMaxFollows(params.get('max-follows')),
    includeSelf: parseEnabled(params.get('include-self')),
    sinceSeconds: parseSinceDays(params.get('since-days')),
    dbName: params.get('db-name') ?? undefined,
    profileFreshness: parseFreshness(params.get('profile-freshness')),
    followsFreshness: parseFreshness(params.get('follows-freshness')),
    debug: parseDebug(params.get('debug')),
    showAvatars: params.get('show-avatars') !== 'false',
    showMedia: params.get('show-media') !== 'false',
  };
}
