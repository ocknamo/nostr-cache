import type { NostrEvent, NostrWireMessage } from '@nostr-cache/shared';
import { WebSocketServerEmulator } from './web-socket-server-emulator.js';

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

      return new Promise<void>((resolve) => {
        const ws = new WebSocket(defaultUrl);
        ws.onopen = () => {
          resolve();
        };
      });
    });

    it('should use custom URL when provided', async () => {
      await emulator.start(customUrl);

      return new Promise<void>((resolve) => {
        const ws = new WebSocket(customUrl);
        ws.onopen = () => {
          resolve();
        };
      });
    });

    it('should use original WebSocket for other URLs', async () => {
      await emulator.start(customUrl);
      const ws = new WebSocket('ws://example.com');
      expect(ws instanceof originalWebSocket).toBe(true);
    });

    it('should trigger onopen event', async () => {
      await emulator.start();

      return new Promise<void>((resolve) => {
        const ws = new WebSocket(defaultUrl);
        ws.onopen = () => {
          resolve();
        };
      });
    });

    it('should trigger connect callback', async () => {
      return new Promise<void>((resolve) => {
        emulator.onConnect((clientId) => {
          expect(clientId).toBe('cache-relay');
          resolve();
        });

        emulator.start().then(() => {
          new WebSocket(defaultUrl);
        });
      });
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

      return new Promise<void>((resolve) => {
        emulator.onMessage((clientId, receivedMessage) => {
          expect(clientId).toBe('cache-relay');
          expect(receivedMessage).toEqual(message);
          resolve();
        });

        const ws = new WebSocket(defaultUrl);
        ws.onopen = () => {
          ws.send(JSON.stringify(message));
        };
      });
    });

    it('should handle invalid messages', async () => {
      return new Promise<void>((resolve) => {
        const ws = new WebSocket(defaultUrl);
        ws.onerror = () => {
          resolve();
        };
        ws.onopen = () => {
          ws.send('invalid json');
        };
      });
    });
  });

  describe('stop()', () => {
    it('should restore original WebSocket', async () => {
      await emulator.start();
      await emulator.stop();
      expect(globalThis.WebSocket).toBe(originalWebSocket);
    });

    it('should trigger close event and disconnect callback', async () => {
      let closeEventTriggered = false;
      let disconnectCallbackTriggered = false;

      return new Promise<void>((resolve) => {
        emulator.onDisconnect((clientId) => {
          expect(clientId).toBe('cache-relay');
          disconnectCallbackTriggered = true;
          if (closeEventTriggered) resolve();
        });

        emulator.start().then(() => {
          const ws = new WebSocket(defaultUrl);
          ws.onclose = () => {
            closeEventTriggered = true;
            if (disconnectCallbackTriggered) resolve();
          };
          ws.onopen = () => {
            emulator.stop();
          };
        });
      });
    });
  });

  describe('send()', () => {
    it('should send messages to connected client', async () => {
      const message: NostrWireMessage = ['NOTICE', 'test message'];

      await emulator.start();

      return new Promise<void>((resolve) => {
        const ws = new WebSocket(defaultUrl);
        ws.onmessage = (event) => {
          const receivedMessage = JSON.parse(event.data);
          expect(receivedMessage).toEqual(message);
          resolve();
        };
        ws.onopen = () => {
          emulator.send('cache-relay', message);
        };
      });
    });

    it('should not throw when sending to non-existent client', () => {
      expect(() => {
        const message: NostrWireMessage = ['NOTICE', 'test'];
        emulator.send('non-existent-client', message);
      }).not.toThrow();
    });
  });
});
