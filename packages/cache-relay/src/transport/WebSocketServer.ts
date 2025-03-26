import { randomUUID } from 'node:crypto';
import { logger } from '@nostr-cache/shared';
import type { NostrWireMessage } from '@nostr-cache/types';
import { WebSocketServer as WS, WebSocket } from 'ws';
import type { TransportAdapter } from './TransportAdapter';

/**
 * WebSocket server implementation for Node.js environment
 */
export class WebSocketServer implements TransportAdapter {
  private server: WS | null = null;
  private clients: Map<string, WebSocket> = new Map();
  private messageCallback?: (clientId: string, message: NostrWireMessage) => void;
  private connectCallback?: (clientId: string) => void;
  private disconnectCallback?: (clientId: string) => void;
  private port = 0;

  /**
   * Create a new WebSocket server
   * @param port Optional port number (default: dynamically assigned)
   */
  constructor(port?: number) {
    this.port = port || 0; // 0 = dynamically assigned port
  }

  /**
   * Start the WebSocket server
   * @returns Promise resolving when transport is started
   */
  async start(): Promise<void> {
    this.server = new WS({ port: this.port });

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
        // Get the actual port number (in case we used 0 for dynamic assignment)
        const address = this.server?.address();
        this.port = typeof address === 'object' && address ? address.port : this.port;
        logger.info(`WebSocket server started on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Get the port the server is listening on
   */
  getPort(): number {
    return this.port;
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
