/**
 * Relay-related type definitions
 */

import {
  RelayConnectHandler,
  RelayDisconnectHandler,
  RelayErrorHandler,
  RelayEventHandler,
} from './message';
import { Filter, NostrEvent, Subscription } from './nostr';

/**
 * Relay connection status
 */
export enum RelayConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

/**
 * Relay connection interface
 */
export interface RelayConnection {
  /**
   * Relay URL
   */
  url: string;

  /**
   * Current connection status
   */
  status: RelayConnectionStatus;

  /**
   * Connect to the relay
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the relay
   */
  disconnect(): Promise<void>;

  /**
   * Subscribe to events matching the given filters
   */
  subscribe(subscription: Subscription): void;

  /**
   * Unsubscribe from a subscription
   */
  unsubscribe(subscriptionId: string): void;

  /**
   * Publish an event to the relay
   */
  publish(event: NostrEvent): Promise<boolean>;

  /**
   * Request events matching the given filters
   */
  request(filters: Filter[]): Promise<NostrEvent[]>;

  /**
   * Add event handler
   */
  on(event: 'connect', callback: RelayConnectHandler): void;
  on(event: 'disconnect', callback: RelayDisconnectHandler): void;
  on(event: 'error', callback: RelayErrorHandler): void;
  on(event: 'event', callback: RelayEventHandler): void;

  /**
   * Remove event handler
   */
  off(event: 'connect', callback: RelayConnectHandler): void;
  off(event: 'disconnect', callback: RelayDisconnectHandler): void;
  off(event: 'error', callback: RelayErrorHandler): void;
  off(event: 'event', callback: RelayEventHandler): void;
}

/**
 * Relay manager interface
 */
export interface RelayManager {
  /**
   * Add a relay to the manager
   */
  addRelay(url: string): RelayConnection;

  /**
   * Remove a relay from the manager
   */
  removeRelay(url: string): void;

  /**
   * Get a relay by URL
   */
  getRelay(url: string): RelayConnection | undefined;

  /**
   * Get all relays
   */
  getRelays(): RelayConnection[];

  /**
   * Connect to all relays
   */
  connectAll(): Promise<void>;

  /**
   * Disconnect from all relays
   */
  disconnectAll(): Promise<void>;

  /**
   * Publish an event to all connected relays
   */
  publish(event: NostrEvent): Promise<string[]>;

  /**
   * Request events from all connected relays
   */
  request(filters: Filter[]): Promise<NostrEvent[]>;
}
