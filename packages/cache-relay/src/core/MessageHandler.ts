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
import { EventValidator } from '../event/EventValidator';

/**
 * Message handler class
 * Handles incoming messages from clients
 */
export class MessageHandler {
  private eventValidator: EventValidator;
  private responseCallbacks: ((clientId: string, message: NostrWireMessage) => void)[] = [];

  /**
   * Create a new MessageHandler instance
   *
   * @param eventValidator Event validator
   */
  constructor(eventValidator: EventValidator) {
    this.eventValidator = eventValidator;
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
  private handleEventMessage(clientId: string, message: EventMessage): void {
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Validate the event
    // 2. Store the event
    // 3. Send OK message
    // 4. Broadcast the event to subscribers

    const event = message.event;

    // Validate the event
    if (!this.eventValidator.validate(event)) {
      this.sendOK(clientId, event.id, false, 'invalid: event validation failed');
      return;
    }

    // For now, just acknowledge the event
    this.sendOK(clientId, event.id, true);
  }

  /**
   * Handle REQ message
   *
   * @param clientId ID of the client that sent the message
   * @param message Message received
   * @private
   */
  private handleReqMessage(clientId: string, message: ReqMessage): void {
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Parse the subscription ID and filters
    // 2. Create a subscription
    // 3. Send matching events
    // 4. Send EOSE message

    if (!message.subscriptionId || !Array.isArray(message.filters)) {
      this.sendNotice(clientId, 'Invalid REQ message format');
      return;
    }

    const { subscriptionId, filters } = message;

    // For now, just acknowledge the subscription
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
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Parse the subscription ID
    // 2. Close the subscription

    if (!message.subscriptionId) {
      this.sendNotice(clientId, 'Invalid CLOSE message format');
      return;
    }

    const { subscriptionId } = message;

    // For now, just log the close
    console.log(`Client ${clientId} closed subscription ${subscriptionId}`);
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
