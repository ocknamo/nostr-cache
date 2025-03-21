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
  }

  /**
   * Handle an incoming message
   *
   * @param clientId ID of the client that sent the message
   * @param wireMessage Message received in wire format
   */
  handleMessage(clientId: string, wireMessage: NostrWireMessage): void {
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
        this.handleEventMessage(clientId, { type, event: wireMessage[1] } as EventMessage);
        break;
      case NostrMessageType.REQ:
        if (wireMessage.length < 2) {
          this.sendNotice(clientId, 'Invalid REQ message format');
          return;
        }
        this.handleReqMessage(clientId, {
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
        this.handleCloseMessage(clientId, { type, subscriptionId: wireMessage[1] } as CloseMessage);
        break;
      default:
        this.sendNotice(clientId, 'Unknown message type: UNKNOWN');
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

    // イベントの処理
    const { success, matches } = await this.eventHandler.handleEvent(event);

    if (!success) {
      this.sendOK(clientId, event.id, false, 'invalid: event validation failed');
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
  }

  /**
   * Handle REQ message
   *
   * @param clientId ID of the client that sent the message
   * @param message Message received
   * @private
   */
  private async handleReqMessage(clientId: string, message: ReqMessage): Promise<void> {
    if (!message.subscriptionId || !Array.isArray(message.filters)) {
      this.sendNotice(clientId, 'Invalid REQ message format');
      return;
    }

    const { subscriptionId, filters } = message;

    // サブスクリプションの作成
    const subscription = this.subscriptionManager.createSubscription(
      clientId,
      subscriptionId,
      filters
    );

    // 既存のイベントの取得と送信
    try {
      const events = await this.storage.getEvents(filters);
      for (const event of events) {
        this.sendEvent(clientId, subscriptionId, event);
      }
    } catch (error) {
      console.error('Failed to get events:', error);
    }

    // EOSEの送信
    this.sendEOSE(clientId, subscriptionId);
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

    // サブスクリプションの削除
    const removed = this.subscriptionManager.removeSubscription(clientId, subscriptionId);
    if (removed) {
      this.sendClosed(clientId, subscriptionId, 'subscription closed');
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
