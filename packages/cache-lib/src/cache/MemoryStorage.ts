/**
 * In-memory cache storage implementation
 */

import { CacheOptions, CacheStorage, CacheEntry } from '@nostr-cache/types';

/**
 * In-memory implementation of CacheStorage
 */
export class MemoryStorage implements CacheStorage {
  private cache: Map<string, CacheEntry>;
  private options: CacheOptions;

  /**
   * Create a new MemoryStorage instance
   * 
   * @param options Cache configuration options
   */
  constructor(options: CacheOptions) {
    this.cache = new Map<string, CacheEntry>();
    this.options = options;
  }

  /**
   * Get an entry from the cache
   * 
   * @param key Cache key
   * @returns Cache entry or undefined if not found
   */
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return undefined;
    }

    // Check if entry has expired
    if (entry.expires && entry.expires < Date.now()) {
      this.delete(key);
      return undefined;
    }

    return entry;
  }

  /**
   * Set an entry in the cache
   * 
   * @param key Cache key
   * @param entry Cache entry
   */
  set(key: string, entry: CacheEntry): void {
    // Enforce max size if configured
    if (this.options.maxSize && this.cache.size >= this.options.maxSize && !this.cache.has(key)) {
      this.evict();
    }

    // Set TTL if configured
    if (this.options.ttl && !entry.expires) {
      entry.expires = Date.now() + this.options.ttl;
    }

    this.cache.set(key, entry);
  }

  /**
   * Delete an entry from the cache
   * 
   * @param key Cache key
   * @returns True if the entry was deleted, false if it didn't exist
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Check if the cache has an entry for the given key
   * 
   * @param key Cache key
   * @returns True if the entry exists and has not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return false;
    }

    // Check if entry has expired
    if (entry.expires && entry.expires < Date.now()) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get all keys in the cache
   * 
   * @returns Array of cache keys
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get the number of entries in the cache
   * 
   * @returns Number of cache entries
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Evict entries based on the configured strategy
   * 
   * @private
   */
  private evict(): void {
    if (this.cache.size === 0) {
      return;
    }

    const strategy = this.options.strategy || 'LRU';
    
    switch (strategy) {
      case 'LRU':
        this.evictLRU();
        break;
      case 'FIFO':
        this.evictFIFO();
        break;
      case 'LFU':
        this.evictLFU();
        break;
      default:
        this.evictLRU(); // Default to LRU
    }
  }

  /**
   * Evict the least recently used entry
   * 
   * @private
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Evict the oldest entry (first in)
   * 
   * @private
   */
  private evictFIFO(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Evict the least frequently used entry
   * 
   * @private
   */
  private evictLFU(): void {
    let leastUsedKey: string | null = null;
    let leastUsedCount = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.accessCount < leastUsedCount) {
        leastUsedCount = entry.accessCount;
        leastUsedKey = key;
      }
    }

    if (leastUsedKey) {
      this.cache.delete(leastUsedKey);
    }
  }
}
