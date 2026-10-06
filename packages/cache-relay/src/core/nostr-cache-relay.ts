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
import { RELAY_LIST_KIND, isEphemeralKind } from '../event/event-kind.js';
import { EventValidator } from '../event/event-validator.js';
import { LazyValidator } from '../event/lazy-validator.js';
import { IndexRelayClient } from '../outbox/index-relay-client.js';
import { OutboxPublisher } from '../outbox/outbox-publisher.js';
import { planReads, readLookups } from '../outbox/read-plan.js';
import { RelayListResolver } from '../outbox/relay-list-resolver.js';
import { type RelayList, normalizeRelayUrl } from '../outbox/relay-list.js';
import { inboxRecipients, writeTargets } from '../outbox/write-targets.js';
import { EvictionSweeper } from '../storage/eviction-sweeper.js';
import { ExpiryReaper } from '../storage/expiry-reaper.js';
import type { StorageAdapter, ValidationStatus } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { FreshnessGate } from '../upstream/freshness.js';
import { narrowFiltersByIdCoverage } from '../upstream/id-coverage.js';
import { type ReadPart, UpstreamCoordinator } from '../upstream/upstream-coordinator.js';
import { UpstreamRelayPool } from '../upstream/upstream-relay-pool.js';
import type { UpstreamPool } from '../upstream/upstream-types.js';
import { capEvents } from '../utils/filter-utils.js';
import { MessageHandler } from './message-handler.js';
import { RelayEventEmitter, type RelayEventName } from './relay-event-emitter.js';
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_RELAY_LIST_FRESHNESS,
  LOCAL_CLIENT_ID,
  type NostrRelayOptions,
  normalizeCachePriority,
  normalizeFreshnessWindows,
  normalizeIndexRelays,
  resolveRelayOptions,
} from './relay-options.js';
import { SubscriptionManager } from './subscription-manager.js';

export type { NostrRelayOptions } from './relay-options.js';

/** ms */
const OUTBOX_RESOLVE_WAIT = 3000;
/** ms。読み込みはクライアントの EOSE を待たせるので、書き込みより短く切る。 */
const OUTBOX_READ_RESOLVE_WAIT = 1500;

/**
 * ephemeral（NIP-46 など）と gift wrap（kind 1059）は使い捨ての鍵で署名されるので、
 * その鍵で 10002 を引いても無駄で、閲覧者と鍵の対応をインデックスリレーに漏らすだけ。
 */
function isOutboxKind(kind: number): boolean {
  return !isEphemeralKind(kind) && kind !== 1059;
}

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
  /** Background eviction sweeper, present only when `storageMaxSize` is set. */
  private evictionSweeper?: EvictionSweeper;
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
  private indexRelayClient?: IndexRelayClient;
  private indexRelays: string[] = [];
  private outboxPublisher?: OutboxPublisher;
  private upstreamPool?: UpstreamPool;
  /** 正規化済みの既定の上流。アウトボックスの宛先から除く。 */
  private defaultRelays = new Set<string>();
  private relayListResolver?: RelayListResolver;
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
      this.freshnessGate,
      () => this.evictionSweeper?.recordStored()
    );

    // 上限の超過は保存のたびではなく、スイープでまとめて解消する
    if (this.options.storageMaxSize !== undefined && this.options.storageMaxSize > 0) {
      this.evictionSweeper = new EvictionSweeper(storage, {
        maxSize: this.options.storageMaxSize,
        intervalSeconds: this.options.storageSweepInterval,
        strategy: this.options.cacheStrategy,
        priority: this.options.cachePriority,
      });
    }

    // TTL 設定時はバックグラウンドの定期パージを用意する。
    // 期限切れイベントは読み出し時ではなく、このスイープで削除する
    if (this.options.ttl !== undefined && this.options.ttl > 0) {
      this.expiryReaper = new ExpiryReaper(storage, {
        ttlSeconds: this.options.ttl,
        intervalSeconds: this.options.ttlSweepInterval,
        priority: this.options.cachePriority,
      });
    }

    // 上流の購読・送信が宛先の解決を呼ぶので、先に用意する
    this.setupOutbox(freshnessWindows?.get(RELAY_LIST_KIND));
    this.setupUpstream();

    this.messageHandler.onResponse((clientId, message) => {
      this.transport.send(clientId, message);
      if (message[0] === 'EVENT') {
        this.observeDelivered(message[2] as NostrEvent);
      }
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
    this.evictionSweeper?.setPriority(normalized);
    this.expiryReaper?.setPriority(normalized);
  }

  /**
   * Drop every cached event.
   *
   * Open subscriptions are left alone: clients keep the events already
   * delivered to them, and live updates keep arriving.
   */
  async clearCache(): Promise<void> {
    await this.storage.clear();
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
    this.upstreamPool = pool;
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
        onPublish: this.outboxPublisher ? (event) => this.forwardToOutbox(event) : undefined,
        route: this.relayListResolver ? (filters) => this.routeReads(filters) : undefined,
      },
      { eoseTimeout: this.options.upstreamEoseTimeout }
    );
    this.messageHandler.setUpstreamCoordinator(this.upstreamCoordinator);
  }

  private setupOutbox(relayListFreshness: number | undefined): void {
    const indexRelays = normalizeIndexRelays(this.options.outbox);
    if (!indexRelays) {
      return;
    }
    this.indexRelays = indexRelays;
    this.defaultRelays = new Set(
      (this.options.upstreamRelays ?? []).map((url) => normalizeRelayUrl(url) ?? url)
    );
    this.outboxPublisher = new OutboxPublisher({
      webSocketFactory: () => this.transport.getOriginalWebSocket?.() ?? globalThis.WebSocket,
    });
    this.indexRelayClient = new IndexRelayClient(indexRelays, {
      webSocketFactory: () => this.transport.getOriginalWebSocket?.() ?? globalThis.WebSocket,
    });
    const client = this.indexRelayClient;
    this.relayListResolver = new RelayListResolver(
      {
        storage: this.storage,
        fetch: (filter) => client.fetch(filter),
        ingest: (event) => this.messageHandler.ingestUpstreamEvent(event),
      },
      { freshnessSeconds: relayListFreshness ?? DEFAULT_RELAY_LIST_FRESHNESS }
    );
    // in-process 購読への配信は transport を通らないので、ここで拾う
    this.emitter.on('event', (event: NostrEvent) => this.observeDelivered(event));
  }

  private forwardToOutbox(event: NostrEvent): void {
    const publisher = this.outboxPublisher;
    if (!publisher || !isOutboxKind(event.kind)) {
      return;
    }
    this.outboxTargets(event)
      .then((relays) => publisher.publish(event, relays))
      .catch((error) => {
        logger.debug('Outbox targets could not be resolved:', error);
      });
  }

  /**
   * 既定の上流以外に送る先。kind 10002 はインデックスリレーにも載せ、他のクライアントが
   * 著者の新しいリストを見つけられるようにする。
   */
  private async outboxTargets(event: NostrEvent): Promise<string[]> {
    const resolver = this.relayListResolver;
    if (!resolver) {
      return [];
    }
    const pubkeys = [event.pubkey, ...inboxRecipients(event)];
    const lists = await this.relayListsWithin(resolver, pubkeys, OUTBOX_RESOLVE_WAIT);
    const targets = writeTargets(event, lists, this.defaultRelays);
    if (event.kind === RELAY_LIST_KIND) {
      for (const url of this.indexRelays) {
        if (!this.defaultRelays.has(url) && !targets.includes(url)) {
          targets.push(url);
        }
      }
    }
    return targets;
  }

  /** 既定の上流では届かない人のために、REQ を足す先。 */
  private async routeReads(filters: Filter[]): Promise<ReadPart[]> {
    const resolver = this.relayListResolver;
    if (!resolver) {
      return [];
    }
    const { pubkeys, eventIds } = readLookups(filters);
    const referencedAuthors = new Map<string, string>();
    if (eventIds.length > 0) {
      for (const event of await this.storage.getEvents([{ ids: eventIds }])) {
        referencedAuthors.set(event.id, event.pubkey);
      }
    }
    const everyone = [...new Set([...pubkeys, ...referencedAuthors.values()])];
    if (everyone.length === 0) {
      return [];
    }
    const lists = await this.relayListsWithin(resolver, everyone, OUTBOX_READ_RESOLVE_WAIT);
    const pool = this.upstreamPool;
    return planReads(filters, {
      lists,
      referencedAuthors,
      isDefault: (relay) => this.defaultRelays.has(relay),
      canReach: (relay) => pool?.canReach?.(relay) ?? true,
    });
  }

  /** 取得待ちの後ろに並ぶと数十秒かかりうるので、待つのは `waitMs` まで。あとは届いている分で決める。 */
  private async relayListsWithin(
    resolver: RelayListResolver,
    pubkeys: string[],
    waitMs: number
  ): Promise<Map<string, RelayList>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        resolver.resolve(pubkeys),
        new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
    } catch (error) {
      logger.debug('Relay list resolution failed; using what is cached:', error);
    } finally {
      clearTimeout(timer);
    }
    return resolver.lookup(pubkeys);
  }

  /**
   * フォローリストは届いた経路（キャッシュ・上流・投稿）を問わず先読みの起点にする。
   * 配信の途中で呼ばれるので、ここで投げると後続のリスナーや送信を巻き込む。
   */
  private observeDelivered(event: NostrEvent): void {
    try {
      if (event?.kind === 3) {
        this.relayListResolver?.prefetchFollows(event);
      }
    } catch (error) {
      logger.debug('Relay list prefetch could not start:', error);
    }
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
    this.indexRelayClient?.start();
    this.outboxPublisher?.start();
    this.relayListResolver?.start();
    this.expiryReaper?.start();
    this.evictionSweeper?.start();
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
    this.relayListResolver?.stop();
    this.indexRelayClient?.stop();
    this.outboxPublisher?.stop();
    // 未検証イベントは validated=0 のまま永続化されており、次回 connect で検証が再開される
    this.lazyValidator?.stop();
    this.expiryReaper?.stop();
    this.evictionSweeper?.stop();
    this.emitter.emit('disconnect');
  }

  async publishEvent(event: NostrEvent): Promise<boolean> {
    // Same rule as EventHandler on the transport path: deletion requests in
    // every mode, relay lists under LAZY too.
    const mustValidateNow =
      isDeletionEvent(event) ||
      this.options.validateEventsType === 'IMMEDIATELY' ||
      (this.options.validateEventsType === 'LAZY' && event.kind === RELAY_LIST_KIND);
    if (mustValidateNow && !(await this.validator.validate(event))) {
      return false;
    }

    // 事前検証を通過したイベントのみ検証済みとして永続化する。LAZY では通常
    // イベントは pending（validated=0）で保存され、バックグラウンド検証パスが
    // 後から検証・マーク（不正なら削除）する
    const saved = await this.storage.saveEvent(event, { validated: mustValidateNow });

    if (saved) {
      this.evictionSweeper?.recordStored();

      // NIP-09: 削除リクエストを保存したら参照先の削除を適用する
      // （transport 経由の EVENT では EventHandler が同じ処理を行う）
      if (isDeletionEvent(event)) {
        await applyDeletionRequest(this.storage, event);
      }

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
