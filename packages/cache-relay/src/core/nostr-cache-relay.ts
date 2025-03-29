/**
 * Nostr Cache Relay
 *
 * Main implementation of the Nostr Cache Relay
 */

import { logger } from '@nostr-cache/shared';
import type {
  Filter,
  NostrEvent,
  NostrWireMessage,
  RelayConnectHandler,
  RelayDisconnectHandler,
  RelayEoseHandler,
  RelayErrorHandler,
  RelayEventHandler,
} from '@nostr-cache/types';
import { EventValidator } from '../event/event-validator.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { MessageHandler } from './message-handler.js';
import { SubscriptionManager } from './subscription-manager.js';

/**
 * Nostr Cache Relay options
 *
 * 注意: 一部のオプションは現在実装中のため、完全にはサポートされていません。
 * 将来のバージョンで全機能が利用可能になる予定です。
 */
export interface NostrRelayOptions {
  /**
   * Storage type to use
   * 'indexeddb' for browser environments, 'memory' for Node.js
   */
  storage?: 'indexeddb' | 'memory';

  /**
   * Storage options
   */
  storageOptions?: {
    /**
     * Database name for IndexedDB
     */
    dbName?: string;

    /**
     * Maximum number of events to store
     */
    maxSize?: number;

    /**
     * Time-to-live in milliseconds
     */
    ttl?: number;
  };

  /**
   * Cache eviction strategy
   */
  cacheStrategy?: 'LRU' | 'FIFO' | 'LFU';

  /**
   * Whether to validate events
   */
  validateEvents?: boolean;

  /**
   * Maximum number of subscriptions per client
   */
  maxSubscriptions?: number;

  /**
   * Maximum number of events to return per request
   */
  maxEventsPerRequest?: number;

  /**
   * Transport type to use
   * 'websocket' for Node.js, 'emulator' for browser
   */
  transport?: 'websocket' | 'emulator';

  /**
   * Port for WebSocket server (Node.js only)
   */
  port?: number;
}

/**
 * Nostr Cache Relay class
 * Implements a Nostr relay with caching functionality
 */
export class NostrCacheRelay {
  private options: NostrRelayOptions;
  private storage: StorageAdapter;
  private transport: TransportAdapter;
  private validator: EventValidator;
  private messageHandler: MessageHandler;
  private eventListeners: Map<
    string,
    Array<
      | RelayConnectHandler
      | RelayDisconnectHandler
      | RelayErrorHandler
      | RelayEventHandler
      | RelayEoseHandler
    >
  > = new Map();

  /**
   * Create a new NostrCacheRelay instance
   *
   * @param storage Storage adapter
   * @param transport Transport adapter
   * @param options Relay configuration options
   */
  constructor(
    storage: StorageAdapter,
    transport: TransportAdapter,
    options: NostrRelayOptions = {}
  ) {
    this.options = {
      validateEvents: true,
      maxSubscriptions: 20,
      maxEventsPerRequest: 500,
      ...options,
    };

    this.storage = storage;
    this.transport = transport;
    this.validator = new EventValidator();

    // 初期化
    const subscriptionManager = new SubscriptionManager(storage);
    this.messageHandler = new MessageHandler(storage, subscriptionManager);

    // メッセージハンドラからの応答をトランスポートに送信するコールバックを設定
    this.messageHandler.onResponse((clientId, message) => {
      this.transport.send(clientId, message);
    });

    this.setupTransportHandlers();
  }

  /**
   * Set up transport event handlers
   *
   * @private
   */
  private setupTransportHandlers(): void {
    this.transport.onConnect((clientId: string) => {
      logger.info(`Client connected: ${clientId}`);
    });

    this.transport.onDisconnect((clientId: string) => {
      logger.info(`Client disconnected: ${clientId}`);
    });

    this.transport.onMessage((clientId: string, message: NostrWireMessage) => {
      this.handleMessage(clientId, message);
    });
  }

  /**
   * Handle incoming message
   *
   * @param clientId ID of the client that sent the message
   * @param message Message received
   * @private
   */
  private handleMessage(clientId: string, wireMessage: NostrWireMessage): void {
    // メッセージハンドラにメッセージを委譲
    this.messageHandler.handleMessage(clientId, wireMessage);
  }

  /**
   * Connect to the relay
   *
   * @returns Promise resolving when connected
   */
  async connect(): Promise<void> {
    await this.transport.start();
    this.emit('connect');
  }

  /**
   * Disconnect from the relay
   *
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    await this.transport.stop();
    this.emit('disconnect');
  }

  /**
   * Publish an event to the relay
   *
   * @param event Event to publish
   * @returns Promise resolving to true if successful, false otherwise
   */
  async publishEvent(event: NostrEvent): Promise<boolean> {
    // Validate the event if enabled
    if (this.options.validateEvents && !(await this.validator.validate(event))) {
      return false;
    }

    // Save the event to storage
    return await this.storage.saveEvent(event);
  }

  /**
   * Subscribe to events matching the given filters
   *
   * @param subscriptionId Subscription ID
   * @param filters Filters to match events against
   */
  subscribe(subscriptionId: string, filters: Filter[]): void {
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Create a subscription
    // 2. Send matching events to the client
    // 3. Send EOSE message

    logger.info(`Created subscription ${subscriptionId} with filters:`, filters);
  }

  /**
   * Unsubscribe from a subscription
   *
   * @param subscriptionId Subscription ID to unsubscribe from
   */
  unsubscribe(subscriptionId: string): void {
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Remove the subscription

    logger.info(`Removed subscription ${subscriptionId}`);
  }

  /**
   * Register an event listener
   *
   * @param event Event type to listen for
   * @param callback Function to call when the event occurs
   */
  on(event: 'connect', callback: RelayConnectHandler): void;
  on(event: 'disconnect', callback: RelayDisconnectHandler): void;
  on(event: 'error', callback: RelayErrorHandler): void;
  on(event: 'event', callback: RelayEventHandler): void;
  on(event: 'eose', callback: RelayEoseHandler): void;
  on(
    event: string,
    callback:
      | RelayConnectHandler
      | RelayDisconnectHandler
      | RelayErrorHandler
      | RelayEventHandler
      | RelayEoseHandler
  ): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }

    this.eventListeners.get(event)?.push(callback);
  }

  /**
   * Remove an event listener
   *
   * @param event Event type to remove listener for
   * @param callback Function to remove
   */
  off(event: 'connect', callback: RelayConnectHandler): void;
  off(event: 'disconnect', callback: RelayDisconnectHandler): void;
  off(event: 'error', callback: RelayErrorHandler): void;
  off(event: 'event', callback: RelayEventHandler): void;
  off(event: 'eose', callback: RelayEoseHandler): void;
  off(
    event: string,
    callback:
      | RelayConnectHandler
      | RelayDisconnectHandler
      | RelayErrorHandler
      | RelayEventHandler
      | RelayEoseHandler
  ): void {
    const listeners = this.eventListeners.get(event);

    if (listeners) {
      const index = listeners.indexOf(callback);

      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Emit an event
   *
   * @param event Event type to emit
   * @param args Arguments to pass to listeners
   * @private
   */
  private emit(event: string): void {
    const listeners = this.eventListeners.get(event);

    if (listeners) {
      for (const listener of listeners) {
        if (event === 'connect' || event === 'disconnect') {
          (listener as RelayConnectHandler | RelayDisconnectHandler)();
        } else if (event === 'error') {
          (listener as RelayErrorHandler)(new Error('Unknown error'));
        } else if (event === 'event') {
          // This is a placeholder, in a real implementation we would pass the actual event
          (listener as RelayEventHandler)({} as NostrEvent);
        } else if (event === 'eose') {
          // This is a placeholder, in a real implementation we would pass the actual subscription ID
          (listener as RelayEoseHandler)('');
        }
      }
    }
  }
}
