/**
 * Storage adapter interface for Nostr Cache Relay
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';

/**
 * Cache eviction strategy.
 *
 * - `FIFO`: evict the oldest events first (by `created_at`).
 * - `LRU`: evict the least recently read events first (reads are tracked
 *   per event on `getEvents`; insertion also counts as an access).
 * - `LFU`: evict the least frequently read events first, ties broken by
 *   least recently read.
 */
export type CacheStrategy = 'LRU' | 'FIFO' | 'LFU';

/**
 * Persisted validation state of a stored event.
 *
 * - `validated`: the event's signature has been verified (either up front in
 *   `IMMEDIATELY` mode or by a background pass in `LAZY` mode).
 * - `pending`: the event is stored but not yet verified.
 * - `unknown`: no event with that id is stored (never stored, deleted as
 *   invalid, or evicted).
 */
export type ValidationStatus = 'validated' | 'pending' | 'unknown';

/**
 * Options for {@link StorageAdapter.saveEvent}.
 */
export interface SaveEventOptions {
  /**
   * Whether the event has already been validated (signature verified) before
   * being saved. Defaults to false (stored as pending validation).
   */
  validated?: boolean;
}

/**
 * Storage adapter interface
 * Defines the contract for storage implementations
 */
export interface StorageAdapter {
  /**
   * Save an event to storage
   *
   * @param event Nostr event to save
   * @param options Save options (e.g. whether the event is already validated)
   * @returns Promise resolving to true if successful, false otherwise
   */
  saveEvent(event: NostrEvent, options?: SaveEventOptions): Promise<boolean>;

  /**
   * Get stored events that have not been validated yet, oldest (by storage
   * insertion time) first. Backs the persistent lazy-validation queue: the
   * background validator drains events from here in batches.
   *
   * Must not count as a read access for LRU/LFU eviction purposes.
   *
   * @param limit Maximum number of events to return
   * @returns Promise resolving to the unvalidated events, oldest first
   */
  getUnvalidatedEvents(limit: number): Promise<NostrEvent[]>;

  /**
   * Mark the given events as validated (signature verified). IDs that are no
   * longer stored are ignored.
   *
   * @param ids IDs of the events to mark as validated
   */
  markValidated(ids: string[]): Promise<void>;

  /**
   * Get the persisted validation status for the given event ids.
   *
   * Must not count as a read access for LRU/LFU eviction purposes, since
   * clients may poll this frequently (e.g. to render verification badges).
   *
   * @param ids Event IDs to look up
   * @returns Promise resolving to a map with one entry per requested id
   *   (`unknown` for ids that are not stored)
   */
  getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>>;

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
   * Delete all events cached (saved to storage) before the given timestamp.
   *
   * Optional capability used by the TTL background sweep. Expiry is keyed on
   * when the event was written into the cache (its storage insertion time),
   * not on the event's own `created_at`. Implementations backed by a time
   * index can do this as an efficient bulk range delete.
   *
   * @param olderThan Unix timestamp (seconds); events cached strictly before
   *   this moment are deleted
   * @returns Promise resolving to the number of events deleted
   */
  deleteExpired?(olderThan: number): Promise<number>;

  /**
   * Evict events so that no more than `maxSize` remain.
   *
   * Optional capability used by the relay to bound storage size. The relay
   * calls this after saving events when `storageMaxSize` is configured.
   * Implementations that cannot evict may omit this method.
   *
   * @param maxSize Maximum number of events to keep (no-op when <= 0)
   * @param strategy Eviction strategy (default `FIFO`)
   * @returns Promise resolving to the number of events evicted
   */
  enforceLimit?(maxSize: number, strategy?: CacheStrategy): Promise<number>;
}
