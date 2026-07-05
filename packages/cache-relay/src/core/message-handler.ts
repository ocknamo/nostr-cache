/**
 * Message handler for Nostr Cache Relay
 *
 * Handles incoming messages from clients
 */

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
import type { CacheStrategy, StorageAdapter } from '../storage/storage-adapter.js';
import type { UpstreamCoordinator } from '../upstream/upstream-coordinator.js';
import { capEvents, isValidFilterShape } from '../utils/filter-utils.js';
import { ClientResponder } from './client-responder.js';
import type { SubscriptionManager } from './subscription-manager.js';

/**
 * Message handler class
 * Handles incoming messages from clients
 */
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
   * Create a new MessageHandler instance
   *
   * @param storage Storage adapter
   * @param subscriptionManager Subscription manager
   * @param maxSubscriptions Maximum number of subscriptions per client
   * @param maxEventsPerRequest Maximum number of stored events returned per REQ
   * @param validateEventsType How incoming EVENTs are validated. `IMMEDIATELY`
   *   rejects invalid events synchronously; `NONE` skips validation; `LAZY`
   *   accepts and stores immediately (as pending), then the background
   *   validator drains unvalidated events straight from storage.
   * @param storageMaxSize When set (> 0), evict down to this size after each
   *   stored event via `storage.enforceLimit`
   * @param cacheStrategy Eviction strategy used with `storageMaxSize`
   */
  constructor(
    storage: StorageAdapter,
    subscriptionManager: SubscriptionManager,
    private maxSubscriptions = 20,
    private maxEventsPerRequest = 500,
    validateEventsType: ValidateEventsType = 'IMMEDIATELY',
    private storageMaxSize?: number,
    private cacheStrategy?: CacheStrategy
  ) {
    this.storage = storage;
    this.subscriptionManager = subscriptionManager;
    this.eventHandler = new EventHandler(storage, subscriptionManager, validateEventsType);
    this.responder = new ClientResponder();
  }

  /**
   * Handle an incoming message
   *
   * @param clientId ID of the client that sent the message
   * @param wireMessage Message received in wire format
   */
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

  /**
   * Handle EVENT message
   *
   * @param clientId ID of the client that sent the message
   * @param message Message received
   * @private
   */
  private async handleEventMessage(clientId: string, message: EventMessage): Promise<void> {
    const event = message.event;

    try {
      const { success, message: resultMessage, matches } = await this.ingestEvent(event);

      if (!success) {
        this.sendOK(clientId, event.id, false, resultMessage);
        return;
      }

      // OK レスポンスの送信
      this.sendOK(clientId, event.id, true);

      // マッチするサブスクリプションへのブロードキャスト
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
   * - IMMEDIATELY: validate synchronously up front (invalid → not stored).
   * - LAZY: store now as pending; the background validator drains it later.
   * - NONE: no validation.
   * After a successful store, enforces the storage limit (a post-save side
   * effect whose failure never affects the result).
   *
   * @param event Event to ingest
   * @returns handleEvent's result (success / stored / message / matches)
   */
  private async ingestEvent(
    event: NostrEvent
  ): Promise<Awaited<ReturnType<EventHandler['handleEvent']>>> {
    // Validation (per the configured mode) is performed inside
    // EventHandler.handleEvent: IMMEDIATELY validates synchronously and rejects
    // invalid events before storing; LAZY stores as pending for the background
    // pass (but validates ephemeral events up front, since they are never
    // stored); NONE skips validation. No pre-check here — doing so would verify
    // the signature twice per EVENT.
    const result = await this.eventHandler.handleEvent(event);
    if (!result.success) {
      return result;
    }

    // LAZY モードで保存されたイベントは validated=0（pending）で永続化されて
    // おり、バックグラウンド検証器がストレージから直接取り出して検証する。
    // ここでの enqueue は不要（DB 自体が検証キュー）。

    // 保存されたイベントについてはストレージ上限の退避を行う。
    // 退避は保存後の付随処理であり、失敗してもレスポンス/配信に影響させない
    if (result.stored && this.storageMaxSize !== undefined && this.storageMaxSize > 0) {
      try {
        await this.storage.enforceLimit?.(this.storageMaxSize, this.cacheStrategy);
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
   *
   * @param event Event fetched from upstream
   * @returns Whether it was accepted (success) and persisted (stored)
   */
  async ingestUpstreamEvent(event: NostrEvent): Promise<{ success: boolean; stored: boolean }> {
    try {
      const { success, stored } = await this.ingestEvent(event);
      return { success, stored };
    } catch (error) {
      logger.error('Error ingesting upstream event:', error);
      return { success: false, stored: false };
    }
  }

  /**
   * Inject the upstream coordinator that enables read/write-through. Called by
   * {@link NostrCacheRelay} after construction (the coordinator needs a
   * reference to this handler's {@link ingestUpstreamEvent}).
   *
   * @param coordinator Coordinator orchestrating upstream relays
   */
  setUpstreamCoordinator(coordinator: UpstreamCoordinator): void {
    this.upstreamCoordinator = coordinator;
  }

  /**
   * Handle REQ message - creates a new subscription and sends matching events
   *
   * @param clientId ID of the client that sent the message
   * @param message Message received
   * @private
   */
  private async handleReqMessage(clientId: string, message: ReqMessage): Promise<void> {
    // 入力メッセージの検証
    if (!message.subscriptionId || typeof message.subscriptionId !== 'string') {
      this.sendNotice(clientId, 'Invalid REQ message: missing or invalid subscriptionId');
      return;
    }

    if (!Array.isArray(message.filters) || message.filters.length === 0) {
      this.sendNotice(clientId, 'Invalid REQ message: filters must be a non-empty array');
      return;
    }

    const { subscriptionId, filters } = message;

    // フィルタの検証
    for (const filter of filters) {
      if (!isValidFilterShape(filter)) {
        this.sendNotice(clientId, `Invalid filter format in subscription ${subscriptionId}`);
        return;
      }
    }

    // サブスクリプション数の上限チェック
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

      // サブスクリプションの作成
      const subscription = this.subscriptionManager.createSubscription(
        clientId,
        subscriptionId,
        filters
      );

      // ローカルログ
      logger.info(
        `Created subscription ${subscriptionId} for client ${clientId} with ${filters.length} filters`
      );

      // ローカルから送信済みのイベント id。上流由来イベントの重複排除に使う。
      const sentIds: string[] = [];

      // 既存の一致するイベントの取得と送信
      try {
        // 各フィルタに一致するイベントを取得（TTL の期限切れは
        // バックグラウンドのスイープで削除されるため、ここでは絞り込まない）
        const events = await this.storage.getEvents(filters);

        // リレーが一度に返すイベント数の上限を適用。上限超過時は NIP-01 の
        // limit セマンティクスに合わせ、新しい順（created_at 降順）に N 件残す
        const limitedEvents = capEvents(events, this.maxEventsPerRequest);

        // イベントをクライアントに送信
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
        // ストレージエラーの処理
        logger.error(`Failed to get events for subscription ${subscriptionId}:`, error);
        this.sendNotice(clientId, 'Failed to get events: storage error');
        // エラー発生時はEOSEを送信せず、上流購読も開かない
        return;
      }

      // リードスルー有効時は上流へ REQ を展開し、EOSE の送出は coordinator に委譲する
      // （上流 EOSE の集約 or タイムアウトで送られる）。無効時は従来どおり即 EOSE。
      if (this.upstreamCoordinator) {
        this.upstreamCoordinator.openForSubscription(clientId, subscriptionId, filters, sentIds);
      } else {
        // EOSE（End of Stored Events）の送信
        // すべての保存されたイベントが送信されたことをクライアントに通知
        this.sendEOSE(clientId, subscriptionId);
      }
    } catch (error) {
      // サブスクリプション作成エラーの処理
      logger.error(`Failed to create subscription ${subscriptionId}:`, error);
      this.sendNotice(clientId, 'Failed to create subscription: subscription error');
    }
  }

  /**
   * Handle CLOSE message
   *
   * @param clientId ID of the client that sent the message
   * @param message Message received
   * @private
   */
  private handleCloseMessage(clientId: string, message: CloseMessage): void {
    if (!message.subscriptionId) {
      this.sendNotice(clientId, 'Invalid CLOSE message format');
      return;
    }

    const { subscriptionId } = message;

    try {
      this.sendClosed(clientId, subscriptionId, 'subscription closed');
      // サブスクリプションの削除
      const removed = this.subscriptionManager.removeSubscription(clientId, subscriptionId);

      // 対応する上流購読も閉じる（開いていなければ no-op）
      this.upstreamCoordinator?.closeForSubscription(clientId, subscriptionId);

      if (!removed) {
        // 存在しないサブスクリプションの場合はログだけ残す
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
   *
   * @param clientId ID of the client that disconnected
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

  /**
   * Send an EVENT message to a client. Delegates to {@link ClientResponder}.
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   * @param event Event to send
   */
  sendEvent(clientId: string, subscriptionId: string, event: NostrEvent): void {
    this.responder.sendEvent(clientId, subscriptionId, event);
  }

  /**
   * Send an OK message to a client. Delegates to {@link ClientResponder}.
   *
   * @param clientId ID of the client to send to
   * @param eventId ID of the event
   * @param success Whether the event was accepted
   * @param message Message to include
   */
  sendOK(clientId: string, eventId: string, success: boolean, message = ''): void {
    this.responder.sendOK(clientId, eventId, success, message);
  }

  /**
   * Send an EOSE message to a client. Delegates to {@link ClientResponder}.
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   */
  sendEOSE(clientId: string, subscriptionId: string): void {
    this.responder.sendEOSE(clientId, subscriptionId);
  }

  /**
   * Send a CLOSED message to a client. Delegates to {@link ClientResponder}.
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   * @param message Message to include
   */
  sendClosed(clientId: string, subscriptionId: string, message: string): void {
    this.responder.sendClosed(clientId, subscriptionId, message);
  }

  /**
   * Send a NOTICE message to a client. Delegates to {@link ClientResponder}.
   *
   * @param clientId ID of the client to send to
   * @param message Message to include
   */
  sendNotice(clientId: string, message: string): void {
    this.responder.sendNotice(clientId, message);
  }

  /**
   * Register a callback for responses. Delegates to {@link ClientResponder}.
   *
   * @param callback Function to call when a response is sent
   */
  onResponse(callback: (clientId: string, message: NostrWireMessage) => void): void {
    this.responder.onResponse(callback);
  }
}
