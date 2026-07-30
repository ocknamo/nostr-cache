/**
 * Storage adapter interface for Nostr Cache Relay
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { CachePriority } from './priority.js';

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
 * Coordinate of a replaceable / addressable event, as carried by a NIP-01
 * `a` tag (`<kind>:<pubkey>:<d-identifier>`).
 *
 * For replaceable kinds (0 / 3 / 10000–19999) the identifier is unused and the
 * coordinate addresses the single newest event per (pubkey, kind).
 */
export interface EventAddress {
  /** Kind of the addressed event. */
  kind: number;
  /** Author of the addressed event (64-char lowercase hex). */
  pubkey: string;
  /** `d` tag value; empty string for replaceable kinds. */
  identifier: string;
}

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
   * Get the cache insertion time (in milliseconds) of the given event ids —
   * the same clock the TTL sweep expires against, i.e. when the event was
   * written into this cache, not the event's own `created_at`.
   *
   * Optional capability backing the `upstreamFreshness` window: the relay uses
   * it to decide whether a cached replaceable event is recent enough to serve
   * without re-asking the upstream relays. Adapters that cannot report it may
   * omit the method, in which case the window has no effect aside from a
   * one-time warning.
   *
   * Like {@link getValidationStatus}, this must not count as a read access for
   * LRU/LFU eviction purposes — a freshness check is bookkeeping, not a read of
   * the event. Ids that are not stored must be left out of the map entirely
   * (callers treat a missing entry as "not fresh").
   *
   * @param ids Event IDs to look up
   * @returns Promise resolving to a map of id → cache insertion time in ms,
   *   containing only the ids that are stored
   */
  getCachedAt?(ids: string[]): Promise<Map<string, number>>;

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
   * Delete the events with the given ids, restricted to a single author.
   * Backs the `e` tags of a NIP-09 deletion request.
   *
   * Implementations MUST enforce two rules of the spec themselves, since the
   * caller cannot see the stored rows:
   * - only events whose `pubkey` equals `pubkey` are deleted (a deletion
   *   request may never delete another author's events);
   * - deletion request events (kind 5) are never deleted — "publishing a
   *   deletion request event against a deletion request has no effect".
   *
   * Ids that are not stored, belong to another author, or name a kind 5 event
   * are skipped silently.
   *
   * @param ids Ids of the events to delete
   * @param pubkey Author of the deletion request; only their events are deleted
   * @returns Promise resolving to the number of events deleted (0 on error)
   */
  deleteEventsByIdsForPubkey(ids: string[], pubkey: string): Promise<number>;

  /**
   * Delete every stored version of a replaceable / addressable event at
   * `address` whose `created_at` is at or before `until`. Backs the `a` tags
   * of a NIP-09 deletion request ("relays SHOULD delete all versions of the
   * replaceable event up to the `created_at` timestamp of the deletion request
   * event"), so a version published after the request survives.
   *
   * For addressable kinds (30000–39999) the `d` tag value must equal
   * `address.identifier` (a missing `d` tag counts as the empty identifier);
   * for replaceable kinds the identifier is ignored.
   *
   * Implementations MUST reject anything else — a coordinate naming a regular
   * kind (`1:<pubkey>:`) would mean "delete every kind 1 note by this author",
   * and a non-finite `until` would remove the upper bound entirely. Calling
   * `isDeletableAddress(address, until)` applies both checks; this is a public
   * method, so the guard cannot live only in the deletion-request parser.
   *
   * @param address Coordinate of the event to delete (kind / pubkey / d value)
   * @param until Unix timestamp (seconds); versions with `created_at <= until`
   *   are deleted
   * @returns Promise resolving to the number of events deleted (0 on error)
   */
  deleteEventsByAddress(address: EventAddress, until: number): Promise<number>;

  /**
   * Delete all events cached (saved to storage) before the given timestamp.
   *
   * Optional capability used by the TTL background sweep. Expiry is keyed on
   * when the event was written into the cache (its storage insertion time),
   * not on the event's own `created_at`. Implementations backed by a time
   * index can do this as an efficient bulk range delete.
   *
   * Priority events (matching `priority`) are exempt from the sweep and are
   * retained even when expired.
   *
   * @param olderThan Unix timestamp (seconds); events cached strictly before
   *   this moment are deleted
   * @param priority Cache priority config; matching events are never deleted
   * @returns Promise resolving to the number of events deleted
   */
  deleteExpired?(olderThan: number, priority?: CachePriority): Promise<number>;

  /**
   * Evict events so that no more than `maxSize` remain.
   *
   * Optional capability used by the relay to bound storage size. The relay
   * calls this after saving events when `storageMaxSize` is configured.
   * Implementations that cannot evict may omit this method.
   *
   * Priority events (matching `priority`) are evicted last: non-priority
   * events are evicted first in strategy order, and only if the store is
   * still over `maxSize` are priority events evicted (also in strategy
   * order), so `maxSize` is always honored.
   *
   * @param maxSize Maximum number of events to keep (no-op when <= 0)
   * @param strategy Eviction strategy (default `FIFO`)
   * @param priority Cache priority config; matching events are evicted last
   * @returns Promise resolving to the number of events evicted
   */
  enforceLimit?(
    maxSize: number,
    strategy?: CacheStrategy,
    priority?: CachePriority
  ): Promise<number>;
}
