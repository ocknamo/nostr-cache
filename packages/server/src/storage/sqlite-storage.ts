import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
// 型のみの import は実行時に消えるため node:sqlite はロードされない。
// 実モジュールは open() 内で遅延取得し、ExperimentalWarning が
// 「永続化を有効にしたときだけ」表示されるようにする
import type * as nodeSqlite from 'node:sqlite';
import type {
  CacheStrategy,
  SaveEventOptions,
  StorageAdapter,
  ValidationStatus,
} from '@nostr-cache/cache-relay';
import { filterUtils, getIndexedTags } from '@nostr-cache/cache-relay';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { logger } from '@nostr-cache/shared';
// drizzle-orm 本体と sqlite-core は node:sqlite をロードしないため静的 import で安全。
// ドライバ（drizzle-orm/node-sqlite）だけは node:sqlite を即ロードするため、
// open() 内で遅延ロードする（下記 requireModule 参照）
import { type SQL, and, asc, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { buildFilterQuery, hasInvalidTagFilter } from './sqlite/query-builder.js';
import {
  events,
  type EventRow,
  SQLITE_PRAGMAS,
  SQLITE_SCHEMA,
  eventTags,
  rowToEvent,
} from './sqlite/schema.js';

// ESM から drizzle ドライバの CJS ビルドを同期・遅延ロードするための require。
// 静的 import だとモジュール評価時に node:sqlite が読み込まれ、永続化を使わない
// 既定モードでも ExperimentalWarning が出てしまう
const requireModule = createRequire(import.meta.url);

// 戦略ごとの退避順序（昇順で先頭から退避）。Dexie 実装の evictionIndex に対応し、
// Dexie の主キー暗黙タイブレークは明示の `id ASC` で再現する
const EVICTION_ORDER: Record<CacheStrategy, SQL[]> = {
  FIFO: [asc(events.createdAt), asc(events.id)],
  LRU: [asc(events.lastAccessedAt), asc(events.id)],
  LFU: [asc(events.accessCount), asc(events.lastAccessedAt), asc(events.id)],
};

// IN 句 1 回あたりの id 数上限（バインド変数上限への防御）
const ID_CHUNK_SIZE = 500;

/**
 * Split an array into chunks of at most `size` elements.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * SqliteStorage implements StorageAdapter using Drizzle ORM over the built-in
 * `node:sqlite` (`DatabaseSync`) — a durable, on-disk backend for the Node
 * relay server.
 *
 * cache-relay の `DexieStorage` のセマンティクスを忠実にミラーする
 * （検証状態の 1→0 ダウングレード禁止、getEvents のみのアクセス追跡、
 * FIFO/LRU/LFU 退避、cached_at 基準 TTL、タグインデックスの 100 件キャップ等）。
 * テーブル定義・DDL は `./sqlite/schema.js`、フィルタ→条件式の変換は
 * `./sqlite/query-builder.js`。
 *
 * クエリは Drizzle の同期 API（`.run()` / `.all()` / `.get()`）のみを使う。
 * 非同期化するとトランザクション（BEGIN〜COMMIT）の間に並行タスクの文が
 * 割り込み得るため、同期実行はこのアダプタの整合性の前提条件。
 * イベントループはブロックするが、単一プロセスのリレー + インデックス付き
 * クエリの規模では許容範囲（WAL + synchronous=NORMAL）。
 * 同一 DB ファイルを複数プロセスで開くことはサポートしない。
 */
export class SqliteStorage implements StorageAdapter {
  private db!: NodeSQLiteDatabase;
  private client!: nodeSqlite.DatabaseSync;
  private readonly dbPath: string;
  private closed = true;

  /**
   * Open (creating if necessary) the SQLite database at the given path.
   *
   * @param dbPath Database file path (parent directories are created), or
   *   `':memory:'` for an in-memory database (used by tests)
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.open();
  }

  /**
   * (Re)open the database at the path given to the constructor. No-op while
   * already open. `close()` 後に呼ぶと同じパスで再オープンできるため、
   * `NostrRelayServer` の stop() → start() の再利用が既定モードと対称になる
   * （`:memory:` の再オープンは空の DB から始まる）。
   */
  open(): void {
    if (!this.closed) {
      return;
    }
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    // ここで初めて node:sqlite と drizzle ドライバがロードされる
    // （ExperimentalWarning もこの時点）
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof nodeSqlite;
    const { drizzle } = requireModule('drizzle-orm/node-sqlite') as typeof import(
      'drizzle-orm/node-sqlite'
    );
    this.client = new DatabaseSync(this.dbPath);
    this.client.exec(SQLITE_PRAGMAS);
    this.client.exec(SQLITE_SCHEMA);
    this.db = drizzle({ client: this.client });
    this.closed = false;
  }

  /**
   * Close the database, checkpointing WAL and releasing file handles.
   * Safe to call more than once; reopen with {@link open}.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.client.close();
  }

  async saveEvent(event: NostrEvent, options?: SaveEventOptions): Promise<boolean> {
    const now = Date.now();
    // Dexie 実装と同じく、既存行の読み取り → 書き込み → タグ再構築を単一の
    // トランザクションで行う。再保存でメタデータはリセット
    // （access_count=1 / cached_at=now → TTL 数え直し）されるが、validated は
    // 1→0 にダウングレードしない（同じ id は同じ内容なので一度検証済みなら
    // 再保存でも検証済みのまま）
    try {
      this.inTransaction(() => {
        const existing = this.db
          .select({ validated: events.validated })
          .from(events)
          .where(eq(events.id, event.id))
          .get();
        const validated = options?.validated || existing?.validated === 1 ? 1 : 0;

        const row = {
          id: event.id,
          pubkey: event.pubkey,
          createdAt: event.created_at,
          kind: event.kind,
          tags: JSON.stringify(event.tags),
          content: event.content,
          sig: event.sig,
          lastAccessedAt: now,
          accessCount: 1,
          cachedAt: now,
          validated,
        };
        if (existing) {
          this.db.update(events).set(row).where(eq(events.id, event.id)).run();
        } else {
          this.db.insert(events).values(row).run();
        }

        this.db.delete(eventTags).where(eq(eventTags.eventId, event.id)).run();
        const tagRows = getIndexedTags(event.tags).map((tag) => ({ eventId: event.id, tag }));
        if (tagRows.length > 0) {
          // onConflictDoNothing = INSERT OR IGNORE（同一イベント内の重複タグを吸収）
          this.db.insert(eventTags).values(tagRows).onConflictDoNothing().run();
        }
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
   * Get stored events that have not been validated yet, oldest first
   * (`cached_at` ascending — the persistent lazy-validation FIFO queue).
   * Does NOT track access (background work must not perturb LRU/LFU eviction).
   *
   * @param limit Maximum number of events to return
   * @returns Promise resolving to the unvalidated events, oldest first
   */
  async getUnvalidatedEvents(limit: number): Promise<NostrEvent[]> {
    if (!(limit > 0)) {
      return [];
    }
    try {
      const rows = this.db
        .select()
        .from(events)
        .where(eq(events.validated, 0))
        .orderBy(asc(events.cachedAt), asc(events.id))
        .limit(Math.floor(limit))
        .all();
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
      // 複数チャンクでも Dexie の単一 modify と同じく全件原子的に適用する
      this.inTransaction(() => {
        for (const part of chunk(ids, ID_CHUNK_SIZE)) {
          this.db.update(events).set({ validated: 1 }).where(inArray(events.id, part)).run();
        }
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
   * Does NOT track access, since clients may poll this frequently.
   *
   * @param ids Event IDs to look up
   * @returns Promise resolving to a map with one entry per requested id
   */
  async getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>> {
    const statuses = new Map<string, ValidationStatus>();
    if (ids.length === 0) {
      return statuses;
    }
    // 未保存（不正で削除済み・退避済みを含む）は 'unknown'
    for (const id of ids) {
      statuses.set(id, 'unknown');
    }
    try {
      for (const part of chunk(ids, ID_CHUNK_SIZE)) {
        const rows = this.db
          .select({ id: events.id, validated: events.validated })
          .from(events)
          .where(inArray(events.id, part))
          .all();
        for (const row of rows) {
          statuses.set(row.id, row.validated === 1 ? 'validated' : 'pending');
        }
      }
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
   * Get events matching the given filters.
   *
   * 各フィルタを独立に評価して id でデデュープ（Dexie 実装と同一）。
   * SQL は候補を絞るだけで、最終判定は共通の `eventMatchesFilter`。
   *
   * @param filters Array of filters to match events against
   * @returns Promise resolving to array of matching events
   */
  async getEvents(filters: Filter[]): Promise<NostrEvent[]> {
    try {
      const eventSets = filters.map((filter) => this.queryFilter(filter));

      const results = Array.from(
        new Map(eventSets.flat().map((event) => [event.id, event])).values()
      );

      // LRU / LFU 退避のためのアクセス追跡（失敗しても読み出し結果には影響させない）
      this.trackAccess(results.map((event) => event.id));

      return results;
    } catch (error) {
      logger.error(
        `Failed to get events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Evaluate a single filter: SQL narrowing + final JS validation + limit.
   */
  private queryFilter(filter: Filter): NostrEvent[] {
    // Stage A: 不正なタグ条件を持つフィルタは何にもマッチしない
    if (hasInvalidTagFilter(filter)) {
      return [];
    }
    // Stage B: インデックスで候補を絞る
    const { where, complete } = buildFilterQuery(this.db, filter);
    let query = this.db.select().from(events).where(where).$dynamic();
    if (filter.limit !== undefined) {
      // 切り詰めは「新しい順」（NIP-01 の limit セマンティクス / capEvents と同じ、
      // id は決定性のためのタイブレーク）。SQL 段階の LIMIT は絞り込みが最終判定と
      // 完全等価な場合のみ（そうでない場合は JS 判定後に切り詰める）
      query = query.orderBy(desc(events.createdAt), asc(events.id));
      if (complete) {
        query = query.limit(Math.max(0, filter.limit));
      }
    }
    const rows: EventRow[] = query.all();
    // Stage C: 完全なイベントに対する最終判定（Dexie と同じ共通実装）
    let matched = rows
      .map(rowToEvent)
      .filter((event) => filterUtils.eventMatchesFilter(event, filter));
    if (filter.limit !== undefined) {
      matched = matched.slice(0, Math.max(0, filter.limit));
    }
    return matched;
  }

  /**
   * Record a read access for the given event ids (`last_accessed_at` /
   * `access_count`), backing the LRU / LFU eviction strategies. Failures are
   * logged and swallowed so they never affect the read path.
   */
  private trackAccess(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    try {
      const now = Date.now();
      // 複数チャンクでも Dexie の単一 modify と同じく全件原子的に適用する
      this.inTransaction(() => {
        for (const part of chunk(ids, ID_CHUNK_SIZE)) {
          this.db
            .update(events)
            .set({ lastAccessedAt: now, accessCount: sql`${events.accessCount} + 1` })
            .where(inArray(events.id, part))
            .run();
        }
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
   * @returns Promise resolving to true if the event existed and was deleted
   */
  async deleteEvent(id: string): Promise<boolean> {
    try {
      const { changes } = this.db.delete(events).where(eq(events.id, id)).run();
      return Number(changes) > 0;
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
      // event_tags は ON DELETE CASCADE で追随する
      this.db.delete(events).run();
    } catch (error) {
      logger.error(
        `Failed to clear events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete all events cached (saved to storage) strictly before `olderThan`.
   * Expiry is keyed on `cached_at` (storage insertion time), not the event's
   * own `created_at` — same as the Dexie implementation.
   *
   * @param olderThan Unix timestamp (seconds); events cached strictly before
   *   this moment are deleted
   * @returns Promise resolving to the number of events deleted (0 on error)
   */
  async deleteExpired(olderThan: number): Promise<number> {
    try {
      // cached_at はミリ秒で保持しているため秒指定の閾値を変換して比較する
      const { changes } = this.db
        .delete(events)
        .where(lt(events.cachedAt, olderThan * 1000))
        .run();
      return Number(changes);
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
      const row = this.db.select({ value: count() }).from(events).get();
      return row ? Number(row.value) : 0;
    } catch (error) {
      logger.error(
        `Failed to count events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return 0;
    }
  }

  /**
   * Evict events so that no more than `maxSize` remain, per the given
   * strategy (FIFO=`created_at` / LRU=`last_accessed_at` /
   * LFU=`access_count`, ties by least recently read). Count + delete run in
   * a single transaction; soft limit semantics as in the Dexie implementation.
   *
   * @param maxSize Maximum number of events to keep (no-op when <= 0)
   * @param strategy Eviction strategy (default `FIFO`)
   * @returns Promise resolving to the number of events evicted
   */
  async enforceLimit(maxSize: number, strategy: CacheStrategy = 'FIFO'): Promise<number> {
    if (!(maxSize > 0)) {
      return 0;
    }
    try {
      // COUNT と DELETE を単一トランザクションで行い、並行パスの古いカウントに
      // 基づく過剰/過少退避を防ぐ（Dexie 実装と同じ）
      const evicted = this.inTransaction(() => {
        const row = this.db.select({ value: count() }).from(events).get();
        const total = Number(row?.value ?? 0);
        if (total <= maxSize) {
          return 0;
        }
        const victims = this.db
          .select({ id: events.id })
          .from(events)
          .orderBy(...EVICTION_ORDER[strategy])
          .limit(total - maxSize);
        const { changes } = this.db.delete(events).where(inArray(events.id, victims)).run();
        return Number(changes);
      });
      if (evicted > 0) {
        logger.info(`Evicted ${evicted} events to respect storageMaxSize ${maxSize}`);
      }
      return evicted;
    } catch (error) {
      logger.error(
        `Failed to enforce storage limit: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return 0;
    }
  }

  /**
   * Delete events with the same pubkey and kind
   * Used for handling replaceable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @returns Promise resolving to true if any event was deleted
   */
  async deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean> {
    try {
      const { changes } = this.db
        .delete(events)
        .where(and(eq(events.pubkey, pubkey), eq(events.kind, kind)))
        .run();
      return Number(changes) > 0;
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
   * d タグの照合は（event_tags ではなく）完全な tags JSON に対して行う。
   * インデックスの 100 件キャップの影響を受けないための Dexie 実装との
   * セマンティクス互換
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @param dTagValue Value of the d tag
   * @returns Promise resolving to true if any event was deleted
   */
  async deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean> {
    try {
      const rows = this.db
        .select({ id: events.id, tags: events.tags })
        .from(events)
        .where(and(eq(events.pubkey, pubkey), eq(events.kind, kind)))
        .all();

      const idsToDelete = rows
        .filter((row) => {
          const tags = JSON.parse(row.tags) as string[][];
          const dTag = tags.find((tag) => tag[0] === 'd');
          return dTag && dTag[1] === dTagValue;
        })
        .map((row) => row.id);

      if (idsToDelete.length === 0) {
        return false;
      }

      // 複数チャンクでも Dexie の単一 bulkDelete と同じく全件原子的に削除する
      this.inTransaction(() => {
        for (const part of chunk(idsToDelete, ID_CHUNK_SIZE)) {
          this.db.delete(events).where(inArray(events.id, part)).run();
        }
      });
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
   * Run `fn` inside a single write transaction. Commits on success; rolls
   * back and rethrows on failure (callers translate the error into their
   * method's safe fallback value).
   *
   * `fn` は同期でなければならない（await を挟むと並行タスクの文が
   * トランザクションに割り込み得る）。
   */
  private inTransaction<T>(fn: () => T): T {
    this.client.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.client.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /**
   * Roll back the current transaction, ignoring failures (e.g. when the
   * transaction was already aborted by the error being handled).
   */
  private rollback(): void {
    try {
      this.client.exec('ROLLBACK');
    } catch {
      // すでにトランザクションが失効している場合は無視
    }
  }
}
