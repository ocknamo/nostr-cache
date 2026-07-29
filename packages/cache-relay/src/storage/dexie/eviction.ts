import { logger } from '@nostr-cache/shared';
import type { Dexie } from 'dexie';
import { type CachePriority, createPriorityMatcher } from '../priority.js';
import type { CacheStrategy } from '../storage-adapter.js';
import type { NostrEventTable } from './schema.js';

// 戦略ごとの退避順序を決めるインデックス。昇順で先頭から退避する
const evictionIndex: Record<CacheStrategy, string> = {
  FIFO: 'created_at',
  LRU: 'last_accessed_at',
  LFU: '[access_count+last_accessed_at]',
};

/**
 * Evict events so that no more than `maxSize` remain.
 *
 * Eviction order depends on `strategy`:
 * - `FIFO` (default): oldest `created_at` first.
 * - `LRU`: least recently read first (`last_accessed_at`, updated on every
 *   `getEvents` hit; insertion also counts as an access).
 * - `LFU`: least frequently read first (`access_count`), ties broken by
 *   least recently read.
 *
 * No-op when `maxSize` is not positive.
 *
 * Semantics / caveats:
 * - This is a **soft limit**. The count and the delete run inside a single
 *   read-write transaction so a given pass is atomic, but the preceding
 *   `saveEvent` commits separately, so under heavy concurrent writes the
 *   store may briefly exceed `maxSize` before converging.
 * - FIFO is keyed on `created_at` (second precision), i.e. "oldest event
 *   first" rather than strict arrival order (`cached_at`) — a deliberate
 *   choice. Events sharing the same `created_at` are evicted in primary-key
 *   (id) order.
 * - Priority events are evicted last: non-priority events are evicted first
 *   in strategy order, and only if the store is still over `maxSize` are
 *   priority events evicted (also in strategy order), so `maxSize` is always
 *   honored. The priority pass needs row values (pubkey/kind), so it walks a
 *   value cursor in eviction order and stops once enough victims are found.
 *   "Priority" covers both the configured `priority` rules and the kinds that
 *   are always retained (NIP-09 deletion requests), so this filtered path runs
 *   even when no `priority` config is given.
 *
 * @param db The Dexie database (used to open the eviction transaction)
 * @param table The Dexie events table
 * @param maxSize Maximum number of events to keep (no-op when <= 0)
 * @param strategy Eviction strategy (default `FIFO`)
 * @param priority Cache priority config; matching events are evicted last
 * @returns Promise resolving to the number of events evicted
 */
export async function enforceLimit(
  db: Dexie,
  table: Dexie.Table<NostrEventTable, string>,
  maxSize: number,
  strategy: CacheStrategy = 'FIFO',
  priority?: CachePriority
): Promise<number> {
  if (!(maxSize > 0)) {
    return 0;
  }

  try {
    // Run count + delete atomically so concurrent passes don't over- or
    // under-evict against a stale count.
    return await db.transaction('rw', table, async () => {
      const count = await table.count();
      if (count <= maxSize) {
        return 0;
      }

      const excess = count - maxSize;

      const isPriority = createPriorityMatcher(priority);
      const nonPriorityVictims = await table
        .orderBy(evictionIndex[strategy])
        .filter((row) => !isPriority(row))
        .limit(excess)
        .primaryKeys();
      if (nonPriorityVictims.length > 0) {
        await table.bulkDelete(nonPriorityVictims);
      }

      // 非優先だけで excess に満たない場合、フィルタは全件走査済みなので
      // 残りは全て優先イベント。フィルタなしの通常順で不足分を退避する。
      const remaining = excess - nonPriorityVictims.length;
      let priorityVictims: string[] = [];
      if (remaining > 0) {
        priorityVictims = await table
          .orderBy(evictionIndex[strategy])
          .limit(remaining)
          .primaryKeys();
        if (priorityVictims.length > 0) {
          await table.bulkDelete(priorityVictims);
        }
      }

      const evicted = nonPriorityVictims.length + priorityVictims.length;
      if (evicted > 0) {
        logger.info(`Evicted ${evicted} events to respect storageMaxSize ${maxSize}`);
      }
      return evicted;
    });
  } catch (error) {
    logger.error(
      `Failed to enforce storage limit: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return 0;
  }
}
