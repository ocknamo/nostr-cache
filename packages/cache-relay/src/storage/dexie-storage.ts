import { logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { Dexie } from 'dexie';
import { enforceLimit } from './dexie/eviction.js';
import { buildOptimizedQuery, eventRowMatchesFilter } from './dexie/query-builder.js';
import { EVENTS_SCHEMA_V1, type NostrEventTable, rowToEvent } from './dexie/schema.js';
import { getIndexedTags } from './dexie/tag-index.js';
import type {
  CacheStrategy,
  SaveEventOptions,
  StorageAdapter,
  ValidationStatus,
} from './storage-adapter.js';

/**
 * DexieStorage class implements StorageAdapter using Dexie.js
 *
 * Acts as a thin facade over the Dexie database: the schema, tag indexing,
 * query building and eviction logic live in `./dexie/*`, while this class owns
 * the table handle, transactions and the validation-status bookkeeping.
 */
export class DexieStorage extends Dexie implements StorageAdapter {
  private events!: Dexie.Table<NostrEventTable, string>;

  constructor(dbName = 'NostrCacheRelay') {
    super(dbName);

    this.version(1).stores({
      events: EVENTS_SCHEMA_V1,
    });
  }

  async saveEvent(event: NostrEvent, options?: SaveEventOptions): Promise<boolean> {
    try {
      const now = Date.now();
      // 既存行の取得と put を単一の rw トランザクションで行い、検証状態の
      // 1 → 0 ダウングレードを防ぐ。同じ id は同じ内容ハッシュなので、一度
      // 検証済みになったイベントは再保存（上流エコー・再 ingest 等）でも
      // 検証済みのままにする
      await this.transaction('rw', this.events, async () => {
        const existing = await this.events.get(event.id);
        await this.events.put({
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags,
          indexed_tags: getIndexedTags(event.tags),
          content: event.content,
          sig: event.sig,
          // 挿入も1回のアクセスとみなす（access_count: 1）。これにより LFU で
          // 挿入直後のイベントが「未読イベントより不利」にならない（既読 >=2 の
          // イベントよりは退避されやすい、標準的な LFU の挙動は残る）。
          // 置換可能イベント等の再 put ではメタデータがリセットされ、頻度履歴を
          // 失い、cached_at も更新される（TTL が保存し直しから数え直しになる）
          last_accessed_at: now,
          access_count: 1,
          cached_at: now,
          validated: options?.validated || existing?.validated === 1 ? 1 : 0,
        });
      });
      return true;
    } catch (error) {
      logger.error(
        `Failed to save event: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return false;
    }
  }

  /**
   * Get stored events that have not been validated yet, oldest first.
   *
   * Uses the `[validated+cached_at]` compound index: equality on the
   * `validated=0` prefix yields results already ordered by `cached_at`
   * ascending, so the persistent lazy-validation queue is drained FIFO
   * without an explicit sort. Does NOT track access (background work must
   * not perturb LRU/LFU eviction).
   *
   * @param limit Maximum number of events to return
   * @returns Promise resolving to the unvalidated events, oldest first
   */
  async getUnvalidatedEvents(limit: number): Promise<NostrEvent[]> {
    if (!(limit > 0)) {
      return [];
    }
    try {
      const rows = await this.events
        .where('[validated+cached_at]')
        .between([0, Dexie.minKey], [0, Dexie.maxKey])
        .limit(limit)
        .toArray();
      return rows.map(rowToEvent);
    } catch (error) {
      logger.error(
        `Failed to get unvalidated events: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return [];
    }
  }

  /**
   * Mark the given events as validated. IDs no longer stored (deleted or
   * evicted meanwhile) are silently ignored.
   *
   * @param ids IDs of the events to mark as validated
   */
  async markValidated(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    try {
      await this.events
        .where('id')
        .anyOf(ids)
        .modify((event) => {
          event.validated = 1;
        });
    } catch (error) {
      logger.error(
        `Failed to mark events validated: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Get the persisted validation status for the given event ids.
   *
   * Primary-key `bulkGet` — the fastest lookup path; no extra index is
   * needed for id → status queries. Does NOT track access, since clients
   * may poll this frequently (e.g. verification badges in a UI).
   *
   * @param ids Event IDs to look up
   * @returns Promise resolving to a map with one entry per requested id
   */
  async getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>> {
    const statuses = new Map<string, ValidationStatus>();
    if (ids.length === 0) {
      return statuses;
    }
    try {
      const rows = await this.events.bulkGet(ids);
      ids.forEach((id, index) => {
        const row = rows[index];
        if (row === undefined) {
          // 未保存（不正で削除済み・退避済みを含む）
          statuses.set(id, 'unknown');
        } else {
          statuses.set(id, row.validated === 1 ? 'validated' : 'pending');
        }
      });
    } catch (error) {
      logger.error(
        `Failed to get validation status: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      for (const id of ids) {
        statuses.set(id, 'unknown');
      }
    }
    return statuses;
  }

  /**
   * Get events matching the given filters
   *
   * @param filters Array of filters to match events against
   * @returns Promise resolving to array of matching events
   */
  async getEvents(filters: Filter[]): Promise<NostrEvent[]> {
    try {
      // Process each filter independently and combine results
      const eventSets = await Promise.all(
        filters.map(async (filter) => {
          let collection = buildOptimizedQuery(this.events, filter);

          // Apply final filter validation
          collection = collection.filter((event) => eventRowMatchesFilter(event, filter));

          // Apply limit before converting to array
          if (filter.limit !== undefined) {
            collection = collection.limit(filter.limit);
          }

          return await collection.toArray();
        })
      );

      // Convert NostrEventTable to NostrEvent and deduplicate results
      const results = Array.from(
        new Map(eventSets.flat().map((event) => [event.id, rowToEvent(event)])).values()
      );

      // LRU / LFU 退避のためのアクセス追跡（失敗しても読み出し結果には影響させない）。
      // トレードオフ: 読み出しごとにヒット分の一括書き込みが1回入り、その分
      // レイテンシが増える。テストの決定性と実装の単純さを優先して await している
      await this.trackAccess(results.map((event) => event.id));

      return results;
    } catch (error) {
      logger.error(
        `Failed to get events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Record a read access for the given event ids, updating the metadata
   * backing the `LRU` / `LFU` eviction strategies (`last_accessed_at` /
   * `access_count`) in a single bulk write.
   *
   * Tracking failures are logged and swallowed so they never affect the read
   * path that triggered them.
   *
   * @param ids IDs of the events that were read
   */
  private async trackAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    try {
      const now = Date.now();
      await this.events
        .where('id')
        .anyOf(ids)
        .modify((event) => {
          event.last_accessed_at = now;
          event.access_count = (event.access_count ?? 0) + 1;
        });
    } catch (error) {
      logger.error(
        `Failed to track event access: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete an event from storage
   *
   * @param id ID of the event to delete
   * @returns Promise resolving to true if successful
   */
  async deleteEvent(id: string): Promise<boolean> {
    try {
      const count = await this.events.where('id').equals(id).delete();
      return count > 0;
    } catch (error) {
      logger.error(
        `Failed to delete event: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return false;
    }
  }

  /**
   * Clear all events from storage
   */
  async clear(): Promise<void> {
    try {
      await this.events.clear();
    } catch (error) {
      logger.error(
        `Failed to clear events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete all events cached (saved to storage) strictly before `olderThan`.
   *
   * Expiry is keyed on `cached_at` — the time the event was written into this
   * cache — not on the event's own `created_at`, so an old event fetched
   * recently still gets a full TTL. Uses the `cached_at` index for an
   * efficient bulk range delete, backing the TTL background sweep.
   *
   * @param olderThan Unix timestamp (seconds); events cached strictly before
   *   this moment are deleted
   * @returns Promise resolving to the number of events deleted (0 on error)
   */
  async deleteExpired(olderThan: number): Promise<number> {
    try {
      // cached_at はミリ秒で保持しているため秒指定の閾値を変換して比較する
      return await this.events
        .where('cached_at')
        .below(olderThan * 1000)
        .delete();
    } catch (error) {
      logger.error(
        `Failed to delete expired events: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return 0;
    }
  }

  /**
   * Count the number of stored events
   *
   * @returns Promise resolving to the number of stored events (0 on error)
   */
  async count(): Promise<number> {
    try {
      return await this.events.count();
    } catch (error) {
      logger.error(
        `Failed to count events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return 0;
    }
  }

  /**
   * Evict events so that no more than `maxSize` remain, per the given
   * strategy. Delegates to the eviction module; see
   * {@link enforceLimit} for the ordering and soft-limit semantics.
   *
   * @param maxSize Maximum number of events to keep (no-op when <= 0)
   * @param strategy Eviction strategy (default `FIFO`)
   * @returns Promise resolving to the number of events evicted
   */
  async enforceLimit(maxSize: number, strategy: CacheStrategy = 'FIFO'): Promise<number> {
    return enforceLimit(this, this.events, maxSize, strategy);
  }

  /**
   * Delete events with the same pubkey and kind
   * Used for handling replaceable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @returns Promise resolving to true if successful, false otherwise
   */
  async deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean> {
    try {
      // 複合インデックスを使用してイベントを削除
      const count = await this.events.where('[pubkey+kind]').equals([pubkey, kind]).delete();
      return count > 0;
    } catch (error) {
      logger.error(
        `Failed to delete events by pubkey and kind: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return false;
    }
  }

  /**
   * Delete events with the same pubkey, kind, and d tag value
   * Used for handling addressable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @param dTagValue Value of the d tag
   * @returns Promise resolving to true if successful, false otherwise
   */
  async deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean> {
    try {
      // pubkeyとkindで一致するイベントをフィルタリング
      const events = await this.events.where('[pubkey+kind]').equals([pubkey, kind]).toArray();

      // dタグが一致するイベントのIDを収集
      const idsToDelete = events
        .filter((event) => {
          const dTag = event.tags.find((tag) => tag[0] === 'd');
          return dTag && dTag[1] === dTagValue;
        })
        .map((event) => event.id);

      if (idsToDelete.length === 0) {
        return false;
      }

      // 収集したIDでイベントを削除
      await this.events.bulkDelete(idsToDelete);
      return true;
    } catch (error) {
      logger.error(
        `Failed to delete events by pubkey, kind, and d tag: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return false;
    }
  }
}
