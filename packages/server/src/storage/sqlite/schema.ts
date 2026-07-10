import type { NostrEvent } from '@nostr-cache/shared';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle table definitions for the SQLite storage adapter.
 *
 * cache-relay の Dexie 実装（`dexie/schema.ts` の `NostrEventTable`）と同じ
 * ブックキーピング列（last_accessed_at / access_count / cached_at / validated）を
 * 持つ。`tags` はイベントのタグ配列全体を JSON 文字列で保持し、返却時の情報源
 * （完全ラウンドトリップ）とする。インデックス対象のタグは別テーブル
 * `event_tags`（Dexie の multientry `*indexed_tags` 相当）に平坦化して持つ。
 *
 * 注意: DDL は下記 {@link SQLITE_SCHEMA} の手書き SQL で発行する（drizzle-kit が
 * node:sqlite に未対応なため、マイグレーション生成は使わない）。テーブル定義と
 * DDL は必ず同期して変更すること。
 */
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  pubkey: text('pubkey').notNull(),
  createdAt: integer('created_at').notNull(), // 秒（イベント自身のフィールド）
  kind: integer('kind').notNull(),
  tags: text('tags').notNull(), // JSON.stringify(event.tags)
  content: text('content').notNull(),
  sig: text('sig').notNull(),
  lastAccessedAt: integer('last_accessed_at').notNull(), // ミリ秒。LRU 退避に使用
  accessCount: integer('access_count').notNull().default(1), // 読み出し回数。LFU 退避に使用
  cachedAt: integer('cached_at').notNull(), // 保存時刻（ミリ秒）。TTL と遅延検証キュー順に使用
  validated: integer('validated').notNull().default(0), // 署名検証済みなら 1、未検証なら 0
});

export const eventTags = sqliteTable(
  'event_tags',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(), // "<単一英字キー>:<値>"（getIndexedTags の出力）
  },
  (table) => [primaryKey({ columns: [table.eventId, table.tag] })]
);

/** Row shape of the `events` table as returned by Drizzle selects. */
export type EventRow = typeof events.$inferSelect;

/**
 * Per-connection pragmas.
 *
 * - `journal_mode = WAL`: 書き込みと読み出しの競合を減らす（`:memory:` では
 *   サポートされないが、指定してもエラーにならず memory モードのまま動く）
 * - `synchronous = NORMAL`: WAL と組み合わせた標準的な耐久性/速度のバランス
 * - `foreign_keys = ON`: `event_tags` の ON DELETE CASCADE に必須（接続ごとに必要）
 * - `busy_timeout = 5000`: 誤って複数プロセスが同一ファイルを開いた場合の事故防御
 */
export const SQLITE_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`;

/**
 * DDL for the events store（上記 Drizzle テーブル定義と 1:1 対応）。
 *
 * インデックスは Dexie スキーマ（EVENTS_SCHEMA_V1）の対応物:
 * pubkey / created_at / kind / (pubkey,kind)＝置換可能・アドレサブル削除用 /
 * last_accessed_at＝LRU / (access_count,last_accessed_at)＝LFU /
 * cached_at＝TTL スイープ / (validated,cached_at)＝遅延検証の永続キュー。
 * `event_tags` は 1 行 1 タグで持ち、(tag, event_id) インデックスで #tag
 * フィルタをインデックス検索にする。複合主キーが Dexie multientry の
 * 行内デデュープに相当。
 */
export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id               TEXT    PRIMARY KEY,
    pubkey           TEXT    NOT NULL,
    created_at       INTEGER NOT NULL,
    kind             INTEGER NOT NULL,
    tags             TEXT    NOT NULL,
    content          TEXT    NOT NULL,
    sig              TEXT    NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    access_count     INTEGER NOT NULL DEFAULT 1,
    cached_at        INTEGER NOT NULL,
    validated        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_pubkey          ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_events_created_at      ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_kind            ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind     ON events(pubkey, kind);
  CREATE INDEX IF NOT EXISTS idx_events_lru             ON events(last_accessed_at);
  CREATE INDEX IF NOT EXISTS idx_events_lfu             ON events(access_count, last_accessed_at);
  CREATE INDEX IF NOT EXISTS idx_events_cached_at       ON events(cached_at);
  CREATE INDEX IF NOT EXISTS idx_events_validated_queue ON events(validated, cached_at);

  CREATE TABLE IF NOT EXISTS event_tags (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (event_id, tag)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON event_tags(tag, event_id);
`;

/**
 * Project a stored row onto the public {@link NostrEvent} shape, dropping the
 * cache bookkeeping columns and parsing the tags JSON back into arrays.
 *
 * @param row Stored table row
 * @returns The event as exposed to callers
 */
export function rowToEvent(row: EventRow): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.createdAt,
    kind: row.kind,
    tags: JSON.parse(row.tags) as string[][],
    content: row.content,
    sig: row.sig,
  };
}
