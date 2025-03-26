/**
 * Base setup for integration tests
 */

import { NostrEvent, NostrWireMessage } from '@nostr-cache/types';
import 'fake-indexeddb/auto';
import { MessageHandler } from '../core/MessageHandler';
import { SubscriptionManager } from '../core/SubscriptionManager';
import { DexieStorage } from '../storage/DexieStorage';
import { WebSocketServer } from '../transport/WebSocketServer';

/**
 * Create a test event
 * @param overrides Properties to override
 * @returns NostrEvent object
 */
export function createTestEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'test-id',
    pubkey: 'test-pubkey',
    created_at: 1234567890,
    kind: 1,
    tags: [['p', 'test-pubkey']],
    content: 'test content',
    sig: 'test-sig',
    ...overrides,
  };
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

  /**
   * Create a new instance
   */
  constructor() {
    this.storage = new DexieStorage('TestNostrCacheRelay');
    this.subscriptionManager = new SubscriptionManager(this.storage);
    this.messageHandler = new MessageHandler(this.storage, this.subscriptionManager);
    this.server = new WebSocketServer();
  }

  /**
   * Setup test environment
   */
  async setup(): Promise<void> {
    await this.server.start();
    this.server.onMessage((clientId, message) => {
      this.messageHandler.handleMessage(clientId, message);
    });

    this.messageHandler.onResponse((clientId, message) => {
      this.server.send(clientId, message);
    });
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
    indexedDB = new IDBFactory();
  }
}
