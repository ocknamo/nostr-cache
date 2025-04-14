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
