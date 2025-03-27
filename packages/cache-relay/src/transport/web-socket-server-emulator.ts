import type { NostrWireMessage } from '@nostr-cache/types';
import type { TransportAdapter } from './transport-adapter.js';

/**
 * WebSocket emulator for browser environment
 * Emulates WebSocket server functionality in the browser
 */
export class WebSocketServerEmulator implements TransportAdapter {
  private originalWebSocket: typeof WebSocket;
  private emulatedSocket: WebSocket | null = null;
  private messageCallback?: (clientId: string, message: NostrWireMessage) => void;
  private connectCallback?: (clientId: string) => void;
  private disconnectCallback?: (clientId: string) => void;
  private relayUrl?: string;

  constructor() {
    this.originalWebSocket = globalThis.WebSocket;
  }

  /**
   * Start the WebSocket emulator
   * Overrides the global WebSocket for cache-relay URL
   * @param url The URL to emulate WebSocket server for
   */
  async start(url = 'ws://localhost:3000'): Promise<void> {
    this.relayUrl = url;
    const emulator = this;

    // Override global WebSocket for cache-relay URL
    globalThis.WebSocket = class extends this.originalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const urlString = url.toString();
        if (urlString === emulator.relayUrl) {
          super(urlString, protocols);
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;

          // Store as emulated socket
          emulator.emulatedSocket = this;

          // Notify connection success asynchronously
          setTimeout(() => {
            if (this.onopen) {
              const event = new Event('open');
              (this.onopen as EventListener)(event);
            }
            emulator.connectCallback?.('cache-relay');
          }, 0);

          // Override send method
          const originalSend = this.send.bind(this);
          this.send = (data: string) => {
            try {
              const message = JSON.parse(data) as NostrWireMessage;
              emulator.messageCallback?.('cache-relay', message);
            } catch (error) {
              if (this.onerror) {
                const event = new Event('error');
                (this.onerror as EventListener)(event);
              }
            }
          };

          // Override close method
          const originalClose = this.close.bind(this);
          this.close = () => {
            if (this.onclose) {
              const event = new Event('close');
              (this.onclose as EventListener)(event);
            }
            emulator.disconnectCallback?.('cache-relay');
            emulator.emulatedSocket = null;
            originalClose();
          };
        } else {
          super(urlString, protocols);
        }
      }
    } as unknown as typeof WebSocket;
  }

  /**
   * Stop the WebSocket emulator
   * Restores the original WebSocket
   */
  async stop(): Promise<void> {
    if (this.emulatedSocket) {
      this.emulatedSocket.close();
    }
    globalThis.WebSocket = this.originalWebSocket;
    this.relayUrl = undefined;
  }

  /**
   * Send a message to a client
   */
  send(clientId: string, message: NostrWireMessage): void {
    if (this.emulatedSocket?.onmessage) {
      const event = new MessageEvent('message', {
        data: JSON.stringify(message),
      });
      (this.emulatedSocket.onmessage as EventListener)(event);
    }
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
}
