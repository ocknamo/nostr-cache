/**
 * Controllable fake `WebSocket` for upstream-layer unit tests.
 *
 * Instances never touch the network. Tests drive the lifecycle explicitly
 * (`mockOpen`, `mockMessage`, `close`) and inspect what the code under test
 * sent (`sent`). `createFakeWebSocketFactory` returns a factory plus the
 * registry of every constructed socket, which is what the upstream pool accepts
 * via its `webSocketFactory` option.
 *
 * Only the surface rx-nostr uses is implemented: `addEventListener` /
 * `removeEventListener` for `open`, `message` and `close`, plus `send()`,
 * `close()` and `readyState`.
 */

const OPEN = 1;
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
  readyState = 0;
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

  /** Drop the connection; the owner learns about it through `close`, as for a real socket. */
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

  private emit(type: FakeEventType, event: FakeEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

export function createFakeWebSocketFactory() {
  const sockets: FakeWebSocket[] = [];
  const Ctor = class extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  };
  return {
    /** Factory to pass as `webSocketFactory`. */
    factory: () => Ctor as unknown as typeof WebSocket,
    /** Every socket constructed so far, in order. */
    sockets,
    /** The most recently constructed socket. */
    last: () => sockets[sockets.length - 1],
    /** The most recent socket opened against `url` (rx-nostr normalizes urls). */
    forUrl: (url: string) => [...sockets].reverse().find((socket) => socket.url === url),
  };
}
