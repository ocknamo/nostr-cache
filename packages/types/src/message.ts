/**
 * Nostr message type definitions
 */

import { Filter, NostrEvent } from './nostr';

/**
 * Nostr message types
 */
export type NostrMessageType = 'EVENT' | 'REQ' | 'CLOSE' | 'NOTICE' | 'OK' | 'EOSE' | 'CLOSED';

/**
 * Base Nostr message
 */
export type NostrMessage = EventMessage | ReqMessage | CloseMessage | NoticeMessage | OkMessage | EoseMessage | ClosedMessage;

/**
 * EVENT message: Client to relay to publish an event
 * ["EVENT", <event JSON>]
 */
export type EventMessage = [type: 'EVENT', event: NostrEvent];

/**
 * REQ message: Client to relay to request events and subscribe
 * ["REQ", <subscription_id>, <filter JSON>, <filter JSON>...]
 */
export type ReqMessage = [type: 'REQ', subscriptionId: string, ...filters: Filter[]];

/**
 * CLOSE message: Client to relay to stop a subscription
 * ["CLOSE", <subscription_id>]
 */
export type CloseMessage = [type: 'CLOSE', subscriptionId: string];

/**
 * NOTICE message: Relay to client to send human-readable messages
 * ["NOTICE", <message>]
 */
export type NoticeMessage = [type: 'NOTICE', message: string];

/**
 * OK message: Relay to client to acknowledge an EVENT
 * ["OK", <event_id>, <success>, <message>]
 */
export type OkMessage = [type: 'OK', eventId: string, success: boolean, message: string];

/**
 * EOSE message: Relay to client to indicate end of stored events
 * ["EOSE", <subscription_id>]
 */
export type EoseMessage = [type: 'EOSE', subscriptionId: string];

/**
 * CLOSED message: Relay to client to indicate a subscription was closed
 * ["CLOSED", <subscription_id>, <message>]
 */
export type ClosedMessage = [type: 'CLOSED', subscriptionId: string, message: string];

/**
 * Event handler type for relay events
 */
export type RelayEventHandler = (event: NostrEvent) => void;

/**
 * Connect handler type for relay connections
 */
export type RelayConnectHandler = () => void;

/**
 * Disconnect handler type for relay disconnections
 */
export type RelayDisconnectHandler = () => void;

/**
 * Error handler type for relay errors
 */
export type RelayErrorHandler = (error: Error) => void;

/**
 * EOSE handler type for relay end of stored events
 */
export type RelayEoseHandler = (subscriptionId: string) => void;
