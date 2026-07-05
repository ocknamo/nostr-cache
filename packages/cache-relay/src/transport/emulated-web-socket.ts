import type { NostrWireMessage } from '@nostr-cache/shared';

/**
 * Normalize a WebSocket URL for comparison (e.g. absorbs trailing-slash differences).
 * Returns the input unchanged when it is not a parsable URL.
 */
export function normalizeWebSocketUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

let clientSequence = 0;

/**
 * Generate a unique client ID for an emulated connection.
 */
export function generateClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return uuid;
  }
  clientSequence += 1;
  return `emulated-client-${clientSequence}`;
}

/**
 * Internal hooks used by the emulator to observe an emulated socket's lifecycle.
 */
export interface EmulatedSocketHooks {
  /** Called once the socket transitions to OPEN */
  onOpen(socket: EmulatedWebSocket): void;
  /** Called when the client sends data through the socket */
  onSend(socket: EmulatedWebSocket, data: string): void;
  /** Called when the socket is closed */
  onClose(socket: EmulatedWebSocket): void;
}

type EmulatedEventHandler = ((event: Event) => void) | null;
type EmulatedMessageHandler = ((event: MessageEvent) => void) | null;

/**
 * In-memory replacement for a client WebSocket connected to the emulated relay.
 *
 * Implements the subset of the WebSocket interface that Nostr clients rely on
 * (readyState lifecycle, send/close, on* handlers and addEventListener) without
 * ever opening a real network connection.
 */
export class EmulatedWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = EmulatedWebSocket.CONNECTING;
  readonly OPEN = EmulatedWebSocket.OPEN;
  readonly CLOSING = EmulatedWebSocket.CLOSING;
  readonly CLOSED = EmulatedWebSocket.CLOSED;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  readyState: number = EmulatedWebSocket.CONNECTING;

  private handlers: {
    open: EmulatedEventHandler;
    message: EmulatedMessageHandler;
    close: EmulatedEventHandler;
    error: EmulatedEventHandler;
  } = { open: null, message: null, close: null, error: null };

  private readonly hooks: EmulatedSocketHooks;

  constructor(url: string, hooks: EmulatedSocketHooks) {
    super();
    this.url = url;
    this.hooks = hooks;

    // Open asynchronously, mirroring real WebSocket semantics (handlers are
    // attached after the constructor returns). The relay side registers the
    // connection first (hooks.onOpen) so that a client sending synchronously
    // from its own open handler can already be answered.
    setTimeout(() => {
      if (this.readyState !== EmulatedWebSocket.CONNECTING) {
        return;
      }
      this.readyState = EmulatedWebSocket.OPEN;
      this.hooks.onOpen(this);
      this.dispatchEvent(new Event('open'));
    }, 0);
  }

  get onopen(): EmulatedEventHandler {
    return this.handlers.open;
  }
  set onopen(handler: EmulatedEventHandler) {
    this.setHandler('open', handler);
  }

  get onmessage(): EmulatedMessageHandler {
    return this.handlers.message;
  }
  set onmessage(handler: EmulatedMessageHandler) {
    this.setHandler('message', handler);
  }

  get onclose(): EmulatedEventHandler {
    return this.handlers.close;
  }
  set onclose(handler: EmulatedEventHandler) {
    this.setHandler('close', handler);
  }

  get onerror(): EmulatedEventHandler {
    return this.handlers.error;
  }
  set onerror(handler: EmulatedEventHandler) {
    this.setHandler('error', handler);
  }

  /**
   * Send data from the client to the emulated relay.
   */
  send(data: string): void {
    if (this.readyState === EmulatedWebSocket.CONNECTING) {
      throw new Error('EmulatedWebSocket: send() called before the connection is open');
    }
    if (this.readyState !== EmulatedWebSocket.OPEN) {
      // Sending on a closing/closed socket is silently ignored, as in browsers.
      return;
    }
    this.hooks.onSend(this, data);
  }

  /**
   * Close the connection.
   */
  close(_code?: number, _reason?: string): void {
    if (
      this.readyState === EmulatedWebSocket.CLOSING ||
      this.readyState === EmulatedWebSocket.CLOSED
    ) {
      return;
    }
    this.readyState = EmulatedWebSocket.CLOSED;
    // CloseEvent is not available in every runtime (e.g. older Node.js);
    // fall back to a plain Event there.
    this.dispatchEvent(
      typeof CloseEvent !== 'undefined'
        ? new CloseEvent('close', { code: 1000, wasClean: true })
        : new Event('close')
    );
    this.hooks.onClose(this);
  }

  /**
   * Deliver a message from the emulated relay to this client socket.
   * Not part of the WebSocket interface; used by the emulator only.
   */
  receiveFromRelay(message: NostrWireMessage): void {
    if (this.readyState !== EmulatedWebSocket.OPEN) {
      return;
    }
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  /**
   * Dispatch an error event on this socket.
   * Not part of the WebSocket interface; used by the emulator only.
   */
  emitError(): void {
    this.dispatchEvent(new Event('error'));
  }

  /**
   * Register an on* handler as an event listener so that both handler
   * properties and addEventListener receive events exactly once.
   */
  private setHandler(
    type: 'open' | 'message' | 'close' | 'error',
    handler: EmulatedEventHandler | EmulatedMessageHandler
  ): void {
    const previous = this.handlers[type];
    if (previous) {
      this.removeEventListener(type, previous as EventListener);
    }
    this.handlers[type] = handler as EmulatedEventHandler & EmulatedMessageHandler;
    if (handler) {
      this.addEventListener(type, handler as EventListener);
    }
  }
}
