import type { Filter, NostrEvent, NostrWireMessage } from '@nostr-cache/shared';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SubscriptionHandlers {
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
  onClosed?: (message?: string) => void;
}

export interface RelayConnectionOptions {
  /** WebSocket constructor to use (defaults to globalThis.WebSocket) */
  webSocketCtor?: typeof WebSocket;
  onStatusChange?: (status: ConnectionStatus) => void;
  onNotice?: (message: string) => void;
  onOk?: (eventId: string, accepted: boolean, message?: string) => void;
}

const READY_STATE_OPEN = 1;

/**
 * Minimal NIP-01 relay client over a WebSocket.
 *
 * Framework-agnostic: all UI state is driven through the callbacks in
 * {@link RelayConnectionOptions} and {@link SubscriptionHandlers}. The
 * WebSocket constructor is injectable for tests. No automatic reconnect:
 * the caller re-invokes connect() (and re-subscribes) when needed.
 */
export class RelayConnection {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, SubscriptionHandlers>();
  private status: ConnectionStatus = 'disconnected';
  private readonly options: RelayConnectionOptions;

  constructor(options: RelayConnectionOptions = {}) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === READY_STATE_OPEN;
  }

  /**
   * Connect to a relay. Resolves once the socket is open; rejects if the
   * socket errors or closes before opening. An existing connection is closed
   * first.
   */
  connect(url: string): Promise<void> {
    this.disconnect();
    const Ctor = this.options.webSocketCtor ?? globalThis.WebSocket;
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new Ctor(url);
      } catch (error) {
        this.setStatus('error');
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.ws = ws;
      let settled = false;

      ws.onopen = () => {
        settled = true;
        this.setStatus('connected');
        resolve();
      };
      ws.onmessage = (event) => {
        this.handleMessage(String(event.data));
      };
      ws.onerror = () => {
        this.setStatus('error');
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to connect to ${url}`));
        }
      };
      ws.onclose = () => {
        // Server-side subscriptions die with the socket.
        this.subscriptions.clear();
        if (this.ws === ws) {
          this.ws = null;
        }
        if (!settled) {
          settled = true;
          this.setStatus('error');
          reject(new Error(`Connection to ${url} closed before opening`));
        } else if (this.status !== 'error') {
          this.setStatus('disconnected');
        }
      };
    });
  }

  /**
   * Close the connection (if any) and drop all subscriptions.
   */
  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    this.subscriptions.clear();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
      this.setStatus('disconnected');
    }
  }

  /**
   * Open a subscription: sends REQ and routes matching EVENT/EOSE/CLOSED
   * messages to the given handlers.
   */
  subscribe(subId: string, filters: Filter[], handlers: SubscriptionHandlers): void {
    this.subscriptions.set(subId, handlers);
    this.send(['REQ', subId, ...filters]);
  }

  /**
   * Close a subscription: sends CLOSE and stops routing its messages.
   */
  unsubscribe(subId: string): void {
    if (this.subscriptions.delete(subId)) {
      this.send(['CLOSE', subId]);
    }
  }

  /**
   * Publish an event. The result arrives via the onOk callback.
   */
  publish(event: NostrEvent): void {
    this.send(['EVENT', event]);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private send(message: NostrWireMessage): void {
    if (!this.isConnected || !this.ws) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // Ignore malformed JSON.
    }
    if (!Array.isArray(message) || typeof message[0] !== 'string') {
      return;
    }

    switch (message[0]) {
      case 'EVENT': {
        // Relay-to-client EVENT always carries the subscription ID.
        const [, subId, event] = message as ['EVENT', string, NostrEvent];
        if (event && typeof event === 'object') {
          this.subscriptions.get(subId)?.onEvent(event);
        }
        break;
      }
      case 'EOSE': {
        const [, subId] = message as ['EOSE', string];
        this.subscriptions.get(subId)?.onEose?.();
        break;
      }
      case 'CLOSED': {
        const [, subId, reason] = message as ['CLOSED', string, string?];
        const handlers = this.subscriptions.get(subId);
        this.subscriptions.delete(subId);
        handlers?.onClosed?.(reason);
        break;
      }
      case 'NOTICE': {
        const [, notice] = message as ['NOTICE', string];
        this.options.onNotice?.(notice);
        break;
      }
      case 'OK': {
        const [, eventId, accepted, reason] = message as ['OK', string, boolean, string?];
        this.options.onOk?.(eventId, accepted, reason);
        break;
      }
      default:
        break; // Ignore unknown message types.
    }
  }
}
