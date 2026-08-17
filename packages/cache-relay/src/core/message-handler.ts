import { logger } from '@nostr-cache/shared';
import {
  type CloseMessage,
  type EventMessage,
  type NostrEvent,
  NostrMessageType,
  type NostrWireMessage,
  type ReqMessage,
} from '@nostr-cache/shared';
import { EventHandler, type ValidateEventsType } from '../event/event-handler.js';
import type { CachePriority } from '../storage/priority.js';
import type { CacheStrategy, StorageAdapter } from '../storage/storage-adapter.js';
import type { FreshnessGate } from '../upstream/freshness.js';
import { narrowFiltersByIdCoverage } from '../upstream/id-coverage.js';
import type { UpstreamCoordinator } from '../upstream/upstream-coordinator.js';
import { capEvents, isValidFilterShape } from '../utils/filter-utils.js';
import { ClientResponder } from './client-responder.js';
import type { SubscriptionManager } from './subscription-manager.js';

export class MessageHandler {
  private eventHandler: EventHandler;
  private storage: StorageAdapter;
  private subscriptionManager: SubscriptionManager;
  private responder: ClientResponder;
  /**
   * Present only when upstream read/write-through is enabled. Injected after
   * construction (see {@link setUpstreamCoordinator}) to break the wiring cycle
   * with {@link NostrCacheRelay}.
   */
  private upstreamCoordinator?: UpstreamCoordinator;

  /**
   * `freshnessGate` is present only when `upstreamFreshness` is configured; it
   * decides which of a REQ's filters still need to be forwarded upstream.
   */
  constructor(
    storage: StorageAdapter,
    subscriptionManager: SubscriptionManager,
    private maxSubscriptions = 20,
    private maxEventsPerRequest = 500,
    validateEventsType: ValidateEventsType = 'IMMEDIATELY',
    private storageMaxSize?: number,
    private cacheStrategy?: CacheStrategy,
    private cachePriority?: CachePriority,
    private freshnessGate?: FreshnessGate
  ) {
    this.storage = storage;
    this.subscriptionManager = subscriptionManager;
    this.eventHandler = new EventHandler(storage, subscriptionManager, validateEventsType);
    this.responder = new ClientResponder();
  }

  async handleMessage(clientId: string, wireMessage: NostrWireMessage): Promise<void> {
    try {
      if (!Array.isArray(wireMessage)) {
        this.sendNotice(clientId, 'Invalid message format');
        return;
      }

      const [type] = wireMessage;

      switch (type) {
        case NostrMessageType.EVENT:
          if (wireMessage.length < 2) {
            this.sendNotice(clientId, 'Invalid EVENT message format');
            return;
          }
          await this.handleEventMessage(clientId, { type, event: wireMessage[1] } as EventMessage);
          break;
        case NostrMessageType.REQ:
          if (wireMessage.length < 2) {
            this.sendNotice(clientId, 'Invalid REQ message format');
            return;
          }
          await this.handleReqMessage(clientId, {
            type,
            subscriptionId: wireMessage[1],
            filters: wireMessage.slice(2),
          } as ReqMessage);
          break;
        case NostrMessageType.CLOSE:
          if (wireMessage.length < 2) {
            this.sendNotice(clientId, 'Invalid CLOSE message format');
            return;
          }
          this.handleCloseMessage(clientId, {
            type,
            subscriptionId: wireMessage[1],
          } as CloseMessage);
          break;
        default:
          this.sendNotice(clientId, `Unknown message type: ${type}`);
      }
    } catch (error) {
      logger.error('Error handling message:', error);
      this.sendNotice(clientId, 'Internal error: server error');
    }
  }

  private async handleEventMessage(clientId: string, message: EventMessage): Promise<void> {
    const event = message.event;

    try {
      const {
        success,
        message: resultMessage,
        superseded,
        matches,
      } = await this.ingestEvent(event);

      if (!success) {
        this.sendOK(clientId, event.id, false, resultMessage);
        return;
      }

      // NIP-01 の版比較で負けた replaceable / addressable イベント（キャッシュが
      // より新しい版を持っている）。イベント自体に問題は無いので OK は true で
      // 返すが、保存していない以上、配信も上流への転送もしない
      if (superseded) {
        this.sendOK(clientId, event.id, true, resultMessage);
        return;
      }

      this.sendOK(clientId, event.id, true);

      if (matches) {
        for (const [targetClientId, subscriptions] of matches.entries()) {
          for (const subscription of subscriptions) {
            this.sendEvent(targetClientId, subscription.id, event);
            // ライトスルーで上流へ転送するイベントは、上流からエコーバックされて
            // 戻ってくる。ローカル配信済みの id を coordinator の重複排除集合に
            // 記録し、エコーの二重配信を防ぐ（上流購読が無ければ no-op）。
            this.upstreamCoordinator?.markDelivered(targetClientId, subscription.id, event.id);
          }
        }
      }

      // ライトスルー: 受理したイベントを上流リレーへも転送する（fire-and-forget）。
      // クライアントへの OK はローカル保存の成否で既に返しており、上流の結果は待たない。
      // ephemeral（stored=false）も success なら転送対象。
      this.upstreamCoordinator?.publish(event);
    } catch (error) {
      logger.error('Error handling event:', error);
      this.sendOK(clientId, event.id, false, 'error: failed to save event');
    }
  }

  /**
   * Validate (per the configured mode), store, and post-process one event —
   * the storage-side work shared by the transport EVENT path and by upstream
   * backfill ({@link ingestUpstreamEvent}). Does NOT send OK or broadcast.
   *
   * Validation happens inside `EventHandler.handleEvent` — IMMEDIATELY rejects
   * invalid events before storing, LAZY stores as pending for the background
   * pass (but validates ephemeral events up front, since they are never
   * stored), NONE skips it. No pre-check here: that would verify the signature
   * twice per EVENT.
   */
  private async ingestEvent(
    event: NostrEvent
  ): Promise<Awaited<ReturnType<EventHandler['handleEvent']>>> {
    const result = await this.eventHandler.handleEvent(event);
    if (!result.success) {
      return result;
    }

    // 退避は保存後の付随処理であり、失敗してもレスポンス/配信に影響させない
    if (result.stored && this.storageMaxSize !== undefined && this.storageMaxSize > 0) {
      try {
        await this.storage.enforceLimit?.(
          this.storageMaxSize,
          this.cacheStrategy,
          this.cachePriority
        );
      } catch (error) {
        logger.error('Failed to enforce storage limit:', error);
      }
    }

    return result;
  }

  /**
   * Backfill one event received from an upstream relay. Runs the same
   * validation / storage / post-processing as a client EVENT but sends no OK
   * and broadcasts to no subscriptions — the {@link UpstreamCoordinator}
   * decides delivery (dedup, routing to the owning subscription).
   */
  async ingestUpstreamEvent(
    event: NostrEvent
  ): Promise<{ success: boolean; stored: boolean; superseded: boolean }> {
    try {
      const { success, stored, superseded } = await this.ingestEvent(event);
      return { success, stored, superseded: superseded === true };
    } catch (error) {
      logger.error('Error ingesting upstream event:', error);
      return { success: false, stored: false, superseded: false };
    }
  }

  /**
   * Inject the upstream coordinator that enables read/write-through. Called by
   * {@link NostrCacheRelay} after construction (the coordinator needs a
   * reference to this handler's {@link ingestUpstreamEvent}).
   */
  setUpstreamCoordinator(coordinator: UpstreamCoordinator): void {
    this.upstreamCoordinator = coordinator;
  }

  /**
   * Replace the cache priority config at runtime. Called by
   * {@link NostrCacheRelay.setCachePriority} with an already-normalized
   * config; takes effect from the next stored event's eviction pass.
   */
  setCachePriority(priority?: CachePriority): void {
    this.cachePriority = priority;
  }

  private async handleReqMessage(clientId: string, message: ReqMessage): Promise<void> {
    if (!message.subscriptionId || typeof message.subscriptionId !== 'string') {
      this.sendNotice(clientId, 'Invalid REQ message: missing or invalid subscriptionId');
      return;
    }

    if (!Array.isArray(message.filters) || message.filters.length === 0) {
      this.sendNotice(clientId, 'Invalid REQ message: filters must be a non-empty array');
      return;
    }

    const { subscriptionId, filters } = message;

    for (const filter of filters) {
      if (!isValidFilterShape(filter)) {
        this.sendNotice(clientId, `Invalid filter format in subscription ${subscriptionId}`);
        return;
      }
    }

    const currentSubscriptions = this.subscriptionManager.getClientSubscriptionCount(clientId);
    if (currentSubscriptions >= this.maxSubscriptions) {
      this.sendNotice(
        clientId,
        `Subscription limit reached: maximum ${this.maxSubscriptions} subscriptions per client`
      );
      return;
    }

    try {
      // 同一 subscriptionId での REQ 再発行に備え、先に旧上流購読を閉じる。
      // SubscriptionManager.createSubscription はローカルの旧購読を内部で削除するが、
      // 上流側は関知しないため、ここで明示的に閉じないと上流購読がリークする。
      this.upstreamCoordinator?.closeForSubscription(clientId, subscriptionId);

      const subscription = this.subscriptionManager.createSubscription(
        clientId,
        subscriptionId,
        filters
      );

      logger.info(
        `Created subscription ${subscriptionId} for client ${clientId} with ${filters.length} filters`
      );

      // ローカルから送信済みのイベント id。上流由来イベントの重複排除に使う。
      const sentIds: string[] = [];
      // 送信したイベント本体。鮮度ウィンドウの充足判定に kind / pubkey が必要。
      let sentEvents: NostrEvent[] = [];

      try {
        // TTL の期限切れはバックグラウンドのスイープで削除されるため、ここでは絞り込まない
        const events = await this.storage.getEvents(filters);

        // 上限超過時は NIP-01 の limit セマンティクスに合わせ、新しい順に N 件残す
        const limitedEvents = capEvents(events, this.maxEventsPerRequest);
        sentEvents = limitedEvents;

        for (const event of limitedEvents) {
          this.sendEvent(clientId, subscriptionId, event);
          sentIds.push(event.id);
        }

        if (events.length > limitedEvents.length) {
          logger.info(
            `Subscription ${subscriptionId} truncated to ${this.maxEventsPerRequest} events (matched ${events.length})`
          );
        }

        logger.info(`Sent ${sentIds.length} events for subscription ${subscriptionId}`);
      } catch (error) {
        logger.error(`Failed to get events for subscription ${subscriptionId}:`, error);
        this.sendNotice(clientId, 'Failed to get events: storage error');
        // エラー時は EOSE を送信せず、上流購読も開かない
        return;
      }

      // キャッシュだけで完全に充足したフィルタは上流へ投げない。判定は2段構えで、
      // どちらも充足を証明できないケースは上流へ転送する側に倒す（フェイルオープン）。
      // 上流が無い構成では判定自体が無意味なので、ストレージに触る前に短絡する
      let upstreamFilters = filters;
      if (this.upstreamCoordinator) {
        // id カバレッジは設定に依存しない正確な判定なので、鮮度ウィンドウが構成
        // されているかどうかに関わらず常に適用する
        upstreamFilters = narrowFiltersByIdCoverage(filters, sentIds);
        const byId = filters.length - upstreamFilters.length;

        let byFreshness = 0;
        if (this.freshnessGate && upstreamFilters.length > 0) {
          const candidates = upstreamFilters;
          // sentEvents は絞らない: 充足判定の根拠は REQ 全体の配信結果である
          upstreamFilters = await this.freshnessGate.filtersForUpstream(candidates, sentEvents);
          byFreshness = candidates.length - upstreamFilters.length;
        }

        if (byId > 0 || byFreshness > 0) {
          logger.debug(
            `Subscription ${subscriptionId}: ${byId} filters answered by id, ${byFreshness} within the freshness window, ${upstreamFilters.length} forwarded upstream`
          );
        }
      }

      // リードスルー有効時は上流へ REQ を展開し、EOSE の送出は coordinator に委譲する
      // （上流 EOSE の集約 or タイムアウトで送られる）。無効時、および鮮度ウィンドウで
      // 全フィルタが充足した場合は従来どおり即 EOSE。
      if (this.upstreamCoordinator && upstreamFilters.length > 0) {
        this.upstreamCoordinator.openForSubscription(
          clientId,
          subscriptionId,
          upstreamFilters,
          sentIds
        );
      } else {
        this.sendEOSE(clientId, subscriptionId);
      }
    } catch (error) {
      logger.error(`Failed to create subscription ${subscriptionId}:`, error);
      this.sendNotice(clientId, 'Failed to create subscription: subscription error');
    }
  }

  private handleCloseMessage(clientId: string, message: CloseMessage): void {
    if (!message.subscriptionId) {
      this.sendNotice(clientId, 'Invalid CLOSE message format');
      return;
    }

    const { subscriptionId } = message;

    try {
      this.sendClosed(clientId, subscriptionId, 'subscription closed');
      const removed = this.subscriptionManager.removeSubscription(clientId, subscriptionId);

      // 対応する上流購読も閉じる（開いていなければ no-op）
      this.upstreamCoordinator?.closeForSubscription(clientId, subscriptionId);

      if (!removed) {
        logger.debug(`Subscription ${subscriptionId} not found for client ${clientId}`);
      }
    } catch (error) {
      logger.error('Failed to remove subscription:', error);
      this.sendNotice(clientId, 'Failed to close subscription: Unknown error');
    }
  }

  /**
   * Handle a client disconnecting: remove all of its subscriptions and close
   * the matching upstream subscriptions. Without this, disconnected clients
   * leak local subscriptions (a pre-existing gap) and, with upstream enabled,
   * leak real upstream connections' REQs.
   */
  handleClientDisconnect(clientId: string): void {
    try {
      this.upstreamCoordinator?.closeAllForClient(clientId);
      const removed = this.subscriptionManager.removeAllSubscriptions(clientId);
      if (removed > 0) {
        logger.debug(`Removed ${removed} subscriptions for disconnected client ${clientId}`);
      }
    } catch (error) {
      logger.error('Failed to clean up subscriptions on disconnect:', error);
    }
  }

  sendEvent(clientId: string, subscriptionId: string, event: NostrEvent): void {
    this.responder.sendEvent(clientId, subscriptionId, event);
  }

  sendOK(clientId: string, eventId: string, success: boolean, message = ''): void {
    this.responder.sendOK(clientId, eventId, success, message);
  }

  sendEOSE(clientId: string, subscriptionId: string): void {
    this.responder.sendEOSE(clientId, subscriptionId);
  }

  sendClosed(clientId: string, subscriptionId: string, message: string): void {
    this.responder.sendClosed(clientId, subscriptionId, message);
  }

  sendNotice(clientId: string, message: string): void {
    this.responder.sendNotice(clientId, message);
  }

  onResponse(callback: (clientId: string, message: NostrWireMessage) => void): void {
    this.responder.onResponse(callback);
  }
}
