/**
 * サーバー用ストレージアダプタのファクトリ。
 * 既定は `fake-indexeddb`（インメモリ・非永続）、`dbPath` 指定で {@link SqliteStorage}。
 */

import { DexieStorage, type StorageAdapter } from '@nostr-cache/cache-relay';
import { SqliteStorage } from './storage/sqlite-storage.js';

// indexedDB の polyfill をここで import してはいけない。Dexie はモジュール評価時に
// global の indexedDB をキャプチャするため、polyfill は cache-relay の評価より前
// （プロセスのエントリ、テストの setup）で導入される必要がある。

export interface CreateStorageOptions {
  /** 既定のインメモリモードのみ。 */
  dbName?: string;
  /** 指定すると永続ストレージになる（`dbName` は無視される）。 */
  dbPath?: string;
}

export function createStorage(options: CreateStorageOptions = {}): StorageAdapter {
  if (options.dbPath) {
    return new SqliteStorage(options.dbPath);
  }
  return new DexieStorage(options.dbName ?? 'NostrRelay');
}
