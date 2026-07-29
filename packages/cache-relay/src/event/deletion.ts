/**
 * NIP-09 (event deletion request) handling.
 *
 * A kind 5 event asks the relay to delete the events it references by `e`
 * (event id) or `a` (replaceable / addressable coordinate) tag. See
 * [doc/nips/nip-09.md](../../../../doc/nips/nip-09.md).
 *
 * Two rules of the spec shape everything here:
 * - only the request author's own events may be deleted. `a` tags carry the
 *   author, so they are filtered while parsing; `e` tags do not, so the
 *   pubkey check is delegated to the storage adapter, which can see the
 *   stored row;
 * - the deletion request itself is stored and kept durably, because clients
 *   may not have seen it yet and it must be re-appliable and forwardable
 *   upstream. Kind 5 is therefore exempt from the TTL sweep and evicted last
 *   under `storageMaxSize` (see `storage/priority.ts`).
 */

import { logger } from '@nostr-cache/shared';
import type { NostrEvent } from '@nostr-cache/shared';
import type { EventAddress, StorageAdapter } from '../storage/storage-adapter.js';
import { isAddressableKind, isCoordinateAddressableKind, isDeletionKind } from './event-kind.js';

/** 64-char lowercase hex, as pubkeys appear in `a` tag coordinates. */
const HEX_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

/** Event ids referenced by `e` tags (32-byte lowercase hex). */
const HEX_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Canonical decimal kind: digits only, no leading zeros (except `0` itself). */
const KIND_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * Maximum references honored per deletion request, per tag type.
 *
 * Each coordinate costs one storage round trip, and on the server those run
 * synchronously against SQLite, so an unbounded request would let a single
 * EVENT block the relay for as long as it liked. Ids are cheaper (one batched
 * query) but capped for symmetry. Excess references are dropped with a log
 * rather than rejecting the request, since the request itself is still worth
 * storing and forwarding.
 */
export const MAX_DELETION_REFERENCES = 1000;

/**
 * The deletion targets carried by one kind 5 event, after dropping malformed
 * and out-of-scope references.
 */
export interface DeletionRequest {
  /** Author of the request; the only author whose events may be deleted. */
  pubkey: string;
  /** Deduplicated event ids from `e` tags. */
  ids: string[];
  /** Deduplicated coordinates from `a` tags, all authored by `pubkey`. */
  addresses: EventAddress[];
  /**
   * `created_at` of the request. Coordinate deletions apply only to versions
   * at or before this moment, so a newer version published afterwards is kept.
   */
  until: number;
}

/**
 * Whether an event is a NIP-09 deletion request.
 *
 * @param event Event to check
 * @returns True for kind 5
 */
export function isDeletionEvent(event: Pick<NostrEvent, 'kind'>): boolean {
  return isDeletionKind(event.kind);
}

/**
 * Parse an `a` tag value (`<kind>:<pubkey>:<d-identifier>`) into a coordinate.
 *
 * The identifier may itself contain `:`, so only the first two separators are
 * significant.
 *
 * @param value Raw `a` tag value
 * @returns The coordinate, or undefined if malformed
 */
export function parseAddress(value: string): EventAddress | undefined {
  const firstColon = value.indexOf(':');
  if (firstColon <= 0) {
    return undefined;
  }
  const secondColon = value.indexOf(':', firstColon + 1);
  if (secondColon < 0) {
    return undefined;
  }

  const rawKind = value.slice(0, firstColon);
  const pubkey = value.slice(firstColon + 1, secondColon);
  const identifier = value.slice(secondColon + 1);

  // 整数以外（'1.5' / '0x1' / ' 1'）を Number の寛容さで取り込まないよう桁だけを許し、
  // 先行ゼロ（'007'）も非正規形として弾く
  if (!KIND_PATTERN.test(rawKind)) {
    return undefined;
  }
  const kind = Number(rawKind);
  if (!Number.isSafeInteger(kind) || !HEX_PUBKEY_PATTERN.test(pubkey)) {
    return undefined;
  }

  return { kind, pubkey, identifier };
}

/**
 * Extract the deletion targets of a kind 5 event.
 *
 * Dropped while parsing: `e` tags that are not 32-byte hex ids; `a` tags that
 * are malformed, name another author, or name a kind that is not addressed by
 * a coordinate (a regular kind such as `1:<pubkey>:` would otherwise delete
 * every note by that author). Self-references to kind 5 are rejected by the
 * storage adapter, which is where a target's kind is visible. References beyond
 * {@link MAX_DELETION_REFERENCES} per tag type are dropped.
 *
 * Tolerates a malformed `tags` array (a non-array, or entries that are not
 * arrays), which `NONE` validation mode makes reachable.
 *
 * @param event Deletion request event (kind 5)
 * @returns The targets to delete, deduplicated
 */
export function parseDeletionRequest(event: NostrEvent): DeletionRequest {
  const ids = new Set<string>();
  const addresses = new Map<string, EventAddress>();
  let dropped = 0;

  for (const tag of Array.isArray(event.tags) ? event.tags : []) {
    if (!Array.isArray(tag)) {
      continue;
    }
    const [name, value] = tag;
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    if (name === 'e') {
      if (!HEX_ID_PATTERN.test(value)) {
        continue;
      }
      if (ids.size >= MAX_DELETION_REFERENCES && !ids.has(value)) {
        dropped++;
        continue;
      }
      ids.add(value);
      continue;
    }

    if (name === 'a') {
      const address = parseAddress(value);
      if (
        address === undefined ||
        address.pubkey !== event.pubkey ||
        !isCoordinateAddressableKind(address.kind)
      ) {
        continue;
      }
      // 同じ座標を指す複数の a タグは 1 回にまとめる
      const key = `${address.kind}:${address.pubkey}:${address.identifier}`;
      if (addresses.size >= MAX_DELETION_REFERENCES && !addresses.has(key)) {
        dropped++;
        continue;
      }
      addresses.set(key, address);
    }
  }

  if (dropped > 0) {
    logger.info(
      `Deletion request ${event.id}: dropped ${dropped} references over the ${MAX_DELETION_REFERENCES} per-type limit`
    );
  }

  return {
    pubkey: event.pubkey,
    ids: Array.from(ids),
    addresses: Array.from(addresses.values()),
    until: event.created_at,
  };
}

/**
 * Whether a coordinate deletion may run at all.
 *
 * Shared guard for the storage adapters, mirroring what
 * {@link parseDeletionRequest} already rejects — the adapters repeat it because
 * `deleteEventsByAddress` is a public method that can be called directly, and a
 * coordinate naming a regular kind would delete every event of that kind by the
 * author. Kind 5 is excluded implicitly: it is neither replaceable nor
 * addressable, so it is never coordinate-addressable.
 *
 * `until` must be a finite number: IndexedDB orders strings above every number,
 * so a non-numeric upper bound would silently turn the range into "all
 * versions".
 *
 * @param address Coordinate being deleted
 * @param until Upper bound on `created_at`
 * @returns True if the deletion may proceed
 */
export function isDeletableAddress(address: EventAddress, until: number): boolean {
  return isCoordinateAddressableKind(address.kind) && Number.isFinite(until);
}

/**
 * Whether a stored event's tags satisfy the `d` identifier of a coordinate.
 *
 * Pure predicate shared by the Dexie and SQLite adapters so both interpret
 * coordinates identically. Only addressable kinds carry a `d` tag; for
 * replaceable kinds the identifier is not part of the address. A missing `d`
 * tag counts as the empty identifier, matching NIP-01.
 *
 * @param tags Tags of the stored event
 * @param address Coordinate being deleted
 * @returns True if the event is a version of the addressed event
 */
export function matchesAddressIdentifier(tags: string[][], address: EventAddress): boolean {
  if (!isAddressableKind(address.kind)) {
    return true;
  }
  const dTag = tags.find((tag) => tag[0] === 'd');
  return (dTag?.[1] ?? '') === address.identifier;
}

/**
 * Apply a deletion request to storage: remove the referenced events that the
 * requester is allowed to delete.
 *
 * Idempotent, so re-receiving the same request (an upstream echo, a client
 * rebroadcast) simply deletes nothing new. Parsing and storage failures alike
 * are logged and swallowed — the request itself is already persisted and gets
 * re-applied the next time it arrives, and callers rely on this never throwing
 * (`NostrCacheRelay.publishEvent` has already committed the save by then).
 *
 * @param storage Storage adapter to delete from
 * @param event Deletion request event (kind 5)
 * @returns Promise resolving to the number of events deleted
 */
export async function applyDeletionRequest(
  storage: StorageAdapter,
  event: NostrEvent
): Promise<number> {
  let deleted = 0;

  try {
    const request = parseDeletionRequest(event);
    if (request.ids.length > 0) {
      deleted += await storage.deleteEventsByIdsForPubkey(request.ids, request.pubkey);
    }
    for (const address of request.addresses) {
      deleted += await storage.deleteEventsByAddress(address, request.until);
    }
  } catch (error) {
    logger.error('Failed to apply deletion request:', error);
  }

  if (deleted > 0) {
    logger.info(`Deleted ${deleted} events for deletion request ${event.id}`);
  }

  return deleted;
}
