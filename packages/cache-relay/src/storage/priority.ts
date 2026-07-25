/**
 * キャッシュ優先度の判定ロジック
 *
 * Dexie にも SQLite にも依存しない純粋関数として切り出し、両ストレージ実装で
 * 共有する（`dexie/tag-index.ts` と同じパターン）。
 */

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
 * Whether the given config contains at least one effective priority rule.
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
 * Build a matcher deciding whether a stored event row is a priority event.
 * Precomputes lookup sets once so the returned function is cheap per row.
 *
 * @param priority Cache priority config
 * @returns Function returning true for rows matching any priority rule
 */
export function createPriorityMatcher(
  priority: CachePriority
): (row: { pubkey: string; kind: number }) => boolean {
  const pubkeys = new Set(priority.pubkeys ?? []);
  const kinds = new Set(priority.kinds ?? []);
  return (row) => pubkeys.has(row.pubkey) || kinds.has(row.kind);
}
