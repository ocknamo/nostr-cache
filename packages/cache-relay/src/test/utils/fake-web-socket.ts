/**
 * Controllable fake `WebSocket` for upstream-layer unit tests.
 *
 * Instances never touch the network. Tests drive the lifecycle explicitly
 * (`mockOpen`, `mockMessage`, `mockClose`) and inspect what the code under test
 * sent (`sent`). `createFakeWebSocketFactory` returns a factory plus the
 * registry of every constructed socket, which is what the upstream pool accepts
 * via its `webSocketFactory` option.
 *
 * Only the `addEventListener` surface rx-nostr actually uses is implemented —
 * `open`, `message` and `close`, plus `send()`, `close()` and `readyState`.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Close code a real socket reports when the connection drops uncleanly. */
const ABNORMAL_CLOSURE = 1006;

type FakeEventType = 'open' | 'message' | 'close';
type FakeEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'close'; code: number; reason: string };
type FakeListener = (event: FakeEvent) => void;

export class FakeWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readyState: number = CONNECTING;
  readonly url: string;
  /** Every payload passed to `send()`, as parsed JSON. */
  readonly sent: unknown[] = [];

  private readonly listeners = new Map<FakeEventType, Set<FakeListener>>();

  constructor(url: string | URL) {
    this.url = url.toString();
  }

  addEventListener(type: FakeEventType, listener: FakeListener): void {
    const set = this.listeners.get(type) ?? new Set<FakeListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: FakeEventType, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  /** Close as a real socket does: the owner learns about it through `close`. */
  close(code: number = ABNORMAL_CLOSURE): void {
    if (this.readyState === CLOSED) {
      return;
    }
    this.readyState = CLOSED;
    this.emit('close', { type: 'close', code, reason: '' });
  }

  /** Transition to OPEN and fire the `open` listeners. */
  mockOpen(): void {
    this.readyState = OPEN;
    this.emit('open', { type: 'open' });
  }

  /** Deliver a wire message to the socket owner. */
  mockMessage(message: unknown): void {
    this.emit('message', { type: 'message', data: JSON.stringify(message) });
  }

  /** Drop the connection the way a network failure would. */
  mockClose(code: number = ABNORMAL_CLOSURE): void {
    this.close(code);
  }

  /** Wire messages of the given type that were sent on this socket. */
  sentOfType(type: string): unknown[][] {
    return this.sent.filter((m): m is unknown[] => Array.isArray(m) && m[0] === type);
  }

  private emit(type: FakeEventType, event: FakeEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

export interface FakeWebSocketFactory {
  /** Factory to pass as `webSocketFactory`. */
  factory: () => typeof WebSocket;
  /** Every socket constructed so far, in order. */
  sockets: FakeWebSocket[];
  /** The most recently constructed socket. */
  last(): FakeWebSocket;
  /** The most recent socket opened against `url` (rx-nostr normalizes urls). */
  forUrl(url: string): FakeWebSocket | undefined;
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
    forUrl: (url) => [...sockets].reverse().find((socket) => socket.url === url),
  };
}
