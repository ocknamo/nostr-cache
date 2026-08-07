/**
 * Transport adapter interface for Nostr Cache Relay
 */

import type { NostrWireMessage } from '@nostr-cache/shared';

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
  send(clientId: string, message: NostrWireMessage): void;

  /**
   * Register a callback for incoming messages
   *
   * @param callback Function to call when a message is received
   */
  onMessage(callback: (clientId: string, message: NostrWireMessage) => void): void;

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

  /**
   * Get the number of currently connected clients
   *
   * @returns The number of active client connections
   */
  getConnectionCount(): number;

  /**
   * Return the port this transport is actually listening on.
   *
   * Transports that bind a real socket should read the port off the live
   * server, so that starting with port 0 (let the OS pick a free port) can be
   * resolved back to the concrete port by the caller. This is the only
   * collision-free way to pick a port; guessing one and hoping it is free
   * races with every other process on the machine.
   *
   * Optional: transports with no network port (e.g. the browser emulator) omit
   * it, and callers should treat that as "no port".
   *
   * @returns The bound port, or null when not listening / not applicable
   */
  getBoundPort?(): number | null;

  /**
   * Return the original `WebSocket` constructor for transports that replace the
   * global one (i.e. the browser emulator). The upstream relay connector uses
   * this to reach real relays without going through the patched global — which
   * would otherwise route an upstream URL that the emulator also intercepts
   * back into the local relay (a self-connection loop).
   *
   * Optional: transports that never patch the global (e.g. the Node.js
   * `WebSocketServer`) may omit it, and callers should fall back to
   * `globalThis.WebSocket`.
   *
   * @returns The pre-patch `WebSocket` constructor, or undefined when unknown
   */
  getOriginalWebSocket?(): typeof WebSocket | undefined;
}
