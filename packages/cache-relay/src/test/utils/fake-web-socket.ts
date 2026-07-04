/**
 * Controllable fake `WebSocket` for upstream-layer unit tests.
 *
 * Instances never touch the network. Tests drive the lifecycle explicitly
 * (`mockOpen`, `mockMessage`, `mockClose`, `mockError`) and inspect what the
 * code under test sent (`sent`). `createFakeWebSocketFactory` returns a factory
 * plus the registry of every constructed socket, which is what the upstream
 * connection/pool accept via their `webSocketFactory` option.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class FakeWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readyState: number = CONNECTING;
  readonly url: string;
  /** Every payload passed to `send()`, as parsed JSON. */
  readonly sent: unknown[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = url.toString();
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === CLOSED) {
      return;
    }
    this.readyState = CLOSED;
  }

  /** Transition to OPEN and fire onopen. */
  mockOpen(): void {
    this.readyState = OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Deliver a wire message to the socket owner. */
  mockMessage(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  /** Fire onerror without changing readyState. */
  mockError(): void {
    this.onerror?.(new Event('error'));
  }

  /** Transition to CLOSED and fire onclose. */
  mockClose(): void {
    this.readyState = CLOSED;
    this.onclose?.(new Event('close'));
  }
}

export interface FakeWebSocketFactory {
  /** Factory to pass as `webSocketFactory`. */
  factory: () => typeof WebSocket;
  /** Every socket constructed so far, in order. */
  sockets: FakeWebSocket[];
  /** The most recently constructed socket. */
  last(): FakeWebSocket;
}

export function createFakeWebSocketFactory(): FakeWebSocketFactory {
  const sockets: FakeWebSocket[] = [];
  const Ctor = class extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  };
  return {
    factory: () => Ctor as unknown as typeof WebSocket,
    sockets,
    last: () => sockets[sockets.length - 1],
  };
}
