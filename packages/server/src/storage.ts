/**
 * Server storage adapter factory.
 *
 * ⚠️ 注意: 現状のサーバーストレージは `fake-indexeddb`（インメモリの IndexedDB
 * ポリフィル）で動作しており、永続化されない。プロセス終了で全キャッシュが失われる。
 * 実永続化（例: SQLite バックエンド）はオプトインの別作業（リファクタリング方針の
 * Phase 7）であり、この関数がその差し替え口（seam）となる。
 *
 * WARNING: server storage is currently backed by `fake-indexeddb`, an in-memory
 * IndexedDB polyfill. It is NOT persistent — all cached events are lost when the
 * process exits. Real persistence is a separate, opt-in change (see the
 * refactoring plan, Phase 7); this function is the single seam where a durable
 * adapter would be swapped in.
 */

import { DexieStorage, type StorageAdapter } from '@nostr-cache/cache-relay';

// 注意: このモジュールは indexedDB の polyfill を **自前で import しない**。
// Dexie はモジュール評価時に global の indexedDB をキャプチャするため、polyfill は
// cache-relay(dexie) の評価より前 —— すなわちプロセスのエントリ（src/index.ts の
// 先頭）やテストの setup（e2e/server の setup-vitest）—— で `fake-indexeddb/auto`
// として一度だけ導入される必要がある。ここで import しても評価順の都合で手遅れになる。

/**
 * Create the server's storage adapter.
 *
 * @param dbName IndexedDB database name
 * @returns A storage adapter for the relay
 */
export function createStorage(dbName: string): StorageAdapter {
  return new DexieStorage(dbName);
}
