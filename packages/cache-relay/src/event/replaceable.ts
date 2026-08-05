/**
 * NIP-01 の「置換可能イベントは最新の1件だけを保持する」判定。
 *
 * Which of two versions of the same replaceable / addressable event wins, per
 * NIP-01:
 *
 * > in case of replaceable events with the same timestamp, the event with the
 * > lowest id (first in lexical order) should be retained, and the other
 * > discarded
 *
 * Dependency-free pure predicates, like `event-kind.ts` / `storage/priority.ts`:
 * the event pipeline decides whether an incoming event may replace what is
 * stored, and both storage adapters (Dexie / SQLite) pick the current version
 * out of the rows they hold — all from this single source of truth.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { EventAddress } from '../storage/storage-adapter.js';
import { isAddressableKind } from './event-kind.js';

/** Fields the version comparison needs; keeps the helpers usable on rows. */
type VersionKey = Pick<NostrEvent, 'id' | 'created_at'>;

/**
 * Get the `d` tag value of an event (the first one, as NIP-01 specifies).
 *
 * @param tags Tags of the event
 * @returns The `d` tag value, or undefined when the event carries no `d` tag
 */
export function getDTagValue(tags: string[][]): string | undefined {
  const dTag = tags.find((tag) => tag[0] === 'd');
  return dTag ? dTag[1] : undefined;
}

/**
 * The coordinate an event is stored at as a replaceable / addressable event:
 * (kind, pubkey) plus the `d` identifier for addressable kinds only.
 *
 * A missing `d` tag counts as the empty identifier, matching NIP-01 and
 * `matchesAddressIdentifier` (the predicate the storage adapters resolve
 * coordinates with).
 *
 * @param event Event to address (kind must be replaceable or addressable)
 * @returns The coordinate of the event
 */
export function addressOf(event: NostrEvent): EventAddress {
  return {
    kind: event.kind,
    pubkey: event.pubkey,
    identifier: isAddressableKind(event.kind) ? (getDTagValue(event.tags) ?? '') : '',
  };
}

/**
 * Whether the stored version wins over an incoming one — i.e. the incoming
 * event must NOT replace it.
 *
 * Newer `created_at` wins; on a tie the lower id wins (NIP-01's tiebreak, which
 * makes the outcome independent of arrival order).
 *
 * The **same id is never superseded**: it is the same event, not an older
 * version. Re-ingesting it (an upstream echo, a client rebroadcast) therefore
 * stays a normal save, which keeps the existing TTL / freshness-window
 * semantics — `cached_at` is re-stamped exactly as before — and keeps the event
 * deliverable to the client that asked for it.
 *
 * @param stored Version currently held by the cache
 * @param incoming Version being ingested
 * @returns True if the stored version must be kept and the incoming one dropped
 */
export function supersedes(stored: VersionKey, incoming: VersionKey): boolean {
  if (stored.id === incoming.id) {
    return false;
  }
  if (stored.created_at !== incoming.created_at) {
    return stored.created_at > incoming.created_at;
  }
  return stored.id < incoming.id;
}

/**
 * Pick the version NIP-01 says to retain out of the stored versions of one
 * coordinate.
 *
 * Normally there is at most one (the relay replaces on write), so this only
 * matters for rows written before the comparison existed, or by another writer
 * on the same database.
 *
 * @param versions Stored versions of a single (pubkey, kind[, d]) coordinate
 * @returns The version to retain, or undefined when there is none
 */
export function selectCurrentVersion<T extends VersionKey>(versions: T[]): T | undefined {
  let current: T | undefined;
  for (const version of versions) {
    if (current === undefined || !supersedes(current, version)) {
      current = version;
    }
  }
  return current;
}
