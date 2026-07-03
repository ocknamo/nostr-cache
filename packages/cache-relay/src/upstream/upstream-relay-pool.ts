/**
 * A pool of upstream relay connections.
 *
 * Fans REQ / EVENT / CLOSE out to every configured relay and aggregates their
 * EOSE responses into a single per-subscription EOSE: it fires once every relay
 * that was connected at subscription time has answered (or immediately when no
 * relay was connected). Relays that connect later do not participate in the
 * aggregate, so a slow or down relay never stalls the client's EOSE forever.
 */

import {
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_MAX_CONCURRENT_RELAYS,
  logger,
} from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { UpstreamConnection } from './upstream-connection.js';
import type { UpstreamPool, UpstreamPoolOptions } from './upstream-types.js';

const DEFAULT_RECONNECT_BASE_DELAY = 1000;
const DEFAULT_RECONNECT_MAX_DELAY = 60000;

export class UpstreamRelayPool implements UpstreamPool {
  private readonly connections = new Map<string, UpstreamConnection>();
  /** Relays still owing an EOSE per subscription (empty set → already fired). */
  private readonly pendingEose = new Map<string, Set<string>>();
  private eventCallback?: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void;
  private eoseCallback?: (upstreamSubId: string) => void;
  private started = false;

  constructor(urls: string[], options: UpstreamPoolOptions = {}) {
    const maxRelays = options.maxRelays ?? DEFAULT_MAX_CONCURRENT_RELAYS;
    const webSocketFactory = options.webSocketFactory ?? (() => globalThis.WebSocket);
    const connectionOptions = {
      connectionTimeout: options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
      reconnectBaseDelay: options.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY,
      reconnectMaxDelay: options.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY,
      webSocketFactory,
    };

    // De-duplicate URLs and cap at maxRelays.
    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length > maxRelays) {
      logger.warn(`Upstream: ${uniqueUrls.length} relays configured, using the first ${maxRelays}`);
    }
    for (const url of uniqueUrls.slice(0, maxRelays)) {
      const connection = new UpstreamConnection(url, connectionOptions, {
        onEvent: (subId, event) => this.eventCallback?.(subId, event, url),
        onEose: (subId) => this.handleRelayEose(url, subId),
        onDisconnect: () => this.handleRelayDisconnect(url),
      });
      this.connections.set(url, connection);
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const connection of this.connections.values()) {
      connection.connect();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.pendingEose.clear();
  }

  publish(event: NostrEvent): void {
    for (const connection of this.connections.values()) {
      connection.send(['EVENT', event]);
    }
  }

  openSubscription(upstreamSubId: string, filters: Filter[]): void {
    // Snapshot the relays connected right now; only those owe an EOSE.
    const connectedUrls = new Set<string>();
    for (const [url, connection] of this.connections) {
      if (connection.isConnected()) {
        connectedUrls.add(url);
      }
    }
    this.pendingEose.set(upstreamSubId, connectedUrls);

    for (const connection of this.connections.values()) {
      connection.openSubscription(upstreamSubId, filters);
    }

    // No relay connected → nothing will ever answer; fire EOSE on the next tick.
    if (connectedUrls.size === 0) {
      queueMicrotask(() => {
        // Guard against a CLOSE that arrived before the microtask ran.
        if (this.pendingEose.get(upstreamSubId)?.size === 0) {
          this.fireEose(upstreamSubId);
        }
      });
    }
  }

  closeSubscription(upstreamSubId: string): void {
    this.pendingEose.delete(upstreamSubId);
    for (const connection of this.connections.values()) {
      connection.closeSubscription(upstreamSubId);
    }
  }

  onEvent(callback: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void): void {
    this.eventCallback = callback;
  }

  onEose(callback: (upstreamSubId: string) => void): void {
    this.eoseCallback = callback;
  }

  getConnectedCount(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.isConnected()) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * A relay dropped: it can no longer answer EOSE for any open subscription, so
   * stop waiting on it. Remove it from every pending set and fire the aggregated
   * EOSE for subscriptions that are now complete — otherwise a relay that goes
   * away mid-REQ would stall the client's EOSE until the coordinator timeout.
   */
  private handleRelayDisconnect(relayUrl: string): void {
    const toFire: string[] = [];
    for (const [upstreamSubId, pending] of this.pendingEose) {
      if (pending.delete(relayUrl) && pending.size === 0) {
        toFire.push(upstreamSubId);
      }
    }
    for (const upstreamSubId of toFire) {
      this.fireEose(upstreamSubId);
    }
  }

  /** Record a relay's EOSE and, once all pending relays have answered, fire once. */
  private handleRelayEose(relayUrl: string, upstreamSubId: string): void {
    const pending = this.pendingEose.get(upstreamSubId);
    if (!pending) {
      // Already fired, or the subscription was closed.
      return;
    }
    pending.delete(relayUrl);
    if (pending.size === 0) {
      this.fireEose(upstreamSubId);
    }
  }

  /** Emit the aggregated EOSE exactly once, then forget the pending set. */
  private fireEose(upstreamSubId: string): void {
    if (!this.pendingEose.has(upstreamSubId)) {
      return;
    }
    this.pendingEose.delete(upstreamSubId);
    this.eoseCallback?.(upstreamSubId);
  }
}
