/**
 * Parses the `filters` attribute — a JSON array of NIP-01 filters — into the
 * `Filter[]` a REQ carries.
 *
 * The comma-separated `kinds` / `authors` / `limit` attributes only reach three
 * of NIP-01's fields and can only ever describe one filter. This is the escape
 * hatch: the embedder writes the filters out in full, including `since`,
 * `until`, `ids` and tag filters, and can pass more than one.
 *
 * Everything here follows the widget's house rule for bad input (see the
 * README): warn on the console and carry on with what is still usable, rather
 * than failing the embed. That matters more here than elsewhere, because the
 * relay refuses a REQ *as a whole* when any one of its filters is malformed —
 * and it answers with a NOTICE, not CLOSED, so the widget would sit on
 * "読み込み中…" forever. Whatever this module lets through has to be something
 * the relay will accept.
 */

import { filterUtils } from '@nostr-cache/cache-relay/browser';
import { type Filter, decodeNip19 } from '@nostr-cache/shared';

/**
 * Filters accepted from one `filters` attribute.
 *
 * The relay runs a storage query per filter, and asks upstream per filter, so
 * the list is a cost multiplier on every REQ. Ten is far more than an embed
 * needs and still bounds what a copy-pasted attribute can do.
 */
export const MAX_FILTERS = 10;

/** NIP-01 scalar fields, all whole seconds/counts. */
const INTEGER_FIELDS = ['since', 'until', 'limit'] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Normalize a value that NIP-01 wants as a 64-character hex pubkey.
 *
 * `npub` / `nprofile` are accepted because that is what an embedder copies out
 * of a client; the wire format is hex either way.
 *
 * @param value Raw entry from `authors` or `#p`
 * Exported because `<nostr-follow-timeline>`'s `pubkey` attribute has to accept
 * exactly the same spellings as an `authors` entry — an embedder copies one out
 * of a client the same way they copy the other.
 */
export function toPubkeyHex(value: string): string | undefined {
  if (isHex64(value)) {
    return value.toLowerCase();
  }
  const decoded = decodeNip19(value);
  return decoded && (decoded.type === 'npub' || decoded.type === 'nprofile')
    ? decoded.pubkey
    : undefined;
}

/**
 * Normalize a value that NIP-01 wants as a 64-character hex event id.
 *
 * `note` / `nevent` are accepted for the same reason `npub` is above.
 */
function toEventIdHex(value: string): string | undefined {
  if (isHex64(value)) {
    return value.toLowerCase();
  }
  const decoded = decodeNip19(value);
  return decoded && (decoded.type === 'note' || decoded.type === 'nevent') ? decoded.id : undefined;
}

/**
 * Map a list through a normalizer, dropping (and reporting) what it rejects.
 *
 * @returns The normalized entries, or `undefined` when every entry was rejected
 *   — the caller drops the whole filter in that case, because a key that simply
 *   disappears would *widen* the query rather than narrow it
 */
function normalizeList(
  values: string[],
  key: string,
  normalize: (value: string) => string | undefined
): string[] | undefined {
  const normalized: string[] = [];
  for (const value of values) {
    const hex = normalize(value);
    if (hex === undefined) {
      console.warn(`[nostr-timeline] Ignoring invalid ${key} entry: ${value}`);
      continue;
    }
    normalized.push(hex);
  }
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Whether a sanitized filter still carries something the relay will match on.
 *
 * Mirrors the relay's own `isValidFilterShape`: a filter that survived
 * sanitizing with nothing left in it would take the whole REQ down with it.
 */
function hasCondition(filter: Filter): boolean {
  return Object.keys(filter).some((key) => key !== 'limit');
}

/** Sanitize one entry of the `filters` array. */
function sanitizeFilter(input: unknown, index: number): Filter | undefined {
  const label = `filters[${index}]`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    console.warn(`[nostr-timeline] Ignoring ${label}: expected a filter object`);
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  const filter: Filter = {};

  for (const [key, value] of Object.entries(candidate)) {
    if (key === 'kinds') {
      if (!Array.isArray(value)) {
        console.warn(`[nostr-timeline] Ignoring ${label}: "kinds" must be an array of numbers`);
        return undefined;
      }
      const kinds = value.filter(
        (kind): kind is number => typeof kind === 'number' && Number.isInteger(kind) && kind >= 0
      );
      if (kinds.length !== value.length) {
        console.warn(`[nostr-timeline] Ignoring invalid kinds in ${label}`);
      }
      if (kinds.length === 0) {
        console.warn(`[nostr-timeline] Ignoring ${label}: "kinds" has no usable value`);
        return undefined;
      }
      filter.kinds = kinds;
      continue;
    }

    if (key === 'authors' || key === 'ids' || filterUtils.isSingleLetterTagKey(key)) {
      if (!isStringArray(value)) {
        console.warn(`[nostr-timeline] Ignoring ${label}: "${key}" must be an array of strings`);
        return undefined;
      }
      // Only the keys NIP-01 defines as hex are normalized. `#t`, `#d` and the
      // rest hold arbitrary tag values, and rewriting those would corrupt them.
      const normalize =
        key === 'authors' || key === '#p'
          ? toPubkeyHex
          : key === 'ids' || key === '#e'
            ? toEventIdHex
            : undefined;
      const entries = normalize
        ? normalizeList(value, `${label} "${key}"`, normalize)
        : value.filter((entry) => entry.length > 0);
      if (entries === undefined || entries.length === 0) {
        // Dropping just the key would turn "posts by these authors" into "all
        // posts", so the filter goes with it.
        console.warn(`[nostr-timeline] Ignoring ${label}: "${key}" has no usable value`);
        return undefined;
      }
      if (key === 'authors' || key === 'ids') {
        filter[key] = entries;
      } else {
        filter[key as `#${string}`] = entries;
      }
      continue;
    }

    if ((INTEGER_FIELDS as readonly string[]).includes(key)) {
      const field = key as (typeof INTEGER_FIELDS)[number];
      const minimum = field === 'limit' ? 1 : 0;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
        console.warn(
          `[nostr-timeline] Ignoring ${label}: "${key}" must be an integer >= ${minimum}`
        );
        return undefined;
      }
      filter[field] = value;
      continue;
    }

    // `search` (NIP-50) lands here too: the cache relay does not implement it,
    // and forwarding it would have the relay reject the whole REQ.
    console.warn(`[nostr-timeline] Ignoring unsupported filter key in ${label}: ${key}`);
  }

  if (!hasCondition(filter)) {
    console.warn(`[nostr-timeline] Ignoring ${label}: no usable condition left`);
    return undefined;
  }
  return filter;
}

/**
 * Parse the `filters` attribute (or `?filters=` query parameter).
 *
 * A filter that names no `limit` is returned without one; supplying the
 * widget's default is `parseFilters`' job, alongside the other defaults.
 *
 * @returns The filters to subscribe with, or `undefined` when nothing usable
 *   was given — the caller then falls back to the `kinds` / `authors` / `limit`
 *   attributes
 */
export function parseFilterList(raw: string | null | undefined): Filter[] | undefined {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[nostr-timeline] Ignoring filters: invalid JSON (${(error as Error).message})`);
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    console.warn('[nostr-timeline] Ignoring filters: expected a JSON array of filter objects');
    return undefined;
  }
  if (parsed.length > MAX_FILTERS) {
    console.warn(
      `[nostr-timeline] Ignoring filters beyond the first ${MAX_FILTERS} (got ${parsed.length})`
    );
  }

  const filters: Filter[] = [];
  for (const [index, entry] of parsed.slice(0, MAX_FILTERS).entries()) {
    const filter = sanitizeFilter(entry, index);
    if (filter) {
      filters.push(filter);
    }
  }
  return filters.length > 0 ? filters : undefined;
}
