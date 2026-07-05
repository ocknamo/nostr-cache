import { logger } from '@nostr-cache/shared';
import type { Dexie } from 'dexie';
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
 *
 * @param db The Dexie database (used to open the eviction transaction)
 * @param table The Dexie events table
 * @param maxSize Maximum number of events to keep (no-op when <= 0)
 * @param strategy Eviction strategy (default `FIFO`)
 * @returns Promise resolving to the number of events evicted
 */
export async function enforceLimit(
  db: Dexie,
  table: Dexie.Table<NostrEventTable, string>,
  maxSize: number,
  strategy: CacheStrategy = 'FIFO'
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
      const idsToEvict = await table.orderBy(evictionIndex[strategy]).limit(excess).primaryKeys();

      if (idsToEvict.length > 0) {
        await table.bulkDelete(idsToEvict);
        logger.info(`Evicted ${idsToEvict.length} events to respect storageMaxSize ${maxSize}`);
      }

      return idsToEvict.length;
    });
  } catch (error) {
    logger.error(
      `Failed to enforce storage limit: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return 0;
  }
}
