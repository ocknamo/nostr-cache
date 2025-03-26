import type { NostrEvent, NostrWireMessage } from '@nostr-cache/types';
import { WebSocketServerEmulator } from './WebSocketServerEmulator';

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
    it('should use default URL when no URL is provided', (done) => {
      emulator.start().then(() => {
        const ws = new WebSocket(defaultUrl);
        ws.onopen = () => {
          done();
        };
      });
    });

    it('should use custom URL when provided', (done) => {
      emulator.start(customUrl).then(() => {
        const ws = new WebSocket(customUrl);
        ws.onopen = () => {
          done();
        };
      });
    });

    it('should use original WebSocket for other URLs', async () => {
      await emulator.start(customUrl);
      const ws = new WebSocket('ws://example.com');
      expect(ws instanceof originalWebSocket).toBe(true);
    });

    it('should trigger onopen event', (done) => {
      emulator.start().then(() => {
        const ws = new WebSocket(defaultUrl);
        ws.onopen = () => {
          done();
        };
      });
    });

    it('should trigger connect callback', (done) => {
      emulator.onConnect((clientId) => {
        expect(clientId).toBe('cache-relay');
        done();
      });

      emulator.start().then(() => {
        new WebSocket(defaultUrl);
      });
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      await emulator.start();
    });

    it('should handle valid Nostr messages', (done) => {
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

      emulator.onMessage((clientId, receivedMessage) => {
        expect(clientId).toBe('cache-relay');
        expect(receivedMessage).toEqual(message);
        done();
      });

      const ws = new WebSocket(defaultUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify(message));
      };
    });

    it('should handle invalid messages', (done) => {
      const ws = new WebSocket(defaultUrl);
      ws.onerror = () => {
        done();
      };
      ws.onopen = () => {
        ws.send('invalid json');
      };
    });
  });

  describe('stop()', () => {
    it('should restore original WebSocket', async () => {
      await emulator.start();
      await emulator.stop();
      expect(globalThis.WebSocket).toBe(originalWebSocket);
    });

    it('should trigger close event and disconnect callback', (done) => {
      let closeEventTriggered = false;
      let disconnectCallbackTriggered = false;

      function checkDone() {
        if (closeEventTriggered && disconnectCallbackTriggered) {
          done();
        }
      }

      emulator.onDisconnect((clientId) => {
        expect(clientId).toBe('cache-relay');
        disconnectCallbackTriggered = true;
        checkDone();
      });

      emulator.start().then(() => {
        const ws = new WebSocket(defaultUrl);
        ws.onclose = () => {
          closeEventTriggered = true;
          checkDone();
        };
        ws.onopen = () => {
          emulator.stop();
        };
      });
    });
  });

  describe('send()', () => {
    it('should send messages to connected client', (done) => {
      const message: NostrWireMessage = ['NOTICE', 'test message'];

      emulator.start().then(() => {
        const ws = new WebSocket(defaultUrl);
        ws.onmessage = (event) => {
          const receivedMessage = JSON.parse(event.data);
          expect(receivedMessage).toEqual(message);
          done();
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
