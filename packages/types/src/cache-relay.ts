/**
 * Cache-specific type definitions for cache-relay
 */

import type { CacheOptions } from './cache.js';
import type { NostrEvent } from './nostr.js';

/**
 * Cache library specific options
 * Extends the base CacheOptions
 */
export interface CacheRelayOptions extends CacheOptions {
  // Additional cache-relay specific options can be added here
}

/**
 * Cache entry
 */
export interface CacheEntry {
  /**
   * Events matching the filter
   */
  eventsId: NostrEvent['id'];

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
