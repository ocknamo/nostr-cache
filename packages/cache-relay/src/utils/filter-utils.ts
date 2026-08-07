/**
 * Filter utilities for Nostr Cache Relay
 *
 * Utilities for working with Nostr filters
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';

/**
 * Extended filter type with index signature for string keys
 */
interface ExtendedFilter extends Filter {
  [key: string]: unknown;
}

/**
 * Create a cache key from a Nostr filter
 *
 * @param filter Nostr filter
 * @returns String key representing the filter
 */
export function createFilterKey(filter: Filter): string {
  // Sort all arrays to ensure consistent keys
  const normalizedFilter = normalizeFilter(filter) as ExtendedFilter;

  // Sort the keys of the normalized filter
  const sortedKeys = Object.keys(normalizedFilter).sort();
  const sortedFilter: ExtendedFilter = {};

  // Create a new object with sorted keys
  for (const key of sortedKeys) {
    sortedFilter[key] = normalizedFilter[key];
  }

  // Convert to JSON string for use as a cache key
  return JSON.stringify(sortedFilter);
}

/**
 * Normalize a filter by sorting all arrays for consistent representation
 *
 * @param filter Nostr filter to normalize
 * @returns Normalized filter with sorted arrays
 */
export function normalizeFilter(filter: Filter): Filter {
  const normalized: ExtendedFilter = {};

  // Process each property in the filter
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      // Sort arrays for consistent ordering
      normalized[key] = [...value].sort();
    } else {
      // Copy non-array values as-is
      normalized[key] = value;
    }
  }

  return normalized;
}

/**
 * Check if an event matches a filter
 *
 * @param event Nostr event
 * @param filter Nostr filter
 * @returns True if the event matches the filter
 */
export function eventMatchesFilter(event: NostrEvent, filter: Filter): boolean {
  // Check ids
  if (filter.ids && !filter.ids.includes(event.id)) {
    return false;
  }

  // Check authors
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }

  // Check kinds
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }

  // Check since
  // `!== undefined` で判定する（`since` が truthy かで見ると `since: 0` を
  // 「指定なし」として無視してしまい、ストレージ側のインデックス絞り込みと割れる）
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }

  // Check until
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }

  // Check tag filters (e.g. #e, #p)
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTags = event.tags.filter((tag) => tag[0] === tagName);
      const eventTagValues = eventTags.map((tag) => tag[1]);

      // Check if any of the filter values match any of the event tag values
      const hasMatch = (values as string[]).some((value) => eventTagValues.includes(value));

      if (!hasMatch) {
        return false;
      }
    }
  }

  // If we got here, the event matches the filter
  return true;
}

/**
 * Normalize a filter's `limit` into a usable non-negative integer count.
 *
 * Filter validation only checks that `limit` is a number, so a client can send
 * `limit: 1.5` or `limit: NaN`. A fractional count breaks SQL `LIMIT` outright
 * (the whole query fails and the client gets an empty response), so both
 * storage adapters normalize through here instead of trusting the raw value.
 *
 * @param limit Raw `filter.limit`
 * @returns A non-negative integer, or `undefined` for "no client-imposed
 *   limit" (unset / `NaN` / `Infinity`). The relay's own `maxEventsPerRequest`
 *   cap still applies in that case.
 */
export function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || Number.isNaN(limit) || limit === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return Math.max(0, Math.floor(limit));
}

/**
 * Sort events newest-first, as NIP-01 requires for `limit` queries:
 * "Newer events should appear first, and in the case of ties the event with
 * the lowest id (first in lexical order) should be first."
 *
 * @param events Events to sort (not mutated)
 * @returns A new array sorted by `created_at` descending, `id` ascending
 */
export function sortNewestFirst(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Apply a relay-imposed cap on the number of events returned.
 *
 * Always sorts newest-first ({@link sortNewestFirst}) — not only when the cap
 * actually truncates. NIP-01 requires that order for the events returned in an
 * initial query, so returning "whatever order storage happened to yield"
 * because the result fits under the cap would still violate it.
 *
 * @param events Events to cap
 * @param maxEvents Maximum number of events to keep
 * @returns The newest-first list of events, truncated to `maxEvents`
 */
export function capEvents(events: NostrEvent[], maxEvents: number): NostrEvent[] {
  return sortNewestFirst(events).slice(0, Math.max(0, maxEvents));
}

/**
 * Merge multiple filters into a single filter
 *
 * @param filters Array of filters to merge
 * @returns Merged filter
 */
export function mergeFilters(filters: Filter[]): Filter {
  if (filters.length === 0) {
    return {};
  }

  if (filters.length === 1) {
    return filters[0];
  }

  const merged: ExtendedFilter = {};

  // Merge ids (union)
  const ids = filters.flatMap((f) => f.ids || []);
  if (ids.length > 0) {
    merged.ids = [...new Set(ids)];
  }

  // Merge authors (union)
  const authors = filters.flatMap((f) => f.authors || []);
  if (authors.length > 0) {
    merged.authors = [...new Set(authors)];
  }

  // Merge kinds (union)
  const kinds = filters.flatMap((f) => f.kinds || []);
  if (kinds.length > 0) {
    merged.kinds = [...new Set(kinds)];
  }

  // Merge since (take the highest)
  const sinceValues = filters.map((f) => f.since).filter((s) => s !== undefined) as number[];
  if (sinceValues.length > 0) {
    merged.since = Math.max(...sinceValues);
  }

  // Merge until (take the lowest)
  const untilValues = filters.map((f) => f.until).filter((u) => u !== undefined) as number[];
  if (untilValues.length > 0) {
    merged.until = Math.min(...untilValues);
  }

  // Merge limit (take the lowest)
  const limitValues = filters.map((f) => f.limit).filter((l) => l !== undefined) as number[];
  if (limitValues.length > 0) {
    merged.limit = Math.min(...limitValues);
  }

  // Merge tag filters (union)
  for (const filter of filters) {
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        if (!merged[key]) {
          merged[key] = [];
        }

        // Add values to the merged filter
        (merged[key] as unknown[]).push(...(values as string[]));

        // Remove duplicates
        merged[key] = [...new Set(merged[key] as unknown[])];
      }
    }
  }

  return merged;
}

/**
 * Whether an incoming REQ filter has at least one recognised, well-typed
 * condition.
 *
 * This is a shape check for subscription filters supplied by clients — "is
 * there something here we can match events against?" — as opposed to
 * {@link eventMatchesFilter}, which tests a concrete event against a filter.
 *
 * @param filter Filter to validate
 * @returns Whether the filter carries at least one valid condition
 */
export function isValidFilterShape(filter: Filter): boolean {
  if (!filter || typeof filter !== 'object') return false;

  // Check for at least one valid filter condition
  return (
    (filter.ids !== undefined && Array.isArray(filter.ids)) ||
    (filter.authors !== undefined && Array.isArray(filter.authors)) ||
    (filter.kinds !== undefined && Array.isArray(filter.kinds) && filter.kinds.length > 0) ||
    hasTagCondition(filter) ||
    (filter.since !== undefined && typeof filter.since === 'number') ||
    (filter.until !== undefined && typeof filter.until === 'number') ||
    (filter.limit !== undefined && typeof filter.limit === 'number')
  );
}

/**
 * Whether the filter carries a usable single-letter tag condition (`#e`, `#p`,
 * `#t`, …).
 *
 * NIP-01 defines the whole `#<single-letter>` family, not just `#e` and `#p`,
 * and both the storage query builder and {@link eventMatchesFilter} already
 * treat them generically — only this shape check used to stop at the two named
 * ones, so a `#t` hashtag filter was refused before it ever reached them.
 */
function hasTagCondition(filter: Filter): boolean {
  return Object.entries(filter).some(
    ([key, value]) =>
      key.length === 2 && key.startsWith('#') && /^[a-zA-Z]$/.test(key[1]) && Array.isArray(value)
  );
}
