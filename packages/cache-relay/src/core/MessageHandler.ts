/**
 * Message handler for Nostr Cache Relay
 *
 * Handles incoming messages from clients
 */

import {
  CloseMessage,
  EoseMessage,
  EventMessage,
  Filter,
  NostrEvent,
  NostrMessage,
  NoticeMessage,
  OkMessage,
  ReqMessage,
} from '@nostr-cache/types';
import { EventValidator } from '../event/EventValidator';

/**
 * Message handler class
 * Handles incoming messages from clients
 */
export class MessageHandler {
  private eventValidator: EventValidator;
  private responseCallbacks: ((clientId: string, message: NostrMessage) => void)[] = [];

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
   * @param message Message received
   */
  handleMessage(clientId: string, message: NostrMessage): void {
    if (!Array.isArray(message) || message.length === 0) {
      this.sendNotice(clientId, 'Invalid message format');
      return;
    }

    const messageType = message[0];

    switch (messageType) {
      case 'EVENT':
        this.handleEventMessage(clientId, message as EventMessage);
        break;
      case 'REQ':
        this.handleReqMessage(clientId, message as ReqMessage);
        break;
      case 'CLOSE':
        this.handleCloseMessage(clientId, message as CloseMessage);
        break;
      default:
        this.sendNotice(clientId, `Unknown message type: ${messageType}`);
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

    if (message.length < 2) {
      this.sendNotice(clientId, 'Invalid EVENT message format');
      return;
    }

    const event = message[1];

    // Validate the event
    if (!this.eventValidator.validate(event)) {
      this.sendOK(clientId, event.id, false, 'invalid: event validation failed');
      return;
    }

    // For now, just acknowledge the event
    this.sendOK(clientId, event.id, true, '');
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

    if (message.length < 3) {
      this.sendNotice(clientId, 'Invalid REQ message format');
      return;
    }

    const subscriptionId = message[1];
    const filters = message.slice(2);

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

    if (message.length < 2) {
      this.sendNotice(clientId, 'Invalid CLOSE message format');
      return;
    }

    const subscriptionId = message[1];

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
    this.sendResponse(clientId, ['EVENT', subscriptionId, event]);
  }

  /**
   * Send an OK message to a client
   *
   * @param clientId ID of the client to send to
   * @param eventId ID of the event
   * @param accepted Whether the event was accepted
   * @param message Message to include
   */
  sendOK(clientId: string, eventId: string, accepted: boolean, message: string): void {
    this.sendResponse(clientId, ['OK', eventId, accepted, message]);
  }

  /**
   * Send an EOSE message to a client
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   */
  sendEOSE(clientId: string, subscriptionId: string): void {
    this.sendResponse(clientId, ['EOSE', subscriptionId]);
  }

  /**
   * Send a CLOSED message to a client
   *
   * @param clientId ID of the client to send to
   * @param subscriptionId Subscription ID
   * @param message Message to include
   */
  sendClosed(clientId: string, subscriptionId: string, message: string): void {
    this.sendResponse(clientId, ['CLOSED', subscriptionId, message]);
  }

  /**
   * Send a NOTICE message to a client
   *
   * @param clientId ID of the client to send to
   * @param message Message to include
   */
  sendNotice(clientId: string, message: string): void {
    this.sendResponse(clientId, ['NOTICE', message]);
  }

  /**
   * Send a response to a client
   *
   * @param clientId ID of the client to send to
   * @param message Message to send
   * @private
   */
  private sendResponse(clientId: string, message: any[]): void {
    for (const callback of this.responseCallbacks) {
      callback(clientId, message as NostrMessage);
    }
  }

  /**
   * Register a callback for responses
   *
   * @param callback Function to call when a response is sent
   */
  onResponse(callback: (clientId: string, message: NostrMessage) => void): void {
    this.responseCallbacks.push(callback);
  }
}
