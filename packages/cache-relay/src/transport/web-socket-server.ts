import { randomUUID } from 'node:crypto';
import { logger } from '@nostr-cache/shared';
import type { NostrWireMessage } from '@nostr-cache/shared';
import { WebSocketServer as WS, WebSocket } from 'ws';
import type { TransportAdapter } from './transport-adapter.js';

/**
 * WebSocket server implementation for Node.js environment
 */
export class WebSocketServer implements TransportAdapter {
  private server: WS | null = null;
  private clients: Map<string, WebSocket> = new Map();
  private messageCallback?: (clientId: string, message: NostrWireMessage) => void;
  private connectCallback?: (clientId: string) => void;
  private disconnectCallback?: (clientId: string) => void;
  /**
   * The port asked for at construction time. Never overwritten by the port the
   * OS actually handed out, so a `stop()` → `start()` cycle on a dynamic-port
   * server re-requests 0 instead of pinning the port from the previous run
   * (which another process may have taken in the meantime).
   */
  private readonly requestedPort: number;

  /**
   * Create a new WebSocket server
   * @param port Optional port number (default: dynamically assigned)
   */
  constructor(port?: number) {
    this.requestedPort = port || 0; // 0 = dynamically assigned port
  }

  /**
   * Start the WebSocket server
   * @returns Promise resolving when transport is started
   */
  async start(): Promise<void> {
    this.server = new WS({ port: this.requestedPort });

    this.server.on('connection', (socket) => {
      const clientId = randomUUID();
      this.clients.set(clientId, socket);
      this.connectCallback?.(clientId);

      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as NostrWireMessage;
          this.messageCallback?.(clientId, message);
        } catch (error) {
          logger.error('Invalid message format:', error);
        }
      });

      socket.on('close', () => {
        this.clients.delete(clientId);
        this.disconnectCallback?.(clientId);
      });

      socket.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    // Handle server errors
    this.server.on('error', (error) => {
      logger.error('WebSocket server error:', error);
    });

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.once('error', (error) => {
        reject(error);
      });

      this.server.once('listening', () => {
        // Report the actual port number (in case we used 0 for dynamic assignment)
        logger.info(`WebSocket server started on port ${this.getBoundPort()}`);
        resolve();
      });
    });
  }

  /**
   * Get the port the server is actually listening on.
   *
   * Reads the address off the live server rather than a cached field, so
   * `port: 0` (let the OS pick) resolves to the real port once `start()` has
   * resolved. Callers that need a collision-free port should construct with 0
   * and read it back here instead of picking a number themselves.
   *
   * @returns The bound port, or null when the server is not listening
   */
  getBoundPort(): number | null {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  }

  /**
   * Get the port the server is listening on, falling back to the port that was
   * requested at construction time while the server is not listening.
   */
  getPort(): number {
    return this.getBoundPort() ?? this.requestedPort;
  }

  /**
   * Get the number of currently connected clients
   *
   * @returns The number of active client connections
   */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    if (this.server) {
      // Close all client connections
      for (const [clientId, socket] of this.clients) {
        socket.close();
        this.clients.delete(clientId);
      }

      // Close server
      await new Promise<void>((resolve, reject) => {
        if (!this.server) {
          resolve();
          return;
        }
        this.server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      this.server = null;
    }
  }

  /**
   * Send a message to a client
   */
  send(clientId: string, message: NostrWireMessage): void {
    const socket = this.clients.get(clientId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
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
