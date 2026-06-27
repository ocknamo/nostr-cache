/**
 * Storage adapter interface for Nostr Cache Relay
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';

/**
 * Cache eviction strategy.
 *
 * - `FIFO`: evict the oldest events first (by `created_at`).
 * - `LRU` / `LFU`: planned; currently fall back to `FIFO` until per-event
 *   access metadata (read tracking) is added.
 */
export type CacheStrategy = 'LRU' | 'FIFO' | 'LFU';

/**
 * Storage adapter interface
 * Defines the contract for storage implementations
 */
export interface StorageAdapter {
  /**
   * Save an event to storage
   *
   * @param event Nostr event to save
   * @returns Promise resolving to true if successful, false otherwise
   */
  saveEvent(event: NostrEvent): Promise<boolean>;

  /**
   * Get events matching the given filters
   *
   * @param filters Array of filters to match events against
   * @returns Promise resolving to array of matching events
   */
  getEvents(filters: Filter[]): Promise<NostrEvent[]>;

  /**
   * Delete an event from storage
   *
   * @param id ID of the event to delete
   * @returns Promise resolving to true if successful, false otherwise
   */
  deleteEvent(id: string): Promise<boolean>;

  /**
   * Clear all events from storage
   *
   * @returns Promise resolving when operation is complete
   */
  clear(): Promise<void>;

  /**
   * Count the number of stored events
   *
   * @returns Promise resolving to the number of stored events
   */
  count(): Promise<number>;

  /**
   * Delete events with the same pubkey and kind
   * Used for handling replaceable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @returns Promise resolving to true if successful, false otherwise
   */
  deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean>;

  /**
   * Delete events with the same pubkey, kind, and d tag value
   * Used for handling addressable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @param dTagValue Value of the d tag
   * @returns Promise resolving to true if successful, false otherwise
   */
  deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean>;

  /**
   * Delete all events older than the given timestamp.
   *
   * Optional capability used by the TTL background sweep. Implementations
   * backed by a time index can do this as an efficient bulk range delete.
   *
   * @param olderThan Unix timestamp (seconds); events with `created_at`
   *   strictly less than this are deleted
   * @returns Promise resolving to the number of events deleted
   */
  deleteExpired?(olderThan: number): Promise<number>;
}
