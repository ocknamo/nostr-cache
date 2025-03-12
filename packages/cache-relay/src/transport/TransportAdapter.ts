/**
 * Transport adapter interface for Nostr Cache Relay
 */

import { NostrMessage } from '@nostr-cache/types';

/**
 * Transport adapter interface
 * Defines the contract for transport implementations (WebSocket, etc.)
 */
export interface TransportAdapter {
  /**
   * Start the transport
   *
   * @returns Promise resolving when transport is started
   */
  start(): Promise<void>;

  /**
   * Stop the transport
   *
   * @returns Promise resolving when transport is stopped
   */
  stop(): Promise<void>;

  /**
   * Send a message to a client
   *
   * @param clientId ID of the client to send the message to
   * @param message Message to send (will be JSON stringified)
   */
  send(clientId: string, message: NostrMessage): void;

  /**
   * Register a callback for incoming messages
   *
   * @param callback Function to call when a message is received
   */
  onMessage(callback: (clientId: string, message: NostrMessage) => void): void;

  /**
   * Register a callback for client connections
   *
   * @param callback Function to call when a client connects
   */
  onConnect(callback: (clientId: string) => void): void;

  /**
   * Register a callback for client disconnections
   *
   * @param callback Function to call when a client disconnects
   */
  onDisconnect(callback: (clientId: string) => void): void;
}
