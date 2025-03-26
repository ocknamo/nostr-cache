import { NostrEvent, NostrWireMessage } from '@nostr-cache/types';
import { WebSocket } from 'ws';
import { WebSocketServer } from './WebSocketServer';

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
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => client.on('open', () => resolve()));
      client.send('invalid json');

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid message format:', expect.any(Error));
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
});
