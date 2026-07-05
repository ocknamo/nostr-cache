/**
 * Vitest setup file for server package
 * Configures test environment settings
 */

import { logger } from '@nostr-cache/shared';
import 'fake-indexeddb/auto';

// テスト環境ではログ抑制を自動的に設定
beforeAll(() => {
  logger.setTestEnvironment(true);
});

// 各テスト後に IndexedDB をリセット。
// fake-indexeddb v6 では旧 `FDBFactory.reset()` が廃止されたため、
// グローバルの indexedDB を新しい IDBFactory インスタンスに差し替えて全 DB を破棄する。
afterEach(() => {
  globalThis.indexedDB = new globalThis.IDBFactory();
});
