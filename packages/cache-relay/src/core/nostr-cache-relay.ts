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
import { ExpiryReaper } from '../storage/expiry-reaper.js';
import type { CacheStrategy, StorageAdapter } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { UpstreamCoordinator } from '../upstream/upstream-coordinator.js';
import { UpstreamRelayPool } from '../upstream/upstream-relay-pool.js';
import type { UpstreamPool } from '../upstream/upstream-types.js';
import { capEvents } from '../utils/filter-utils.js';
import { MessageHandler } from './message-handler.js';
import { SubscriptionManager } from './subscription-manager.js';

/**
 * Default relay-imposed cap on the number of stored events returned per REQ
 * subscription / in-process subscribe replay.
 */
const DEFAULT_MAX_EVENTS = 500;

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
   * Maximum number of stored events returned per REQ subscription
   * (relay-imposed cap applied on top of each filter's own `limit`).
   * デフォルト値500
   */
  maxEventsPerRequest?: number;

  /**
   * Maximum number of events to keep in storage. When set, after each saved
   * event the relay asks the storage adapter to evict down to this size
   * (see {@link cacheStrategy}). Disabled when undefined or non-positive.
   *
   * Requires a storage adapter implementing `enforceLimit` (DexieStorage
   * does); otherwise it has no effect.
   */
  storageMaxSize?: number;

  /**
   * Time-to-live in seconds for cached events. Events cached (saved to
   * storage) more than `ttl` seconds ago are deleted by a periodic background
   * sweep (see {@link ttlSweepInterval}) rather than filtered on every read.
   * Expiry counts from when the event entered this cache, not from the
   * event's own `created_at`.
   *
   * Trade-off: an expired event may still be returned for up to one sweep
   * interval before it is purged. Disabled when undefined or non-positive.
   *
   * Requires a storage adapter implementing `deleteExpired` (DexieStorage
   * does). If the adapter does not, the TTL silently has no effect aside from
   * a one-time warning logged on the first sweep.
   */
  ttl?: number;

  /**
   * Interval in seconds between TTL background sweeps when `ttl` is set.
   * Defaults to 60. Smaller values reduce staleness at the cost of more
   * frequent delete passes.
   */
  ttlSweepInterval?: number;

  /**
   * Eviction strategy used when `storageMaxSize` is exceeded: `FIFO` (oldest
   * `created_at` first), `LRU` (least recently read first) or `LFU` (least
   * frequently read first). Defaults to `FIFO`.
   */
  cacheStrategy?: CacheStrategy;

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
   */
  lazyValidateBatchSize?: number;

  /**
   * Port for WebSocket server (Node.js only)
   */
  port?: number;

  /**
   * 上流リレーの URL リスト。指定したときだけリードスルー / ライトスルーが有効になる。
   * 未指定（または空配列）の場合は従来どおり「自分が保存済みのイベントのみ返す独立
   * リレー」として動作する。
   *
   * List of upstream relay URLs. When set (non-empty), the relay becomes a
   * transparent cache: REQ is read-through (forwarded upstream, results
   * backfilled) and EVENT is write-through (forwarded upstream). When unset,
   * behaviour is unchanged (an independent relay).
   */
  upstreamRelays?: string[];

  /**
   * リードスルー時、上流の EOSE を待ってクライアントへ EOSE を返す上限 (ms)。
   * 既定は `DEFAULT_SUBSCRIPTION_TIMEOUT`。上流が全滅していても、この時間で EOSE を返す。
   *
   * Max time (ms) to hold the client's EOSE waiting for the aggregated upstream
   * EOSE. Defaults to `DEFAULT_SUBSCRIPTION_TIMEOUT`.
   */
  upstreamEoseTimeout?: number;

  /**
   * 上流リレーへの接続タイムアウト (ms)。既定は `DEFAULT_CONNECTION_TIMEOUT`。
   *
   * Connect timeout (ms) for each upstream relay. Defaults to
   * `DEFAULT_CONNECTION_TIMEOUT`.
   */
  upstreamConnectionTimeout?: number;

  /**
   * テスト・高度用途向け: 上流プールの実装を差し替える。指定時は `upstreamRelays`
   * より優先され、リード/ライトスルーが有効になる。
   *
   * Test / advanced hook: inject a custom upstream pool. Takes precedence over
   * `upstreamRelays` and enables read/write-through when present.
   */
  upstreamPool?: UpstreamPool;
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
  /** Background TTL sweeper, present only when `ttl` is configured. */
  private expiryReaper?: ExpiryReaper;
  /**
   * Upstream read/write-through orchestrator, present only when upstream relays
   * (or a custom pool) are configured.
   */
  private upstreamCoordinator?: UpstreamCoordinator;
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
      ...options,
      // Guard against an explicit `undefined` clobbering the default
      maxEventsPerRequest: options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS,
    };

    this.storage = storage;
    this.transport = transport;
    this.validator = new EventValidator();

    // 遅延バリデーション有効時はバックグラウンド検証器を用意
    if (this.options.validateEventsType === 'LAZY') {
      this.lazyValidator = new LazyValidator(
        storage,
        {
          intervalSeconds: this.options.lazyValidateInterval,
          batchSize: this.options.lazyValidateBatchSize,
        },
        // relay と検証器インスタンスを共有
        this.validator
      );
    }

    // 初期化
    this.subscriptionManager = new SubscriptionManager();
    this.messageHandler = new MessageHandler(
      storage,
      this.subscriptionManager,
      this.options.maxSubscriptions,
      this.options.maxEventsPerRequest,
      // トランスポート経由 EVENT の検証モードと、LAZY 時の検証キューを委譲
      this.options.validateEventsType ?? 'IMMEDIATELY',
      this.lazyValidator,
      // 保存後のストレージ上限退避（transport 経由 EVENT）
      this.options.storageMaxSize,
      this.options.cacheStrategy
    );

    // TTL 設定時はバックグラウンドの定期パージを用意する。
    // 期限切れイベントは読み出し時ではなく、このスイープで削除する
    if (this.options.ttl !== undefined && this.options.ttl > 0) {
      this.expiryReaper = new ExpiryReaper(storage, {
        ttlSeconds: this.options.ttl,
        intervalSeconds: this.options.ttlSweepInterval,
      });
    }

    // 上流リレーが設定されていればリード/ライトスルーの orchestrator を用意する。
    // 未設定なら coordinator を作らず、従来どおりの独立リレーとして動作する（opt-in）。
    if (this.options.upstreamPool || (this.options.upstreamRelays?.length ?? 0) > 0) {
      const pool =
        this.options.upstreamPool ??
        new UpstreamRelayPool(this.options.upstreamRelays as string[], {
          connectionTimeout: this.options.upstreamConnectionTimeout,
          // WebSocket コンストラクタは接続時に評価する（遅延ファクトリ）。ブラウザで
          // エミュレータがグローバル WebSocket を差し替えても、上流には差し替え前の
          // オリジナルを使うことで自己接続ループを防ぐ。
          webSocketFactory: () => this.transport.getOriginalWebSocket?.() ?? globalThis.WebSocket,
        });
      this.upstreamCoordinator = new UpstreamCoordinator(
        {
          pool,
          ingest: (event) => this.messageHandler.ingestUpstreamEvent(event),
          deliver: (clientId, subscriptionId, event) => {
            if (clientId === LOCAL_CLIENT_ID) {
              this.emit('event', event);
            } else {
              this.messageHandler.sendEvent(clientId, subscriptionId, event);
            }
          },
          sendEose: (clientId, subscriptionId) => {
            if (clientId === LOCAL_CLIENT_ID) {
              this.emit('eose', subscriptionId);
            } else {
              this.messageHandler.sendEOSE(clientId, subscriptionId);
            }
          },
        },
        { eoseTimeout: this.options.upstreamEoseTimeout }
      );
      this.messageHandler.setUpstreamCoordinator(this.upstreamCoordinator);
    }

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
      // 切断したクライアントのローカル購読を破棄し、対応する上流購読も閉じる
      this.messageHandler.handleClientDisconnect(clientId);
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
    // TTL の定期パージを開始
    this.expiryReaper?.start();
    // 上流リレーへの接続を開始する。接続失敗はログのみで connect 自体は成功させる
    // （キャッシュはオフラインでも従来動作で機能すべき）
    if (this.upstreamCoordinator) {
      try {
        await this.upstreamCoordinator.start();
      } catch (error) {
        logger.error('Failed to start upstream coordinator:', error);
      }
    }
    this.emit('connect');
  }

  /**
   * Disconnect from the relay
   *
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    await this.transport.stop();
    // 上流リレーとの接続・購読を閉じ、保留中の EOSE タイマーも解除する
    await this.upstreamCoordinator?.stop();
    // 遅延バリデーションの定期実行を停止し、未処理キューを検証しきってから終了
    // （未検証イベントの取りこぼしを防ぐ）
    this.lazyValidator?.stop();
    await this.lazyValidator?.flush();
    // TTL の定期パージを停止
    this.expiryReaper?.stop();
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

      // ストレージ上限を超えた場合は古いイベントを退避する
      await this.enforceStorageLimit();

      // Notify local subscribers whose filters match the published event
      const matches = this.subscriptionManager.findMatchingSubscriptions(event);
      const localSubs = matches.get(LOCAL_CLIENT_ID);
      if (localSubs && localSubs.length > 0) {
        this.emit('event', event);
        // ライトスルーで上流へ転送するイベントは上流からエコーバックされる。
        // ローカル配信済みの id を coordinator の重複排除集合に記録し、
        // エコーの二重配信（emit の再発火）を防ぐ
        for (const subscription of localSubs) {
          this.upstreamCoordinator?.markDelivered(LOCAL_CLIENT_ID, subscription.id, event.id);
        }
      }

      // ライトスルー: 保存に成功したイベントを上流リレーへも転送する（fire-and-forget）
      this.upstreamCoordinator?.publish(event);
    }

    return saved;
  }

  /**
   * Ask the storage adapter to evict down to `storageMaxSize` (if configured
   * and supported). Eviction failures never affect the originating save.
   *
   * @private
   */
  private async enforceStorageLimit(): Promise<void> {
    const maxSize = this.options.storageMaxSize;
    if (maxSize === undefined || maxSize <= 0) {
      return;
    }
    // Eviction is a post-save side effect; never let its failure affect the
    // originating save / notification.
    try {
      await this.storage.enforceLimit?.(maxSize, this.options.cacheStrategy);
    } catch (error) {
      logger.error('Failed to enforce storage limit:', error);
    }
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

    // Replay the matching stored events to the listeners.
    // TTL expiry is handled by the background sweep, not filtered here.
    const sentIds: string[] = [];
    try {
      const events = await this.storage.getEvents(filters);
      const limitedEvents = capEvents(
        events,
        this.options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS
      );
      for (const event of limitedEvents) {
        this.emit('event', event);
        sentIds.push(event.id);
      }
    } catch (error) {
      logger.error(`Failed to load stored events for subscription ${subscriptionId}:`, error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }

    // リードスルー有効時は上流へも問い合わせ、EOSE は coordinator が
    // （上流 EOSE の集約 or タイムアウトで）発火する。無効時は従来どおり即 EOSE。
    if (this.upstreamCoordinator) {
      this.upstreamCoordinator.openForSubscription(
        LOCAL_CLIENT_ID,
        subscriptionId,
        filters,
        sentIds
      );
    } else {
      // Signal the end of stored events
      this.emit('eose', subscriptionId);
    }
  }

  /**
   * Unsubscribe from a subscription
   *
   * @param subscriptionId Subscription ID to unsubscribe from
   * @returns True if the subscription existed and was removed, false otherwise
   */
  unsubscribe(subscriptionId: string): boolean {
    const removed = this.subscriptionManager.removeSubscription(LOCAL_CLIENT_ID, subscriptionId);

    // 対応する上流購読も閉じる（開いていなければ no-op）
    this.upstreamCoordinator?.closeForSubscription(LOCAL_CLIENT_ID, subscriptionId);

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
