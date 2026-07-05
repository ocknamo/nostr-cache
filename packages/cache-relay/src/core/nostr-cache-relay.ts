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
import type { StorageAdapter, ValidationStatus } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { UpstreamCoordinator } from '../upstream/upstream-coordinator.js';
import { UpstreamRelayPool } from '../upstream/upstream-relay-pool.js';
import { capEvents } from '../utils/filter-utils.js';
import { MessageHandler } from './message-handler.js';
import { RelayEventEmitter, type RelayEventName } from './relay-event-emitter.js';
import {
  DEFAULT_MAX_EVENTS,
  LOCAL_CLIENT_ID,
  type NostrRelayOptions,
  resolveRelayOptions,
} from './relay-options.js';
import { SubscriptionManager } from './subscription-manager.js';

export type { NostrRelayOptions } from './relay-options.js';

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
  private emitter = new RelayEventEmitter();

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
    this.options = resolveRelayOptions(options);

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
      // トランスポート経由 EVENT の検証モード。LAZY の検証キューはストレージ
      // 自体（validated カラム）なので、ここで検証器を渡す必要はない
      this.options.validateEventsType ?? 'IMMEDIATELY',
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
    this.setupUpstream();

    // メッセージハンドラからの応答をトランスポートに送信するコールバックを設定
    this.messageHandler.onResponse((clientId, message) => {
      this.transport.send(clientId, message);
    });

    this.setupTransportHandlers();
  }

  /**
   * Wire up the upstream read/write-through coordinator when upstream relays
   * (or a custom pool) are configured. When neither is set, no coordinator is
   * created and the relay behaves as an independent relay (opt-in).
   *
   * @private
   */
  private setupUpstream(): void {
    if (!(this.options.upstreamPool || (this.options.upstreamRelays?.length ?? 0) > 0)) {
      return;
    }

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
            this.emitter.emit('event', event);
          } else {
            this.messageHandler.sendEvent(clientId, subscriptionId, event);
          }
        },
        sendEose: (clientId, subscriptionId) => {
          if (clientId === LOCAL_CLIENT_ID) {
            this.emitter.emit('eose', subscriptionId);
          } else {
            this.messageHandler.sendEOSE(clientId, subscriptionId);
          }
        },
      },
      { eoseTimeout: this.options.upstreamEoseTimeout }
    );
    this.messageHandler.setUpstreamCoordinator(this.upstreamCoordinator);
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
    this.emitter.emit('connect');
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
    // 遅延バリデーションの定期実行を停止する。未検証イベントは validated=0 の
    // ままストレージに永続化されており、次回 connect 時に検証が再開される
    this.lazyValidator?.stop();
    // TTL の定期パージを停止
    this.expiryReaper?.stop();
    this.emitter.emit('disconnect');
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

    // Save the event to storage. IMMEDIATELY で事前検証を通過した場合のみ
    // 検証済みとして永続化する。LAZY では pending（validated=0）で保存され、
    // バックグラウンド検証パスが後から検証・マーク（不正なら削除）する
    const saved = await this.storage.saveEvent(event, {
      validated: this.options.validateEventsType === 'IMMEDIATELY',
    });

    if (saved) {
      // ストレージ上限を超えた場合は古いイベントを退避する
      await this.enforceStorageLimit();

      // Notify local subscribers whose filters match the published event
      const matches = this.subscriptionManager.findMatchingSubscriptions(event);
      const localSubs = matches.get(LOCAL_CLIENT_ID);
      if (localSubs && localSubs.length > 0) {
        this.emitter.emit('event', event);
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
   * Get the persisted validation status for the given event ids.
   *
   * Lets an embedding client reuse this relay's (potentially lazy) signature
   * verification instead of re-verifying events itself — e.g. to render
   * "verified" badges. Lookup is by primary key, so it is cheap to call
   * frequently and never counts as a read for LRU/LFU eviction.
   *
   * @param ids Event IDs to look up
   * @returns Promise resolving to a map with one entry per requested id:
   *   `validated` (signature verified), `pending` (stored, not yet verified —
   *   possible in `LAZY` / `NONE` modes), or `unknown` (not stored)
   */
  getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>> {
    return this.storage.getValidationStatus(ids);
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
        this.emitter.emit('event', event);
        sentIds.push(event.id);
      }
    } catch (error) {
      logger.error(`Failed to load stored events for subscription ${subscriptionId}:`, error);
      this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
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
      this.emitter.emit('eose', subscriptionId);
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
    this.emitter.on(event as RelayEventName, callback);
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
    this.emitter.off(event as RelayEventName, callback);
  }
}
