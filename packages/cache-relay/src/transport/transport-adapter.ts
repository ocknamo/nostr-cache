/** Transport adapter interface for Nostr Cache Relay */

import type { NostrWireMessage } from '@nostr-cache/shared';

/**
 * Transport adapter interface
 * Defines the contract for transport implementations (WebSocket, etc.)
 */
export interface TransportAdapter {
  start(): Promise<void>;

  stop(): Promise<void>;

  send(clientId: string, message: NostrWireMessage): void;

  onMessage(callback: (clientId: string, message: NostrWireMessage) => void): void;

  onConnect(callback: (clientId: string) => void): void;

  onDisconnect(callback: (clientId: string) => void): void;

  getConnectionCount(): number;

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
   */
  getOriginalWebSocket?(): typeof WebSocket | undefined;
}
