/**
 * In-memory cache storage implementation
 */
import { CacheOptions, CacheStorage, CacheEntry } from '@nostr-cache/types';
/**
 * In-memory implementation of CacheStorage
 */
export declare class MemoryStorage implements CacheStorage {
    private cache;
    private options;
    /**
     * Create a new MemoryStorage instance
     *
     * @param options Cache configuration options
     */
    constructor(options: CacheOptions);
    /**
     * Get an entry from the cache
     *
     * @param key Cache key
     * @returns Cache entry or undefined if not found
     */
    get(key: string): CacheEntry | undefined;
    /**
     * Set an entry in the cache
     *
     * @param key Cache key
     * @param entry Cache entry
     */
    set(key: string, entry: CacheEntry): void;
    /**
     * Delete an entry from the cache
     *
     * @param key Cache key
     * @returns True if the entry was deleted, false if it didn't exist
     */
    delete(key: string): boolean;
    /**
     * Clear the entire cache
     */
    clear(): void;
    /**
     * Check if the cache has an entry for the given key
     *
     * @param key Cache key
     * @returns True if the entry exists and has not expired
     */
    has(key: string): boolean;
    /**
     * Get all keys in the cache
     *
     * @returns Array of cache keys
     */
    keys(): string[];
    /**
     * Get the number of entries in the cache
     *
     * @returns Number of cache entries
     */
    size(): number;
    /**
     * Evict entries based on the configured strategy
     *
     * @private
     */
    private evict;
    /**
     * Evict the least recently used entry
     *
     * @private
     */
    private evictLRU;
    /**
     * Evict the oldest entry (first in)
     *
     * @private
     */
    private evictFIFO;
    /**
     * Evict the least frequently used entry
     *
     * @private
     */
    private evictLFU;
}
