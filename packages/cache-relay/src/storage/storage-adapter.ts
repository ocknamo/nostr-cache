import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { CachePriority } from './priority.js';

/**
 * - `FIFO`: evict the oldest events first (by `created_at`).
 * - `LRU`: evict the least recently read events first (reads are tracked
 *   per event on `getEvents`; insertion also counts as an access).
 * - `LFU`: evict the least frequently read events first, ties broken by
 *   least recently read.
 */
export type CacheStrategy = 'LRU' | 'FIFO' | 'LFU';

/**
 * - `validated`: the event's signature has been verified.
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
  kind: number;
  pubkey: string;
  /** `d` tag value; empty string for replaceable kinds. */
  identifier: string;
}

export interface SaveEventOptions {
  /** Store as signature-verified. Defaults to false (stored as pending). */
  validated?: boolean;
}

export interface StorageAdapter {
  saveEvent(event: NostrEvent, options?: SaveEventOptions): Promise<boolean>;

  /**
   * Get stored events that have not been validated yet, oldest (by storage
   * insertion time) first. Backs the persistent lazy-validation queue: the
   * background validator drains events from here in batches.
   *
   * Must not count as a read access for LRU/LFU eviction purposes.
   */
  getUnvalidatedEvents(limit: number): Promise<NostrEvent[]>;

  /** Mark events as validated. IDs that are no longer stored are ignored. */
  markValidated(ids: string[]): Promise<void>;

  /**
   * Get the persisted validation status for the given ids (`unknown` for ids
   * that are not stored).
   *
   * Must not count as a read access for LRU/LFU eviction purposes, since
   * clients may poll this frequently (e.g. to render verification badges).
   */
  getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>>;

  getEvents(filters: Filter[]): Promise<NostrEvent[]>;

  /**
   * Get the stored version of a replaceable / addressable event at `address`,
   * i.e. the one NIP-01 says to retain (newest `created_at`, ties broken by the
   * lowest id). Backs the relay's "only the newest version is kept" rule: an
   * incoming event is compared against this before it may replace anything.
   *
   * `address.kind` must be replaceable (0 / 3 / 10000–19999) or addressable
   * (30000–39999). For addressable kinds the stored event's `d` tag value must
   * equal `address.identifier` (a missing `d` tag counts as the empty
   * identifier); for replaceable kinds the identifier is ignored — the same
   * coordinate semantics as {@link deleteEventsByAddress}.
   *
   * Like {@link getValidationStatus}, this must not count as a read access for
   * LRU/LFU eviction purposes: it is a write-path precondition check, not a read
   * of the event on anyone's behalf.
   *
   * Unlike most methods here it must **not** swallow storage errors: the caller
   * cannot tell "nothing stored" (which permits the incoming event to be saved)
   * from "the lookup failed", and reporting the latter as the former is exactly
   * how a newer version would get overwritten by an older one. Let the error
   * propagate and the relay rejects the event instead.
   */
  getCurrentVersion(address: EventAddress): Promise<NostrEvent | undefined>;

  /**
   * Get the cache insertion time (in milliseconds) of the given event ids —
   * the same clock the TTL sweep expires against, i.e. when the event was
   * written into this cache, not the event's own `created_at`.
   *
   * Optional capability backing the `upstreamFreshness` window. Adapters that
   * cannot report it may omit the method, in which case the window has no
   * effect aside from a one-time warning.
   *
   * Must not count as a read access for LRU/LFU eviction purposes. Ids that are
   * not stored must be left out of the map entirely (callers treat a missing
   * entry as "not fresh").
   */
  getCachedAt?(ids: string[]): Promise<Map<string, number>>;

  /**
   * Reset the cache insertion time of the given event ids to now, returning the
   * number of events updated (0 on error).
   *
   * Optional companion to {@link getCachedAt}, used when an upstream relay
   * confirms that a copy the cache already holds is still current: without this
   * the `upstreamFreshness` window could never re-arm for an event whose content
   * never changes, since the upstream echo of an already-delivered id is deduped
   * before it reaches `saveEvent`.
   *
   * Semantically this is "revalidated just now", so — exactly as a re-`saveEvent`
   * of the same id does — it also restarts the {@link deleteExpired} TTL for
   * those events.
   *
   * Must not change validation state, and must not count as a read access for
   * LRU/LFU eviction purposes. Ids that are not stored are skipped silently.
   */
  touchCachedAt?(ids: string[]): Promise<number>;

  deleteEvent(id: string): Promise<boolean>;

  clear(): Promise<void>;

  count(): Promise<number>;

  /** Used for handling replaceable events. */
  deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean>;

  /** Used for handling addressable events. */
  deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean>;

  /**
   * Delete the events with the given ids, restricted to a single author, and
   * return how many were deleted (0 on error). Backs the `e` tags of a NIP-09
   * deletion request.
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
   */
  deleteEventsByIdsForPubkey(ids: string[], pubkey: string): Promise<number>;

  /**
   * Delete every stored version of a replaceable / addressable event at
   * `address` whose `created_at` is at or before `until`, returning how many
   * were deleted (0 on error). Backs the `a` tags of a NIP-09 deletion request
   * ("relays SHOULD delete all versions of the replaceable event up to the
   * `created_at` timestamp of the deletion request event"), so a version
   * published after the request survives.
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
   */
  deleteEventsByAddress(address: EventAddress, until: number): Promise<number>;

  /**
   * Delete all events cached (saved to storage) before `olderThan` (Unix
   * seconds), returning how many were deleted.
   *
   * Optional capability used by the TTL background sweep. Expiry is keyed on
   * when the event was written into the cache, not on the event's own
   * `created_at`. Implementations backed by a time index can do this as an
   * efficient bulk range delete.
   *
   * Priority events (matching `priority`) are exempt from the sweep and are
   * retained even when expired.
   */
  deleteExpired?(olderThan: number, priority?: CachePriority): Promise<number>;

  /**
   * Evict events so that no more than `maxSize` remain (no-op when <= 0),
   * returning how many were evicted.
   *
   * Optional capability used by the relay to bound storage size. The relay
   * calls this after saving events when `storageMaxSize` is configured.
   *
   * Priority events (matching `priority`) are evicted last: non-priority
   * events are evicted first in strategy order, and only if the store is
   * still over `maxSize` are priority events evicted (also in strategy
   * order), so `maxSize` is always honored.
   */
  enforceLimit?(
    maxSize: number,
    strategy?: CacheStrategy,
    priority?: CachePriority
  ): Promise<number>;
}
