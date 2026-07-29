/**
 * キャッシュの保持優先度（退避・TTL スイープからの保護）の判定ロジック
 *
 * Dexie にも SQLite にも依存しない純粋関数として切り出し、両ストレージ実装で
 * 共有する（`dexie/tag-index.ts` と同じパターン）。
 */

import { DELETION_EVENT_KIND } from '../event/event-kind.js';

/**
 * Cache priority configuration.
 *
 * Events whose `pubkey` matches any listed pubkey OR whose `kind` matches any
 * listed kind are treated as priority events: they are evicted last under
 * `storageMaxSize` (non-priority events are evicted first; priority events are
 * still evicted by the normal strategy once only priority events remain, so
 * `maxSize` is always honored) and they are exempt from the TTL sweep.
 *
 * Pubkeys must already be normalized to 64-character lowercase hex — npub
 * decoding happens once at option-resolution time, not here.
 */
export interface CachePriority {
  /** Priority authors as 64-character lowercase hex pubkeys */
  pubkeys?: string[];
  /** Priority event kinds */
  kinds?: number[];
}

/**
 * Kinds that are always retained, on top of whatever the user configured.
 *
 * NIP-09 deletion requests (kind 5) are the only entry: the spec asks relays to
 * keep serving them indefinitely, and dropping one also drops this cache's
 * ability to re-apply the deletion when the deleted event arrives again from an
 * upstream relay. See [doc/nips/nip-09.md](../../../../doc/nips/nip-09.md).
 *
 * Retention is absolute against the TTL sweep and best-effort against
 * `storageMaxSize` — protected events are evicted last, but `maxSize` still
 * wins when nothing else is left to evict.
 */
const ALWAYS_RETAINED_KINDS: ReadonlySet<number> = new Set([DELETION_EVENT_KIND]);

/**
 * Whether the given config contains at least one user-configured priority rule.
 *
 * Note this says nothing about {@link ALWAYS_RETAINED_KINDS}: retention rules
 * always apply, so callers must not use this to skip filtering entirely.
 *
 * @param priority Cache priority config (possibly undefined or empty)
 * @returns True when at least one pubkey or kind is listed
 */
export function hasPriorityRules(priority?: CachePriority): priority is CachePriority {
  return Boolean(
    priority && ((priority.pubkeys?.length ?? 0) > 0 || (priority.kinds?.length ?? 0) > 0)
  );
}

/**
 * Whether a kind is retained regardless of the configured priority rules.
 *
 * @param kind Event kind
 * @returns True if the kind must survive TTL expiry and be evicted last
 */
export function isAlwaysRetainedKind(kind: number): boolean {
  return ALWAYS_RETAINED_KINDS.has(kind);
}

/**
 * The kinds that are always retained, for storage backends that express
 * retention as a query condition rather than a per-row predicate.
 *
 * @returns The always-retained kinds
 */
export function getAlwaysRetainedKinds(): number[] {
  return Array.from(ALWAYS_RETAINED_KINDS);
}

/**
 * Build a matcher deciding whether a stored event row must be retained —
 * either because it matches a configured priority rule or because its kind is
 * always retained. Precomputes lookup sets once so the returned function is
 * cheap per row.
 *
 * @param priority Cache priority config (optional; retention still applies
 *   without it)
 * @returns Function returning true for rows that should be retained
 */
export function createPriorityMatcher(
  priority?: CachePriority
): (row: { pubkey: string; kind: number }) => boolean {
  const pubkeys = new Set(priority?.pubkeys ?? []);
  const kinds = new Set(priority?.kinds ?? []);
  return (row) => isAlwaysRetainedKind(row.kind) || pubkeys.has(row.pubkey) || kinds.has(row.kind);
}
