import type { NostrEvent, NostrWireMessage } from '@nostr-cache/shared';
import { WebSocketServerEmulator } from './web-socket-server-emulator.js';

/**
 * Open an emulated WebSocket and resolve once its open event fires.
 */
function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
  });
}

describe('WebSocketServerEmulator', () => {
  let emulator: WebSocketServerEmulator;
  let originalWebSocket: typeof WebSocket;
  const defaultUrl = 'ws://localhost:3000';
  const customUrl = 'ws://localhost:3001';

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    emulator = new WebSocketServerEmulator();
  });

  afterEach(async () => {
    await emulator.stop();
    globalThis.WebSocket = originalWebSocket;
  });

  describe('start()', () => {
    it('should use default URL when no URL is provided', async () => {
      await emulator.start();
      await openSocket(defaultUrl);
    });

    it('should use custom URL when provided', async () => {
      await emulator.start(customUrl);
      await openSocket(customUrl);
    });

    it('should accept target URLs via the constructor', async () => {
      const constructed = new WebSocketServerEmulator(customUrl);
      await constructed.start();
      await openSocket(customUrl);
      await constructed.stop();
    });

    it('should intercept multiple target URLs given to the constructor', async () => {
      const constructed = new WebSocketServerEmulator([defaultUrl, customUrl]);
      const connected: string[] = [];
      constructed.onConnect((clientId) => connected.push(clientId));
      await constructed.start();

      await openSocket(defaultUrl);
      await openSocket(customUrl);

      expect(connected).toHaveLength(2);
      expect(constructed.getConnectionCount()).toBe(2);
      await constructed.stop();
    });

    it('should normalize URLs when matching (trailing slash)', async () => {
      await emulator.start();
      // Same URL with a trailing slash must still be intercepted.
      await openSocket('ws://localhost:3000/');
      expect(emulator.getConnectionCount()).toBe(1);
    });

    it('should not open a real network connection for intercepted URLs', async () => {
      // A port that nothing listens on: a real connection would error, the
      // emulated one must open immediately.
      const unreachableUrl = 'ws://127.0.0.1:59999';
      const constructed = new WebSocketServerEmulator(unreachableUrl);
      await constructed.start();

      const errors: Event[] = [];
      const ws = await new Promise<WebSocket>((resolve) => {
        const socket = new WebSocket(unreachableUrl);
        socket.onerror = (event) => errors.push(event);
        socket.onopen = () => resolve(socket);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(errors).toHaveLength(0);
      await constructed.stop();
    });

    it('should use original WebSocket for other URLs', async () => {
      await emulator.start(customUrl);
      const ws = new WebSocket('ws://example.com');
      expect(ws instanceof originalWebSocket).toBe(true);
      ws.onerror = () => {
        // Ignore network errors from the real socket in the test environment.
      };
      ws.close();
    });

    it('should answer a client that sends synchronously from its open handler', async () => {
      await emulator.start();
      // Echo every message straight back through the emulator.
      emulator.onMessage((clientId, message) => {
        emulator.send(clientId, message);
      });

      const echoed = await new Promise<NostrWireMessage>((resolve) => {
        const ws = new WebSocket(defaultUrl);
        ws.onmessage = (event) => resolve(JSON.parse(event.data));
        ws.onopen = () => {
          // The relay must already know this connection: a synchronous
          // response here must not be dropped.
          ws.send(JSON.stringify(['NOTICE', 'sync send']));
        };
      });

      expect(echoed).toEqual(['NOTICE', 'sync send']);
    });

    it('should trigger connect callback with the same clientId used for messages', async () => {
      const connectedIds: string[] = [];
      emulator.onConnect((clientId) => connectedIds.push(clientId));
      await emulator.start();

      const messageClientId = new Promise<string>((resolve) => {
        emulator.onMessage((clientId) => resolve(clientId));
      });

      const ws = await openSocket(defaultUrl);
      ws.send(JSON.stringify(['NOTICE', 'hello']));

      expect(connectedIds).toHaveLength(1);
      expect(await messageClientId).toBe(connectedIds[0]);
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      await emulator.start();
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

      const received = new Promise<NostrWireMessage>((resolve) => {
        emulator.onMessage((_clientId, receivedMessage) => resolve(receivedMessage));
      });

      const ws = await openSocket(defaultUrl);
      ws.send(JSON.stringify(message));

      expect(await received).toEqual(message);
    });

    it('should handle invalid messages', async () => {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(defaultUrl);
        ws.onerror = () => {
          resolve();
        };
        ws.onopen = () => {
          ws.send('invalid json');
        };
      });
    });

    it('should route messages independently for multiple connections', async () => {
      const clientIds: string[] = [];
      emulator.onConnect((clientId) => clientIds.push(clientId));

      const ws1 = await openSocket(defaultUrl);
      const ws2 = await openSocket(defaultUrl);
      expect(clientIds).toHaveLength(2);
      expect(clientIds[0]).not.toBe(clientIds[1]);

      const ws1Messages: NostrWireMessage[] = [];
      const ws2Messages: NostrWireMessage[] = [];
      ws1.onmessage = (event) => ws1Messages.push(JSON.parse(event.data));
      ws2.onmessage = (event) => ws2Messages.push(JSON.parse(event.data));

      const toFirst: NostrWireMessage = ['NOTICE', 'for first'];
      const toSecond: NostrWireMessage = ['NOTICE', 'for second'];
      emulator.send(clientIds[0], toFirst);
      emulator.send(clientIds[1], toSecond);

      expect(ws1Messages).toEqual([toFirst]);
      expect(ws2Messages).toEqual([toSecond]);
    });

    it('should deliver messages to listeners registered via addEventListener', async () => {
      let clientId = '';
      emulator.onConnect((id) => {
        clientId = id;
      });
      const ws = await openSocket(defaultUrl);

      const message: NostrWireMessage = ['NOTICE', 'listener test'];
      const received = new Promise<NostrWireMessage>((resolve) => {
        ws.addEventListener('message', (event) => {
          resolve(JSON.parse((event as MessageEvent).data));
        });
      });
      emulator.send(clientId, message);

      expect(await received).toEqual(message);
    });
  });

  describe('stop()', () => {
    it('should restore original WebSocket', async () => {
      await emulator.start();
      await emulator.stop();
      expect(globalThis.WebSocket).toBe(originalWebSocket);
    });

    it('should trigger close event and disconnect callback', async () => {
      let disconnectedClientId: string | undefined;
      emulator.onDisconnect((clientId) => {
        disconnectedClientId = clientId;
      });
      let connectedClientId: string | undefined;
      emulator.onConnect((clientId) => {
        connectedClientId = clientId;
      });

      await emulator.start();
      const ws = await openSocket(defaultUrl);

      const closed = new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });
      await emulator.stop();
      await closed;

      expect(disconnectedClientId).toBeDefined();
      expect(disconnectedClientId).toBe(connectedClientId);
    });

    it('should cancel sockets that are still connecting when stopped', async () => {
      const connected: string[] = [];
      emulator.onConnect((clientId) => connected.push(clientId));
      await emulator.start();

      // Create the socket but stop the emulator before its open timer fires.
      const ws = new WebSocket(defaultUrl);
      await emulator.stop();

      // Give the (cancelled) open timer a chance to run.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connected).toEqual([]);
      expect(emulator.getConnectionCount()).toBe(0);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
      expect(globalThis.WebSocket).toBe(originalWebSocket);
    });

    it('should fire disconnect when the client closes the socket', async () => {
      const disconnected: string[] = [];
      emulator.onDisconnect((clientId) => disconnected.push(clientId));
      await emulator.start();

      const ws = await openSocket(defaultUrl);
      ws.close();

      expect(disconnected).toHaveLength(1);
      expect(emulator.getConnectionCount()).toBe(0);
    });
  });

  describe('send()', () => {
    it('should send messages to connected client', async () => {
      const message: NostrWireMessage = ['NOTICE', 'test message'];
      let clientId = '';
      emulator.onConnect((id) => {
        clientId = id;
      });

      await emulator.start();
      const ws = await openSocket(defaultUrl);

      const received = new Promise<NostrWireMessage>((resolve) => {
        ws.onmessage = (event) => resolve(JSON.parse(event.data));
      });
      emulator.send(clientId, message);

      expect(await received).toEqual(message);
    });

    it('should not throw when sending to non-existent client', () => {
      expect(() => {
        const message: NostrWireMessage = ['NOTICE', 'test'];
        emulator.send('non-existent-client', message);
      }).not.toThrow();
    });
  });

  describe('getConnectionCount()', () => {
    it('should be 0 before any connection', () => {
      expect(emulator.getConnectionCount()).toBe(0);
    });

    it('should track multiple open connections', async () => {
      await emulator.start();

      await openSocket(defaultUrl);
      const ws2 = await openSocket(defaultUrl);
      expect(emulator.getConnectionCount()).toBe(2);

      ws2.close();
      expect(emulator.getConnectionCount()).toBe(1);
    });
  });
});
