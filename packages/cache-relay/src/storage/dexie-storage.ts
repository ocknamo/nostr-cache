import { logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { Dexie } from 'dexie';
import { isDeletableAddress, matchesAddressIdentifier } from '../event/deletion.js';
import { DELETION_EVENT_KIND } from '../event/event-kind.js';
import { selectCurrentVersion } from '../event/replaceable.js';
import { capEvents, normalizeLimit } from '../utils/filter-utils.js';
import { enforceLimit } from './dexie/eviction.js';
import { eventRowMatchesFilter, planQuery, rejectsEveryRow } from './dexie/query-builder.js';
import { EVENTS_SCHEMA_V1, type NostrEventTable, rowToEvent } from './dexie/schema.js';
import { getIndexedTags } from './dexie/tag-index.js';
import { type CachePriority, createPriorityMatcher } from './priority.js';
import type {
  CacheStrategy,
  EventAddress,
  SaveEventOptions,
  StorageAdapter,
  ValidationStatus,
} from './storage-adapter.js';

/**
 * Read the newest `limit` matching rows from a descending collection, plus
 * everything tied with the last of them.
 *
 * The ties are why this is not `collection.filter(…).limit(limit)`: a descending
 * walk puts equal timestamps in *descending primary key* order, while NIP-01
 * breaks such a tie by the **lowest** id, so stopping at exactly `limit` rows can
 * drop the row that should have been kept.
 *
 * Exported for its own test — the chain order below only costs speed when it is
 * wrong, which no assertion about the returned rows can see.
 *
 * @param collection Must come from a {@link planQuery} plan whose `ordered` is set
 * @param matches The filter's row predicate
 */
export async function readNewest(
  collection: Dexie.Collection<NostrEventTable, string>,
  matches: (row: NostrEventTable) => boolean,
  limit: number
): Promise<NostrEventTable[]> {
  const rows: NostrEventTable[] = [];
  /** `created_at` of the `limit`-th match; rows older than it are surplus. */
  let boundary: number | undefined;

  await collection
    // `filter` より先に積む。Dexie の鎖は短絡評価なので、逆順だと一致しない行で
    // 打ち切り判定が評価されず、次の一致行まで走査が伸びる
    .until((row) => boundary !== undefined && row.created_at < boundary)
    .filter(matches)
    .each((row) => {
      rows.push(row);
      if (rows.length === limit) {
        boundary = row.created_at;
      }
    });

  return rows;
}

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
   * Unlike the filter queries this `between()` intentionally keeps Dexie's
   * default exclusive upper bound: the bound is `Dexie.maxKey`, which sorts
   * above every real key, so nothing can be excluded by it.
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
   * Get the stored version of the replaceable / addressable event at `address`.
   *
   * The `[pubkey+kind]` index gives the coordinate's rows directly (normally at
   * most one, since writes replace); the `d` identifier is then matched with
   * cache-relay's shared predicate, and `selectCurrentVersion` applies NIP-01's
   * ordering to whatever is left. Does NOT track access: this backs a write-path
   * precondition, not a read on a client's behalf.
   *
   * Deliberately has no try/catch — see {@link StorageAdapter.getCurrentVersion}:
   * a swallowed error would read as "no version stored" and let an older event
   * overwrite a newer one.
   */
  async getCurrentVersion(address: EventAddress): Promise<NostrEvent | undefined> {
    const rows = await this.events
      .where('[pubkey+kind]')
      .equals([address.pubkey, address.kind])
      .toArray();
    return selectCurrentVersion(
      rows.filter((row) => matchesAddressIdentifier(row.tags, address)).map(rowToEvent)
    );
  }

  /**
   * Get the cache insertion time (ms) of the given event ids.
   *
   * Primary-key `bulkGet`, like {@link getValidationStatus}, and likewise does
   * NOT track access: a freshness check must not disturb LRU/LFU ordering.
   * Ids that are not stored are omitted from the map.
   */
  async getCachedAt(ids: string[]): Promise<Map<string, number>> {
    const cachedAt = new Map<string, number>();
    if (ids.length === 0) {
      return cachedAt;
    }
    try {
      const rows = await this.events.bulkGet(ids);
      ids.forEach((id, index) => {
        const row = rows[index];
        if (row !== undefined) {
          cachedAt.set(id, row.cached_at);
        }
      });
    } catch (error) {
      logger.error(
        `Failed to get cache insertion times: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      // 部分的な結果を返すと「新鮮」と誤判定しうるため空で返す（= 全件が
      // 期限切れ扱い → 上流へ転送）
      cachedAt.clear();
    }
    return cachedAt;
  }

  /**
   * Re-stamp the cache insertion time of the given ids to now.
   *
   * Only touches `cached_at`, so validation state and the LRU/LFU access
   * metadata are left alone. Restarts the TTL for those events, as a re-save of
   * the same id would.
   */
  async touchCachedAt(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    try {
      const now = Date.now();
      return await this.events
        .where('id')
        .anyOf(ids)
        .modify((event) => {
          event.cached_at = now;
        });
    } catch (error) {
      logger.error(
        `Failed to touch cache insertion times: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return 0;
    }
  }

  async getEvents(filters: Filter[]): Promise<NostrEvent[]> {
    try {
      const eventSets = await Promise.all(
        filters.map(async (filter) => {
          // NIP-01 の `limit` は「一致するうち最新 N 件を新しい順で」。Dexie の
          // `Collection.limit()` はインデックス順の先頭 N 件なので、切り詰めは常に
          // capEvents が行う（SqliteStorage / maxEventsPerRequest と同じ規則）
          if (rejectsEveryRow(filter)) {
            return [];
          }

          const limit = normalizeLimit(filter.limit);
          const plan = planQuery(this.events, filter, limit);
          const matches = (row: NostrEventTable) => eventRowMatchesFilter(row, filter);

          if (plan.ordered && limit !== undefined) {
            // カーソルの間に書き込みが挟まると、1 つのフィルタの答えが別々の
            // スナップショットから組み上がってしまう
            const rows = await this.transaction('r', this.events, async () =>
              (
                await Promise.all(
                  plan.collections.map((collection) => readNewest(collection, matches, limit))
                )
              ).flat()
            );
            return capEvents(rows.map(rowToEvent), limit);
          }

          const collection = plan.collections[0].filter(matches);
          const events = (await collection.toArray()).map(rowToEvent);
          return limit !== undefined ? capEvents(events, limit) : events;
        })
      );

      const results = Array.from(
        new Map(eventSets.flat().map((event) => [event.id, event])).values()
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
   * Priority events (matching `priority`) are exempt and retained even when
   * expired, as are the always-retained kinds (NIP-09 deletion requests).
   *
   * @param olderThan Unix timestamp (seconds); events cached strictly before
   *   this moment are deleted
   */
  async deleteExpired(olderThan: number, priority?: CachePriority): Promise<number> {
    try {
      // cached_at はミリ秒で保持しているため秒指定の閾値を変換して比較する
      const expired = this.events.where('cached_at').below(olderThan * 1000);
      // 常時保持の kind（NIP-09 の削除リクエスト）があるため、priority 設定が
      // 無くても行ごとの判定が要る（範囲一括削除には落とせない）
      const isRetained = createPriorityMatcher(priority);
      return await expired.filter((row) => !isRetained(row)).delete();
    } catch (error) {
      logger.error(
        `Failed to delete expired events: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return 0;
    }
  }

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
   */
  async enforceLimit(
    maxSize: number,
    strategy: CacheStrategy = 'FIFO',
    priority?: CachePriority
  ): Promise<number> {
    return enforceLimit(this, this.events, maxSize, strategy, priority);
  }

  async deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean> {
    try {
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

  async deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean> {
    try {
      const events = await this.events.where('[pubkey+kind]').equals([pubkey, kind]).toArray();

      const idsToDelete = events
        .filter((event) => {
          const dTag = event.tags.find((tag) => tag[0] === 'd');
          return dTag && dTag[1] === dTagValue;
        })
        .map((event) => event.id);

      if (idsToDelete.length === 0) {
        return false;
      }

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

  /**
   * Delete the events with the given ids that belong to `pubkey`
   * (NIP-09 `e` tags).
   *
   * The primary-key lookup is narrowed by a filter rather than trusting the
   * caller, because both restrictions can only be checked against the stored
   * row: another author's event must never be deleted, and a deletion request
   * (kind 5) is never deletable — a kind 5 targeting a kind 5 has no effect.
   */
  async deleteEventsByIdsForPubkey(ids: string[], pubkey: string): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    try {
      return await this.events
        .where('id')
        .anyOf(ids)
        .filter((row) => row.pubkey === pubkey && row.kind !== DELETION_EVENT_KIND)
        .delete();
    } catch (error) {
      logger.error(
        `Failed to delete events by ids: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return 0;
    }
  }

  /**
   * Delete every version of the addressed event with `created_at <= until`
   * (NIP-09 `a` tags).
   *
   * The `[pubkey+kind+created_at]` index gives the range directly; the `d`
   * identifier and the coordinate guard come from cache-relay's shared
   * predicates so Dexie and SQLite read coordinates the same way.
   */
  async deleteEventsByAddress(address: EventAddress, until: number): Promise<number> {
    if (!isDeletableAddress(address, until)) {
      return 0;
    }
    try {
      return await this.events
        .where('[pubkey+kind+created_at]')
        .between(
          [address.pubkey, address.kind, Dexie.minKey],
          [address.pubkey, address.kind, until],
          true,
          true
        )
        .filter((row) => matchesAddressIdentifier(row.tags, address))
        .delete();
    } catch (error) {
      logger.error(
        `Failed to delete events by address: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return 0;
    }
  }
}
