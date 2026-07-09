import type { NostrWireMessage } from '@nostr-cache/shared';
import {
  EmulatedWebSocket,
  generateClientId,
  normalizeWebSocketUrl,
} from './emulated-web-socket.js';
import type { TransportAdapter } from './transport-adapter.js';

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
   * Return the original `WebSocket` constructor captured when the emulator was
   * started (before it replaced the global). Used by the upstream relay
   * connector so that connections to real relays are never routed back through
   * the patched global — which would turn an intercepted upstream URL into a
   * self-connection loop.
   *
   * Falls back to the current `globalThis.WebSocket` when called before
   * `start()`, so the connector always gets a usable constructor.
   *
   * @returns The pre-patch `WebSocket` constructor
   */
  getOriginalWebSocket(): typeof WebSocket | undefined {
    return this.originalWebSocket ?? globalThis.WebSocket;
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
