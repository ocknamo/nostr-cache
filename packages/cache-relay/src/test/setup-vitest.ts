/**
 * Vitest setup file for cache-relay package
 * Configures test environment settings
 */

import { logger } from '@nostr-cache/shared';

// テスト環境ではログ抑制を自動的に設定
beforeAll(() => {
  logger.setTestEnvironment(true);
});
