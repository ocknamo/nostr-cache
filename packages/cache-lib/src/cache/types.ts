/**
 * Cache-specific type definitions
 */

import { CacheOptions as SharedCacheOptions, NostrEvent, Filter } from '@nostr-cache/shared';

/**
 * Re-export CacheOptions from shared
 */
export type CacheOptions = SharedCacheOptions;

/**
 * Cache key generator function
 */
export type CacheKeyGenerator = (filter: Filter) => string;

/**
 * Cache entry
 */
export interface CacheEntry {
  /**
   * Events matching the filter
   */
  events: NostrEvent[];
  
  /**
   * When the entry was created
   */
  timestamp: number;
  
  /**
   * When the entry expires (if TTL is set)
   */
  expires?: number;
  
  /**
   * Number of times the entry has been accessed
   */
  accessCount: number;
  
  /**
   * Last time the entry was accessed
   */
  lastAccessed: number;
}

/**
 * Cache storage interface
 */
export interface CacheStorage {
  /**
   * Get an entry from the cache
   */
  get(key: string): CacheEntry | undefined;
  
  /**
   * Set an entry in the cache
   */
  set(key: string, entry: CacheEntry): void;
  
  /**
   * Delete an entry from the cache
   */
  delete(key: string): boolean;
  
  /**
   * Clear the entire cache
   */
  clear(): void;
  
  /**
   * Check if the cache has an entry for the given key
   */
  has(key: string): boolean;
  
  /**
   * Get all keys in the cache
   */
  keys(): string[];
  
  /**
   * Get the number of entries in the cache
   */
  size(): number;
}
