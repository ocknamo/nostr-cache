/**
 * Client responder for Nostr Cache Relay
 *
 * Owns the relay-to-client response mechanism: the registry of transport
 * callbacks and the sending of each response message type (EVENT / OK / EOSE /
 * CLOSED / NOTICE). Keeping this separate from {@link MessageHandler} isolates
 * "how a response reaches the client" from "how an incoming message is handled".
 */

import {
  type ClosedResponse,
  type EoseResponse,
  type EventMessage,
  type NostrEvent,
  NostrMessageType,
  type NostrWireMessage,
  type NoticeResponse,
  type OkResponse,
  messageToWire,
} from '@nostr-cache/shared';

/** Dispatches responses to registered client transport callbacks. */
export class ClientResponder {
  private responseCallbacks: ((clientId: string, message: NostrWireMessage) => void)[] = [];

  sendEvent(clientId: string, subscriptionId: string, event: NostrEvent): void {
    const message: EventMessage = {
      type: NostrMessageType.EVENT,
      event,
      subscriptionId,
    };
    this.sendResponse(clientId, message);
  }

  sendOK(clientId: string, eventId: string, success: boolean, message = ''): void {
    const response: OkResponse = {
      type: NostrMessageType.OK,
      eventId,
      success,
      message,
    };
    this.sendResponse(clientId, response);
  }

  sendEOSE(clientId: string, subscriptionId: string): void {
    const response: EoseResponse = {
      type: NostrMessageType.EOSE,
      subscriptionId,
    };
    this.sendResponse(clientId, response);
  }

  sendClosed(clientId: string, subscriptionId: string, message: string): void {
    const response: ClosedResponse = {
      type: NostrMessageType.CLOSED,
      subscriptionId,
      message,
    };
    this.sendResponse(clientId, response);
  }

  sendNotice(clientId: string, message: string): void {
    const response: NoticeResponse = {
      type: NostrMessageType.NOTICE,
      message,
    };
    this.sendResponse(clientId, response);
  }

  /** Register a callback for responses */
  onResponse(callback: (clientId: string, message: NostrWireMessage) => void): void {
    this.responseCallbacks.push(callback);
  }

  private sendResponse(
    clientId: string,
    message: EventMessage | OkResponse | EoseResponse | ClosedResponse | NoticeResponse
  ): void {
    const wireMessage = messageToWire(message);
    for (const callback of this.responseCallbacks) {
      callback(clientId, wireMessage);
    }
  }
}
