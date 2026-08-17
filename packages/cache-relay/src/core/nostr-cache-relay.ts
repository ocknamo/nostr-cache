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
import { applyDeletionRequest, isDeletionEvent } from '../event/deletion.js';
import { EventValidator } from '../event/event-validator.js';
import { LazyValidator } from '../event/lazy-validator.js';
import { ExpiryReaper } from '../storage/expiry-reaper.js';
import type { StorageAdapter, ValidationStatus } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { FreshnessGate } from '../upstream/freshness.js';
import { narrowFiltersByIdCoverage } from '../upstream/id-coverage.js';
import { UpstreamCoordinator } from '../upstream/upstream-coordinator.js';
import { UpstreamRelayPool } from '../upstream/upstream-relay-pool.js';
import { capEvents } from '../utils/filter-utils.js';
import { MessageHandler } from './message-handler.js';
import { RelayEventEmitter, type RelayEventName } from './relay-event-emitter.js';
import {
  DEFAULT_MAX_EVENTS,
  LOCAL_CLIENT_ID,
  type NostrRelayOptions,
  normalizeCachePriority,
  normalizeFreshnessWindows,
  resolveRelayOptions,
} from './relay-options.js';
import { SubscriptionManager } from './subscription-manager.js';

export type { NostrRelayOptions } from './relay-options.js';

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
  /**
   * Cache-first freshness window, present only when `upstreamFreshness` is
   * configured. Shared with {@link MessageHandler} so the transport REQ path and
   * the in-process {@link subscribe} path decide identically.
   */
  private freshnessGate?: FreshnessGate;
  private emitter = new RelayEventEmitter();

  constructor(
    storage: StorageAdapter,
    transport: TransportAdapter,
    options: NostrRelayOptions = {}
  ) {
    this.options = resolveRelayOptions(options);

    this.storage = storage;
    this.transport = transport;
    this.validator = new EventValidator();

    if (this.options.validateEventsType === 'LAZY') {
      this.lazyValidator = new LazyValidator(
        storage,
        {
          intervalSeconds: this.options.lazyValidateInterval,
          batchSize: this.options.lazyValidateBatchSize,
        },
        this.validator
      );
    }

    // 鮮度ウィンドウ。不正な設定はここで例外になる（`cachePriority` と同じ方針）。
    // `upstreamRelays` 未指定でも構築する: 上流が無ければ REQ はそもそも転送されず
    // gate は呼ばれないため無害で、設定ミスだけは常に構築時に気づける
    const freshnessWindows = normalizeFreshnessWindows(this.options.upstreamFreshness);
    if (freshnessWindows) {
      this.freshnessGate = new FreshnessGate(storage, freshnessWindows);
    }

    this.subscriptionManager = new SubscriptionManager();
    this.messageHandler = new MessageHandler(
      storage,
      this.subscriptionManager,
      this.options.maxSubscriptions,
      this.options.maxEventsPerRequest,
      // LAZY の検証キューはストレージ自体（validated カラム）なので、
      // ここで検証器を渡す必要はない
      this.options.validateEventsType ?? 'IMMEDIATELY',
      this.options.storageMaxSize,
      this.options.cacheStrategy,
      this.options.cachePriority,
      this.freshnessGate
    );

    // TTL 設定時はバックグラウンドの定期パージを用意する。
    // 期限切れイベントは読み出し時ではなく、このスイープで削除する
    if (this.options.ttl !== undefined && this.options.ttl > 0) {
      this.expiryReaper = new ExpiryReaper(storage, {
        ttlSeconds: this.options.ttl,
        intervalSeconds: this.options.ttlSweepInterval,
        priority: this.options.cachePriority,
      });
    }

    this.setupUpstream();

    this.messageHandler.onResponse((clientId, message) => {
      this.transport.send(clientId, message);
    });

    this.setupTransportHandlers();
  }

  /**
   * Replace the cache priority config at runtime.
   *
   * Pubkeys are accepted as `npub1...` or 64-char hex (normalized to hex, as
   * at construction time); invalid input throws and leaves the current config
   * unchanged. Pass `undefined` (or an empty config) to clear all rules.
   *
   * Because priority is evaluated at eviction / TTL-sweep time (nothing is
   * persisted per event), the new rules take full effect from the next
   * eviction pass and the next TTL sweep — no backfill needed. Events already
   * evicted or expired under the old rules are not restored.
   *
   * @throws Error naming the offending entry on an invalid pubkey or kind
   */
  setCachePriority(input?: { pubkeys?: string[]; kinds?: number[] }): void {
    // 正規化が throw した場合は現行設定を維持する（先に検証してから反映）
    const normalized = normalizeCachePriority(input);
    this.options.cachePriority = normalized;
    this.messageHandler.setCachePriority(normalized);
    this.expiryReaper?.setPriority(normalized);
  }

  /**
   * Wire up the upstream read/write-through coordinator when upstream relays
   * (or a custom pool) are configured. When neither is set, no coordinator is
   * created and the relay behaves as an independent relay (opt-in).
   */
  private setupUpstream(): void {
    if (!(this.options.upstreamPool || (this.options.upstreamRelays?.length ?? 0) > 0)) {
      return;
    }

    const pool =
      this.options.upstreamPool ??
      new UpstreamRelayPool(this.options.upstreamRelays as string[], {
        // WebSocket コンストラクタは接続開始時に評価する（遅延ファクトリ）。ブラウザで
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
        // 上流が既配信の id を返してきた = キャッシュ済みの版が最新だと確認できた。
        // 鮮度ウィンドウを張り直す（内容が変わらない replaceable でも窓が
        // 再武装するようにするため。詳細は FreshnessGate.markRevalidated）
        onDuplicate: (event) => this.freshnessGate?.markRevalidated(event),
      },
      { eoseTimeout: this.options.upstreamEoseTimeout }
    );
    this.messageHandler.setUpstreamCoordinator(this.upstreamCoordinator);
  }

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

  private handleMessage(clientId: string, wireMessage: NostrWireMessage): void {
    this.messageHandler.handleMessage(clientId, wireMessage);
  }

  async connect(): Promise<void> {
    await this.transport.start();
    this.lazyValidator?.start();
    this.expiryReaper?.start();
    // 上流への接続失敗はログのみで connect 自体は成功させる
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

  async disconnect(): Promise<void> {
    await this.transport.stop();
    await this.upstreamCoordinator?.stop();
    // 未検証イベントは validated=0 のまま永続化されており、次回 connect で検証が再開される
    this.lazyValidator?.stop();
    this.expiryReaper?.stop();
    this.emitter.emit('disconnect');
  }

  async publishEvent(event: NostrEvent): Promise<boolean> {
    // NIP-09 deletion requests destroy other events on arrival and no later
    // pass can undo that, so they are verified in every mode — `NONE` included,
    // exactly as EventHandler does on the transport path.
    const mustValidateNow =
      isDeletionEvent(event) || this.options.validateEventsType === 'IMMEDIATELY';
    if (mustValidateNow && !(await this.validator.validate(event))) {
      return false;
    }

    // 事前検証を通過したイベントのみ検証済みとして永続化する。LAZY では通常
    // イベントは pending（validated=0）で保存され、バックグラウンド検証パスが
    // 後から検証・マーク（不正なら削除）する
    const saved = await this.storage.saveEvent(event, { validated: mustValidateNow });

    if (saved) {
      // NIP-09: 削除リクエストを保存したら参照先の削除を適用する
      // （transport 経由の EVENT では EventHandler が同じ処理を行う）
      if (isDeletionEvent(event)) {
        await applyDeletionRequest(this.storage, event);
      }

      await this.enforceStorageLimit();

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
   * and supported). Eviction is a post-save side effect: its failure never
   * affects the originating save / notification.
   */
  private async enforceStorageLimit(): Promise<void> {
    const maxSize = this.options.storageMaxSize;
    if (maxSize === undefined || maxSize <= 0) {
      return;
    }
    try {
      await this.storage.enforceLimit?.(
        maxSize,
        this.options.cacheStrategy,
        this.options.cachePriority
      );
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
   */
  async subscribe(subscriptionId: string, filters: Filter[]): Promise<void> {
    this.subscriptionManager.createSubscription(LOCAL_CLIENT_ID, subscriptionId, filters);

    logger.info(`Created subscription ${subscriptionId} with filters:`, filters);

    // TTL expiry is handled by the background sweep, not filtered here.
    const sentIds: string[] = [];
    let sentEvents: NostrEvent[] = [];
    try {
      const events = await this.storage.getEvents(filters);
      const limitedEvents = capEvents(
        events,
        this.options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS
      );
      sentEvents = limitedEvents;
      for (const event of limitedEvents) {
        this.emitter.emit('event', event);
        sentIds.push(event.id);
      }
    } catch (error) {
      logger.error(`Failed to load stored events for subscription ${subscriptionId}:`, error);
      this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }

    // キャッシュだけで充足したフィルタは上流へ投げない
    // （transport 経由の REQ と同じ2段の判定を通す。上流が無ければ短絡する）
    let upstreamFilters = filters;
    if (this.upstreamCoordinator) {
      upstreamFilters = narrowFiltersByIdCoverage(filters, sentIds);
      if (this.freshnessGate && upstreamFilters.length > 0) {
        upstreamFilters = await this.freshnessGate.filtersForUpstream(upstreamFilters, sentEvents);
      }
    }

    // リードスルー有効時は上流へも問い合わせ、EOSE は coordinator が
    // （上流 EOSE の集約 or タイムアウトで）発火する。無効時、および鮮度ウィンドウで
    // 全フィルタが充足した場合は従来どおり即 EOSE。
    if (this.upstreamCoordinator && upstreamFilters.length > 0) {
      this.upstreamCoordinator.openForSubscription(
        LOCAL_CLIENT_ID,
        subscriptionId,
        upstreamFilters,
        sentIds
      );
    } else {
      this.emitter.emit('eose', subscriptionId);
    }
  }

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
