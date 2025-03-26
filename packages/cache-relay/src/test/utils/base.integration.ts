/**
 * Base setup for integration tests
 */

import { NostrEvent } from '@nostr-cache/types';
import 'fake-indexeddb/auto';
import { seckeySigner } from 'rx-nostr-crypto';
import { MessageHandler } from '../../core/MessageHandler';
import { SubscriptionManager } from '../../core/SubscriptionManager';
import { DexieStorage } from '../../storage/DexieStorage';
import { WebSocketServer } from '../../transport/WebSocketServer';
import { getRandomSecret } from './getRandomSecret';

/**
 * Create a test event
 * @param overrides Properties to override
 * @returns NostrEvent object
 */
export async function createTestEvent(
  seckey?: string,
  overrides: Partial<NostrEvent> = {}
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
    this.subscriptionManager = new SubscriptionManager(this.storage);
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
    indexedDB = new IDBFactory();
  }
}
