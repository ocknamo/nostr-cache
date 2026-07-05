import type { NostrEvent } from '@nostr-cache/shared';

/**
 * NostrEvent table schema (Dexie row shape).
 *
 * Extends the public {@link NostrEvent} fields with cache bookkeeping columns
 * used for indexing, eviction, TTL and lazy validation.
 */
export interface NostrEventTable {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  indexed_tags: string[]; // インデックス化されたタグ
  content: string;
  sig: string;
  last_accessed_at: number; // 最終アクセス時刻（ミリ秒）。LRU 退避に使用
  access_count: number; // 読み出し回数。LFU 退避に使用
  cached_at: number; // キャッシュ投入（保存）時刻（ミリ秒）。保存時刻ベース TTL に使用
  validated: number; // 署名検証済みなら 1、未検証なら 0（boolean はインデックス不可のため数値）
}

/**
 * Dexie schema (v1) for the `events` table.
 *
 * last_accessed_at / [access_count+last_accessed_at] は LRU / LFU 退避用の
 * アクセスメタデータインデックス、cached_at は保存時刻ベース TTL 用の
 * スイープインデックス。[validated+cached_at] は遅延検証の永続キュー用で、
 * 「validated=0 を cached_at 昇順（古い順）」で効率よくスキャンできる。
 * id → 検証状態の参照は主キー（bulkGet）で行うため専用インデックスは不要。
 * （いずれも未リリースのため v1 に直接定義）
 */
export const EVENTS_SCHEMA_V1 = `
  id,
  pubkey,
  created_at,
  kind,
  *indexed_tags,
  [pubkey+kind],
  [kind+created_at],
  [pubkey+created_at],
  [pubkey+kind+created_at],
  last_accessed_at,
  [access_count+last_accessed_at],
  cached_at,
  [validated+cached_at]
`;

/**
 * Project a stored row onto the public {@link NostrEvent} shape, dropping the
 * cache bookkeeping columns (indexed_tags / last_accessed_at / access_count /
 * cached_at / validated).
 *
 * @param row Stored table row
 * @returns The event as exposed to callers
 */
export function rowToEvent(row: NostrEventTable): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: row.tags,
    content: row.content,
    sig: row.sig,
  };
}
