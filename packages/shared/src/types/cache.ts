/**
 * Cache-related type definitions
 */

/**
 * Cache strategy options
 */
export type CacheStrategy = 'LRU' | 'FIFO' | 'LFU';

/**
 * Cache configuration options
 */
export interface CacheOptions {
  /**
   * Maximum number of items to store in the cache
   */
  maxSize?: number;

  /**
   * Time-to-live in milliseconds
   */
  ttl?: number;

  /**
   * Cache eviction strategy
   */
  strategy?: CacheStrategy;

  /**
   * Whether to persist cache to disk
   */
  persist?: boolean;

  /**
   * Path for cache persistence (if enabled)
   */
  persistPath?: string;
}

/**
 * Cache item with metadata
 */
export interface CacheItem<T> {
  /**
   * The cached data
   */
  data: T;

  /**
   * When the item was added to the cache
   */
  timestamp: number;

  /**
   * When the item expires (if TTL is set)
   */
  expires?: number;

  /**
   * Number of times the item has been accessed
   */
  accessCount: number;

  /**
   * Last time the item was accessed
   */
  lastAccessed: number;
}
