/**
 * Server storage adapter factory.
 *
 * 既定ではサーバーストレージは `fake-indexeddb`（インメモリの IndexedDB
 * ポリフィル）で動作し、永続化されない（プロセス終了で全キャッシュが失われる）。
 * `dbPath` を指定すると `node:sqlite` ベースの永続ストレージ
 * （{@link SqliteStorage}）にオプトインでき、再起動をまたいでイベントが保持される。
 *
 * By default the server storage is backed by `fake-indexeddb`, an in-memory
 * IndexedDB polyfill — NOT persistent, all cached events are lost when the
 * process exits. Passing `dbPath` opts in to the durable `node:sqlite` backend
 * ({@link SqliteStorage}), which keeps events across restarts.
 */

import { DexieStorage, type StorageAdapter } from '@nostr-cache/cache-relay';
import { SqliteStorage } from './storage/sqlite-storage.js';

// 注意: このモジュールは indexedDB の polyfill を **自前で import しない**。
// Dexie はモジュール評価時に global の indexedDB をキャプチャするため、polyfill は
// cache-relay(dexie) の評価より前 —— すなわちプロセスのエントリ（src/index.ts の
// 先頭）やテストの setup（e2e/server の setup-vitest）—— で `fake-indexeddb/auto`
// として一度だけ導入される必要がある。ここで import しても評価順の都合で手遅れになる。
// （SQLite モードではこの制約は無関係だが、既定モードのために維持している）

/**
 * Options for {@link createStorage}.
 */
export interface CreateStorageOptions {
  /** IndexedDB database name (default mode only) */
  dbName?: string;
  /**
   * SQLite データベースのファイルパス。指定すると `node:sqlite` による
   * 永続ストレージを使用（`dbName` は無視される）。未指定なら従来どおり
   * fake-indexeddb（インメモリ・非永続）
   */
  dbPath?: string;
}

/**
 * Create the server's storage adapter.
 *
 * @param options Storage options (see {@link CreateStorageOptions})
 * @returns A storage adapter for the relay
 */
export function createStorage(options: CreateStorageOptions = {}): StorageAdapter {
  if (options.dbPath) {
    return new SqliteStorage(options.dbPath);
  }
  return new DexieStorage(options.dbName ?? 'NostrRelay');
}
