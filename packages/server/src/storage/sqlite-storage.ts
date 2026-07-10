import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// 型のみの import は実行時に消えるため node:sqlite はロードされない。
// 実モジュールはコンストラクタ内で process.getBuiltinModule により遅延取得し、
// ExperimentalWarning が「永続化を有効にしたときだけ」表示されるようにする
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
import { buildFilterQuery, hasInvalidTagFilter } from './sqlite/query-builder.js';
import { SQLITE_PRAGMAS, SQLITE_SCHEMA, type SqliteEventRow, rowToEvent } from './sqlite/schema.js';

// 戦略ごとの退避順序（昇順で先頭から退避）。Dexie 実装の evictionIndex に対応し、
// Dexie の主キー暗黙タイブレークは明示の `id ASC` で再現する
const EVICTION_ORDER: Record<CacheStrategy, string> = {
  FIFO: 'created_at ASC, id ASC',
  LRU: 'last_accessed_at ASC, id ASC',
  LFU: 'access_count ASC, last_accessed_at ASC, id ASC',
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
 * SqliteStorage implements StorageAdapter using the built-in `node:sqlite`
 * (`DatabaseSync`) — a durable, on-disk backend for the Node relay server.
 *
 * cache-relay の `DexieStorage` のセマンティクスを忠実にミラーする
 * （検証状態の 1→0 ダウングレード禁止、getEvents のみのアクセス追跡、
 * FIFO/LRU/LFU 退避、cached_at 基準 TTL、タグインデックスの 100 件キャップ等）。
 * スキーマ・クエリ構築はそれぞれ `./sqlite/schema.js` / `./sqlite/query-builder.js`。
 *
 * 同期 API のため各文はイベントループをブロックするが、単一プロセスのリレー +
 * インデックス付きクエリの規模では許容範囲（WAL + synchronous=NORMAL）。
 * 同一 DB ファイルを複数プロセスで開くことはサポートしない。
 */
export class SqliteStorage implements StorageAdapter {
  private db!: nodeSqlite.DatabaseSync;
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
    // ここで初めて node:sqlite がロードされる（ExperimentalWarning もこの時点）
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof nodeSqlite;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SQLITE_PRAGMAS);
    this.db.exec(SQLITE_SCHEMA);
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
    this.db.close();
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
          .prepare('SELECT validated FROM events WHERE id = ?')
          .get(event.id) as Pick<SqliteEventRow, 'validated'> | undefined;
        const validated = options?.validated || existing?.validated === 1 ? 1 : 0;

        if (existing) {
          // 注意: INSERT OR REPLACE は内部的に DELETE + INSERT のため
          // event_tags の ON DELETE CASCADE が発火してしまう。明示的な
          // UPDATE / INSERT の分岐で置き換えの副作用を避ける
          this.db
            .prepare(
              `UPDATE events SET
                 pubkey = ?, created_at = ?, kind = ?, tags = ?, content = ?, sig = ?,
                 last_accessed_at = ?, access_count = 1, cached_at = ?, validated = ?
               WHERE id = ?`
            )
            .run(
              event.pubkey,
              event.created_at,
              event.kind,
              JSON.stringify(event.tags),
              event.content,
              event.sig,
              now,
              now,
              validated,
              event.id
            );
        } else {
          this.db
            .prepare(
              `INSERT INTO events
                 (id, pubkey, created_at, kind, tags, content, sig,
                  last_accessed_at, access_count, cached_at, validated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
            )
            .run(
              event.id,
              event.pubkey,
              event.created_at,
              event.kind,
              JSON.stringify(event.tags),
              event.content,
              event.sig,
              now,
              now,
              validated
            );
        }

        this.db.prepare('DELETE FROM event_tags WHERE event_id = ?').run(event.id);
        const insertTag = this.db.prepare(
          'INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)'
        );
        for (const tag of getIndexedTags(event.tags)) {
          insertTag.run(event.id, tag);
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
        .prepare('SELECT * FROM events WHERE validated = 0 ORDER BY cached_at ASC, id ASC LIMIT ?')
        .all(Math.floor(limit)) as unknown as SqliteEventRow[];
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
          const placeholders = part.map(() => '?').join(', ');
          this.db
            .prepare(`UPDATE events SET validated = 1 WHERE id IN (${placeholders})`)
            .run(...part);
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
        const placeholders = part.map(() => '?').join(', ');
        const rows = this.db
          .prepare(`SELECT id, validated FROM events WHERE id IN (${placeholders})`)
          .all(...part) as unknown as Pick<SqliteEventRow, 'id' | 'validated'>[];
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
    const { sql, params } = buildFilterQuery(filter);
    const rows = this.db.prepare(sql).all(...params) as unknown as SqliteEventRow[];
    // Stage C: 完全なイベントに対する最終判定（Dexie と同じ共通実装）
    let events = rows
      .map(rowToEvent)
      .filter((event) => filterUtils.eventMatchesFilter(event, filter));
    if (filter.limit !== undefined) {
      events = events.slice(0, Math.max(0, filter.limit));
    }
    return events;
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
          const placeholders = part.map(() => '?').join(', ');
          this.db
            .prepare(
              `UPDATE events
               SET last_accessed_at = ?, access_count = access_count + 1
               WHERE id IN (${placeholders})`
            )
            .run(now, ...part);
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
      const { changes } = this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
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
      this.db.exec('DELETE FROM events');
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
        .prepare('DELETE FROM events WHERE cached_at < ?')
        .run(olderThan * 1000);
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
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as
        | { count: number }
        | undefined;
      return row ? Number(row.count) : 0;
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
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as {
          count: number;
        };
        const count = Number(row.count);
        if (count <= maxSize) {
          return 0;
        }
        const { changes } = this.db
          .prepare(
            `DELETE FROM events WHERE id IN (
               SELECT id FROM events ORDER BY ${EVICTION_ORDER[strategy]} LIMIT ?
             )`
          )
          .run(count - maxSize);
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
        .prepare('DELETE FROM events WHERE pubkey = ? AND kind = ?')
        .run(pubkey, kind);
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
        .prepare('SELECT id, tags FROM events WHERE pubkey = ? AND kind = ?')
        .all(pubkey, kind) as unknown as Pick<SqliteEventRow, 'id' | 'tags'>[];

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
          const placeholders = part.map(() => '?').join(', ');
          this.db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...part);
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
   */
  private inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
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
      this.db.exec('ROLLBACK');
    } catch {
      // すでにトランザクションが失効している場合は無視
    }
  }
}
