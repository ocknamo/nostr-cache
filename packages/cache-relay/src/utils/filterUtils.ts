/**
 * Filter utilities for Nostr Cache Relay
 *
 * Utilities for working with Nostr filters
 */

import { Filter, NostrEvent } from '@nostr-cache/types';

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
  if (filter.since && event.created_at < filter.since) {
    return false;
  }

  // Check until
  if (filter.until && event.created_at > filter.until) {
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
