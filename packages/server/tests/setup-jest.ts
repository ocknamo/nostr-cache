/**
 * Jest setup file for server package
 * Configures test environment settings
 */

import { logger } from '@nostr-cache/shared';
import 'fake-indexeddb/auto';

// テスト環境ではログ抑制を自動的に設定
beforeAll(() => {
  logger.setTestEnvironment(true);
});

// 各テスト後にIndexedDBをリセット
afterEach(() => {
  try {
    const resetMethod = require('fake-indexeddb/lib/FDBFactory').reset;
    if (typeof resetMethod === 'function') {
      resetMethod();
    }
  } catch (error) {
    console.warn('Failed to reset IndexedDB:', error);
  }
});
