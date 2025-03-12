/**
 * NostrCache implementation
 */
import { NostrEvent, Filter, CacheOptions } from '@nostr-cache/types';
/**
 * NostrCache class for caching Nostr relay interactions
 */
export declare class NostrCache {
    private options;
    private storage;
    private keyGenerator;
    /**
     * Create a new NostrCache instance
     *
     * @param options Cache configuration options
     */
    constructor(options?: CacheOptions);
    /**
     * Get events from cache or fetch from relays if not cached
     *
     * @param filters Nostr filters to match events
     * @returns Promise resolving to matching events
     */
    getEvents(filters: Filter[]): Promise<NostrEvent[]>;
    /**
     * Add an event to the cache
     *
     * @param event Nostr event to cache
     */
    addEvent(event: NostrEvent): void;
    /**
     * Clear the entire cache
     */
    clearCache(): void;
    /**
     * Invalidate cache entries matching the given filter
     *
     * @param filter Filter to match cache entries to invalidate
     */
    invalidate(filter: Filter): void;
    /**
     * Get cache statistics
     *
     * @returns Object with cache statistics
     */
    getStats(): {
        size: number;
        keys: string[];
    };
}
