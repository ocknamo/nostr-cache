/**
 * Base setup for integration tests
 */

import type { NostrEvent } from '@nostr-cache/shared';
import 'fake-indexeddb/auto';
import { seckeySigner } from 'rx-nostr-crypto';
import { MessageHandler } from '../../core/message-handler.js';
import { SubscriptionManager } from '../../core/subscription-manager.js';
import { DexieStorage } from '../../storage/dexie-storage.js';
import { WebSocketServer } from '../../transport/web-socket-server.js';
import { getRandomSecret } from './getRandomSecret.js';

/**
 * Create a test event
 * @param seckey 秘密鍵（オプション）
 * @param overrides イベントのプロパティをオーバーライド
 * @returns NostrEvent object
 */
export async function createTestEvent(
  seckey?: string,
  overrides: Omit<Partial<NostrEvent>, 'id' | 'pubkey' | 'sig'> = {}
): Promise<NostrEvent> {
  const hexSecKey = seckey || getRandomSecret();
  const signer = seckeySigner(hexSecKey);
  const pubkey = await signer.getPublicKey();

  const event = {
    pubkey,
    created_at: 1234567890,
    kind: 1,
    tags: [['p', pubkey]],
    content: 'test content',
    ...overrides,
  };

  return signer.signEvent(event);
}

/**
 * Base class for integration tests
 * Sets up common test dependencies
 */
export class IntegrationTestBase {
  storage: DexieStorage;
  subscriptionManager: SubscriptionManager;
  messageHandler: MessageHandler;
  server: WebSocketServer;
  port = 0;

  /**
   * Create a new instance
   * @param port Optional port number (0 = dynamically assigned)
   */
  constructor(port = 0) {
    this.storage = new DexieStorage('TestNostrCacheRelay');
    this.subscriptionManager = new SubscriptionManager();
    this.messageHandler = new MessageHandler(this.storage, this.subscriptionManager);
    this.server = new WebSocketServer(port);
  }

  /**
   * Setup test environment
   * @returns The port the WebSocket server is listening on
   */
  async setup(): Promise<number> {
    await this.server.start();
    this.port = this.server.getPort();
    this.server.onMessage((clientId, message) => {
      this.messageHandler.handleMessage(clientId, message);
    });

    this.messageHandler.onResponse((clientId, message) => {
      this.server.send(clientId, message);
    });

    return this.port;
  }

  /**
   * Get WebSocket server URL
   * @returns The WebSocket server URL (ws://localhost:port)
   */
  getServerUrl(): string {
    return `ws://localhost:${this.port}`;
  }

  /**
   * Teardown test environment
   */
  async teardown(): Promise<void> {
    await this.server.stop();
    await this.storage.clear();
    await this.storage.delete();
    // Reset indexedDB for next test
    // @ts-ignore - fake-indexeddb types
    // biome-ignore lint/suspicious/noGlobalAssign: for indexedDB mock
    indexedDB = new IDBFactory();
  }
}
