/**
 * キャッシュの保持優先度（退避・TTL スイープからの保護）の判定。
 * 両ストレージ実装で共有するため、Dexie にも SQLite にも依存しない純粋関数。
 */

import { DELETION_EVENT_KIND } from '../event/event-kind.js';

/**
 * pubkey **または** kind のどちらかに一致すれば優先イベント。
 * pubkey は正規化済みの hex であることが前提（npub の復号はオプション解決時に済ませる）。
 */
export interface CachePriority {
  /** 64 桁の小文字 hex */
  pubkeys?: string[];
  kinds?: number[];
}

/**
 * 利用者の設定によらず常に保持する kind。NIP-09 の削除リクエスト（kind 5）だけが対象で、
 * 捨てると上流から削除済みイベントが再び届いたときに削除を再適用できなくなる。
 *
 * TTL に対しては絶対、`storageMaxSize` に対しては best-effort（他に退避できるものが
 * 無ければ `maxSize` が優先）。
 */
const ALWAYS_RETAINED_KINDS: ReadonlySet<number> = new Set([DELETION_EVENT_KIND]);

/**
 * Whether the given config contains at least one user-configured priority rule.
 *
 * Note this says nothing about {@link ALWAYS_RETAINED_KINDS}: retention rules
 * always apply, so callers must not use this to skip filtering entirely.
 */
export function hasPriorityRules(priority?: CachePriority): priority is CachePriority {
  return Boolean(
    priority && ((priority.pubkeys?.length ?? 0) > 0 || (priority.kinds?.length ?? 0) > 0)
  );
}

/** Whether a kind is retained regardless of the configured priority rules. */
export function isAlwaysRetainedKind(kind: number): boolean {
  return ALWAYS_RETAINED_KINDS.has(kind);
}

/** 行ごとの述語ではなくクエリ条件で保持を表すストレージ向け。 */
export function getAlwaysRetainedKinds(): number[] {
  return Array.from(ALWAYS_RETAINED_KINDS);
}

/** 参照集合を先に作るので、返す関数は 1 行あたり安い。 */
export function createPriorityMatcher(
  priority?: CachePriority
): (row: { pubkey: string; kind: number }) => boolean {
  const pubkeys = new Set(priority?.pubkeys ?? []);
  const kinds = new Set(priority?.kinds ?? []);
  return (row) => isAlwaysRetainedKind(row.kind) || pubkeys.has(row.pubkey) || kinds.has(row.kind);
}
