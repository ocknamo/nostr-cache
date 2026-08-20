import type { Filter, NostrEvent } from '@nostr-cache/shared';

interface ExtendedFilter extends Filter {
  [key: string]: unknown;
}

/** Stable JSON key for a filter: arrays and object keys are both sorted. */
export function createFilterKey(filter: Filter): string {
  const normalizedFilter = normalizeFilter(filter) as ExtendedFilter;

  const sortedKeys = Object.keys(normalizedFilter).sort();
  const sortedFilter: ExtendedFilter = {};
  for (const key of sortedKeys) {
    sortedFilter[key] = normalizedFilter[key];
  }

  return JSON.stringify(sortedFilter);
}

/** Normalize a filter by sorting all arrays for consistent representation */
export function normalizeFilter(filter: Filter): Filter {
  const normalized: ExtendedFilter = {};

  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      normalized[key] = [...value].sort();
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

export function eventMatchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) {
    return false;
  }

  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }

  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }

  // `!== undefined` で判定する（`since` が truthy かで見ると `since: 0` を
  // 「指定なし」として無視してしまい、ストレージ側のインデックス絞り込みと割れる）
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }

  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }

  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTags = event.tags.filter((tag) => tag[0] === tagName);
      const eventTagValues = eventTags.map((tag) => tag[1]);

      const hasMatch = (values as string[]).some((value) => eventTagValues.includes(value));

      if (!hasMatch) {
        return false;
      }
    }
  }

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
 */
export function capEvents(events: NostrEvent[], maxEvents: number): NostrEvent[] {
  return sortNewestFirst(events).slice(0, Math.max(0, maxEvents));
}

/**
 * Merge filters into one: `ids` / `authors` / `kinds` / tag conditions take the
 * union, `since` the highest, `until` and `limit` the lowest.
 */
export function mergeFilters(filters: Filter[]): Filter {
  if (filters.length === 0) {
    return {};
  }

  if (filters.length === 1) {
    return filters[0];
  }

  const merged: ExtendedFilter = {};

  const ids = filters.flatMap((f) => f.ids || []);
  if (ids.length > 0) {
    merged.ids = [...new Set(ids)];
  }

  const authors = filters.flatMap((f) => f.authors || []);
  if (authors.length > 0) {
    merged.authors = [...new Set(authors)];
  }

  const kinds = filters.flatMap((f) => f.kinds || []);
  if (kinds.length > 0) {
    merged.kinds = [...new Set(kinds)];
  }

  const sinceValues = filters.map((f) => f.since).filter((s) => s !== undefined) as number[];
  if (sinceValues.length > 0) {
    merged.since = Math.max(...sinceValues);
  }

  const untilValues = filters.map((f) => f.until).filter((u) => u !== undefined) as number[];
  if (untilValues.length > 0) {
    merged.until = Math.min(...untilValues);
  }

  const limitValues = filters.map((f) => f.limit).filter((l) => l !== undefined) as number[];
  if (limitValues.length > 0) {
    merged.limit = Math.min(...limitValues);
  }

  for (const filter of filters) {
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        if (!merged[key]) {
          merged[key] = [];
        }

        (merged[key] as unknown[]).push(...(values as string[]));
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
 */
export function isValidFilterShape(filter: Filter): boolean {
  if (!filter || typeof filter !== 'object') return false;

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
