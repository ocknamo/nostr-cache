import {
  NostrMessageType,
  type NostrMessageUnion,
  type NostrResponseUnion,
  type NostrWireMessage,
  isCloseMessage,
  isClosedResponse,
  isEoseResponse,
  isEventMessage,
  isNoticeResponse,
  isOkResponse,
  isReqMessage,
} from '../types/message.js';

/**
 * Convert internal message format to wire format
 */
export function messageToWire(message: NostrMessageUnion | NostrResponseUnion): NostrWireMessage {
  if (isEventMessage(message)) {
    return message.subscriptionId
      ? [NostrMessageType.EVENT, message.subscriptionId, message.event]
      : [NostrMessageType.EVENT, message.event];
  }
  if (isReqMessage(message)) {
    return [NostrMessageType.REQ, message.subscriptionId, ...message.filters];
  }
  if (isCloseMessage(message)) {
    return [NostrMessageType.CLOSE, message.subscriptionId];
  }
  if (isOkResponse(message)) {
    return [NostrMessageType.OK, message.eventId, message.success, message.message || ''];
  }
  if (isEoseResponse(message)) {
    return [NostrMessageType.EOSE, message.subscriptionId];
  }
  if (isClosedResponse(message)) {
    return message.message
      ? [NostrMessageType.CLOSED, message.subscriptionId, message.message]
      : [NostrMessageType.CLOSED, message.subscriptionId];
  }
  if (isNoticeResponse(message)) {
    return [NostrMessageType.NOTICE, message.message];
  }
  throw new Error('Unknown message type');
}
