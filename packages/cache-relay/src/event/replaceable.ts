/**
 * NIP-01 の「置換可能イベントは最新の1件だけを保持する」判定。
 *
 * イベントパイプラインと両ストレージアダプタ（Dexie / SQLite）が同じ順序で版を選ぶ
 * ため、依存を持たない純粋関数として切り出している。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { EventAddress } from '../storage/storage-adapter.js';
import { isAddressableKind } from './event-kind.js';

/** Fields the version comparison needs; keeps the helpers usable on rows. */
type VersionKey = Pick<NostrEvent, 'id' | 'created_at'>;

/** Get the `d` tag value of an event (the first one, as NIP-01 specifies). */
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
