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
} from '@nostr-cache/shared';
import { EventValidator } from '../event/event-validator.js';
import { LazyValidator } from '../event/lazy-validator.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { MessageHandler } from './message-handler.js';
import { SubscriptionManager } from './subscription-manager.js';

/**
 * Client ID used for subscriptions created through the in-process API
 * (`subscribe()` / `unsubscribe()`), as opposed to subscriptions created
 * by remote clients over the transport layer.
 */
const LOCAL_CLIENT_ID = 'local';

/**
 * Nostr Cache Relay options
 * flat option
 *
 * 注意: 一部のオプションは現在実装中のため、完全にはサポートされていません。
 * 将来のバージョンで全機能が利用可能になる予定です。
 */
export interface NostrRelayOptions {
  /**
   * Maximum number of subscriptions per client
   * デフォルト値20
   */
  maxSubscriptions?: number;

  /**
   * Maximum number of events to return per request
   * 未実装
   */
  maxEventsPerRequest?: number;

  /**
   * Maximum number of events to store
   * 未実装
   */
  storageMaxSize?: number;

  /**
   * Time-to-live in seconds
   * 未実装
   */
  ttl?: number;

  /**
   * Cache eviction strategy
   * 未実装
   */
  cacheStrategy?: 'LRU' | 'FIFO' | 'LFU';

  /**
   * Whether to validate events
   */
  validateEventsType?: 'NONE' | 'IMMEDIATELY' | 'LAZY';

  /**
   * Interval in seconds between background validation passes when
   * `validateEventsType` is `'LAZY'`. Defaults to 60.
   */
  lazyValidateInterval?: number;

  /**
   * Number of events validated per background pass when `validateEventsType`
   * is `'LAZY'`. Defaults to 100.
   *
   * @deprecated Misspelled. Use {@link lazyValidateBatchSize} instead; this
   *   alias is kept for backward compatibility and will be removed.
   */
  lazyValidateBachSize?: number;

  /**
   * Number of events validated per background pass when `validateEventsType`
   * is `'LAZY'`. Defaults to 100. Supersedes the misspelled
   * {@link lazyValidateBachSize}.
   */
  lazyValidateBatchSize?: number;

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
  private subscriptionManager: SubscriptionManager;
  /** Background validator, present only when `validateEventsType` is `'LAZY'`. */
  private lazyValidator?: LazyValidator;
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
      validateEventsType: 'IMMEDIATELY',
      maxSubscriptions: 20,
      maxEventsPerRequest: 500,
      ...options,
    };

    this.storage = storage;
    this.transport = transport;
    this.validator = new EventValidator();

    // 遅延バリデーション有効時はバックグラウンド検証器を用意
    if (this.options.validateEventsType === 'LAZY') {
      this.lazyValidator = new LazyValidator(storage, {
        intervalSeconds: this.options.lazyValidateInterval,
        // 正式名を優先し、タイポの旧名はフォールバックとして許容
        batchSize: this.options.lazyValidateBatchSize ?? this.options.lazyValidateBachSize,
      });
    }

    // 初期化
    this.subscriptionManager = new SubscriptionManager();
    this.messageHandler = new MessageHandler(
      storage,
      this.subscriptionManager,
      this.options.maxSubscriptions
    );

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
    // 遅延バリデーションの定期実行を開始
    this.lazyValidator?.start();
    this.emit('connect');
  }

  /**
   * Disconnect from the relay
   *
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    await this.transport.stop();
    // 遅延バリデーションの定期実行を停止
    this.lazyValidator?.stop();
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
    if (
      this.options.validateEventsType === 'IMMEDIATELY' &&
      !(await this.validator.validate(event))
    ) {
      return false;
    }

    // Save the event to storage
    const saved = await this.storage.saveEvent(event);

    if (saved) {
      // 'LAZY' モードでは保存後にバックグラウンド検証へ回す。
      // 不正なイベントは後続の検証パスでストレージから削除される
      this.lazyValidator?.enqueue(event);

      // Notify local subscribers whose filters match the published event
      const matches = this.subscriptionManager.findMatchingSubscriptions(event);
      if (matches.has(LOCAL_CLIENT_ID)) {
        this.emit('event', event);
      }
    }

    return saved;
  }

  /**
   * Subscribe to events matching the given filters
   *
   * Creates an in-process subscription, replays the matching stored events
   * through the `event` listeners, and finishes with an `eose` event. Any
   * events published afterwards that match the filters are delivered to the
   * `event` listeners via {@link publishEvent}.
   *
   * @param subscriptionId Subscription ID
   * @param filters Filters to match events against
   * @returns Promise resolving when the stored events have been replayed
   */
  async subscribe(subscriptionId: string, filters: Filter[]): Promise<void> {
    // Register the subscription so future events can be matched against it
    this.subscriptionManager.createSubscription(LOCAL_CLIENT_ID, subscriptionId, filters);

    logger.info(`Created subscription ${subscriptionId} with filters:`, filters);

    // Replay the matching stored events to the listeners
    try {
      const events = await this.storage.getEvents(filters);
      for (const event of events) {
        this.emit('event', event);
      }
    } catch (error) {
      logger.error(`Failed to load stored events for subscription ${subscriptionId}:`, error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }

    // Signal the end of stored events
    this.emit('eose', subscriptionId);
  }

  /**
   * Unsubscribe from a subscription
   *
   * @param subscriptionId Subscription ID to unsubscribe from
   * @returns True if the subscription existed and was removed, false otherwise
   */
  unsubscribe(subscriptionId: string): boolean {
    const removed = this.subscriptionManager.removeSubscription(LOCAL_CLIENT_ID, subscriptionId);

    if (removed) {
      logger.info(`Removed subscription ${subscriptionId}`);
    } else {
      logger.debug(`Subscription ${subscriptionId} not found`);
    }

    return removed;
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
   * Emit an event to the registered listeners
   *
   * @param event Event type to emit
   * @param payload Data to pass to the listeners (an Error for `error`, a
   *   NostrEvent for `event`, the subscription ID for `eose`)
   * @private
   */
  private emit(event: 'connect' | 'disconnect'): void;
  private emit(event: 'error', payload: Error): void;
  private emit(event: 'event', payload: NostrEvent): void;
  private emit(event: 'eose', payload: string): void;
  private emit(event: string, payload?: Error | NostrEvent | string): void {
    const listeners = this.eventListeners.get(event);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      switch (event) {
        case 'connect':
        case 'disconnect':
          (listener as RelayConnectHandler | RelayDisconnectHandler)();
          break;
        case 'error':
          (listener as RelayErrorHandler)(payload as Error);
          break;
        case 'event':
          (listener as RelayEventHandler)(payload as NostrEvent);
          break;
        case 'eose':
          (listener as RelayEoseHandler)(payload as string);
          break;
      }
    }
  }
}
