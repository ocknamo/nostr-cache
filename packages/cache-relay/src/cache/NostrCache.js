"use strict";
/**
 * NostrCache implementation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NostrCache = void 0;
const MemoryStorage_1 = require("./MemoryStorage");
const filterUtils_1 = require("../utils/filterUtils");
/**
 * Default cache options
 */
const DEFAULT_OPTIONS = {
    maxSize: 1000,
    ttl: 3600000, // 1 hour
    strategy: 'LRU',
    persist: false
};
/**
 * NostrCache class for caching Nostr relay interactions
 */
class NostrCache {
    /**
     * Create a new NostrCache instance
     *
     * @param options Cache configuration options
     */
    constructor(options = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.storage = new MemoryStorage_1.MemoryStorage(this.options);
        this.keyGenerator = filterUtils_1.createFilterKey;
    }
    /**
     * Get events from cache or fetch from relays if not cached
     *
     * @param filters Nostr filters to match events
     * @returns Promise resolving to matching events
     */
    async getEvents(filters) {
        // This is a placeholder implementation
        // In a real implementation, this would:
        // 1. Check if the filters match any cached data
        // 2. Return cached data if available and not expired
        // 3. Fetch from relays if not cached or expired
        // 4. Update the cache with new data
        // 5. Return the events
        const cachedEvents = [];
        const uncachedFilters = [];
        // Check cache for each filter
        for (const filter of filters) {
            const key = this.keyGenerator(filter);
            const entry = this.storage.get(key);
            if (entry && (!entry.expires || entry.expires > Date.now())) {
                // Update access metadata
                entry.accessCount++;
                entry.lastAccessed = Date.now();
                this.storage.set(key, entry);
                // Add cached events to result
                cachedEvents.push(...entry.events);
            }
            else {
                // Mark filter for fetching from relays
                uncachedFilters.push(filter);
            }
        }
        // In a real implementation, we would fetch uncached filters from relays
        // For now, we'll just return the cached events
        return cachedEvents;
    }
    /**
     * Add an event to the cache
     *
     * @param event Nostr event to cache
     */
    addEvent(event) {
        // This is a placeholder implementation
        // In a real implementation, this would:
        // 1. Determine which cached filters this event matches
        // 2. Add the event to the matching cache entries
        // For demonstration purposes only
        console.log(`Added event ${event.id} to cache`);
    }
    /**
     * Clear the entire cache
     */
    clearCache() {
        this.storage.clear();
    }
    /**
     * Invalidate cache entries matching the given filter
     *
     * @param filter Filter to match cache entries to invalidate
     */
    invalidate(filter) {
        const key = this.keyGenerator(filter);
        this.storage.delete(key);
    }
    /**
     * Get cache statistics
     *
     * @returns Object with cache statistics
     */
    getStats() {
        return {
            size: this.storage.size(),
            keys: this.storage.keys()
        };
    }
}
exports.NostrCache = NostrCache;
//# sourceMappingURL=NostrCache.js.map