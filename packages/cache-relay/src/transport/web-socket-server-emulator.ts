import type { NostrWireMessage } from '@nostr-cache/shared';
import type { TransportAdapter } from './transport-adapter.js';

/**
 * Normalize a WebSocket URL for comparison (e.g. absorbs trailing-slash differences).
 * Returns the input unchanged when it is not a parsable URL.
 */
function normalizeWebSocketUrl(url: string): string {
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
function generateClientId(): string {
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
interface EmulatedSocketHooks {
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
class EmulatedWebSocket extends EventTarget {
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

/**
 * WebSocket emulator for browser environment
 *
 * Overrides the global WebSocket so that connections to the configured relay
 * URL(s) are served by the in-process relay instead of the network. Supports
 * multiple concurrent client connections, each identified by a generated
 * client ID. Connections to any other URL fall through to the original
 * WebSocket implementation untouched.
 */
export class WebSocketServerEmulator implements TransportAdapter {
  private originalWebSocket: typeof WebSocket | undefined;
  private sockets = new Map<string, EmulatedWebSocket>();
  /** Every created socket, including ones still CONNECTING (not yet in `sockets`) */
  private allSockets = new Set<EmulatedWebSocket>();
  private targetUrls: Set<string>;
  private messageCallback?: (clientId: string, message: NostrWireMessage) => void;
  private connectCallback?: (clientId: string) => void;
  private disconnectCallback?: (clientId: string) => void;

  /**
   * @param urls URL or URLs to intercept. The default uses the RFC 6761
   * reserved `.invalid` TLD, which is guaranteed never to resolve — so a
   * misconfigured (non-intercepted) connection can never reach a real
   * server, unlike e.g. `ws://localhost:3000`.
   */
  constructor(urls: string | string[] = 'ws://nostr-cache.invalid') {
    const list = Array.isArray(urls) ? urls : [urls];
    this.targetUrls = new Set(list.map(normalizeWebSocketUrl));
  }

  /**
   * Start the WebSocket emulator
   * Overrides the global WebSocket for the configured relay URL(s)
   *
   * @param url Optional URL to intercept; replaces the URLs given to the constructor
   */
  async start(url?: string): Promise<void> {
    if (url) {
      this.targetUrls = new Set([normalizeWebSocketUrl(url)]);
    }
    if (this.originalWebSocket) {
      // Already started; only the target URLs were updated.
      return;
    }

    const OriginalWebSocket = globalThis.WebSocket;
    this.originalWebSocket = OriginalWebSocket;
    const emulator = this;

    const PatchedWebSocket = class {
      constructor(target: string | URL, protocols?: string | string[]) {
        const urlString = target.toString();
        // Constructor return trick: hand back the emulated socket for target
        // URLs (never touching the network) and delegate everything else to
        // the original implementation.
        // biome-ignore lint/correctness/noConstructorReturn: intentional interception pattern
        return emulator.isTargetUrl(urlString)
          ? emulator.createEmulatedSocket(urlString)
          : new OriginalWebSocket(target, protocols);
      }
    };
    // Inherit static properties (CONNECTING/OPEN/...) from the original.
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    globalThis.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
  }

  /**
   * Stop the WebSocket emulator
   * Closes all emulated connections and restores the original WebSocket
   */
  async stop(): Promise<void> {
    // Close every created socket, including ones still CONNECTING (their
    // pending open timer then becomes a no-op).
    for (const socket of [...this.allSockets]) {
      socket.close();
    }
    this.allSockets.clear();
    this.sockets.clear();
    if (this.originalWebSocket) {
      globalThis.WebSocket = this.originalWebSocket;
      this.originalWebSocket = undefined;
    }
  }

  /**
   * Send a message to a client
   */
  send(clientId: string, message: NostrWireMessage): void {
    this.sockets.get(clientId)?.receiveFromRelay(message);
  }

  /**
   * Register message handler
   */
  onMessage(callback: (clientId: string, message: NostrWireMessage) => void): void {
    this.messageCallback = callback;
  }

  /**
   * Register connect handler
   */
  onConnect(callback: (clientId: string) => void): void {
    this.connectCallback = callback;
  }

  /**
   * Register disconnect handler
   */
  onDisconnect(callback: (clientId: string) => void): void {
    this.disconnectCallback = callback;
  }

  /**
   * Get the number of currently connected clients
   *
   * @returns The number of active emulated connections
   */
  getConnectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Whether the given URL should be intercepted by the emulator.
   */
  private isTargetUrl(url: string): boolean {
    return this.targetUrls.has(normalizeWebSocketUrl(url));
  }

  /**
   * Create an emulated socket wired to this emulator's callbacks.
   */
  private createEmulatedSocket(url: string): EmulatedWebSocket {
    const clientId = generateClientId();
    const socket = new EmulatedWebSocket(url, {
      onOpen: (opened) => {
        this.sockets.set(clientId, opened);
        this.connectCallback?.(clientId);
      },
      onSend: (sender, data) => {
        let message: NostrWireMessage;
        try {
          message = JSON.parse(data) as NostrWireMessage;
        } catch {
          sender.emitError();
          return;
        }
        this.messageCallback?.(clientId, message);
      },
      onClose: (closed) => {
        this.allSockets.delete(closed);
        if (this.sockets.delete(clientId)) {
          this.disconnectCallback?.(clientId);
        }
      },
    });
    this.allSockets.add(socket);
    return socket;
  }
}
