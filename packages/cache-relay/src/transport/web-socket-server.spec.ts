import type { NostrEvent, NostrWireMessage } from '@nostr-cache/shared';
import { vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketServer } from './web-socket-server.js';

describe('WebSocketServer', () => {
  let server: WebSocketServer;
  let client: WebSocket;
  let port: number;

  beforeEach(() => {
    server = new WebSocketServer();
  });

  afterEach(async () => {
    if (client?.readyState === WebSocket.OPEN) {
      client.close();
    }
    await server.stop();
  });

  describe('start()', () => {
    it('should start WebSocket server', async () => {
      await server.start();
      port = server.getPort();
      expect(port).toBeGreaterThan(0);

      // Try to connect
      await new Promise<void>((resolve, reject) => {
        client = new WebSocket(`ws://localhost:${port}`);
        client.on('open', () => resolve());
        client.on('error', reject);
      });
    });

    it('should trigger connect callback', async () => {
      const connectPromise = new Promise<string>((resolve) => {
        server.onConnect((clientId) => {
          expect(clientId).toBeDefined();
          resolve(clientId);
        });
      });

      await server.start();
      port = server.getPort();
      expect(port).toBeGreaterThan(0);

      client = new WebSocket(`ws://localhost:${port}`);
      await connectPromise;
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      await server.start();
      port = server.getPort();
      expect(port).toBeGreaterThan(0);
    });

    it('should handle valid Nostr messages', async () => {
      const event: NostrEvent = {
        id: '123',
        kind: 1,
        content: 'test',
        created_at: 0,
        pubkey: '',
        sig: '',
        tags: [],
      };
      const message: NostrWireMessage = ['EVENT', event];

      const messagePromise = new Promise<void>((resolve) => {
        server.onMessage((clientId, receivedMessage) => {
          expect(clientId).toBeDefined();
          expect(receivedMessage).toEqual(message);
          resolve();
        });
      });

      client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => client.on('open', () => resolve()));
      client.send(JSON.stringify(message));
      await messagePromise;
    });

    it('should handle invalid messages', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => client.on('open', () => resolve()));
      client.send('invalid json');

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[ERROR] Invalid message format:',
        expect.any(Error)
      );
      consoleErrorSpy.mockRestore();
    });
  });

  describe('stop()', () => {
    it('should close all client connections', async () => {
      await server.start();
      port = server.getPort();
      expect(port).toBeGreaterThan(0);

      const clientClosedPromise = new Promise<void>((resolve) => {
        client = new WebSocket(`ws://localhost:${port}`);
        client.on('close', () => resolve());
      });

      await new Promise<void>((resolve) => {
        client.on('open', () => resolve());
      });

      await server.stop();
      await clientClosedPromise;
    });

    it('should trigger disconnect callback', async () => {
      const disconnectPromise = new Promise<void>((resolve) => {
        server.onDisconnect((clientId) => {
          expect(clientId).toBeDefined();
          resolve();
        });
      });

      await server.start();
      port = server.getPort();
      expect(port).toBeGreaterThan(0);

      client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => client.on('open', () => resolve()));
      await server.stop();
      await disconnectPromise;
    });
  });

  describe('send()', () => {
    it('should send messages to connected client', async () => {
      const message: NostrWireMessage = ['NOTICE', 'test message'];

      await server.start();
      port = server.getPort();
      expect(port).toBeGreaterThan(0);

      const messagePromise = new Promise<void>((resolve) => {
        client = new WebSocket(`ws://localhost:${port}`);
        client.on('message', (data) => {
          const receivedMessage = JSON.parse(data.toString());
          expect(receivedMessage).toEqual(message);
          resolve();
        });
      });

      // Wait for client to connect and get its ID
      const clientId = await new Promise<string>((resolve) => {
        server.onConnect((id) => resolve(id));
        client.on('open', () => {
          /* connection established */
        });
      });

      server.send(clientId, message);
      await messagePromise;
    });

    it('should not throw when sending to non-existent client', () => {
      expect(() => {
        const message: NostrWireMessage = ['NOTICE', 'test'];
        server.send('non-existent-client', message);
      }).not.toThrow();
    });
  });

  describe('getBoundPort()', () => {
    it('should be null before start and after stop, and the real port while listening', async () => {
      expect(server.getBoundPort()).toBeNull();
      // 未起動のあいだ getPort() はコンストラクタで要求した値（既定 0）を返す
      expect(server.getPort()).toBe(0);

      await server.start();
      const bound = server.getBoundPort();
      expect(bound).toBeGreaterThan(0);
      expect(server.getPort()).toBe(bound);

      await server.stop();
      expect(server.getBoundPort()).toBeNull();
    });

    it('should request a fresh dynamic port on restart instead of pinning the old one', async () => {
      // stop() 後に前回のポートを掴みにいくと、その間に他プロセスが取っていた
      // 場合に EADDRINUSE になる。要求ポート（0）は起動をまたいでも変わらない。
      await server.start();
      const first = server.getBoundPort();
      expect(first).toBeGreaterThan(0);
      await server.stop();

      // 前回のポートを塞いだ状態で再起動しても、別ポートで問題なく上がる
      const squatter = new WebSocketServer(first as number);
      await squatter.start();
      try {
        await server.start();
        expect(server.getBoundPort()).toBeGreaterThan(0);
        expect(server.getBoundPort()).not.toBe(first);
      } finally {
        await squatter.stop();
      }
    });
  });

  describe('getConnectionCount()', () => {
    it('should start at zero', () => {
      expect(server.getConnectionCount()).toBe(0);
    });

    it('should track connects and disconnects', async () => {
      await server.start();
      port = server.getPort();

      const connected = new Promise<void>((resolve) => {
        server.onConnect(() => resolve());
      });
      client = new WebSocket(`ws://localhost:${port}`);
      // Wait for the client handshake to complete before closing, so the socket
      // is never torn down mid-handshake.
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve());
        client.on('error', reject);
      });
      await connected;
      expect(server.getConnectionCount()).toBe(1);

      const disconnected = new Promise<void>((resolve) => {
        server.onDisconnect(() => resolve());
      });
      client.close();
      await disconnected;
      expect(server.getConnectionCount()).toBe(0);
    });
  });
});
