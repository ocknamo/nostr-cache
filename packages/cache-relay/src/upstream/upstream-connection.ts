/**
 * A single connection to one upstream Nostr relay.
 *
 * Owns the WebSocket lifecycle for that relay: connecting (with a timeout),
 * exponential-backoff reconnection, and re-establishing active subscriptions
 * (re-sending their REQ) after a reconnect. Received EVENT / EOSE messages are
 * surfaced through callbacks; OK / NOTICE / CLOSED are logged only.
 *
 * Uses only the standard `WebSocket` API so it runs unchanged on Node.js
 * (native `globalThis.WebSocket`) and in the browser.
 */

import { logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent, NostrWireMessage } from '@nostr-cache/shared';

/** Callbacks the connection reports upstream activity through. */
export interface UpstreamConnectionHandlers {
  /** An EVENT arrived for the given subscription id. */
  onEvent(upstreamSubId: string, event: NostrEvent): void;
  /** EOSE arrived for the given subscription id. */
  onEose(upstreamSubId: string): void;
  /** The connection became established (initial connect or a reconnect). */
  onConnect?(): void;
  /** The connection was lost (before a reconnect attempt). */
  onDisconnect?(): void;
}

/** Tuning for a single connection. */
export interface UpstreamConnectionOptions {
  connectionTimeout: number;
  reconnectBaseDelay: number;
  reconnectMaxDelay: number;
  /** Lazy factory for the `WebSocket` constructor (evaluated per connect). */
  webSocketFactory: () => typeof WebSocket;
}

const OPEN = 1;

export class UpstreamConnection {
  private ws?: WebSocket;
  private readonly activeSubscriptions = new Map<string, Filter[]>();
  private reconnectAttempts = 0;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** When true, no further (re)connects are scheduled. */
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly options: UpstreamConnectionOptions,
    private readonly handlers: UpstreamConnectionHandlers
  ) {}

  /** Start connecting. Safe to call once; reconnection is automatic thereafter. */
  connect(): void {
    this.closed = false;
    this.open();
  }

  /** Stop reconnecting and close the socket. */
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.teardownSocket();
  }

  /** Whether the socket is currently established. */
  isConnected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  /** Send a raw wire message. Dropped (with a debug log) unless the socket is open. */
  send(message: NostrWireMessage): void {
    if (this.ws?.readyState !== OPEN) {
      logger.debug(`Upstream ${this.url}: dropped message (socket not open)`);
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      logger.debug(`Upstream ${this.url}: send failed:`, error);
    }
  }

  /**
   * Track and open a subscription. The filters are remembered so the REQ is
   * re-sent automatically after a reconnect.
   */
  openSubscription(upstreamSubId: string, filters: Filter[]): void {
    this.activeSubscriptions.set(upstreamSubId, filters);
    this.send(['REQ', upstreamSubId, ...filters]);
  }

  /** Stop tracking a subscription and send CLOSE. */
  closeSubscription(upstreamSubId: string): void {
    if (this.activeSubscriptions.delete(upstreamSubId)) {
      this.send(['CLOSE', upstreamSubId]);
    }
  }

  /**
   * Open the socket and wire its event handlers. A connect timeout forces a
   * reconnect if the socket never opens.
   */
  private open(): void {
    let ws: WebSocket;
    try {
      const WebSocketCtor = this.options.webSocketFactory();
      ws = new WebSocketCtor(this.url);
    } catch (error) {
      logger.debug(`Upstream ${this.url}: construction failed:`, error);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== OPEN) {
        logger.debug(`Upstream ${this.url}: connect timed out`);
        // Force onclose → reconnect. Detach handlers so the stale socket is inert.
        this.dropSocket(ws);
        this.scheduleReconnect();
      }
    }, this.options.connectionTimeout);

    ws.onopen = () => {
      this.clearConnectTimer();
      this.reconnectAttempts = 0;
      logger.info(`Upstream ${this.url}: connected`);
      this.handlers.onConnect?.();
      // Re-establish every active subscription on this (re)connection.
      for (const [subId, filters] of this.activeSubscriptions) {
        this.send(['REQ', subId, ...filters]);
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      logger.debug(`Upstream ${this.url}: socket error`);
      // The browser fires error before close; let onclose drive the reconnect.
    };

    ws.onclose = () => {
      this.clearConnectTimer();
      if (this.ws === ws) {
        this.ws = undefined;
      }
      this.handlers.onDisconnect?.();
      this.scheduleReconnect();
    };
  }

  /** Parse and dispatch a received message; only EVENT and EOSE are acted on. */
  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      logger.debug(`Upstream ${this.url}: dropped unparseable message`);
      return;
    }
    if (!Array.isArray(message) || message.length < 2) {
      return;
    }

    const [type] = message as [string, ...unknown[]];
    switch (type) {
      case 'EVENT': {
        const subId = message[1];
        const event = message[2];
        if (typeof subId === 'string' && event && typeof event === 'object') {
          this.handlers.onEvent(subId, event as NostrEvent);
        }
        break;
      }
      case 'EOSE': {
        const subId = message[1];
        if (typeof subId === 'string') {
          this.handlers.onEose(subId);
        }
        break;
      }
      default:
        // OK / NOTICE / CLOSED / unknown: informational only.
        logger.debug(`Upstream ${this.url}: ${String(type)} message`);
    }
  }

  /** Schedule the next reconnect using exponential backoff, unless closed. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      this.options.reconnectBaseDelay * 2 ** this.reconnectAttempts,
      this.options.reconnectMaxDelay
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) {
        this.open();
      }
    }, delay);
  }

  /** Detach handlers and close a socket without triggering our onclose logic. */
  private dropSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // ignore
    }
    if (this.ws === ws) {
      this.ws = undefined;
    }
  }

  private teardownSocket(): void {
    if (this.ws) {
      this.dropSocket(this.ws);
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
