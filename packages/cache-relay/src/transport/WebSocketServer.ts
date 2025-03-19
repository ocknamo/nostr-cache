import { randomUUID } from 'crypto';
import { NostrMessage } from '@nostr-cache/types';
import { WebSocket, WebSocketServer as WS } from 'ws';
import { TransportAdapter } from './TransportAdapter';

/**
 * WebSocket server implementation for Node.js environment
 */
export class WebSocketServer implements TransportAdapter {
  private server: WS | null = null;
  private clients: Map<string, WebSocket> = new Map();
  private messageCallback?: (clientId: string, message: NostrMessage) => void;
  private connectCallback?: (clientId: string) => void;
  private disconnectCallback?: (clientId: string) => void;

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    this.server = new WS({ port: 3000 });

    this.server.on('connection', (socket) => {
      const clientId = randomUUID();
      this.clients.set(clientId, socket);
      this.connectCallback?.(clientId);

      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as NostrMessage;
          this.messageCallback?.(clientId, message);
        } catch (error) {
          console.error('Invalid message format:', error);
        }
      });

      socket.on('close', () => {
        this.clients.delete(clientId);
        this.disconnectCallback?.(clientId);
      });

      socket.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    // Handle server errors
    this.server.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });

    // Wait for server to start
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.once('listening', () => {
        console.log('WebSocket server started on port 3000');
        resolve();
      });
    });
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
  send(clientId: string, message: NostrMessage): void {
    const socket = this.clients.get(clientId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Register message handler
   */
  onMessage(callback: (clientId: string, message: NostrMessage) => void): void {
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
