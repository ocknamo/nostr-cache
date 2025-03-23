/**
 * Message handler for Nostr Cache Relay
 *
 * Handles incoming messages from clients
 */

import {
  CloseMessage,
  ClosedResponse,
  EoseResponse,
  EventMessage,
  Filter,
  NostrEvent,
  NostrMessageType,
  NostrWireMessage,
  NoticeResponse,
  OkResponse,
  ReqMessage,
  messageToWire,
  wireToMessage,
} from '@nostr-cache/types';
import { EventHandler } from '../event/EventHandler';
import { EventValidator } from '../event/EventValidator';
import { StorageAdapter } from '../storage/StorageAdapter';
import { SubscriptionManager } from './SubscriptionManager';

/**
 * Message handler class
 * Handles incoming messages from clients
 */
export class MessageHandler {
  private eventHandler: EventHandler;
  private storage: StorageAdapter;
  private subscriptionManager: SubscriptionManager;
  private responseCallbacks: ((clientId: string, message: NostrWireMessage) => void)[] = [];
  private eventValidator: EventValidator;

  /**
   * Create a new MessageHandler instance
   *
   * @param storage Storage adapter
   * @param subscriptionManager Subscription manager
   */
  constructor(storage: StorageAdapter, subscriptionManager: SubscriptionManager) {
    this.storage = storage;
    this.subscriptionManager = subscriptionManager;
    this.eventHandler = new EventHandler(storage, subscriptionManager);
    this.eventValidator = new EventValidator();
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
      console.error('Error handling message:', error);
      this.sendNotice(clientId, 'Internal error: server error');
    }
  }

  /**
   * Validate Nostr event data
   *
   * @param event Event to validate
   * @returns Whether the event is valid
   */
  private validateEvent(event: NostrEvent): Promise<boolean> {
    return this.eventValidator.validate(event);
  }

  /**
   * Validate filter data
   *
   * @param filter Filter to validate
   * @returns Whether the filter is valid
   */
  private validateFilter(filter: Filter): boolean {
    if (!filter || typeof filter !== 'object') return false;

    // Check for at least one valid filter condition
    const hasValidCondition =
      (filter.ids !== undefined && Array.isArray(filter.ids)) ||
      (filter.authors !== undefined && Array.isArray(filter.authors)) ||
      (filter.kinds !== undefined && Array.isArray(filter.kinds) && filter.kinds.length > 0) ||
      (filter['#e'] !== undefined && Array.isArray(filter['#e'])) ||
      (filter['#p'] !== undefined && Array.isArray(filter['#p'])) ||
      (filter.since !== undefined && typeof filter.since === 'number') ||
      (filter.until !== undefined && typeof filter.until === 'number') ||
      (filter.limit !== undefined && typeof filter.limit === 'number');

    return hasValidCondition;
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

    // Validate event format
    if (!(await this.validateEvent(event))) {
      this.sendOK(clientId, event.id, false, 'invalid: event validation failed');
      return;
    }

    try {
      const { success, message, matches } = await this.eventHandler.handleEvent(event);

      if (!success) {
        this.sendOK(clientId, event.id, false, message);
        return;
      }

      // OK レスポンスの送信
      this.sendOK(clientId, event.id, true);

      // マッチするサブスクリプションへのブロードキャスト
      if (matches) {
        for (const [targetClientId, subscriptions] of matches.entries()) {
          for (const subscription of subscriptions) {
            this.sendEvent(targetClientId, subscription.id, event);
          }
        }
      }
    } catch (error) {
      console.error('Error handling event:', error);
      this.sendOK(clientId, event.id, false, 'error: failed to save event');
    }
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
      if (!this.validateFilter(filter)) {
        this.sendNotice(clientId, `Invalid filter format in subscription ${subscriptionId}`);
        return;
      }
    }

    try {
      // サブスクリプションの作成
      const subscription = this.subscriptionManager.createSubscription(
        clientId,
        subscriptionId,
        filters
      );

      // ローカルログ
      console.log(
        `Created subscription ${subscriptionId} for client ${clientId} with ${filters.length} filters`
      );

      // 既存の一致するイベントの取得と送信
      try {
        // 各フィルタに一致するイベントを取得
        const events = await this.storage.getEvents(filters);

        // イベントをクライアントに送信
        let eventCount = 0;
        for (const event of events) {
          this.sendEvent(clientId, subscriptionId, event);
          eventCount++;
        }

        console.log(`Sent ${eventCount} events for subscription ${subscriptionId}`);
      } catch (error) {
        // ストレージエラーの処理
        console.error(`Failed to get events for subscription ${subscriptionId}:`, error);
        this.sendNotice(clientId, 'Failed to get events: storage error');
        // エラー発生時はEOSEを送信しない
        return;
      }

      // EOSE（End of Stored Events）の送信
      // すべての保存されたイベントが送信されたことをクライアントに通知
      this.sendEOSE(clientId, subscriptionId);
    } catch (error) {
      // サブスクリプション作成エラーの処理
      console.error(`Failed to create subscription ${subscriptionId}:`, error);
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

      if (!removed) {
        // 存在しないサブスクリプションの場合はログだけ残す
        console.log(`Subscription ${subscriptionId} not found for client ${clientId}`);
      }
    } catch (error) {
      console.error('Failed to remove subscription:', error);
      this.sendNotice(clientId, 'Failed to close subscription: Unknown error');
    }
  }

  /**
   * Send an EVENT message to a client
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   * @param event Event to send
   */
  sendEvent(clientId: string, subscriptionId: string, event: NostrEvent): void {
    const message: EventMessage = {
      type: NostrMessageType.EVENT,
      event,
      subscriptionId,
    };
    this.sendResponse(clientId, message);
  }

  /**
   * Send an OK message to a client
   *
   * @param clientId ID of the client to send to
   * @param eventId ID of the event
   * @param success Whether the event was accepted
   * @param message Message to include
   */
  sendOK(clientId: string, eventId: string, success: boolean, message = ''): void {
    const response: OkResponse = {
      type: NostrMessageType.OK,
      eventId,
      success,
      message,
    };
    this.sendResponse(clientId, response);
  }

  /**
   * Send an EOSE message to a client
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   */
  sendEOSE(clientId: string, subscriptionId: string): void {
    const response: EoseResponse = {
      type: NostrMessageType.EOSE,
      subscriptionId,
    };
    this.sendResponse(clientId, response);
  }

  /**
   * Send a CLOSED message to a client
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   * @param message Message to include
   */
  sendClosed(clientId: string, subscriptionId: string, message: string): void {
    const response: ClosedResponse = {
      type: NostrMessageType.CLOSED,
      subscriptionId,
      message,
    };
    this.sendResponse(clientId, response);
  }

  /**
   * Send a NOTICE message to a client
   *
   * @param clientId ID of the client to send to
   * @param message Message to include
   */
  sendNotice(clientId: string, message: string): void {
    const response: NoticeResponse = {
      type: NostrMessageType.NOTICE,
      message,
    };
    this.sendResponse(clientId, response);
  }

  /**
   * Send a response to a client
   *
   * @param clientId ID of the client to send to
   * @param message Message to send
   * @private
   */
  private sendResponse(
    clientId: string,
    message: EventMessage | OkResponse | EoseResponse | ClosedResponse | NoticeResponse
  ): void {
    const wireMessage = messageToWire(message);
    for (const callback of this.responseCallbacks) {
      callback(clientId, wireMessage);
    }
  }

  /**
   * Register a callback for responses
   *
   * @param callback Function to call when a response is sent
   */
  onResponse(callback: (clientId: string, message: NostrWireMessage) => void): void {
    this.responseCallbacks.push(callback);
  }
}
