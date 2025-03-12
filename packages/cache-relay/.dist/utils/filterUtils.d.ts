/**
 * Utility functions for working with Nostr filters
 */
import { Filter, NostrEvent } from '@nostr-cache/types';
/**
 * Create a cache key from a Nostr filter
 *
 * @param filter Nostr filter
 * @returns String key representing the filter
 */
export declare function createFilterKey(filter: Filter): string;
/**
 * Normalize a filter by sorting all arrays for consistent representation
 *
 * @param filter Nostr filter to normalize
 * @returns Normalized filter with sorted arrays
 */
export declare function normalizeFilter(filter: Filter): Filter;
/**
 * Check if an event matches a filter
 *
 * @param event Nostr event
 * @param filter Nostr filter
 * @returns True if the event matches the filter
 */
export declare function eventMatchesFilter(event: NostrEvent, filter: Filter): boolean;
/**
 * Merge multiple filters into a single filter
 *
 * @param filters Array of filters to merge
 * @returns Merged filter
 */
export declare function mergeFilters(filters: Filter[]): Filter;
