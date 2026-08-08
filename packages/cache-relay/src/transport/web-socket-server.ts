import { randomUUID } from 'node:crypto';
import { logger } from '@nostr-cache/shared';
import type { NostrWireMessage } from '@nostr-cache/shared';
import { WebSocketServer as WS, WebSocket } from 'ws';
import type { TransportAdapter } from './transport-adapter.js';

export class WebSocketServer implements TransportAdapter {
  private server: WS | null = null;
  private clients: Map<string, WebSocket> = new Map();
  private messageCallback?: (clientId: string, message: NostrWireMessage) => void;
  private connectCallback?: (clientId: string) => void;
  private disconnectCallback?: (clientId: string) => void;
  private port = 0;

  constructor(port?: number) {
    this.port = port || 0; // 0 = dynamically assigned port
  }

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

    this.server.on('error', (error) => {
      logger.error('WebSocket server error:', error);
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.once('error', (error) => {
        reject(error);
      });

      this.server.once('listening', () => {
        const address = this.server?.address();
        this.port = typeof address === 'object' && address ? address.port : this.port;
        logger.info(`WebSocket server started on port ${this.port}`);
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  getConnectionCount(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    if (this.server) {
      for (const [clientId, socket] of this.clients) {
        socket.close();
        this.clients.delete(clientId);
      }

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

  send(clientId: string, message: NostrWireMessage): void {
    const socket = this.clients.get(clientId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  onMessage(callback: (clientId: string, message: NostrWireMessage) => void): void {
    this.messageCallback = callback;
  }

  onConnect(callback: (clientId: string) => void): void {
    this.connectCallback = callback;
  }

  onDisconnect(callback: (clientId: string) => void): void {
    this.disconnectCallback = callback;
  }
}
