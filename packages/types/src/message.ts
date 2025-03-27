import type { Filter, NostrEvent } from './nostr.js';

/**
 * Nostr message types as defined in NIP-01
 */
export const NostrMessageType = {
  EVENT: 'EVENT',
  REQ: 'REQ',
  CLOSE: 'CLOSE',
  OK: 'OK',
  EOSE: 'EOSE',
  CLOSED: 'CLOSED',
  NOTICE: 'NOTICE',
} as const;

export type NostrMessageType = (typeof NostrMessageType)[keyof typeof NostrMessageType];

/**
 * Nostr wire format message types (array format used in WebSocket communication)
 */
export type NostrWireMessage =
  | ['EVENT', NostrEvent]
  | ['EVENT', string, NostrEvent]
  | ['REQ', string, ...Filter[]]
  | ['CLOSE', string]
  | ['OK', string, boolean, string?]
  | ['EOSE', string]
  | ['CLOSED', string, string?]
  | ['NOTICE', string];

/**
 * Base interface for all Nostr messages
 */
export interface NostrMessage {
  type: NostrMessageType;
}

/**
 * EVENT message for publishing new events
 */
export interface EventMessage extends NostrMessage {
  type: typeof NostrMessageType.EVENT;
  event: NostrEvent;
  subscriptionId?: string;
}

/**
 * REQ message for requesting events with filters
 */
export interface ReqMessage extends NostrMessage {
  type: typeof NostrMessageType.REQ;
  subscriptionId: string;
  filters: Filter[];
}

/**
 * CLOSE message for closing a subscription
 */
export interface CloseMessage extends NostrMessage {
  type: typeof NostrMessageType.CLOSE;
  subscriptionId: string;
}

/**
 * OK response for event publication
 */
export interface OkResponse extends NostrMessage {
  type: typeof NostrMessageType.OK;
  eventId: string;
  success: boolean;
  message?: string;
}

/**
 * EOSE (End of Stored Events) response
 */
export interface EoseResponse extends NostrMessage {
  type: typeof NostrMessageType.EOSE;
  subscriptionId: string;
}

/**
 * CLOSED response for subscription termination
 */
export interface ClosedResponse extends NostrMessage {
  type: typeof NostrMessageType.CLOSED;
  subscriptionId: string;
  message?: string;
}

/**
 * NOTICE response for general notifications
 */
export interface NoticeResponse extends NostrMessage {
  type: typeof NostrMessageType.NOTICE;
  message: string;
}

/**
 * Union type of all possible Nostr messages
 */
export type NostrMessageUnion = EventMessage | ReqMessage | CloseMessage;

/**
 * Union type of all possible Nostr responses
 */
export type NostrResponseUnion = OkResponse | EoseResponse | ClosedResponse | NoticeResponse;

/**
 * Relay event handlers
 */
export type RelayConnectHandler = () => void;
export type RelayDisconnectHandler = () => void;
export type RelayErrorHandler = (error: Error) => void;
export type RelayEventHandler = (event: NostrEvent) => void;
export type RelayEoseHandler = (subscriptionId: string) => void;

/**
 * Type guards for message types
 */
export function isEventMessage(
  message: NostrMessageUnion | NostrResponseUnion
): message is EventMessage {
  return message.type === NostrMessageType.EVENT;
}

export function isReqMessage(
  message: NostrMessageUnion | NostrResponseUnion
): message is ReqMessage {
  return message.type === NostrMessageType.REQ;
}

export function isCloseMessage(
  message: NostrMessageUnion | NostrResponseUnion
): message is CloseMessage {
  return message.type === NostrMessageType.CLOSE;
}

export function isOkResponse(
  message: NostrMessageUnion | NostrResponseUnion
): message is OkResponse {
  return message.type === NostrMessageType.OK;
}

export function isEoseResponse(
  message: NostrMessageUnion | NostrResponseUnion
): message is EoseResponse {
  return message.type === NostrMessageType.EOSE;
}

export function isClosedResponse(
  message: NostrMessageUnion | NostrResponseUnion
): message is ClosedResponse {
  return message.type === NostrMessageType.CLOSED;
}

export function isNoticeResponse(
  message: NostrMessageUnion | NostrResponseUnion
): message is NoticeResponse {
  return message.type === NostrMessageType.NOTICE;
}

/**
 * Convert wire format message to internal message format
 */
export function wireToMessage(wire: NostrWireMessage): NostrMessageUnion | NostrResponseUnion {
  const [type, ...params] = wire;

  switch (type) {
    case NostrMessageType.EVENT: {
      if (params.length === 1) {
        return {
          type: NostrMessageType.EVENT,
          event: params[0] as NostrEvent,
        };
      }
      return {
        type: NostrMessageType.EVENT,
        subscriptionId: params[0] as string,
        event: params[1] as NostrEvent,
      };
    }
    case NostrMessageType.REQ:
      return {
        type: NostrMessageType.REQ,
        subscriptionId: params[0] as string,
        filters: params.slice(1) as Filter[],
      };
    case NostrMessageType.CLOSE:
      return {
        type: NostrMessageType.CLOSE,
        subscriptionId: params[0] as string,
      };
    case NostrMessageType.OK:
      return {
        type: NostrMessageType.OK,
        eventId: params[0] as string,
        success: params[1] as boolean,
        message: params[2] as string | undefined,
      };
    case NostrMessageType.EOSE:
      return {
        type: NostrMessageType.EOSE,
        subscriptionId: params[0] as string,
      };
    case NostrMessageType.CLOSED:
      return {
        type: NostrMessageType.CLOSED,
        subscriptionId: params[0] as string,
        message: params[1] as string | undefined,
      };
    case NostrMessageType.NOTICE:
      return {
        type: NostrMessageType.NOTICE,
        message: params[0] as string,
      };
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

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
